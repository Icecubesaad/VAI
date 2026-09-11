// reel-regenerate — fresh variation of one weekly-drop card via the restyle core.
// POST { cardId|card_id|render_id, note?, idempotency_key? }
//   (+ X-Idempotency-Key header, preferred) → 202 ReelCard (200 on idempotent replay)
// Card identity is STABLE: the returned card keeps `id` = cardId with `renderId` =
// the new render, so the client swaps by `id`. The regenerated card is STANDALONE —
// it is NOT appended to WeeklyDrop.card_ids (the drop stays idempotent per
// (user,weekOf)); the client swaps it into the rendered week locally.
// Cost: 1 credit ALWAYS (requestRestyle — shared core with POST /restyle and
// render-tryon mode 'restyle', identical caps/cost/idempotency): free consumes
// the lifetime/credit pool + the atomic 1/day slot; premium consumes the
// monthly/credit pool; Max parents need HD credit. Terminal failure refunds
// (failed predictions cost 0). Max 3 restyles per session chain + max 3 per
// UTC week (P1-2 weekly budget, server is truth — enforced in the shared core
// AFTER idempotency so replays cost 0; direct-API callers cannot bypass it).
// Pending render: imageUrl "" + costUsd $0.067 estimate; poll render-tryon
// { action:'status', render_id } (or renders realtime) until done.
// Retry note: if a previous attempt terminally failed under the same
// X-Idempotency-Key, retry with a FRESH key (the core keys retries by it).
// POSE (0005): accepts pose_mode ('keep'|'adapt', default 'keep') +
// pose_ref_id (aliases poseMode/poseRefId/pose_ref) — resolved server-side
// (ownership-checked, fail closed 400 pose_ref_not_found) and passed into
// the shared restyle core, which records pose_* in garment_refs.meta +
// renders.pose_mode/pose_ref_id for the AI crew's adapt consumer. The keep
// path is byte-identical to before.

import { admin, requireUser } from "../_shared/auth.ts";
import {
  badRequest,
  getIdempotencyKey,
  handleOptions,
  json,
  readJson,
  requireMethod,
  toErrorResponse,
} from "../_shared/http.ts";
import { parsePoseMode, resolvePoseRef } from "../_shared/pinterest.ts";
import {
  isReelPose,
  toReelCard,
  type ReelCard,
  type ReelRenderRow,
} from "../_shared/reel.ts";
import { requestRestyle } from "../_shared/restyle.ts";

const DEFAULT_NOTE = "Fresh variation of this look — same outfit, preserve face identity exactly";

interface RegenerateBody {
  cardId?: unknown;
  card_id?: unknown;
  render_id?: unknown;
  renderId?: unknown;
  note?: unknown;
  pose_mode?: unknown;
  poseMode?: unknown;
  pose_ref_id?: unknown;
  poseRefId?: unknown;
  pose_ref?: unknown;
  idempotency_key?: unknown;
  idempotencyKey?: unknown;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<RegenerateBody>(req);

    const cardId = [body.cardId, body.card_id, body.render_id, body.renderId]
      .find((v): v is string => typeof v === "string" && v.length > 0);
    if (!cardId) throw badRequest("card_required", "cardId required");
    const note = typeof body.note === "string" && body.note.trim().length > 0
      ? body.note
      : DEFAULT_NOTE;

    const sb = admin();
    const { data: parent } = await sb.from("renders")
      .select("id,outfit_id,output_url,status,created_at,garment_refs")
      .eq("id", cardId).eq("user_id", user.id)
      .maybeSingle<ReelRenderRow>();
    if (!parent) throw badRequest("card_not_found", "Card not found");
    const parentMeta = (parent.garment_refs?.meta ?? {}) as Record<string, unknown>;

    // Pose (0005): server-side resolve, fail closed — before the 1-credit core.
    const poseMode = parsePoseMode(body.pose_mode ?? body.poseMode);
    const poseRefIdRaw = [body.pose_ref_id, body.poseRefId, body.pose_ref]
      .find((v): v is string => typeof v === "string" && v.length > 0);
    const poseRef = poseRefIdRaw ? await resolvePoseRef(sb, user.id, poseRefIdRaw) : null;

    // 1 credit via the shared restyle core (caps + idempotency inside).
    // Ownership + parent-done are enforced there; error shapes
    // (restyle_session_cap keep-best, restyle_weekly_cap 403, restyle_daily_exhausted/quota 402s) match
    // POST /restyle exactly.
    const outcome = await requestRestyle(sb, user.id, {
      renderId: cardId,
      note,
      idempotencyKey: getIdempotencyKey(req, body),
      poseMode,
      poseRefId: poseRef?.poseRefId ?? null,
      poseImageUrl: poseRef?.imageUrl,
    });

    const { data: fresh, error: fErr } = await sb.from("renders")
      .select("id,outfit_id,output_url,status,created_at,garment_refs")
      .eq("id", outcome.render_id).eq("user_id", user.id)
      .single<ReelRenderRow>();
    if (fErr || !fresh) throw fErr ?? new Error("Regenerated render not visible");

    const trend = parentMeta["trend_tag"];
    const card: ReelCard = await toReelCard(sb, fresh, {
      cardId,
      poseFallback: isReelPose(parentMeta["pose"]) ? parentMeta["pose"] : undefined,
      trendFallback: typeof trend === "string" ? trend : null,
    });
    return json(card, outcome.cached ? 200 : 202);
  } catch (e) {
    return toErrorResponse(e);
  }
});
