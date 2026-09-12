/**
 * VAI · auto-tag client (integrations turf).
 *
 * Execution is server-side (`auto-tag` edge fn: bg-remove → Gemini Flash
 * vision, temp 0, strict JSON → cutout_url + 512-d CLIP embedding for
 * pgvector). This module owns the JSON schema contract, the vision prompt,
 * the invalid-JSON salvage/repair fallback, and the CLIP-embedding hook
 * (client-side cosine similarity for owned-complement matching).
 *
 * DB enums mirrored from BUILD-PACK §3 — keep in sync with the migration:
 * garment_cat(top,bottom,dress,outerwear,shoes,bag,accessory,onepiece,active),
 * season(ss,fw,all).
 */

import { callEdgeFunction, generateIdempotencyKey } from '../edge';
import type { EdgeCallOptions } from '../edge';

export const GARMENT_CATEGORIES = [
  'top',
  'bottom',
  'dress',
  'outerwear',
  'shoes',
  'bag',
  'accessory',
  'onepiece',
  'active',
] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

export const GARMENT_SEASONS = ['ss', 'fw', 'all'] as const;
export type GarmentSeason = (typeof GARMENT_SEASONS)[number];

/** Canonical auto-tag JSON schema (contract with the `auto-tag` edge fn). */
export interface GarmentTag {
  category: GarmentCategory;
  subcat?: string;
  colors: string[];
  fabric?: string;
  /** 1 (loungewear) – 5 (black tie). */
  formality: number;
  seasons: GarmentSeason[];
  brand?: string;
  cutoutUrl?: string;
}

export interface TagValidationIssue {
  field: string;
  message: string;
}

/** Hand-rolled strict validator (no zod dep — keeps install surface small). */
export function validateGarmentTag(raw: unknown): { ok: true; tag: GarmentTag } | { ok: false; issues: TagValidationIssue[] } {
  const issues: TagValidationIssue[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: '$', message: 'Tag must be a JSON object.' }] };
  }
  const o = raw as Record<string, unknown>;
  const category = o['category'];
  if (typeof category !== 'string' || !(GARMENT_CATEGORIES as readonly string[]).includes(category)) {
    issues.push({ field: 'category', message: `Must be one of ${GARMENT_CATEGORIES.join(', ')}.` });
  }
  const colors = o['colors'];
  if (!Array.isArray(colors) || colors.length === 0 || !colors.every((c) => typeof c === 'string' && c.length > 0)) {
    issues.push({ field: 'colors', message: 'Must be a non-empty array of color-name strings.' });
  }
  const formality = o['formality'];
  if (typeof formality !== 'number' || !Number.isInteger(formality) || formality < 1 || formality > 5) {
    issues.push({ field: 'formality', message: 'Must be an integer 1–5.' });
  }
  const seasons = o['seasons'];
  if (
    !Array.isArray(seasons) ||
    seasons.length === 0 ||
    !seasons.every((s) => typeof s === 'string' && (GARMENT_SEASONS as readonly string[]).includes(s))
  ) {
    issues.push({ field: 'seasons', message: `Must be a non-empty array of ${GARMENT_SEASONS.join(', ')}.` });
  }
  for (const f of ['subcat', 'fabric', 'brand', 'cutoutUrl'] as const) {
    const v = o[f];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      issues.push({ field: f, message: 'When present must be a non-empty string.' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const tag: GarmentTag = {
    category: category as GarmentCategory,
    colors: colors as string[],
    formality: formality as number,
    seasons: seasons as GarmentSeason[],
  };
  const opt = (f: 'subcat' | 'fabric' | 'brand' | 'cutoutUrl'): string | undefined =>
    typeof o[f] === 'string' ? (o[f] as string) : undefined;
  const subcat = opt('subcat');
  const fabric = opt('fabric');
  const brand = opt('brand');
  const cutoutUrl = opt('cutoutUrl');
  if (subcat !== undefined) tag.subcat = subcat;
  if (fabric !== undefined) tag.fabric = fabric;
  if (brand !== undefined) tag.brand = brand;
  if (cutoutUrl !== undefined) tag.cutoutUrl = cutoutUrl;
  return { ok: true, tag };
}

/** Vision prompt (temp 0, strict JSON) — mirrored by the `auto-tag` edge fn. */
export const AUTO_TAG_SYSTEM_PROMPT = [
  'You are a fashion cataloguer. Temperature 0.',
  'Describe exactly ONE garment centered in the image.',
  'Colors: plain lowercase names, most-dominant first (e.g. ["black","white"]).',
  'Formality: 1 loungewear/sport, 2 casual, 3 smart-casual, 4 business, 5 evening/black-tie.',
  'Seasons: ["ss"] summer/spring, ["fw"] fall/winter, ["all"] year-round.',
  'Return STRICT JSON only, no markdown, no commentary, exactly this shape:',
  '{"category": "top|bottom|dress|outerwear|shoes|bag|accessory|onepiece|active",',
  ' "subcat": "e.g. oxford-shirt", "colors": ["..."], "fabric": "e.g. cotton",',
  ' "formality": 1-5, "seasons": ["ss|fw|all"], "brand": "visible brand or omit"}',
].join('\n');

export function buildAutoTagPrompt(hint?: string): string {
  // Capped like pose-transfer's stance note (280) — an unbounded hint shipped
  // arbitrary user text straight into the server LLM prompt (cost + abuse).
  return hint && hint.trim().length > 0
    ? `${AUTO_TAG_SYSTEM_PROMPT}\nUser hint (may be wrong — image wins): ${hint.trim().slice(0, 280)}`
    : AUTO_TAG_SYSTEM_PROMPT;
}

// ------------------------------------------------------- invalid-JSON fallback

/** Strip code fences / commentary and extract the first {...} block. */
export function salvageJsonBlock(raw: string): string | null {
  const noFences = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const start = noFences.indexOf('{');
  const end = noFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return noFences.slice(start, end + 1);
}

/** Remove trailing commas before } or ] (most common LLM JSON defect). */
export function stripTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, '$1');
}

export class AutoTagError extends Error {
  readonly code = 'auto-tag-invalid';
  readonly excerpt: string;
  constructor(excerpt: string) {
    super('auto-tag returned invalid JSON after salvage + server repair. Flag for manual review.');
    this.name = 'AutoTagError';
    this.excerpt = excerpt;
  }
}

function tryParseTag(text: string): GarmentTag | null {
  try {
    const parsed: unknown = JSON.parse(stripTrailingCommas(text));
    const v = validateGarmentTag(parsed);
    return v.ok ? v.tag : null;
  } catch {
    return null;
  }
}

interface AutoTagResponse {
  /** tag_json may arrive as object OR raw string (model-dependent). */
  tag_json: unknown;
  cutout_url?: string;
  embedding?: number[];
  repaired?: boolean;
}

export interface AutoTagParams {
  userId: string;
  imageUrl?: string;
  imageBase64?: string;
  hint?: string;
  idempotencyKey?: string;
}

export interface AutoTagResult {
  tag: GarmentTag;
  cutoutUrl?: string;
  embedding?: number[];
  /** True when salvage/repair path was used (log + sample for prompt tuning). */
  repaired: boolean;
}

/**
 * Request auto-tag via the `auto-tag` edge fn.
 * Fallback chain (never a stub): strict parse → salvage (fence strip +
 * trailing-comma fix) + schema validate → ONE server repair pass
 * (`{repair:true, raw}`) → typed AutoTagError with excerpt for review queue.
 */
export async function requestAutoTag(
  params: AutoTagParams,
  edgeOpts: EdgeCallOptions = {},
): Promise<AutoTagResult> {
  if (!params.imageUrl && !params.imageBase64) {
    throw new Error('requestAutoTag requires imageUrl or imageBase64.');
  }
  const idempotencyKey =
    params.idempotencyKey ??
    (await generateIdempotencyKey([
      params.userId,
      params.imageUrl ?? params.imageBase64 ?? 'auto-tag',
      // Full image participates: the first 64 base64 chars are the JPEG/PNG
      // header — near-identical across a device session, so two different
      // garments could collide and inherit each other's tags.
      params.hint ?? '',
    ]));
  const base = {
    image_url: params.imageUrl,
    image_base64: params.imageBase64,
    prompt: buildAutoTagPrompt(params.hint),
  };
  const res = await callEdgeFunction<AutoTagResponse>('auto-tag', base, {
    timeoutMs: 45_000,
    retries: 1,
    ...edgeOpts,
    idempotencyKey,
  });
  const direct = coerceTag(res.tag_json);
  if (direct) {
    return finish(direct, res, false);
  }
  // Salvage path: the model wrapped JSON in fences/commentary.
  const rawText = typeof res.tag_json === 'string' ? res.tag_json : JSON.stringify(res.tag_json);
  const block = salvageJsonBlock(rawText);
  const salvaged = block ? tryParseTag(block) : null;
  if (salvaged) return finish(salvaged, res, true);

  // Repair path: exactly one server-side rewrite of the raw payload.
  const repair = await callEdgeFunction<AutoTagResponse>(
    'auto-tag',
    { ...base, repair: true, raw: rawText.slice(0, 4000) },
    { timeoutMs: 45_000, retries: 0, ...edgeOpts, idempotencyKey: `${idempotencyKey}:repair` },
  );
  const fixed = coerceTag(repair.tag_json);
  if (fixed) return finish(fixed, repair, true);
  throw new AutoTagError(rawText.slice(0, 500));
}

function coerceTag(tagJson: unknown): GarmentTag | null {
  if (typeof tagJson === 'string') {
    const block = salvageJsonBlock(tagJson) ?? tagJson;
    return tryParseTag(block);
  }
  const v = validateGarmentTag(tagJson);
  return v.ok ? v.tag : null;
}

function finish(tag: GarmentTag, res: AutoTagResponse, repaired: boolean): AutoTagResult {
  const out: AutoTagResult = { tag, repaired: repaired || res.repaired === true };
  const cutout = res.cutout_url ?? tag.cutoutUrl;
  if (cutout !== undefined) out.cutoutUrl = cutout;
  if (res.embedding !== undefined) out.embedding = res.embedding;
  return out;
}

// ------------------------------------------------------- CLIP-embedding hook

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dims: number;
}

/**
 * CLIP-embedding hook: server computes the 512-d image embedding stored on
 * garments.embedding (pgvector). Client uses it for owned-complement
 * matching via cosineSimilarity — no extra model dep client-side.
 */
export async function requestEmbedding(
  params: { userId: string; imageUrl?: string; garmentId?: string; idempotencyKey?: string },
  edgeOpts: EdgeCallOptions = {},
): Promise<EmbeddingResult> {
  if (!params.imageUrl && !params.garmentId) {
    throw new Error('requestEmbedding requires imageUrl or garmentId.');
  }
  const idempotencyKey =
    params.idempotencyKey ??
    (await generateIdempotencyKey([params.userId, params.imageUrl ?? params.garmentId!, 'embed']));
  const res = await callEdgeFunction<{ embedding: number[]; model?: string }>(
    'auto-tag',
    { action: 'embed', image_url: params.imageUrl, garment_id: params.garmentId },
    { timeoutMs: 45_000, retries: 1, ...edgeOpts, idempotencyKey },
  );
  if (!Array.isArray(res.embedding) || res.embedding.length === 0) {
    throw new Error('auto-tag embed returned an empty embedding.');
  }
  return { embedding: res.embedding, model: res.model ?? 'clip', dims: res.embedding.length };
}

/** Cosine similarity in [-1, 1]. Throws on dim mismatch (fail loud, not NaN). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`cosineSimilarity dim mismatch: ${a.length} vs ${b.length}.`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
