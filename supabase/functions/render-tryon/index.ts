// render-tryon — quota + idempotency → Inngest queue → provider chain → push.
//
// CANONICAL REQUEST (CONTRACT-integrations §2 — the single shape both clients
// converge on; documented here as the authority):
//   POST / { base_photo_id?, base_photo_url?,
//            garment_refs: [{ garmentId?, imageUrl, category? }] | string[],
//            mode: 'tryon' | 'restyle' | 'compare', tier?: 'std' | 'max',
//            resolution?: '0.5K'|'1K'|'2K'|'4K',
//            model_hint?: 'gemini-3.1-flash-image' | 'gemini-3-pro-image',
//            outfit_id?, day?: 'YYYY-MM-DD', fallback_of?, note?,
//            pose_mode?: 'keep'|'adapt', pose_ref_id?,
//            idempotency_key? }
//   + `X-Idempotency-Key` header (preferred). Identical key → cached URL, 0 cost.
// POSE (0005, Pinterest inspiration): pose_ref_id is resolved SERVER-SIDE via
//   pose_refs → style_pins.image_url / base_photos (ownership-checked, fail
//   closed 400 pose_ref_not_found on unknown/other-user/dismissed rows — the
//   client never supplies pose image bytes or URLs). pose_mode 'keep'
//   (default) leaves the pipeline prompt byte-identical; 'adapt' records
//   { pose_mode, pose_ref_id, pose_image_url } in garment_refs.meta AND the
//   renders.pose_mode/pose_ref_id columns for the AI crew's prompt consumer
//   (adapt rendering itself is AI-crew turf — this fn only resolves + records).
//   Pose participates in the idempotency key (via promptHash) so keep/adapt
//   renders never collide; default keep-without-ref keeps legacy keys stable.
// TRANSITION ALIASES (accepted, mapped to canonical — remove after the client
// migration lands): outfitId, basePhotoId, basePhotoUrl, garmentRefs,
// garment_ids / garmentIds (string[]), renderId, idempotencyKey.
//   → 202 { render_id, status, cached, model?, output_url?, cost_usd?,
//           fallback_eligible?, error_code?, idempotency_key }
// STATUS POLL (gemini-client getRenderStatus/pollRender — always POST):
//   POST / { action: 'status', render_id } → 200 same shape (cost_usd resolved
//   from the ledger render_cost memo once done; null until then).
// RESTYLE VIA THIS FN: mode 'restyle' + { render_id, note, ...restyle fields }
//   routes to the SAME core as POST /restyle (../_shared/restyle.ts) —
//   identical caps (3/session), cost (1 credit), and idempotency. Previously
//   rejected with mode_invalid (P0-3); now accepted.
// PROVIDER ORDER (founder law): Gemini flash → pro → FASHN; max tier leads
// with pro (HD-pack fidelity), flash still precedes FASHN. Client model_hint
// is recorded in render meta for analytics but NEVER reorders the chain.
// POST /?process=1  (Inngest worker, HMAC-verified) { render_id } → runs ONE
//   provider attempt; throws (HTTP 500) so Inngest retries the next provider.
// GET /?sync=1&render_id= (ALLOW_SYNC_RENDER=true only) — local dev fallback.
// Tiers: std default everywhere incl. free. max = HD packs only (402
// hd_requires_pack otherwise). compare = ONE Max render, tiled single image.

import { admin, requireUser, supabaseUrl } from "../_shared/auth.ts";
import { badRequest, getIdempotencyKey, handleOptions, HttpError, json, paymentRequired, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { buildRenderKey, findRenderByKey, isReusableRow, type RenderRow } from "../_shared/idempotency.ts";
import { renderCostUsd } from "../_shared/ledger.ts";
import {
  enqueueRender,
  processRender,
  verifyInngestSignature,
  type PipelineTier,
} from "../_shared/pipeline.ts";
import { parsePoseMode, resolvePoseRef } from "../_shared/pinterest.ts";
import { consumeAllowance, getEntitlementState, refundAllowance, todayISO, type PoolCode } from "../_shared/quota.ts";
import { requestRestyle } from "../_shared/restyle.ts";
import { signedRenderUrl } from "../_shared/storage.ts";

type LooseBody = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const firstStr = (...vs: unknown[]): string | null => {
  for (const v of vs) {
    const s = str(v);
    if (s) return s;
  }
  return null;
};

interface GarmentRefObject {
  garmentId?: unknown;
  garment_id?: unknown;
  id?: unknown;
  imageUrl?: unknown;
  image_url?: unknown;
  url?: unknown;
  category?: unknown;
}

/** Normalize every accepted garment shape to owned garment IDs. */
async function resolveGarmentIds(
  sb: ReturnType<typeof admin>,
  userId: string,
  body: LooseBody,
): Promise<{ outfitId: string | null; garmentIds: string[] }> {
  const outfitId = firstStr(body.outfit_id, body.outfitId);
  if (outfitId) {
    const { data, error } = await sb.from("outfits").select("garment_ids").eq("id", outfitId)
      .eq("user_id", userId).maybeSingle<{ garment_ids: string[] }>();
    if (error || !data) throw badRequest("outfit_not_found", "Outfit not found");
    return { outfitId, garmentIds: data.garment_ids ?? [] };
  }

  const raw = body.garment_refs ?? body.garmentRefs ?? body.garment_ids ?? body.garmentIds ?? null;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const ids: string[] = [];
  const urls: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.length > 0) {
      ids.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const o = entry as GarmentRefObject;
      const id = firstStr(o.garmentId, o.garment_id, o.id);
      if (id) {
        ids.push(id);
        continue;
      }
      const url = firstStr(o.imageUrl, o.image_url, o.url);
      if (url) urls.push(url);
    }
  }

  // URL-only refs (gemini-client shape without IDs): match against the
  // caller's own garments by stored image/cutout URL. Unmatched URLs fail
  // closed — we never render someone else's (or a nonexistent) garment.
  if (urls.length > 0) {
    const { data, error } = await sb.from("garments")
      .select("id,image_url,cutout_url").eq("user_id", userId).is("deleted_at", null);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; image_url: string | null; cutout_url: string | null }>;
    const byUrl = new Map<string, string>();
    for (const g of rows) {
      if (g.image_url) byUrl.set(g.image_url, g.id);
      if (g.cutout_url) byUrl.set(g.cutout_url, g.id);
    }
    for (const u of urls) {
      const hit = byUrl.get(u);
      if (!hit) throw badRequest("garment_not_found", "A garment URL doesn't match your closet — sync the closet and retry");
      ids.push(hit);
    }
  }

  const unique = [...new Set(ids)];
  if (unique.length === 0) throw badRequest("garments_required", "Provide outfit_id or garment_ids / garment_refs");
  if (unique.length > 6) throw badRequest("too_many_garments", "Max 6 garments per render");
  const { data, error } = await sb.from("garments").select("id").eq("user_id", userId)
    .in("id", unique).is("deleted_at", null);
  if (error) throw error;
  if ((data ?? []).length !== unique.length) {
    throw badRequest("garment_not_found", "An item is missing or removed");
  }
  return { outfitId: null, garmentIds: unique };
}

const INGEST_MAX_BYTES = 8 * 1024 * 1024;
// Base-photo ingest HEAD/download budget (was referenced but never defined —
// every ingest 500'd at runtime).
const INGEST_TIMEOUT_MS = 10_000;

/**
 * base_photo_url without an ID: accepts ONLY this project's own private
 * `base` bucket URLs (SSRF guard — the edge must never become a fetch proxy
 * for arbitrary or internal hosts). The bytes are already durable in storage,
 * so this verifies existence/size and registers the base_photos row under
 * the caller's own prefix. Becomes the active base only when the user has none.
 */
async function ingestBasePhotoUrl(
  sb: ReturnType<typeof admin>,
  userId: string,
  url: string,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("base_url_invalid", "base_photo_url is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw badRequest("base_url_invalid", "base_photo_url must be https");
  }
  const projectHost = (() => {
    try {
      return new URL(supabaseUrl()).host;
    } catch {
      return "";
    }
  })();
  const m = /^\/storage\/v1\/object\/(?:authenticated\/|sign\/[^/]+\/)?base\/(.+)$/.exec(
    parsed.pathname,
  );
  if (!projectHost || parsed.host !== projectHost || !m) {
    throw badRequest("base_url_invalid", "base_photo_url must be a VAI storage URL");
  }
  const objectPath = decodeURIComponent(m[1]!);
  if (!objectPath.startsWith(`${userId}/`)) {
    throw badRequest("base_url_forbidden", "base_photo_url must live under your own storage prefix");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INGEST_TIMEOUT_MS);
  try {
    const { data: blob, error: dlErr } = await sb.storage.from("base").download(objectPath);
    if (dlErr || !blob) throw badRequest("base_url_unfetchable", "base_photo_url does not resolve to a stored photo");
    if (blob.size > INGEST_MAX_BYTES) throw badRequest("base_url_too_large", "Base photo exceeds 8MB");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw badRequest("base_url_unfetchable", "Base photo check timed out");
    }
    throw badRequest("base_url_unfetchable", "base_photo_url does not resolve to a stored photo");
  } finally {
    clearTimeout(timer);
  }

  const { data: active } = await sb.from("base_photos").select("id").eq("user_id", userId)
    .eq("is_active", true).limit(1).maybeSingle<{ id: string }>();
  const { data: row, error: insErr } = await sb.from("base_photos").insert({
    user_id: userId,
    url: objectPath,
    is_active: !active,
  }).select("id").single<{ id: string }>();
  if (insErr || !row) throw badRequest("base_ingest_failed", "Could not register base photo");
  return row.id;
}

async function resolveBasePhotoId(
  sb: ReturnType<typeof admin>,
  userId: string,
  body: LooseBody,
): Promise<string> {
  const id = firstStr(body.base_photo_id, body.basePhotoId);
  if (id) {
    const { data: bp } = await sb.from("base_photos").select("id").eq("id", id)
      .eq("user_id", userId).maybeSingle();
    if (!bp) throw badRequest("base_not_found", "Base photo not found — retake your selfie");
    return id;
  }
  const url = firstStr(body.base_photo_url, body.basePhotoUrl);
  if (url) return await ingestBasePhotoUrl(sb, userId, url);
  const { data: active } = await sb.from("base_photos").select("id").eq("user_id", userId)
    .eq("is_active", true).limit(1).maybeSingle<{ id: string }>();
  if (!active) throw badRequest("base_missing", "Take your mirror selfie first");
  return active.id;
}

/** Canonical status payload (CONTRACT render-tryon response). */
async function statusPayload(
  sb: ReturnType<typeof admin>,
  row: RenderRow,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    render_id: row.id,
    status: row.status,
    cached: false,
  };
  if (row.provider) out.model = row.provider;
  // output_url is minted fresh per response (1h signed URL, 0008) — the DB
  // stores only the private bucket path.
  const outputUrl = row.output_path
    ? await signedRenderUrl(sb, row.user_id, row.output_path)
    : row.output_url; // legacy row predating 0008
  if (outputUrl) out.output_url = outputUrl;
  if (row.status === "done") {
    const cost = await renderCostUsd(sb, row.id);
    if (cost !== null) out.cost_usd = cost;
  }
  if (row.status === "failed") out.error_code = "render_failed";
  return out;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const url = new URL(req.url);

    // ---------------------------------------------------------- worker path
    if (url.searchParams.get("process") === "1") {
      requireMethod(req, "POST");
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
      const renderId = (parsed as { render_id?: unknown }).render_id;
      if (typeof renderId !== "string" || !renderId) {
        throw badRequest("render_required", "render_id required");
      }
      await processRender(admin(), renderId); // throws → Inngest retries
      return json({ processed: renderId });
    }

    // ---------------------------------------------------------- sync dev path
    if (url.searchParams.get("sync") === "1") {
      requireMethod(req, "POST");
      if (Deno.env.get("ALLOW_SYNC_RENDER") !== "true") {
        throw badRequest("sync_disabled", "Sync renders are dev-only");
      }
      const user = await requireUser(req);
      const body = await readJson<{ render_id?: string; renderId?: string }>(req);
      const rid = body.render_id ?? body.renderId;
      if (!rid) throw badRequest("render_required", "render_id required");
      const sb = admin();
      const { data: own } = await sb.from("renders").select("id").eq("id", rid)
        .eq("user_id", user.id).maybeSingle();
      if (!own) throw badRequest("render_not_found", "Render not found");
      for (let i = 0; i < 3; i++) {
        try {
          await processRender(sb, rid);
          break;
        } catch (e) {
          if (i === 2) throw e;
        }
      }
      const { data: done } = await sb.from("renders")
        .select("id,user_id,status,output_url,output_path,error").eq("id", rid).single<{
          id: string;
          user_id: string;
          status: string;
          output_url: string | null;
          output_path: string | null;
          error: string | null;
        }>();
      if (done) {
        done.output_url = done.output_path
          ? await signedRenderUrl(sb, done.user_id, done.output_path)
          : done.output_url;
        delete (done as Record<string, unknown>).output_path;
        delete (done as Record<string, unknown>).user_id;
      }
      return json(done);
    }

    // ---------------------------------------------------------- enqueue path
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<LooseBody>(req);
    const sb = admin();

    // Status poll (gemini-client getRenderStatus/pollRender): ownership-checked
    // read, no quota touch. Accepts render_id (canonical) + renderId (alias).
    if (body.action === "status") {
      const rid = firstStr(body.render_id, body.renderId);
      if (!rid) throw badRequest("render_required", "render_id required");
      const { data: row } = await sb.from("renders").select(
        "id,user_id,status,output_url,output_path,provider,mode,tier,idempotency_key,attempts,created_at",
      ).eq("id", rid).eq("user_id", user.id).maybeSingle<RenderRow>();
      if (!row) throw badRequest("render_not_found", "Render not found");
      return json(await statusPayload(sb, row));
    }

    // Batch read: latest DONE render per outfit (Today hero + week strip).
    // POST { action: 'outfit-status', outfit_ids: [..] (max 10) }
    // -> { renders: { [outfit_id]: { render_id, output_url, created_at } } }
    if (body.action === "outfit-status") {
      const rawIds = Array.isArray(body.outfit_ids) ? body.outfit_ids : [];
      const ids = [...new Set(rawIds.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 10);
      if (ids.length === 0) return json({ renders: {} });
      const { data: rows } = await sb.from("renders").select(
        "id,outfit_id,status,output_url,output_path,created_at",
      ).eq("user_id", user.id).eq("status", "done").in("outfit_id", ids)
        .order("created_at", { ascending: false });
      const out: Record<string, { render_id: string; output_url: string; created_at: string }> = {};
      for (const r of (rows ?? []) as Array<{
        id: string; outfit_id: string | null; status: string;
        output_url: string | null; output_path: string | null; created_at: string;
      }>) {
        if (!r.outfit_id || out[r.outfit_id]) continue; // first = newest
        const url = r.output_path ? await signedRenderUrl(sb, user.id, r.output_path) : r.output_url;
        if (url) out[r.outfit_id] = { render_id: r.id, output_url: url, created_at: r.created_at };
      }
      return json({ renders: out });
    }

    const mode = str(body.mode) ?? "tryon";

    // Pose (0005): validated + resolved BEFORE any money moves. Fail closed.
    const poseMode = parsePoseMode(body.pose_mode ?? body.poseMode);
    const poseRefId = firstStr(body.pose_ref_id, body.poseRefId, body.pose_ref);
    const poseRef = poseRefId ? await resolvePoseRef(sb, user.id, poseRefId) : null;

    // Restyle THROUGH render-tryon: same core, caps, and cost as POST /restyle.
    if (mode === "restyle") {
      const outcome = await requestRestyle(sb, user.id, {
        renderId: firstStr(body.render_id, body.renderId) ?? "",
        note: str(body.note) ?? "",
        rewrittenPrompt: str(body.rewritten_prompt),
        promptTags: Array.isArray(body.prompt_tags)
          ? (body.prompt_tags as unknown[]).filter((t): t is string => typeof t === "string")
          : undefined,
        photoConditions: body.photo_conditions !== null && typeof body.photo_conditions === "object"
          ? body.photo_conditions as Record<string, unknown>
          : undefined,
        tierHint: str(body.tier),
        modelHint: str(body.model_hint),
        idempotencyKey: getIdempotencyKey(req, body),
        poseMode,
        poseRefId: poseRef?.poseRefId ?? null,
        poseImageUrl: poseRef?.imageUrl,
      });
      return json(outcome, 202);
    }

    if (mode !== "tryon" && mode !== "compare") {
      throw badRequest("mode_invalid", "mode must be tryon|restyle|compare");
    }
    // Compare = ONE Max render, single tiled image (never 3 renders).
    let tier = (str(body.tier) ?? "std") as PipelineTier;
    if (mode === "compare") tier = "max";
    if (tier !== "std" && tier !== "max") throw badRequest("tier_invalid", "tier must be std|max");

    const { outfitId, garmentIds } = await resolveGarmentIds(sb, user.id, body);

    // Base photo must exist (explicit id, ingested URL, or active) before money.
    const basePhotoId = await resolveBasePhotoId(sb, user.id, body);

    // Idempotency FIRST: identical re-request = cached URL, 0 cost.
    // Pose participates via promptHash so keep/adapt never collide; the
    // default (keep, no ref) omits it so legacy keys stay stable.
    const dayRaw = str(body.day);
    const day = dayRaw && /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : todayISO();
    const clientKey = getIdempotencyKey(req, body);
    const key = clientKey ?? await buildRenderKey({
      userId: user.id,
      basePhotoId,
      outfitId,
      garmentIds,
      day,
      mode,
      tier,
      ...(poseRef || poseMode !== "keep"
        ? { promptHash: `${poseMode}:${poseRef?.poseRefId ?? ""}` }
        : {}),
    });
    const existing = await findRenderByKey(sb, user.id, key);
    if (existing && isReusableRow(existing)) {
      return json({
        ...(await statusPayload(sb, existing)),
        idempotency_key: key,
        cached: true,
      }, 200);
    }

    // Quota SECOND: atomic consume; throws 402 with paywall payload.
    const kind = tier === "max" ? "max" : "std";
    let pool: PoolCode;
    try {
      pool = await consumeAllowance(sb, user.id, kind);
    } catch (e) {
      // Surface remaining quota alongside the 402 for the QuotaBadge.
      const ent = await getEntitlementState(sb, user.id);
      throw paymentRequired(
        (e as { code?: string }).code === "hd_requires_pack" ? "hd_requires_pack" : "quota_exhausted",
        (e as Error).message,
        { renders_left: ent.rendersLeft, std_credits: ent.stdCredits, hd_credits: ent.hdCredits },
      );
    }

    // Client hints are recorded in render meta for analytics/cost attribution.
    // They NEVER reorder the server-owned provider chain (see pipeline.ts).
    const metaExtra: Record<string, unknown> = { day };
    const resolution = str(body.resolution);
    if (resolution) metaExtra.resolution = resolution.slice(0, 8);
    const modelHint = str(body.model_hint);
    if (modelHint) metaExtra.model_hint = modelHint.slice(0, 64);
    const fallbackOf = str(body.fallback_of);
    if (fallbackOf) metaExtra.fallback_of = fallbackOf.slice(0, 128);
    // Pose record (0005): keep path leaves the pipeline prompt untouched; the
    // adapt consumer (AI crew) reads garment_refs.meta.pose_* server-side.
    metaExtra.pose_mode = poseMode;
    if (poseRef) {
      metaExtra.pose_ref_id = poseRef.poseRefId;
      if (poseRef.imageUrl) metaExtra.pose_image_url = poseRef.imageUrl;
    }

    let row: { id: string; status: string };
    try {
      row = await enqueueRender(sb, {
        userId: user.id,
        outfitId,
        basePhotoId,
        garmentIds,
        mode: mode as "tryon" | "compare",
        tier,
        idempotencyKey: key,
        note: str(body.note),
        pool,
        metaExtra,
        poseMode,
        poseRefId: poseRef?.poseRefId ?? null,
      });
      // RENDER_INLINE (dev / pre-Inngest): run the provider chain in this
      // request and return the finished render instead of a 202 queued stub.
      if (Deno.env.get("RENDER_INLINE") === "true") {
        await processRender(sb, row.id);
        const done = await findRenderByKey(sb, user.id, key);
        if (!done) throw new HttpError(500, "render_missing", "Render row disappeared mid-process.");
        return json({
          ...(await statusPayload(sb, done)),
          idempotency_key: key,
        }, done.status === "done" ? 200 : 500);
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e;
      // The renders.idempotency_key UNIQUE constraint is GLOBAL, while the
      // lookup above is user-scoped: we lost either a same-user enqueue race
      // (adopt the winner, 0 net spend) or a cross-user actor pre-registered
      // this client-supplied key (never let the victim pay — refund).
      await refundAllowance(sb, user.id, pool);
      const winner = await findRenderByKey(sb, user.id, key);
      if (winner && isReusableRow(winner)) {
        return json({
          ...(await statusPayload(sb, winner)),
          idempotency_key: key,
          cached: true,
        }, 200);
      }
      throw new HttpError(
        409,
        "idempotency_conflict",
        "This render key is already in use — the request was not charged.",
      );
    }

    return json({
      render_id: row.id,
      status: "queued",
      cached: false,
      fallback_eligible: true,
      idempotency_key: key,
    }, 202);
  } catch (e) {
    return toErrorResponse(e);
  }
});
