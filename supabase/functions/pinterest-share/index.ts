// pinterest-share — post ONE finished render to a Pinterest board.
// POST / { renderId, boardId, title?, description?, altText? } (JWT)
//   (snake_case aliases render_id/board_id/alt_text accepted) → 200
//   { pin_id, board_id }
// EXPLICIT-TAP ONLY: this function is called from the share sheet after the
// user picks a board and confirms — NEVER from any cron, queue, or automatic
// flow (no auto-post anywhere; grep must show zero internal callers).
// Guards (all fail closed): render must be owned + done + servable (signed
// the account must hold pins:write (else 403 share_not_authorized → client
// re-runs pinterest-auth ?action=auth-url&with_write=1); the board is
// re-verified owned via GET /v5/boards/{id} (1 budgeted request).
// Composer input is clamped to Pinterest limits (title 100 / desc 800 /
// alt 500); defaults carry the honest "AI try-on" caption.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, forbidden, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { getValidToken, loadAccount, pinApi } from "../_shared/pinterest.ts";
import { signedRenderUrl } from "../_shared/storage.ts";

const TITLE_MAX = 100;
const DESC_MAX = 800;
const ALT_MAX = 500;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<Record<string, unknown>>(req);
    const sb = admin();

    const renderId = [body.renderId, body.render_id]
      .find((v): v is string => typeof v === "string" && v.length > 0);
    if (!renderId) throw badRequest("render_required", "renderId required");
    const boardId = [body.boardId, body.board_id]
      .find((v): v is string => typeof v === "string" && v.length > 0);
    if (!boardId) throw badRequest("board_required", "boardId required");

    const { data: render } = await sb.from("renders").select("id,user_id,status,output_url,output_path")
      .eq("id", renderId).eq("user_id", user.id)
      .maybeSingle<{ id: string; user_id: string; status: string; output_url: string | null; output_path: string | null }>();
    if (!render) throw badRequest("render_not_found", "Render not found");
    // Fresh 1h signed URL (0008) — Pinterest's fetcher needs a publicly
    // reachable image; the private-bucket path alone won't do.
    const pinImageUrl = render.output_path
      ? await signedRenderUrl(sb, render.user_id, render.output_path)
      : render.output_url;
    if (render.status !== "done" || !pinImageUrl) {
      throw badRequest("render_not_ready", "Only a finished try-on can be shared");
    }

    const account = await loadAccount(sb, user.id);
    if (!account.scopes.includes("pins:write")) {
      throw forbidden("share_not_authorized",
        "Sharing needs Pinterest write permission — approve it to continue.",
        { reauth: "pinterest-auth?action=auth-url&with_write=1" });
    }
    const { token } = await getValidToken(sb, user.id);

    // Re-verify the board belongs to the user (fail closed on 404/wrong owner).
    const board = (await pinApi(sb, token, `/boards/${encodeURIComponent(boardId)}`)) as {
      id?: string;
      owner?: { username?: string };
    };
    if (board.id !== boardId) throw badRequest("board_not_found", "Board not found on your Pinterest account");

    const title = (typeof body.title === "string" && body.title.trim().length > 0
      ? body.title.trim()
      : "My VAI try-on").slice(0, TITLE_MAX);
    const description = (typeof body.description === "string" && body.description.trim().length > 0
      ? body.description.trim()
      : "Styled with VAI — AI try-on, may differ from fit.").slice(0, DESC_MAX);
    const altText = (typeof body.altText === "string" || typeof body.alt_text === "string"
      ? String(body.altText ?? body.alt_text).trim() || null
      : null)?.slice(0, ALT_MAX) ?? null;

    const created = (await pinApi(sb, token, "/pins", {
      method: "POST",
      body: {
        board_id: boardId,
        title,
        description,
        ...(altText ? { alt_text: altText } : {}),
        media_source: { source_type: "image_url", url: pinImageUrl },
      },
    })) as { id?: string };

    if (!created.id) throw badRequest("share_failed", "Pinterest did not return a pin id");
    return json({ pin_id: created.id, board_id: boardId });
  } catch (e) {
    return toErrorResponse(e);
  }
});
