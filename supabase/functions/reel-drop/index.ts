// reel-drop — weekly stylist reel + reel-week read.
// POST / { weekOf|week_of (YYYY-MM-DD Monday), trendTag|trend_tag? }
//   → 202 WeeklyDrop (fresh drop; renders still queued — card imageUrl is ""
//     until done, costUsd is the $0.067 std estimate until ledger-authoritative)
//   → 200 WeeklyDrop (idempotent replay per (user,weekOf) — 0 extra cost;
//     terminally-failed cards self-heal: replay deletes the dead row and
//     re-enqueues the same sha256(user|weekOf|dayIndex) key)
// GET /?weekOf=YYYY-MM-DD (reel-week) → 200 WeeklyDrop | null
//   ({ ok:true, data:null } when the week was never generated).
//
// Quota law (consume_render_allowance pools, unchanged): free teaser = 3 std
// cards drawing the 5-LIFETIME pool; premium full = 7 std cards drawing the
// 30/mo pool; packs overflow. Pre-flight 402s (free_exhausted /
// monthly_exhausted, upgrade:true) fire BEFORE any consumption; a mid-loop
// 402 (concurrent-spend race only) leaves finished cards in place and retry
// resumes them at 0 cost via the per-card keys — the drop row is inserted
// only once all cards exist, so a retry never double-charges.
// Outfits: buildDayOutfit() — the same core plan-week wraps — called directly
// so the free teaser isn't blocked by plan-week's v2_locked flag/premium gate;
// rows persist with source='reel-drop' (+ week_of/reel_day_index in context)
// for recency tracking. Dates: dayIndex 0..N-1 → Mon..Sun of weekOf.
// Pose rotation: front→step→detail cycle over the poses the user HAS (active
// base_photos — CANONICAL `pose` column wins, legacy `pose_meta.pose`
// fallback via resolveBasePhotoPose, P0-1/0004; neither reads as front);
// poses without a captured photo are skipped, never synthesized. Renders store mode 'tryon' +
// meta { source:'reel-drop', pose, week_of, day_index, trend_tag? } (0003
// decision — no new renders mode). TASTE AUTOPILOT (0006): Pinterest pose is
// auto-selected per card (rotation over taste_context.pose_ref_ids — a
// DIFFERENT axis from the base-photo front/step/detail above, recorded as
// pose_mode/pose_ref_id for the AI crew's adapt consumer) honoring
// pose_mode_default ('auto' = adapt iff a fresh pose_ref exists, else keep;
// stale/missing refs fail OPEN to keep — the drop never blocks). Style seeds
// auto-inject via buildDayOutfit (reads taste_context, scaled by
// style_influence) + are mirrored into render meta as taste_tags. No client
// params needed; manual pose pickers stay on render-tryon/reel-regenerate.
// Crons (Sun 01:00 taste-build, Sun 02:00 gen, Mon 07:00 push) live
// in supabase/inngest.md; per-card render_ready pushes fire via the pipeline.

import { admin, requireUser } from "../_shared/auth.ts";
import {
  badRequest,
  getQuery,
  handleOptions,
  json,
  paymentRequired,
  readJson,
  requireMethod,
  toErrorResponse,
} from "../_shared/http.ts";
import { findRenderByKey, isReusableRow } from "../_shared/idempotency.ts";
import { enqueueRender } from "../_shared/pipeline.ts";
import { buildDayOutfit } from "../_shared/plan.ts";
import { resolvePoseRef } from "../_shared/pinterest.ts";
import {
  consumeAllowance,
  getEntitlementState,
  refundAllowance,
  type PoolCode,
} from "../_shared/quota.ts";
import {
  addDaysIso,
  assertMondayWeek,
  buildReelKey,
  readWeeklyDrop,
  REEL_FULL_CARDS,
  REEL_POSES,
  REEL_TEASER_CARDS,
  resolveBasePhotoPose,
  type ReelPose,
  type WeeklyDrop,
} from "../_shared/reel.ts";
import {
  POSE_FRESH_DAYS,
  POSE_REF_CAP,
  readTasteContext,
  readTastePrefs,
  resolveAutoPoseMode,
  selectTasteTags,
} from "../_shared/taste.ts";

interface ReelDropBody {
  weekOf?: unknown;
  week_of?: unknown;
  trendTag?: unknown;
  trend_tag?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

type Admin = ReturnType<typeof admin>;

interface BasePhotoRow {
  id: string;
  url: string;
  pose: string | null;
  pose_meta: { pose?: unknown } | null;
}

/**
 * Active base photo per pose.
 * CANONICAL: `pose` column wins; `pose_meta.pose` is the legacy client path
 * (pose-pack writes meta-only) and is read as fallback (P0-1 — shared
 * resolveBasePhotoPose, cf. _shared/reel.ts). Rows with neither resolve to
 * 'front' (pre-0003 legacy rows, per 0003 backfill-free contract).
 */
async function poseBases(sb: Admin, userId: string): Promise<Map<ReelPose, string>> {
  const { data, error } = await sb.from("base_photos").select("id,url,pose,pose_meta")
    .eq("user_id", userId).eq("is_active", true).order("created_at", { ascending: true });
  if (error) throw error;
  const byPose = new Map<ReelPose, string>();
  for (const p of (data ?? []) as BasePhotoRow[]) {
    const pose: ReelPose = resolveBasePhotoPose(p) ?? "front";
    if (!byPose.has(pose)) byPose.set(pose, p.id);
  }
  return byPose;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const sb = admin();

    // ------------------------------------------------------- GET reel-week
    if (req.method === "GET") {
      const user = await requireUser(req);
      const weekOf = (getQuery(req, "weekOf") ?? getQuery(req, "week_of") ?? "").trim();
      if (!weekOf) throw badRequest("week_required", "Pass ?weekOf=YYYY-MM-DD (a Monday)");
      assertMondayWeek(weekOf);
      return json(await readWeeklyDrop(sb, user.id, weekOf));
    }

    // ------------------------------------------------------ POST reel-drop
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<ReelDropBody>(req);
    const weekOf = str(body.weekOf ?? body.week_of);
    if (!weekOf) throw badRequest("week_required", "weekOf (YYYY-MM-DD Monday) required");
    assertMondayWeek(weekOf);
    const trendTag = str(body.trendTag ?? body.trend_tag)?.slice(0, 64) ?? null;

    // Idempotency per (user,weekOf): replay costs 0.
    const cached = await readWeeklyDrop(sb, user.id, weekOf);
    if (cached) return json(cached, 200);

    const ent = await getEntitlementState(sb, user.id);
    const full = ent.tier === "premium";
    const want = full ? REEL_FULL_CARDS : REEL_TEASER_CARDS;

    // Per-card resume: reusable rows (queued/processing/done) are adopted at
    // 0 cost; terminally-failed rows are cleared so the same key retries clean.
    const made = new Map<number, string>(); // dayIndex -> renderId
    for (let i = 0; i < want; i++) {
      const key = await buildReelKey(user.id, weekOf, i);
      const hit = await findRenderByKey(sb, user.id, key);
      if (!hit) continue;
      if (isReusableRow(hit)) {
        made.set(i, hit.id);
      } else {
        await sb.from("renders").delete().eq("id", hit.id).eq("user_id", user.id);
      }
    }

    // Pre-flight BEFORE any consumption: only the still-missing cards must fit.
    const need = want - made.size;
    const available = ent.rendersLeft + ent.stdCredits;
    if (available < need) {
      throw paymentRequired(
        full ? "monthly_exhausted" : "free_exhausted",
        full
          ? `Your weekly drop needs ${need} more render${need === 1 ? "" : "s"} but only ${available} remain this month. Top up with a credit pack.`
          : `Your teaser needs ${need} more of your 5 lifetime renders but only ${available} remain. Upgrade for 30 renders a month.`,
        { renders_left: ent.rendersLeft, std_credits: ent.stdCredits, needed: need },
      );
    }
    if (need === 0) {
      // All cards exist but the drop row doesn't (crash between enqueue and
      // insert): persist + return, no new spend.
      const ids = [...made.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
      const { error: dErr } = await sb.from("reel_drops").insert({
        user_id: user.id,
        week_of: weekOf,
        tier: full ? "full" : "teaser",
        card_ids: ids,
        trend_tag: trendTag,
      });
      if (dErr && (dErr as { code?: string }).code !== "23505") throw dErr;
      const healed = await readWeeklyDrop(sb, user.id, weekOf);
      if (!healed) throw new Error("Drop insert not visible");
      return json(healed, 200);
    }

    // Base photos must exist before money (mirrors render-tryon ordering).
    const byPose = await poseBases(sb, user.id);
    const rotation = REEL_POSES.filter((p) => byPose.has(p));
    if (rotation.length === 0) {
      throw badRequest("base_missing",
        "Take your mirror selfie first — the weekly drop needs at least a front photo");
    }

    // Taste autopilot (0006): ONE-row read, no client params. Rotation walks
    // taste_context.pose_ref_ids across cards; resolvePoseRef fails OPEN per
    // card (bad ref → keep, the drop never blocks on stale taste).
    const tastePrefs = await readTastePrefs(sb, user.id);
    const taste = await readTasteContext(sb, user.id);
    const tasteRefs = (taste?.poseRefIds ?? []).slice(0, POSE_REF_CAP);
    const tasteTags = taste ? selectTasteTags(taste.seedTags, tastePrefs.styleInfluence) : [];
    let freshPoseRef = false;
    if (tasteRefs.length > 0) {
      const { data: refRows } = await sb.from("pose_refs").select("id,created_at")
        .eq("user_id", user.id).in("id", tasteRefs);
      const cutoff = Date.now() - POSE_FRESH_DAYS * 86400000;
      freshPoseRef = ((refRows ?? []) as Array<{ id: string; created_at: string }>)
        .some((r) => tasteRefs.includes(r.id) && Date.parse(r.created_at) >= cutoff);
    }
    const autoPose = resolveAutoPoseMode(tastePrefs.poseModeDefault, tasteRefs, freshPoseRef);

    // Seed laundry exclusion from already-made cards' outfits.
    const excluded: string[] = [];
    if (made.size > 0) {
      const { data: used } = await sb.from("renders").select("outfit_id")
        .in("id", [...made.values()]).eq("user_id", user.id);
      const oids = ((used ?? []) as Array<{ outfit_id: string | null }>)
        .map((r) => r.outfit_id).filter((o): o is string => !!o);
      if (oids.length > 0) {
        const { data: ow } = await sb.from("outfits").select("garment_ids")
          .in("id", oids).eq("user_id", user.id);
        for (const o of (ow ?? []) as Array<{ garment_ids: string[] }>) {
          if (Array.isArray(o.garment_ids)) excluded.push(...o.garment_ids);
        }
      }
    }

    for (let i = 0; i < want; i++) {
      if (made.has(i)) continue;
      const date = addDaysIso(weekOf, i);

      let plan: Awaited<ReturnType<typeof buildDayOutfit>>;
      try {
        plan = await buildDayOutfit(sb, user.id, {
          date,
          excludeGarmentIds: excluded.slice(-24),
        });
      } catch (e) {
        if ((e as { code?: string }).code === "closet_empty") {
          throw badRequest("closet_empty", (e as Error).message);
        }
        throw e;
      }
      const { data: outfit, error: oErr } = await sb.from("outfits").insert({
        user_id: user.id,
        date,
        garment_ids: plan.garment_ids,
        wishlist_ids: plan.wishlist_ids,
        context: { ...plan.context, week_of: weekOf, reel_day_index: i },
        why_line: plan.why_line,
        source: "reel-drop",
        score: plan.score,
      }).select("id").single<{ id: string }>();
      if (oErr || !outfit) throw oErr ?? new Error("Outfit insert failed");
      excluded.push(...plan.garment_ids);

      const pose: ReelPose = rotation[i % rotation.length] ?? "front";
      const basePhotoId = byPose.get(pose) as string;
      const key = await buildReelKey(user.id, weekOf, i);

      // Autopilot pose for this card: rotate over pose_refs (0006).
      let cardPoseMode: "keep" | "adapt" = "keep";
      let cardPoseRefId: string | null = null;
      let cardPoseImageUrl: string | null = null;
      if (autoPose === "adapt" && tasteRefs.length > 0) {
        const refId = tasteRefs[i % tasteRefs.length] as string;
        try {
          const resolved = await resolvePoseRef(sb, user.id, refId);
          cardPoseMode = "adapt";
          cardPoseRefId = resolved.poseRefId;
          cardPoseImageUrl = resolved.imageUrl;
        } catch {
          // Fail open: this card keeps the base pose, rotation continues.
        }
      }

      // Race check: a concurrent drop may have enqueued since the pre-pass.
      const race = await findRenderByKey(sb, user.id, key);
      if (race && isReusableRow(race)) {
        made.set(i, race.id);
        continue;
      }

      let pool: PoolCode | null = null;
      try {
        pool = await consumeAllowance(sb, user.id, "std");
      } catch (e) {
        const fresh = await getEntitlementState(sb, user.id);
        throw paymentRequired("quota_exhausted", (e as Error).message, {
          renders_left: fresh.rendersLeft,
          std_credits: fresh.stdCredits,
          needed: want - made.size,
        });
      }

      try {
        const row = await enqueueRender(sb, {
          userId: user.id,
          outfitId: outfit.id,
          basePhotoId,
          garmentIds: plan.garment_ids,
          mode: "tryon",
          tier: "std",
          idempotencyKey: key,
          pool,
          poseMode: cardPoseMode,
          poseRefId: cardPoseRefId,
          metaExtra: {
            source: "reel-drop",
            pose,
            week_of: weekOf,
            day_index: i,
            outfit_date: date,
            ...(trendTag ? { trend_tag: trendTag } : {}),
            pose_mode: cardPoseMode,
            ...(cardPoseRefId ? { pose_ref_id: cardPoseRefId } : {}),
            ...(cardPoseImageUrl ? { pose_image_url: cardPoseImageUrl } : {}),
            ...(tasteTags.length > 0 ? { taste_tags: tasteTags } : {}),
            ...(taste?.weekOf ? { taste_week: taste.weekOf } : {}),
          },
        });
        made.set(i, row.id);
      } catch (e) {
        if ((e as { code?: string }).code === "23505" && pool) {
          // Lost the enqueue race: refund our unconsumed allowance and adopt
          // the winner's row (0 net spend for this card).
          await refundAllowance(sb, user.id, pool);
          const winner = await findRenderByKey(sb, user.id, key);
          if (winner && isReusableRow(winner)) {
            made.set(i, winner.id);
            continue;
          }
        }
        throw e;
      }
    }

    const cardIds = [...made.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
    const { error: dErr } = await sb.from("reel_drops").insert({
      user_id: user.id,
      week_of: weekOf,
      tier: full ? "full" : "teaser",
      card_ids: cardIds,
      trend_tag: trendTag,
    });
    if (dErr) {
      // Concurrent double-POST winner: return their drop (identical keys →
      // identical cards, 0 extra cost either way).
      if ((dErr as { code?: string }).code === "23505") {
        const winner = await readWeeklyDrop(sb, user.id, weekOf);
        if (winner) return json(winner as WeeklyDrop, 200);
      }
      throw dErr;
    }

    const drop = await readWeeklyDrop(sb, user.id, weekOf);
    if (!drop) throw new Error("Drop insert not visible");
    return json(drop as WeeklyDrop, 202);
  } catch (e) {
    return toErrorResponse(e);
  }
});
