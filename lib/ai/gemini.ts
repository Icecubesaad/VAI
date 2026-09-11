/**
 * VAI · Gemini image pipeline client (integrations turf).
 *
 * PRIMARY (verified Sep 2026): `gemini-3.1-flash-image` (Nano Banana 2,
 * Feb-2026 stable, ~$0.067/image, 0.5K/1K/2K/4K).
 * FALLBACK 1: `gemini-3-pro-image` (higher fidelity, higher cost).
 * FALLBACK 2 (only): FASHN API — server-side, per README stack table.
 *
 * NOTE vs BUILD-PACK §1/§5: the pack names FASHN primary / nano-banana
 * fallback. The Sep-2026 verified stack (README + brief) reverses that:
 * Gemini Flash Image is primary. This client implements Gemini-primary.
 * The backend `render-tryon` edge fn MUST match this order.
 *
 * SECRETS: GEMINI_API_KEY lives ONLY in Supabase Edge Function secrets.
 * This module NEVER reads it, NEVER accepts it as a param, and refuses to
 * run if a public GEMINI key is detected (misconfiguration guard below).
 * All image generation routes via the `render-tryon` / `restyle` edge fns.
 */

import { callEdgeFunction, generateIdempotencyKey } from '../edge';
import type { EdgeCallOptions } from '../edge';

export const PRIMARY_IMAGE_MODEL = 'gemini-3.1-flash-image' as const;
export const FALLBACK_IMAGE_MODEL = 'gemini-3-pro-image' as const;
export const LEGACY_FALLBACK = 'fashn' as const;

export type ImageModel =
  | typeof PRIMARY_IMAGE_MODEL
  | typeof FALLBACK_IMAGE_MODEL
  | typeof LEGACY_FALLBACK;

/** std = default queue everywhere incl. free. max = premium/compare/hero only. */
export type RenderTier = 'std' | 'max';
export type ImageResolution = '0.5K' | '1K' | '2K' | '4K';
export type RenderMode = 'tryon' | 'restyle' | 'compare';

const TIER_DEFAULT_RESOLUTION: Record<RenderTier, ImageResolution> = {
  std: '1K',
  max: '2K',
};

/**
 * Per-call cost accounting (USD), client-side ESTIMATES for pre-flight UI.
 * - flash-image std $0.067: VERIFIED Sep 2026 (server GEMINI_STD_COST_USD).
 * - flash-image max $0.134: estimate (2K ≈ 2× pixels) — server reports actual.
 * - restyle ~$0.068: std render + prompt-rewrite overhead — server reports actual.
 * - pro-image std $0.15 / max $0.30: conservative estimates; server reports actual.
 * - fashn legacy-fallback (server-side chain only, never routed from here):
 *   std $0.075 / max $0.38, matching server FASHN_STD/MAX_COST_USD.
 * - cached re-requests and failed predictions cost $0 (CACHED_COST_USD /
 *   FAILED_COST_USD) — only `done` decrements quota/ledger.
 * The edge fn returns authoritative `cost_usd` per call — ALWAYS prefer it
 * for ledger/analytics over this table.
 */
export const GEMINI_IMAGE_COST_USD: Record<ImageModel, Record<RenderTier, number>> = {
  [PRIMARY_IMAGE_MODEL]: { std: 0.067, max: 0.134 },
  [FALLBACK_IMAGE_MODEL]: { std: 0.15, max: 0.3 },
  [LEGACY_FALLBACK]: { std: 0.075, max: 0.38 },
};

/** Restyle pre-flight estimate (std render + prompt rewrite). Display only. */
export const RESTYLE_COST_USD = 0.068;
/** Identical re-request (same sha256 key) serves the cached URL: $0 marginal. */
export const CACHED_COST_USD = 0;
/** Failed/errored predictions are refunded and never hit the ledger: $0. */
export const FAILED_COST_USD = 0;

export function estimateCostUsd(model: ImageModel, tier: RenderTier): number {
  return GEMINI_IMAGE_COST_USD[model][tier];
}

// ---------------------------------------------------------------- types

export interface GarmentRef {
  garmentId?: string;
  imageUrl: string;
  category?: string;
}

export interface TryOnParams {
  userId: string;
  basePhotoId?: string;
  basePhotoUrl?: string;
  garments: GarmentRef[];
  tier?: RenderTier;
  resolution?: ImageResolution;
  outfitId?: string;
  /** Day bucket YYYY-MM-DD for the §5 idempotency form. Defaults to today. */
  day?: string;
  /** Override; otherwise sha256(user|base|outfit|day) per §5. */
  idempotencyKey?: string;
  /** Set false to disable automatic pro-image fallback (tests). Default true. */
  allowFallback?: boolean;
}

export type RenderStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface TryOnResult {
  renderId: string;
  status: RenderStatus;
  /** True when the server returned a cached render (0 marginal cost). */
  cached: boolean;
  model: ImageModel;
  tier: RenderTier;
  resolution: ImageResolution;
  /** Authoritative server-reported cost (0 for cached / failed-free). */
  costUsd: number;
  /** Pre-flight estimate from GEMINI_IMAGE_COST_USD (display only). */
  estimatedCostUsd: number;
  outputUrl?: string;
  idempotencyKey: string;
  attempts: number;
}

export type PriorFailTag =
  | 'face-drift'
  | 'hands-artifact'
  | 'garment-crop'
  | 'color-shift'
  | 'bg-bleed'
  | 'pose-shift';

export interface PhotoConditions {
  lighting?: string;
  background?: string;
  pose?: string;
  priorFailTags?: PriorFailTag[];
}

export const MAX_RESTYLES_PER_SESSION = 3;

/** Non-negotiable preservation directives appended to every restyle prompt. */
export const FACE_POSE_DIRECTIVES =
  'Preserve the person\'s face identity, facial features, skin tone, and expression exactly. ' +
  'Preserve body pose, camera angle, framing, and background. ' +
  'Change ONLY the garments described below; do not beautify, slim, age-shift, or re-light the person.';

const PRIOR_FAIL_MITIGATIONS: Record<PriorFailTag, string> = {
  'face-drift': 'Anchor on the reference face landmarks; zero identity drift allowed.',
  'hands-artifact': 'Render hands behind the garment or out of frame rather than deformed.',
  'garment-crop': 'Keep every garment fully inside the frame with clean hems and edges.',
  'color-shift': 'Match garment colors exactly to the reference swatches; no recoloring.',
  'bg-bleed': 'Keep the original background pixels untouched outside the garment mask.',
  'pose-shift': 'Lock the skeleton to the base photo; do not change stance or limb angles.',
};

export interface RestyleParams {
  userId: string;
  renderId: string;
  note: string;
  photoConditions?: PhotoConditions;
  /** Restyles already used in this session (pack §4: max 3/session). */
  sessionRestyleCount: number;
  tier?: RenderTier;
  idempotencyKey?: string;
}

export interface RestyleResult extends TryOnResult {
  rewrittenPrompt: string;
}

export class RestyleLimitError extends Error {
  readonly code = 'restyle-limit';
  constructor() {
    super(`Max ${MAX_RESTYLES_PER_SESSION} restyles per session. Keep the best render.`);
    this.name = 'RestyleLimitError';
  }
}

export class GeminiConfigError extends Error {
  readonly code = 'gemini-misconfigured';
  constructor() {
    super('GEMINI_API_KEY must never be exposed client-side. Remove any EXPO_PUBLIC_GEMINI_* var; all calls route via Supabase edge functions.');
    this.name = 'GeminiConfigError';
  }
}

/** Fail fast if someone accidentally publishes the server key to the client. */
export function assertNoClientGeminiKey(): void {
  if (process.env['EXPO_PUBLIC_GEMINI_API_KEY']) {
    if (__DEV__) console.error('[gemini] EXPO_PUBLIC_GEMINI_API_KEY is set — refusing to run.');
    throw new GeminiConfigError();
  }
}

// ------------------------------------------------------- prompt builder

export interface RewrittenPrompt {
  prompt: string;
  tags: string[];
}

/**
 * Prompt-rewrite builder for the `restyle` edge fn (pack §4): appends
 * base-photo conditions (lighting/bg/pose), prior-fail mitigations, and the
 * face/pose preservation directives. Pure + unit-testable; the server may
 * reuse the same algorithm — contract pins the output shape.
 */
export function buildRestylePrompt(note: string, conditions: PhotoConditions = {}): RewrittenPrompt {
  const cleaned = note.trim().replace(/\s+/g, ' ');
  const tags: string[] = [];
  const parts: string[] = [`Restyle request: ${cleaned}.`];
  if (conditions.lighting) {
    tags.push(`lighting:${conditions.lighting}`);
    parts.push(`Match the base photo lighting (${conditions.lighting}).`);
  }
  if (conditions.background) {
    tags.push(`bg:${conditions.background}`);
    parts.push(`Keep the base photo background (${conditions.background}).`);
  }
  if (conditions.pose) {
    tags.push(`pose:${conditions.pose}`);
    parts.push(`Keep the base photo pose (${conditions.pose}).`);
  }
  for (const tag of conditions.priorFailTags ?? []) {
    tags.push(`prior-fail:${tag}`);
    parts.push(PRIOR_FAIL_MITIGATIONS[tag]);
  }
  parts.push(FACE_POSE_DIRECTIVES);
  return { prompt: parts.join(' '), tags };
}

// ------------------------------------------------------- edge payloads

interface RenderTryonResponse {
  render_id: string;
  status: RenderStatus;
  cached?: boolean;
  model?: string;
  output_url?: string;
  /** Authoritative cost; absent until the render completes. */
  cost_usd?: number;
  fallback_eligible?: boolean;
  error_code?: string;
}

interface RestyleResponse extends RenderTryonResponse {
  rewritten_prompt?: string;
}

function toImageModel(raw: string | undefined, fallback: ImageModel): ImageModel {
  if (raw === PRIMARY_IMAGE_MODEL || raw === FALLBACK_IMAGE_MODEL || raw === LEGACY_FALLBACK) return raw;
  return fallback;
}

function todayDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------- public API

/**
 * Queue a virtual try-on via the `render-tryon` edge fn (async queue — the
 * server returns a renderId fast; completion arrives via push + poll).
 * Retries once on std timeout (pack §5); auto-falls-back to pro-image once
 * when the server marks the failure fallback-eligible.
 */
export async function tryon(
  params: TryOnParams,
  edgeOpts: EdgeCallOptions = {},
): Promise<TryOnResult> {
  assertNoClientGeminiKey();
  if (params.garments.length === 0) throw new Error('tryon requires at least one garment reference.');
  const tier = params.tier ?? 'std';
  const resolution = params.resolution ?? TIER_DEFAULT_RESOLUTION[tier];
  const baseKey = params.basePhotoId ?? params.basePhotoUrl;
  if (!baseKey) throw new Error('tryon requires basePhotoId or basePhotoUrl.');
  const day = params.day ?? todayDay();
  const idempotencyKey =
    params.idempotencyKey ??
    (await generateIdempotencyKey([
      params.userId,
      baseKey,
      params.outfitId ?? params.garments.map((g) => g.garmentId ?? g.imageUrl).join(','),
      day,
    ]));

  const baseBody = {
    base_photo_id: params.basePhotoId,
    base_photo_url: params.basePhotoUrl,
    garment_refs: params.garments,
    mode: 'tryon' as RenderMode,
    tier,
    resolution,
    model_hint: PRIMARY_IMAGE_MODEL,
    outfit_id: params.outfitId,
    day,
  };

  // Attempt 1: primary model.
  try {
    const res = await callEdgeFunction<RenderTryonResponse>('render-tryon', baseBody, {
      timeoutMs: 30_000,
      retries: tier === 'std' ? 1 : 0,
      ...edgeOpts,
      idempotencyKey,
    });
    return toTryOnResult(res, { tier, resolution, idempotencyKey, attempts: 1, fallback: PRIMARY_IMAGE_MODEL });
  } catch (firstErr) {
    const eligible =
      params.allowFallback !== false &&
      isFallbackEligible(firstErr);
    if (!eligible) throw firstErr;
    // Attempt 2 (once): pro-image fallback, same idempotency scope + suffix so
    // the server can distinguish the fallback render while still deduping it.
    const fallbackKey = `${idempotencyKey}:pro`;
    const res = await callEdgeFunction<RenderTryonResponse>(
      'render-tryon',
      { ...baseBody, model_hint: FALLBACK_IMAGE_MODEL, fallback_of: idempotencyKey },
      { timeoutMs: 30_000, retries: 0, ...edgeOpts, idempotencyKey: fallbackKey },
    );
    return toTryOnResult(res, { tier, resolution, idempotencyKey: fallbackKey, attempts: 2, fallback: FALLBACK_IMAGE_MODEL });
  }
}

function isFallbackEligible(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    // Upstream generation failures are worth one pro-image attempt; auth,
    // quota, and validation errors are not.
    return code === 'upstream-failed' || code === 'upstream-timeout' || code === 'timeout';
  }
  return false;
}

function toTryOnResult(
  res: RenderTryonResponse,
  ctx: { tier: RenderTier; resolution: ImageResolution; idempotencyKey: string; attempts: number; fallback: ImageModel },
): TryOnResult {
  const model = toImageModel(res.model, ctx.fallback);
  // costUsd is 0 until the server reports authoritative cost_usd (queued /
  // cached / failed-free). Resolved at completion via getRenderStatus/push —
  // analytics MUST use that value, never estimatedCostUsd.
  const result: TryOnResult = {
    renderId: res.render_id,
    status: res.status,
    cached: res.cached === true,
    model,
    tier: ctx.tier,
    resolution: ctx.resolution,
    costUsd: typeof res.cost_usd === 'number' ? res.cost_usd : 0,
    estimatedCostUsd: estimateCostUsd(model, ctx.tier),
    idempotencyKey: ctx.idempotencyKey,
    attempts: ctx.attempts,
  };
  if (res.output_url !== undefined) result.outputUrl = res.output_url;
  return result;
}

/**
 * Request a restyle of an existing render via the `restyle` edge fn.
 * Enforces the §4 max-3/session cap client-side (server enforces too).
 */
export async function restyle(
  params: RestyleParams,
  edgeOpts: EdgeCallOptions = {},
): Promise<RestyleResult> {
  assertNoClientGeminiKey();
  if (params.sessionRestyleCount >= MAX_RESTYLES_PER_SESSION) throw new RestyleLimitError();
  if (!params.note.trim()) throw new Error('restyle requires a non-empty note.');
  const tier = params.tier ?? 'std';
  const { prompt, tags } = buildRestylePrompt(params.note, params.photoConditions ?? {});
  const idempotencyKey =
    params.idempotencyKey ??
    (await generateIdempotencyKey([params.userId, params.renderId, prompt]));
  const res = await callEdgeFunction<RestyleResponse>(
    'restyle',
    {
      render_id: params.renderId,
      note: params.note.trim(),
      rewritten_prompt: prompt,
      prompt_tags: tags,
      photo_conditions: params.photoConditions ?? {},
      tier,
      model_hint: PRIMARY_IMAGE_MODEL,
    },
    { timeoutMs: 30_000, retries: 0, ...edgeOpts, idempotencyKey },
  );
  const base = toTryOnResult(res, {
    tier,
    resolution: TIER_DEFAULT_RESOLUTION[tier],
    idempotencyKey,
    attempts: 1,
    fallback: PRIMARY_IMAGE_MODEL,
  });
  return { ...base, rewrittenPrompt: res.rewritten_prompt ?? prompt };
}

/** Fetch current render status (server is source of truth; push is primary). */
export async function getRenderStatus(
  renderId: string,
  edgeOpts: EdgeCallOptions = {},
): Promise<{ renderId: string; status: RenderStatus; outputUrl?: string; costUsd: number }> {
  const res = await callEdgeFunction<RenderTryonResponse>(
    'render-tryon',
    { action: 'status', render_id: renderId },
    { timeoutMs: 15_000, retries: 2, ...edgeOpts },
  );
  const out: { renderId: string; status: RenderStatus; outputUrl?: string; costUsd: number } = {
    renderId: res.render_id,
    status: res.status,
    costUsd: typeof res.cost_usd === 'number' ? res.cost_usd : 0,
  };
  if (res.output_url !== undefined) out.outputUrl = res.output_url;
  return out;
}

export interface PollOptions extends EdgeCallOptions {
  /** Total budget. Default 90_000 (pack §5 server timeout). */
  timeoutMs?: number;
  startIntervalMs?: number;
  maxIntervalMs?: number;
}

/**
 * Convenience poller for foreground waits (push "Try-on ready" remains the
 * primary completion path — renders take 10–55s IRL, never show countdowns).
 */
export async function pollRender(
  renderId: string,
  opts: PollOptions = {},
): Promise<{ renderId: string; status: RenderStatus; outputUrl?: string; costUsd: number }> {
  const budgetMs = opts.timeoutMs ?? 90_000;
  let interval = opts.startIntervalMs ?? 2_000;
  const maxInterval = opts.maxIntervalMs ?? 8_000;
  const deadline = Date.now() + budgetMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = await getRenderStatus(renderId, opts);
    if (s.status === 'done' || s.status === 'failed') return s;
    if (Date.now() + interval > deadline) {
      throw new Error(`Render ${renderId} still ${s.status} after ${budgetMs}ms — rely on push "Try-on ready".`);
    }
    const { sleep: sleepFn } = await import('../edge');
    await sleepFn(interval);
    interval = Math.min(maxInterval, interval * 1.5);
  }
}
