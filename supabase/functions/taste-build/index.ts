// taste-build — invisible-autopilot taste compiler (0006).
// POST / (JWT) { sync_cadence?, pose_mode_default?, style_influence?, force? }
//   → upserts prefs (the single cadence-preference call surface), builds the
//   week's taste_context, returns { prefs, taste_context, sync }.
// GET / (JWT) → { prefs, taste_context } (connect-moment status read, $0).
// POST /?build=1 { user_id } (nightly cron, HMAC-verified — same worker
//   pattern as pinterest-sync ?sync=1 / render-tryon ?process=1) → same build,
//   no user JWT required.
//
// Pipeline per user: prefs gate (skip when cadence 'off' or Pinterest
// disconnected) → idempotency per (user,week) → incremental pinterest-sync
// (via the ?sync=1 worker over HTTP, so the Trial budget pool + 429 backoff
// in _shared/pinterest.ts are shared, never bypassed) → vocab tag extractor
// (server port of lib/ai/taste-seeds.ts, $0) → pose auto-mark (top pins →
// pose_refs upsert, cap 12/user, stale rotated) → taste_context upsert.
//
// Sync failures are FAIL-SOFT: the build proceeds from whatever pins exist
// (stale context beats no context); the `sync` block reports the error and
// the nightly cron alerts when >20% of the cohort fails (supabase/inngest.md).
// Manual pose/pin pickers are untouched (0005 API stays the manual path).

import { admin, requireUser, supabaseUrl } from "../_shared/auth.ts";
import {
  badRequest,
  getQuery,
  handleOptions,
  json,
  readJson,
  requireMethod,
  toErrorResponse,
} from "../_shared/http.ts";
import { verifyInngestSignature } from "../_shared/pipeline.ts";
import {
  mondayOf,
  parsePoseModeDefault,
  parseStyleInfluence,
  parseSyncCadence,
  POSE_REF_CAP,
  readTasteContext,
  readTastePrefs,
  tasteSeedPack,
  TASTE_LOOKBACK_DAYS,
  type PoseModeDefault,
  type SyncCadence,
  type TasteContext,
  type TastePrefs,
} from "../_shared/taste.ts";

type Admin = ReturnType<typeof admin>;

const PIN_LOOKBACK_LIMIT = 200;
const PIN_IMAGE_PREFETCH_LIMIT = 2000;

interface StylePinRow {
  pin_id: string;
  board_id: string | null;
  board_name: string | null;
  image_url: string | null;
  title: string | null;
  description: string | null;
  width: number | null;
  height: number | null;
  use_as_pose: boolean;
  synced_at: string;
}

interface PoseRefRow {
  id: string;
  pin_id: string | null;
  created_at: string;
}

interface SyncResult {
  imported: number;
  skipped: number;
  truncated: boolean;
  error?: string;
}

/** Hex HMAC-SHA256 — the signing side of verifyInngestSignature (pipeline.ts). */
async function signHmac(secret: string, msg: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(msg),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Incremental sync via the pinterest-sync worker (shares the Trial budget pool). */
async function runIncrementalSync(userId: string): Promise<SyncResult> {
  const signingKey = Deno.env.get("INNGEST_SIGNING_KEY");
  if (!signingKey) return { imported: 0, skipped: 0, truncated: false, error: "signing_unconfigured" };
  const body = JSON.stringify({ user_id: userId });
  try {
    const res = await fetch(`${supabaseUrl()}/functions/v1/pinterest-sync?sync=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inngest-signature": await signHmac(signingKey, body),
      },
      body,
    });
    const payload = (await res.json()) as { ok?: boolean; data?: SyncResult; error?: { code?: string } };
    if (res.ok && payload.ok && payload.data) {
      return {
        imported: payload.data.imported ?? 0,
        skipped: payload.data.skipped ?? 0,
        truncated: payload.data.truncated ?? false,
      };
    }
    // Budget exhaustion mid-run is partial-success, not failure (pins kept).
    if (payload.error?.code === "pinterest_budget_exhausted") {
      return { imported: 0, skipped: 0, truncated: true };
    }
    return { imported: 0, skipped: 0, truncated: false, error: payload.error?.code ?? `sync_http_${res.status}` };
  } catch (e) {
    return { imported: 0, skipped: 0, truncated: false, error: `sync_unreachable:${(e as Error).message.slice(0, 80)}` };
  }
}

interface PrefsPatch {
  syncCadence?: SyncCadence;
  poseModeDefault?: PoseModeDefault;
  styleInfluence?: number;
}

async function upsertPrefs(sb: Admin, userId: string, patch: PrefsPatch): Promise<TastePrefs> {
  const prev = await readTastePrefs(sb, userId);
  const row = {
    user_id: userId,
    pinterest_connected: prev.pinterestConnected,
    sync_cadence: patch.syncCadence ?? prev.syncCadence,
    pose_mode_default: patch.poseModeDefault ?? prev.poseModeDefault,
    style_influence: patch.styleInfluence ?? prev.styleInfluence,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("user_taste_prefs").upsert(row, { onConflict: "user_id" });
  if (error) throw error;
  return {
    userId,
    pinterestConnected: row.pinterest_connected,
    syncCadence: row.sync_cadence,
    poseModeDefault: row.pose_mode_default,
    styleInfluence: row.style_influence,
  };
}

interface BuildResult {
  status: "built" | "cached" | "skipped";
  reason?: string;
  prefs: TastePrefs;
  taste_context: TasteContext | null;
  sync: SyncResult;
  new_pins: number;
}

async function buildForUser(sb: Admin, userId: string, force: boolean): Promise<BuildResult> {
  const weekOf = mondayOf(new Date());
  let prefs = await readTastePrefs(sb, userId);

  // Gate 1: user turned the autopilot off.
  if (prefs.syncCadence === "off") {
    return { status: "skipped", reason: "off", prefs, taste_context: await readTasteContext(sb, userId), sync: { imported: 0, skipped: 0, truncated: false }, new_pins: 0 };
  }

  // Idempotent per (user,week): replay costs 0 (no sync, no writes).
  const prevCtx = await readTasteContext(sb, userId);
  if (!force && prevCtx && prevCtx.weekOf === weekOf) {
    return { status: "cached", prefs, taste_context: prevCtx, sync: { imported: 0, skipped: 0, truncated: false }, new_pins: 0 };
  }

  // Gate 2: Pinterest must be connected (single connect moment owns this).
  const { data: acct } = await sb.from("pinterest_accounts")
    .select("user_id,status").eq("user_id", userId)
    .maybeSingle<{ user_id: string; status: string }>();
  const connected = !!acct && acct.status === "connected";
  if (prefs.pinterestConnected !== connected) {
    await sb.from("user_taste_prefs").upsert({
      user_id: userId,
      pinterest_connected: connected,
      sync_cadence: prefs.syncCadence,
      pose_mode_default: prefs.poseModeDefault,
      style_influence: prefs.styleInfluence,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    prefs = { ...prefs, pinterestConnected: connected };
  }
  if (!connected) {
    return { status: "skipped", reason: "disconnected", prefs, taste_context: prevCtx, sync: { imported: 0, skipped: 0, truncated: false }, new_pins: 0 };
  }

  // Incremental sync (new pins since last run; caps live in pinterest-sync).
  const sync = await runIncrementalSync(userId);

  // Extract: recent live pins grouped by board (most-recent board first),
  // per-board vocab packs merged in first-seen order, capped at 8.
  const cutoff = new Date(Date.now() - TASTE_LOOKBACK_DAYS * 86400000).toISOString();
  const { data: pins, error: pinsErr } = await sb.from("style_pins")
    .select("pin_id,board_id,board_name,image_url,title,description,width,height,use_as_pose,synced_at")
    .eq("user_id", userId).eq("dismissed", false)
    .gte("synced_at", cutoff)
    .order("synced_at", { ascending: false })
    .limit(PIN_LOOKBACK_LIMIT);
  if (pinsErr) throw pinsErr;
  const live = ((pins ?? []) as StylePinRow[]).filter((p) => p.pin_id);
  const sincePrev = prevCtx ? prevCtx.computedAt : null;
  const newPins = sincePrev ? live.filter((p) => p.synced_at > sincePrev).length : live.length;

  const byBoard = new Map<string, { name: string | null; pins: StylePinRow[] }>();
  for (const p of live) {
    const key = p.board_id ?? "__noboard__";
    let g = byBoard.get(key);
    if (!g) {
      g = { name: p.board_name, pins: [] };
      byBoard.set(key, g);
    }
    g.pins.push(p);
  }
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const g of byBoard.values()) {
    const { tags } = tasteSeedPack({ boardName: g.name, pins: g.pins });
    for (const t of tags) {
      if (!seen.has(t)) {
        seen.add(t);
        merged.push(t);
      }
      if (merged.length >= 8) break;
    }
    if (merged.length >= 8) break;
  }

  // Pose auto-mark: top pins → pose_refs upsert, cap 12/user, stale rotated.
  // Rank: explicit use_as_pose first, then portrait-readable, then recency.
  const ranked = [...live]
    .filter((p) => p.image_url)
    .sort((a, b) => {
      if (a.use_as_pose !== b.use_as_pose) return a.use_as_pose ? -1 : 1;
      const aPor = (a.height ?? 0) >= (a.width ?? 0) ? 0 : 1;
      const bPor = (b.height ?? 0) >= (b.width ?? 0) ? 0 : 1;
      if (aPor !== bPor) return aPor - bPor;
      return b.synced_at.localeCompare(a.synced_at);
    });
  const { data: existingRefs } = await sb.from("pose_refs")
    .select("id,pin_id,created_at").eq("user_id", userId).not("pin_id", "is", null);
  const refs = ((existingRefs ?? []) as PoseRefRow[]).filter((r) => r.pin_id);
  // Cursor for the FULL pin set (dedup/eviction must see beyond the 200 window).
  const { data: allPins } = await sb.from("style_pins").select("pin_id")
    .eq("user_id", userId).eq("dismissed", false).limit(PIN_IMAGE_PREFETCH_LIMIT);
  const allLive = new Set(((allPins ?? []) as Array<{ pin_id: string }>).map((r) => r.pin_id));

  // Evict: refs pointing at dismissed/deleted pins first (stale rotation),
  // then oldest-created beyond the cap.
  const staleIds = refs.filter((r) => r.pin_id && !allLive.has(r.pin_id)).map((r) => r.id);
  if (staleIds.length > 0) {
    await sb.from("pose_refs").delete().eq("user_id", userId).in("id", staleIds);
  }
  const surviving = refs.filter((r) => !staleIds.includes(r.id));
  const havePinIds = new Set(surviving.map((r) => r.pin_id as string));

  // Fill up to the cap with top-ranked pins not already marked.
  const toAdd = ranked.filter((p) => !havePinIds.has(p.pin_id)).slice(0, Math.max(0, POSE_REF_CAP - surviving.length));
  if (toAdd.length > 0) {
    const { error: insErr } = await sb.from("pose_refs").insert(
      toAdd.map((p) => ({ user_id: userId, pin_id: p.pin_id, label: (p.title ?? p.board_name ?? "pose").slice(0, 80) })),
    );
    if (insErr && (insErr as { code?: string }).code !== "23505") throw insErr;
  }

  // Hard-trim to the cap (oldest-created evicted; CHECK in 0006 is the backstop).
  const { data: finalRefs } = await sb.from("pose_refs")
    .select("id,pin_id,created_at").eq("user_id", userId).not("pin_id", "is", null)
    .order("created_at", { ascending: false });
  const ordered = ((finalRefs ?? []) as PoseRefRow[]).filter((r) => r.pin_id && allLive.has(r.pin_id));
  const over = ordered.slice(POSE_REF_CAP).map((r) => r.id);
  if (over.length > 0) {
    await sb.from("pose_refs").delete().eq("user_id", userId).in("id", over);
  }
  const poseRefIds = ordered.slice(0, POSE_REF_CAP).map((r) => r.id);

  const styleNote = merged.length === 0 && poseRefIds.length === 0
    ? `no style signal yet · wk ${weekOf} · ${sync.imported} new pins`
    : [
      merged.slice(0, 3).map((t) => t.slice(t.indexOf(":") + 1)).join(" · ") || "no tags",
      `${poseRefIds.length} pose ref${poseRefIds.length === 1 ? "" : "s"}`,
      `wk ${weekOf}`,
      `${newPins} new pin${newPins === 1 ? "" : "s"}`,
    ].join(" — ");

  const { error: ctxErr } = await sb.from("taste_context").upsert({
    user_id: userId,
    seed_tags: merged,
    pose_ref_ids: poseRefIds,
    style_note: styleNote.slice(0, 280),
    computed_at: new Date().toISOString(),
    week_of: weekOf,
  }, { onConflict: "user_id" });
  if (ctxErr) throw ctxErr;

  const taste_context = await readTasteContext(sb, userId);
  return { status: "built", prefs, taste_context, sync, new_pins: newPins };
}

interface TasteBuildBody {
  user_id?: unknown;
  userId?: unknown;
  sync_cadence?: unknown;
  pose_mode_default?: unknown;
  style_influence?: unknown;
  force?: unknown;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const sb = admin();

    // ------------------------------------------------------- status read
    if (req.method === "GET") {
      const user = await requireUser(req);
      return json({
        prefs: await readTastePrefs(sb, user.id),
        taste_context: await readTasteContext(sb, user.id),
      });
    }

    requireMethod(req, "POST");

    // ------------------------------------------------------- cron worker
    if (getQuery(req, "build") === "1") {
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
      return json(await buildForUser(sb, userId, false));
    }

    // ------------------------------------------------------- user path
    // Single cadence-preference surface: optional pref fields are validated
    // + upserted, then the week's context is (re)built. Manual pose/pin
    // pickers stay on the 0005 API; this fn never takes pin ids.
    const user = await requireUser(req);
    const body = await readJson<TasteBuildBody>(req);
    const patch: PrefsPatch = {};
    if (body.sync_cadence !== undefined) patch.syncCadence = parseSyncCadence(body.sync_cadence);
    if (body.pose_mode_default !== undefined) patch.poseModeDefault = parsePoseModeDefault(body.pose_mode_default);
    if (body.style_influence !== undefined) patch.styleInfluence = parseStyleInfluence(body.style_influence);
    if (Object.keys(patch).length > 0) {
      await upsertPrefs(sb, user.id, patch);
    }
    const force = body.force === true;
    return json(await buildForUser(sb, user.id, force));
  } catch (e) {
    return toErrorResponse(e);
  }
});
