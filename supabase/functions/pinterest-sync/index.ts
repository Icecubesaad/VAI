// pinterest-sync — import the user's OWN boards/pins into style_pins.
// POST / { boardIds?: string[] } (JWT) → 200 { imported, skipped, truncated }
//   boardIds omitted = all boards. Returns counts; `truncated: true` means the
//   Trial daily budget stopped the run early (partial results kept).
// GET /?action=list (JWT) → 200 { boards: [{ board_id, name, pin_count, privacy }] }
//   Read-only board list for the picker. Shares listAllBoards() with the POST
//   path (single read path — no drift); canonical snake response, same board
//   shape the POST-side mapper already tolerates.
// Flow: list boards (paginated) → per-board pins (paginated) → detail-fetch
//   ONLY pins whose list item lacks an image → upsert style_pins.
//   Dismissed rows are NEVER overwritten (counted as skipped).
// Rate limits: every Pinterest call goes through pinApi() (429 → Retry-After
//   + exp backoff; 401 → single refresh + retry inside getValidToken). The
//   Trial 1000/day app-wide budget is enforced by checkPinBudget() BEFORE the
//   run and spendPinBudget() per call — see _shared/pinterest.ts.
// POST /?sync=1 { user_id } (Inngest nightly cron, HMAC-verified — same worker
//   pattern as render-tryon ?process=1) → same payload, no user JWT required.
// Safety caps: 10 board pages (250 boards), 20 pin pages per board, 50
// explicit boardIds — bounds worst-case spend per run under Trial.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, handleOptions, HttpError, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { checkPinBudget, getValidToken, pinApi } from "../_shared/pinterest.ts";
import { verifyInngestSignature } from "../_shared/pipeline.ts";

type Db = ReturnType<typeof admin>;

const PAGE_SIZE = 25;
const MAX_BOARD_PAGES = 10;
const MAX_PIN_PAGES_PER_BOARD = 20;
const MAX_BOARD_IDS = 50;

interface BoardItem {
  id: string;
  name?: string;
  pin_count?: number;
  privacy?: string;
}

interface BoardsPage {
  items?: BoardItem[];
  bookmark?: string | null;
}

interface PinListItem {
  id: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  image?: { original?: { url?: string; width?: number; height?: number } } | null;
  media_source?: { image_url?: string; url?: string } | null;
}

interface PinsPage {
  items?: PinListItem[];
  bookmark?: string | null;
}

async function listAllBoards(sb: Db, token: string): Promise<BoardItem[]> {
  const boards: BoardItem[] = [];
  let bookmark: string | null = null;
  for (let page = 0; page < MAX_BOARD_PAGES; page++) {
    const qs = `/boards?page_size=${PAGE_SIZE}` + (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : "");
    const res = (await pinApi(sb, token, qs)) as BoardsPage;
    for (const b of res.items ?? []) {
      if (typeof b.id === "string" && b.id.length > 0) boards.push(b);
    }
    bookmark = res.bookmark ?? null;
    if (!bookmark) break;
  }
  return boards;
}

/** Canonical snake board row (client mapper is camel-tolerant). */
function toBoardRow(b: BoardItem): { board_id: string; name: string; pin_count: number; privacy: string } {
  const p = typeof b.privacy === "string" ? b.privacy.toLowerCase() : "";
  return {
    board_id: b.id,
    name: typeof b.name === "string" && b.name.length > 0 ? b.name : "Untitled board",
    pin_count: typeof b.pin_count === "number" ? b.pin_count : 0,
    privacy: p === "secret" || p === "private" ? "secret" : "public",
  };
}

function pinImageOf(pin: PinListItem): { url: string | null; width: number | null; height: number | null } {
  const orig = pin.image?.original;
  if (orig?.url) {
    return {
      url: orig.url,
      width: typeof orig.width === "number" ? orig.width : null,
      height: typeof orig.height === "number" ? orig.height : null,
    };
  }
  const ms = pin.media_source;
  const url = ms?.image_url ?? ms?.url ?? null;
  return { url: typeof url === "string" && url.length > 0 ? url : null, width: null, height: null };
}

interface PinDetail {
  id?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  image?: { original?: { url?: string; width?: number; height?: number } } | null;
  media_source?: { image_url?: string; url?: string } | null;
  width?: number | null;
  height?: number | null;
}

/** Detail fetch for image originals (only when the list item had no image). */
async function fetchPinDetail(sb: Db, token: string, pinId: string): Promise<PinListItem | null> {
  try {
    const d = (await pinApi(sb, token, `/pins/${encodeURIComponent(pinId)}`)) as PinDetail;
    return {
      id: pinId,
      title: d.title ?? null,
      description: d.description ?? null,
      link: d.link ?? null,
      image: d.image ?? null,
      media_source: d.media_source ?? null,
    };
  } catch {
    return null; // deleted/private pin — caller counts it as skipped
  }
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

async function syncUser(sb: Db, userId: string, boardIds: string[] | null): Promise<{ imported: number; skipped: number; truncated: boolean }> {
  await checkPinBudget(sb);
  const { token } = await getValidToken(sb, userId);

  let boards = await listAllBoards(sb, token);
  if (boardIds) {
    const want = new Set(boardIds);
    boards = boards.filter((b) => want.has(b.id));
  }

  let imported = 0;
  let skipped = 0;
  let truncated = false;

  for (const board of boards) {
    let bookmark: string | null = null;
    for (let page = 0; page < MAX_PIN_PAGES_PER_BOARD; page++) {
      let pins: PinListItem[];
      try {
        const qs = `/boards/${encodeURIComponent(board.id)}/pins?page_size=${PAGE_SIZE}` +
          (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : "");
        const res = (await pinApi(sb, token, qs)) as PinsPage;
        pins = (res.items ?? []).filter((p) => typeof p.id === "string" && p.id.length > 0);
        bookmark = res.bookmark ?? null;
      } catch (e) {
        // Budget exhaustion mid-run → keep partial results, report truncation.
        if (e instanceof HttpError && e.code === "pinterest_budget_exhausted") {
          truncated = true;
          bookmark = null;
          break;
        }
        throw e;
      }

      // Resolve images (detail-fetch only when the list item lacks one), then
      // partition against existing rows in ONE query per page.
      const resolved: PinListItem[] = [];
      for (const p of pins) {
        if (pinImageOf(p).url) {
          resolved.push(p);
          continue;
        }
        try {
          const full = await fetchPinDetail(sb, token, p.id);
          resolved.push(full ?? p);
        } catch (e) {
          if (e instanceof HttpError && e.code === "pinterest_budget_exhausted") {
            truncated = true;
            break;
          }
          throw e;
        }
      }

      const ids = resolved.map((p) => p.id);
      const { data: existing } = ids.length > 0
        ? await sb.from("style_pins").select("pin_id,dismissed").eq("user_id", userId).in("pin_id", ids)
        : { data: [] as Array<{ pin_id: string; dismissed: boolean }> };
      const byPin = new Map((existing ?? []).map((r) => [r.pin_id, r.dismissed]));

      const toInsert: Record<string, unknown>[] = [];
      const toUpdate: PinListItem[] = [];
      for (const p of resolved) {
        const state = byPin.get(p.id);
        if (state === undefined) {
          const img = pinImageOf(p);
          toInsert.push({
            user_id: userId,
            pin_id: p.id,
            board_id: board.id,
            board_name: strOrNull(board.name),
            image_url: img.url,
            title: strOrNull(p.title),
            description: typeof p.description === "string" ? p.description.slice(0, 2000) : null,
            link: strOrNull(p.link),
            width: img.width,
            height: img.height,
            synced_at: new Date().toISOString(),
          });
        } else if (state === true) {
          skipped++; // dismissed → never overwritten, never unhidden
        } else {
          toUpdate.push(p);
        }
      }

      if (toInsert.length > 0) {
        const { error } = await sb.from("style_pins").insert(toInsert);
        if (error) throw error;
        imported += toInsert.length;
      }
      for (const p of toUpdate) {
        const img = pinImageOf(p);
        const { error } = await sb.from("style_pins").update({
          board_id: board.id,
          board_name: strOrNull(board.name),
          image_url: img.url,
          title: strOrNull(p.title),
          description: typeof p.description === "string" ? p.description.slice(0, 2000) : null,
          link: strOrNull(p.link),
          width: img.width,
          height: img.height,
          synced_at: new Date().toISOString(),
        }).eq("user_id", userId).eq("pin_id", p.id).eq("dismissed", false);
        if (error) throw error;
        imported++;
      }

      if (truncated) break;
      if (!bookmark) break;
    }
    if (truncated) break;
  }

  return { imported, skipped, truncated };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const sb = admin();

    // ------------------------------------------------------- board-list read
    // GET /?action=list shares listAllBoards() with the POST sync path below
    // (single read path — no drift).
    if (req.method === "GET") {
      requireMethod(req, "GET");
      const user = await requireUser(req);
      const url = new URL(req.url);
      if (url.searchParams.get("action") !== "list") {
        throw badRequest("action_invalid", "Use ?action=list");
      }
      const { token } = await getValidToken(sb, user.id);
      const boards = await listAllBoards(sb, token);
      return json({ boards: boards.map(toBoardRow) });
    }

    requireMethod(req, "POST");
    const url = new URL(req.url);

    // ------------------------------------------------------- cron worker path
    if (url.searchParams.get("sync") === "1") {
      const raw = await req.text();
      if (!(await verifyInngestSignature(req, raw))) {
        throw badRequest("bad_signature", "Invalid Inngest signature");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw badRequest("invalid_json", "Worker body must be JSON");
      }
      const userId = (parsed as { user_id?: unknown }).user_id;
      if (typeof userId !== "string" || !userId) {
        throw badRequest("user_required", "user_id required");
      }
      return json(await syncUser(sb, userId, null));
    }

    // ------------------------------------------------------- user path
    const user = await requireUser(req);
    const body = await readJson<{ boardIds?: unknown; board_ids?: unknown }>(req);
    const rawIds = body.boardIds ?? body.board_ids ?? null;
    let boardIds: string[] | null = null;
    if (rawIds !== null && rawIds !== undefined) {
      if (!Array.isArray(rawIds)) throw badRequest("boards_invalid", "boardIds must be an array of board ids");
      boardIds = rawIds.filter((b): b is string => typeof b === "string" && b.length > 0).slice(0, MAX_BOARD_IDS);
      if (boardIds.length === 0) throw badRequest("boards_invalid", "boardIds must be an array of board ids");
    }
    return json(await syncUser(sb, user.id, boardIds));
  } catch (e) {
    return toErrorResponse(e);
  }
});
