// Shared restyle core (Deno, strict TS) — used by BOTH `restyle` and
// `render-tryon` (mode: 'restyle'). One implementation so the two entry points
// can never drift on caps, cost, or idempotency.
//
// Rules (§4 + §7, unchanged from the original restyle fn):
//   parent must be `done`; max 3 restyles per session chain (cycle-guarded);
//   max 3 restyles per user per UTC week (P1-2 weekly budget, mirrors client
//   MAX_REGENERATES_PER_WEEK — enforced here in the shared core so BOTH
//   `reel-regenerate` and direct `POST /restyle` consume the same pool;
//   idempotent replays bypass it at 0 cost);
//   restyle ALWAYS costs 1 credit (free tier additionally consumes the atomic
//   1/day slot via bump_restyle_daily — bumped after the idempotency lookup so
//   replays never burn it, and the single-statement bump means concurrent
//   restyles cannot double-spend it, P1-009); Max parents need HD credit.
// Provider failure → simplified-prompt retry in the pipeline; response always
// carries keep_best_url + a report so the client can "keep best".

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { badRequest, forbidden, paymentRequired } from "./http.ts";
import { buildRenderKey, findRenderByKey, isReusableRow } from "./idempotency.ts";
import { enqueueRender, type PipelineTier } from "./pipeline.ts";
import {
  bumpRestyleDaily,
  checkRestyleWeeklyCap,
  consumeAllowance,
  FREE_RESTYLES_PER_DAY,
  getEntitlementState,
  refundAllowance,
  RESTYLE_MAX_PER_SESSION,
  todayISO,
  type PoolCode,
} from "./quota.ts";

export interface RestyleInput {
  renderId: string;
  note: string;
  /** Client-rewritten prompt (gemini-client buildRestylePrompt); echoed back. */
  rewrittenPrompt?: string | null;
  promptTags?: string[];
  photoConditions?: Record<string, unknown>;
  /** Accepted for contract compat; informational only (parent tier governs). */
  tierHint?: string | null;
  modelHint?: string | null;
  /** Resolved idempotency key (header > body); server-computed when null. */
  idempotencyKey?: string | null;
  /** Pinterest pose (0005): resolved + ownership-checked by the caller. */
  poseMode?: "keep" | "adapt";
  poseRefId?: string | null;
  poseImageUrl?: string | null;
}

export interface RestyleOutcome {
  render_id: string;
  status: "queued" | "processing" | "done";
  cached: boolean;
  restyle_n?: number;
  restyles_left_session?: number;
  keep_best_url: string | null;
  rewritten_prompt?: string;
  report: string | null;
  idempotency_key: string;
}

interface ParentRow {
  id: string;
  user_id: string;
  outfit_id: string | null;
  base_photo_id: string | null;
  parent_render_id: string | null;
  garment_refs: { garment_ids?: string[] } | null;
  mode: string | null;
  tier: string | null;
  status: string;
  output_url: string | null;
  error: string | null;
}

function extractFailTags(errorText: string | null): string[] {
  if (!errorText) return [];
  const stop = new Set(["the", "and", "with", "from", "that", "this", "failed", "attempt", "error"]);
  return errorText.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4 && !stop.has(w)).slice(0, 5);
}

export async function requestRestyle(
  sb: SupabaseClient,
  userId: string,
  input: RestyleInput,
): Promise<RestyleOutcome> {
  const note = (input.note ?? "").trim().slice(0, 280);
  if (!input.renderId) throw badRequest("render_required", "render_id required");
  if (!note) throw badRequest("note_required", "Describe the change (e.g. “tuck it in, warmer light”)");

  const { data: parent, error } = await sb.from("renders").select(
    "id,user_id,outfit_id,base_photo_id,parent_render_id,garment_refs,mode,tier,status,output_url,error",
  ).eq("id", input.renderId).eq("user_id", userId).maybeSingle<ParentRow>();
  if (error || !parent) throw badRequest("render_not_found", "Render not found");
  if (parent.status !== "done") {
    throw badRequest("parent_not_ready", "You can only restyle a finished try-on");
  }

  // Session depth: walk the chain; max 3 restyles per session.
  let depth = 0;
  let cursor: string | null = parent.parent_render_id;
  const seen = new Set<string>([parent.id]);
  while (cursor && depth < 10) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const { data: anc } = await sb.from("renders").select(
      "id,parent_render_id",
    ).eq("id", cursor).eq("user_id", userId)
      .maybeSingle<{ id: string; parent_render_id: string | null }>();
    if (!anc) break;
    depth += 1;
    cursor = anc.parent_render_id;
  }
  const restyleN = depth + 1;
  if (restyleN > RESTYLE_MAX_PER_SESSION) {
    // Keep-best: latest done render in this session chain.
    const { data: best } = await sb.from("renders").select("id,output_url")
      .eq("user_id", userId).eq("status", "done")
      .order("created_at", { ascending: false }).limit(1)
      .maybeSingle<{ id: string; output_url: string | null }>();
    throw forbidden("restyle_session_cap",
      "3 restyles per session — kept your best version. Start a new try-on to explore further.",
      { keep_best_url: best?.output_url ?? parent.output_url, keep_best_id: best?.id ?? parent.id });
  }

  // Cost: 1 credit, always. Free tier also burns its 1/day slot — but ONLY
  // once this request is actually going to enqueue (the bump sits AFTER the
  // idempotency lookup below, so cache hits never consume the daily slot).
  const ent = await getEntitlementState(sb, userId);
  const tier = (parent.tier === "max" ? "max" : "std") as PipelineTier;

  const garmentIds = parent.garment_refs?.garment_ids ?? [];
  const key = input.idempotencyKey ?? await buildRenderKey({
    userId,
    basePhotoId: parent.base_photo_id ?? "active",
    outfitId: parent.outfit_id,
    garmentIds,
    day: todayISO(),
    mode: "restyle",
    tier,
    promptHash: `${parent.id}:${note}:${input.poseMode ?? "keep"}:${input.poseRefId ?? ""}`,
  });

  // Idempotency: identical re-request (same key) = same row, 0 extra cost.
  const existing = await findRenderByKey(sb, userId, key);
  if (existing && isReusableRow(existing)) {
    return {
      render_id: existing.id,
      status: existing.status,
      cached: true,
      keep_best_url: parent.output_url,
      rewritten_prompt: input.rewrittenPrompt ?? undefined,
      report: null,
      idempotency_key: key,
    };
  }

  // P1-2 weekly budget (all tiers): AFTER idempotency so replays (0 cost) are
  // never blocked and never consume budget; BEFORE consumeAllowance so an
  // exhausted week spends nothing. Direct-API callers hit this same core —
  // the client 3/week mirror cannot be bypassed.
  await checkRestyleWeeklyCap(sb, userId);

  // Free tier: atomic daily-slot bump (P1-009) — after idempotency, before
  // any other money movement.
  if (ent.tier === "free") {
    const usedToday = await bumpRestyleDaily(sb, userId);
    if (usedToday > FREE_RESTYLES_PER_DAY) {
      throw paymentRequired("restyle_daily_exhausted",
        "Free includes 1 restyle a day. Upgrade for 30 renders a month.", { used: usedToday });
    }
  }

  let pool: PoolCode;
  try {
    pool = await consumeAllowance(sb, userId, tier);
  } catch (e) {
    const fresh = await getEntitlementState(sb, userId);
    throw paymentRequired("quota_exhausted", (e as Error).message, {
      renders_left: fresh.rendersLeft,
      std_credits: fresh.stdCredits,
      hd_credits: fresh.hdCredits,
    });
  }

  // Feed prior-fail tags into the base photo so the rewritten prompt avoids them.
  const failTags = extractFailTags(parent.error);
  if (failTags.length > 0 && parent.base_photo_id) {
    const { data: bp } = await sb.from("base_photos").select("pose_meta")
      .eq("id", parent.base_photo_id).eq("user_id", userId)
      .maybeSingle<{ pose_meta: Record<string, unknown> }>();
    const meta = (bp?.pose_meta ?? {}) as Record<string, unknown>;
    const merged = [...new Set([...(Array.isArray(meta.prior_fail_tags) ? meta.prior_fail_tags as string[] : []), ...failTags])].slice(0, 5);
    await sb.from("base_photos").update({ pose_meta: { ...meta, prior_fail_tags: merged } })
      .eq("id", parent.base_photo_id);
  }

  let row: { id: string; status: string };
  try {
    row = await enqueueRender(sb, {
      userId,
      outfitId: parent.outfit_id,
      basePhotoId: parent.base_photo_id,
      garmentIds,
      mode: "restyle",
      tier,
      idempotencyKey: key,
      parentRenderId: parent.id,
      note: `${note} (preserve face identity, pose, body shape exactly)`,
      pool,
      poseMode: input.poseMode,
      poseRefId: input.poseRefId ?? null,
      metaExtra: {
        ...(input.rewrittenPrompt ? { rewritten_prompt: input.rewrittenPrompt.slice(0, 2000) } : {}),
        ...(input.promptTags ? { prompt_tags: input.promptTags.slice(0, 12) } : {}),
        ...(input.photoConditions ? { photo_conditions: input.photoConditions } : {}),
        ...(input.modelHint ? { model_hint: String(input.modelHint).slice(0, 64) } : {}),
        // Pinterest pose (0005): recorded for the AI crew; the pipeline prompt
        // is unchanged (keep path) until the adapt consumer lands.
        pose_mode: input.poseMode ?? "keep",
        ...(input.poseRefId ? { pose_ref_id: input.poseRefId } : {}),
        ...(input.poseImageUrl ? { pose_image_url: input.poseImageUrl } : {}),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
    // Global idempotency_key UNIQUE vs user-scoped lookup: lost a same-user
    // race (adopt the winner) or the key was pre-registered cross-user —
    // refund either way so the victim never pays for an unrendered restyle.
    await refundAllowance(sb, userId, pool);
    const winner = await findRenderByKey(sb, userId, key);
    if (winner && isReusableRow(winner)) {
      return {
        render_id: winner.id,
        status: winner.status,
        cached: true,
        keep_best_url: parent.output_url,
        rewritten_prompt: input.rewrittenPrompt ?? undefined,
        report: null,
        idempotency_key: key,
      };
    }
    throw forbidden("idempotency_conflict", "This restyle key is already in use — the request was not charged.");
  }

  return {
    render_id: row.id,
    status: "queued",
    cached: false,
    restyle_n: restyleN,
    restyles_left_session: RESTYLE_MAX_PER_SESSION - restyleN,
    keep_best_url: parent.output_url,
    rewritten_prompt: input.rewrittenPrompt ?? undefined,
    report: restyleN >= 2
      ? "If this attempt fails, the pipeline retries once with a simplified prompt and keeps your best version."
      : null,
    idempotency_key: key,
  };
}
