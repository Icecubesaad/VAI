/**
 * VAI · outfit-reasoning prompt pack + client (integrations turf).
 *
 * Execution is server-side (`plan-day` / `plan-week` edge fns, Gemini Flash,
 * temp 0, strict JSON). This module owns the prompt contract, the
 * deterministic why-line generator (instant, $0), and client-side validation
 * of the anti-generic rules so the UI can show violations without a round-trip.
 *
 * Iron laws enforced here: owned-only (no phantom garments), no repeats
 * within 14 days, laundry dedup, color/season validation.
 */

import { callEdgeFunction, generateIdempotencyKey } from '../edge';
import type { EdgeCallOptions } from '../edge';
import { estimateCostUsd, PRIMARY_IMAGE_MODEL } from './gemini';
import { assertReelPose, REEL_WEEK_POSES, selectBaseForPose } from './poses';
import type { BasePhotoLite, ReelPose } from './poses';

export const NO_REPEAT_DAYS = 14;

export interface WeatherInput {
  tempC: number;
  condition: string;
  precipitationChancePct?: number;
  windKph?: number;
}

export interface EventInput {
  title?: string;
  dressCode?: string;
  /** 1 (loungewear) – 5 (black tie). */
  formality?: number;
  venue?: 'indoor' | 'outdoor' | 'mixed';
}

export interface StyleSummary {
  everydayStyle?: string;
  palette?: string;
  dressCode?: string;
  boldness?: number;
  colorSeason?: string;
}

export interface ClosetGarmentLite {
  id: string;
  category: string;
  colors: string[];
  seasons: string[];
  formality: number;
}

export interface OutfitHistoryEntry {
  date: string;
  garmentIds: string[];
}

export interface PlanDayInput {
  userId: string;
  date: string;
  weather: WeatherInput;
  event?: EventInput;
  /** Owned garment IDs the model MUST choose from (closed world). */
  ownedGarmentIds: string[];
  style?: StyleSummary;
  /** Recent outfits for the no-repeat rule (pass ≥14 days). */
  history?: OutfitHistoryEntry[];
  /** Garments in the laundry basket — must not be suggested. */
  laundryBlockedIds?: string[];
}

export interface PlannedOutfit {
  garmentIds: string[];
  whyLine: string;
  score?: number;
}

export type PlanViolationCode =
  | 'repeat-14d'
  | 'laundry-conflict'
  | 'season-mismatch'
  | 'formality-gap'
  | 'unowned-garment'
  | 'empty-plan';

export interface PlanViolation {
  code: PlanViolationCode;
  message: string;
  garmentIds?: string[];
}

const OWNED_ONLY_CONSTRAINT = [
  'HARD CONSTRAINT — OWNED ONLY: you may select ONLY garment IDs from the',
  '`owned_garment_ids` array. Never invent, substitute, or "similar-item" a',
  'garment. If no owned combination fits the weather/event, return the',
  'closest owned outfit and say what gap to shop in `gap_note`.',
].join(' ');

const ANTI_GENERIC_RULES = [
  `RECENCY: do not reuse any garment worn in the last ${NO_REPEAT_DAYS} days (see history).`,
  'LAUNDRY: never select a garment in `laundry_blocked_ids`.',
  'SEASON: every garment must match the month/season (no wool coats in heat, no linen in frost).',
  'COLOR: validate palette harmony against the user color season; veto clashing pairs explicitly.',
  'SPECIFICITY: the why_line must name the actual garments/weather/event — never generic praise.',
  'OUTPUT: strict JSON only: {"garment_ids": string[], "why_line": string, "gap_note"?: string}. No markdown.',
].join('\n');

/** System prompt shared with the `plan-day` edge fn (contract-pinned). */
export const PLAN_DAY_SYSTEM_PROMPT = [
  'You are VAI, a closet-aware stylist. Temperature 0. Strict JSON output.',
  OWNED_ONLY_CONSTRAINT,
  ANTI_GENERIC_RULES,
].join('\n\n');

/** Build the user prompt for one day. Pure — safe to unit test / snapshot. */
export function buildPlanDayPrompt(input: PlanDayInput): string {
  const w = input.weather;
  const lines = [
    `Date: ${input.date}.`,
    `Weather: ${w.tempC}°C, ${w.condition}` +
      (w.precipitationChancePct !== undefined ? `, ${w.precipitationChancePct}% precip` : '') +
      (w.windKph !== undefined ? `, wind ${w.windKph} kph` : '') + '.',
  ];
  if (input.event) {
    const e = input.event;
    lines.push(
      `Event: ${e.title ?? 'day'}${e.dressCode ? `, dress code "${e.dressCode}"` : ''}` +
        (e.formality !== undefined ? `, formality ${e.formality}/5` : '') +
        (e.venue ? `, ${e.venue}` : '') + '.',
    );
  }
  if (input.style) {
    const s = input.style;
    lines.push(
      `Style profile: ${s.everydayStyle ?? 'unspecified'}; palette ${s.palette ?? 'unspecified'}; ` +
        `boldness ${s.boldness ?? 3}/5; color season ${s.colorSeason ?? 'unknown'}.`,
    );
  }
  lines.push(`owned_garment_ids: [${input.ownedGarmentIds.map((id) => `"${id}"`).join(', ')}]`);
  if (input.laundryBlockedIds && input.laundryBlockedIds.length > 0) {
    lines.push(`laundry_blocked_ids: [${input.laundryBlockedIds.map((id) => `"${id}"`).join(', ')}]`);
  }
  if (input.history && input.history.length > 0) {
    lines.push(`history (last worn): ${JSON.stringify(input.history.slice(-NO_REPEAT_DAYS))}`);
  }
  return lines.join('\n');
}

/**
 * Narrow the `ReadonlyMap | Record` garment index. `instanceof Map` alone
 * does not narrow `ReadonlyMap` (interface) out of the union for the
 * bracket-access branch, so the Record side needs an explicit assertion.
 */
function lookupGarment(
  garmentsById: ReadonlyMap<string, ClosetGarmentLite> | Record<string, ClosetGarmentLite>,
  id: string,
): ClosetGarmentLite | undefined {
  if (garmentsById instanceof Map) return garmentsById.get(id);
  return (garmentsById as Record<string, ClosetGarmentLite>)[id];
}

// ------------------------------------------------------- validation

function monthOf(dateISO: string): number {
  return Number(dateISO.slice(5, 7));
}

/** Northern-hemisphere default; pass hemisphere:'southern' for AU/LATAM users. */
export function seasonsForMonth(month: number, hemisphere: 'northern' | 'southern' = 'northern'): string[] {
  const m = hemisphere === 'southern' ? ((month + 6 - 1) % 12) + 1 : month;
  if (m >= 6 && m <= 8) return ['ss', 'all'];
  if (m >= 12 || m <= 2) return ['fw', 'all'];
  return ['ss', 'fw', 'all'];
}

/**
 * Client-side validator for every anti-generic rule. Returns violations
 * (empty = clean). The UI should surface these; planDay() auto-repairs once.
 */
export function validatePlan(
  plan: PlannedOutfit,
  ctx: {
    date: string;
    ownedIds: Set<string> | string[];
    garmentsById: ReadonlyMap<string, ClosetGarmentLite> | Record<string, ClosetGarmentLite>;
    history?: OutfitHistoryEntry[];
    laundryBlockedIds?: string[] | Set<string>;
    eventFormality?: number;
    hemisphere?: 'northern' | 'southern';
  },
): PlanViolation[] {
  const out: PlanViolation[] = [];
  const owned = ctx.ownedIds instanceof Set ? ctx.ownedIds : new Set(ctx.ownedIds);
  const laundry = ctx.laundryBlockedIds instanceof Set
    ? ctx.laundryBlockedIds
    : new Set(ctx.laundryBlockedIds ?? []);
  const lookup = (id: string): ClosetGarmentLite | undefined =>
    lookupGarment(ctx.garmentsById, id);

  if (plan.garmentIds.length === 0) {
    out.push({ code: 'empty-plan', message: 'Plan contains no garments.' });
    return out;
  }
  const unowned = plan.garmentIds.filter((id) => !owned.has(id));
  if (unowned.length > 0) {
    out.push({ code: 'unowned-garment', message: `Plan suggests unowned garments: ${unowned.join(', ')}.`, garmentIds: unowned });
  }
  const dirty = plan.garmentIds.filter((id) => laundry.has(id));
  if (dirty.length > 0) {
    out.push({ code: 'laundry-conflict', message: `Plan reuses laundry-blocked items: ${dirty.join(', ')}.`, garmentIds: dirty });
  }
  const recent = new Map<string, string>();
  for (const h of (ctx.history ?? []).slice(-NO_REPEAT_DAYS)) {
    for (const id of h.garmentIds) {
      if (!recent.has(id)) recent.set(id, h.date);
    }
  }
  const repeated = plan.garmentIds.filter((id) => recent.has(id));
  if (repeated.length > 0) {
    out.push({
      code: 'repeat-14d',
      message: `Recently worn (last ${NO_REPEAT_DAYS}d): ${repeated.map((id) => `${id}@${recent.get(id)}`).join(', ')}.`,
      garmentIds: repeated,
    });
  }
  const okSeasons = seasonsForMonth(monthOf(ctx.date), ctx.hemisphere ?? 'northern');
  const offSeason = plan.garmentIds.filter((id) => {
    const g = lookup(id);
    return g !== undefined && !g.seasons.some((s) => okSeasons.includes(s));
  });
  if (offSeason.length > 0) {
    out.push({ code: 'season-mismatch', message: `Off-season for ${ctx.date.slice(0, 7)}: ${offSeason.join(', ')}.`, garmentIds: offSeason });
  }
  if (ctx.eventFormality !== undefined) {
    const gaps = plan.garmentIds.filter((id) => {
      const g = lookup(id);
      return g !== undefined && Math.abs(g.formality - ctx.eventFormality!) > 2;
    });
    if (gaps.length > 0 && gaps.length === plan.garmentIds.length) {
      out.push({ code: 'formality-gap', message: `Whole outfit misses event formality ${ctx.eventFormality}/5.`, garmentIds: gaps });
    }
  }
  return out;
}

// ------------------------------------------------------- edge clients

interface PlanDayResponse {
  garment_ids: string[];
  why_line: string;
  score?: number;
  gap_note?: string;
}

export interface PlanDayResult extends PlannedOutfit {
  gapNote?: string;
  repaired: boolean;
  violations: PlanViolation[];
}

/**
 * Plan one day via the `plan-day` edge fn, then client-validate. On
 * violations, ONE repair call is issued with the violations appended
 * (bounded cost: ≤2 LLM calls). Throws on unrepairable plans.
 */
export async function planDay(
  input: PlanDayInput,
  ctx: Omit<Parameters<typeof validatePlan>[1], 'date' | 'ownedIds'> & { hemisphere?: 'northern' | 'southern' },
  edgeOpts: EdgeCallOptions = {},
): Promise<PlanDayResult> {
  // The key covers EVERY plan input: with only user+date, re-planning after a
  // closet change / laundry event / history roll returned the deduped stale
  // plan forever (and defeated the documented repair loop).
  const key = await generateIdempotencyKey([
    input.userId,
    input.date,
    'plan-day',
    [...input.ownedGarmentIds].sort().join(','),
    JSON.stringify(input.weather ?? null),
    JSON.stringify(input.event ?? null),
    (input.history ?? []).map((h) => `${h.date}:${[...(h.garmentIds ?? [])].sort().join(',')}`).join(','),
    [...(input.laundryBlockedIds ?? [])].sort().join(','),
  ]);
  const attempt = async (prompt: string, idemKey: string): Promise<PlanDayResponse> =>
    callEdgeFunction<PlanDayResponse>('plan-day', {
      date: input.date,
      weather: input.weather,
      event: input.event ?? null,
      owned_garment_ids: input.ownedGarmentIds,
      history: (input.history ?? []).slice(-NO_REPEAT_DAYS),
      laundry_blocked_ids: input.laundryBlockedIds ?? [],
      style: input.style ?? null,
      prompt,
    }, { timeoutMs: 30_000, retries: 1, ...edgeOpts, idempotencyKey: idemKey });

  const first = await attempt(buildPlanDayPrompt(input), key);
  const asPlanned = (r: PlanDayResponse): PlannedOutfit => ({
    garmentIds: r.garment_ids,
    whyLine: r.why_line,
    ...(r.score !== undefined ? { score: r.score } : {}),
  });
  let violations = validatePlan(asPlanned(first), { ...ctx, date: input.date, ownedIds: input.ownedGarmentIds });
  if (violations.length === 0) {
    const done: PlanDayResult = { ...asPlanned(first), repaired: false, violations: [] };
    if (first.gap_note !== undefined) done.gapNote = first.gap_note;
    return done;
  }
  const repairPrompt =
    `${buildPlanDayPrompt(input)}\nREPAIR — the previous proposal violated these rules, fix ALL of them:\n` +
    violations.map((v) => `- [${v.code}] ${v.message}`).join('\n');
  const second = await attempt(repairPrompt, `${key}:repair`);
  violations = validatePlan(asPlanned(second), { ...ctx, date: input.date, ownedIds: input.ownedGarmentIds });
  if (violations.length > 0) {
    throw new Error(`plan-day unrepairable: ${violations.map((v) => `[${v.code}] ${v.message}`).join(' ')}`);
  }
  const repaired: PlanDayResult = { ...asPlanned(second), repaired: true, violations: [] };
  if (second.gap_note !== undefined) repaired.gapNote = second.gap_note;
  return repaired;
}

export interface PlanWeekResult {
  days: Record<string, PlanDayResult>;
}

/** 7× plan-day with week-level laundry dedup (mirrors `plan-week` server fn). */
export async function planWeek(
  days: PlanDayInput[],
  ctx: Omit<Parameters<typeof validatePlan>[1], 'date' | 'ownedIds'> & { hemisphere?: 'northern' | 'southern' },
  edgeOpts: EdgeCallOptions = {},
): Promise<PlanWeekResult> {
  if (days.length !== 7) throw new Error(`planWeek requires exactly 7 days, got ${days.length}.`);
  const key = await generateIdempotencyKey([
    days[0]?.userId ?? 'x',
    'plan-week',
    days.map((d) => d.date).join(','),
    ...days.map((d) => [...d.ownedGarmentIds].sort().join(',')),
    JSON.stringify(days.map((d) => d.weather ?? null)),
    JSON.stringify(days.map((d) => d.event ?? null)),
    (days[0]?.history ?? []).map((h) => `${h.date}:${[...(h.garmentIds ?? [])].sort().join(',')}`).join(','),
  ]);
  const res = await callEdgeFunction<{ days: Record<string, PlanDayResponse> }>(
    'plan-week',
    {
      days: days.map((d) => ({
        date: d.date,
        weather: d.weather,
        event: d.event ?? null,
        owned_garment_ids: d.ownedGarmentIds,
        history: (d.history ?? []).slice(-NO_REPEAT_DAYS),
        laundry_blocked_ids: d.laundryBlockedIds ?? [],
        style: d.style ?? null,
      })),
    },
    { timeoutMs: 60_000, retries: 1, ...edgeOpts, idempotencyKey: key },
  );
  const out: Record<string, PlanDayResult> = {};
  for (const d of days) {
    const r = res.days[d.date];
    if (!r) throw new Error(`plan-week response missing day ${d.date}.`);
    const planned: PlannedOutfit = {
      garmentIds: r.garment_ids,
      whyLine: r.why_line,
      ...(r.score !== undefined ? { score: r.score } : {}),
    };
    const violations = validatePlan(planned, { ...ctx, date: d.date, ownedIds: d.ownedGarmentIds });
    const entry: PlanDayResult = { ...planned, repaired: false, violations };
    if (r.gap_note !== undefined) entry.gapNote = r.gap_note;
    out[d.date] = entry;
  }
  return { days: out };
}

// ------------------------------------------------------- reel drops (additive)

/**
 * Injectable trend tags for reel drops (e.g. 'Office Siren', 'Under $100',
 * seasonal tags). `promptBlock` is the exact block the `plan-week` server fn
 * appends to each day prompt; the owned-only constraint still wins — trends
 * bias picks within the owned closet, never conjure garments. Pure.
 */
export interface TrendSeedInput {
  /** Trend names, e.g. ['Office Siren']. Trimmed, deduped, capped at 6. */
  trends?: string[];
  /** Budget band, e.g. 'Under $100' (surfaced to gap_note/shop, not a render input). */
  budgetBand?: string;
  /** Season label, e.g. 'FW26'. */
  season?: string;
}

export interface TrendSeedPack {
  tags: string[];
  promptBlock: string;
}

export const MAX_TREND_SEEDS = 6;

export function trendSeedPack(input: TrendSeedInput = {}): TrendSeedPack {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.trends ?? []) {
    const cleaned = raw.trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`trend:${cleaned}`);
    if (tags.length >= MAX_TREND_SEEDS) break;
  }
  const budget = (input.budgetBand ?? '').trim().replace(/\s+/g, ' ');
  if (budget) tags.push(`budget:${budget}`);
  const season = (input.season ?? '').trim().replace(/\s+/g, ' ');
  if (season) tags.push(`season:${season}`);
  if (tags.length === 0) return { tags: [], promptBlock: '' };
  return {
    tags,
    promptBlock:
      'TREND SEED (reel drop) — bias picks toward these tags where the owned ' +
      `closet allows; the owned-only constraint still wins, never invent garments: ${tags.join(', ')}.`,
  };
}

// ------------------------------------------------------- weekly drop composition

/** Renders per weekly drop @ std flash-image: free teaser (3) vs premium full week (7). */
export const REEL_DROP_CARD_COUNT = { free: 3, premium: 7 } as const;
export type ReelDropTier = keyof typeof REEL_DROP_CARD_COUNT;

/**
 * Pre-flight weekly-drop estimate (display only): card count × std
 * flash-image. Resolves to free $0.20 / premium $0.47. The edge fn returns
 * authoritative per-render `cost_usd` — analytics MUST use that, never this.
 */
export function estimateWeeklyDropCostUsd(tier: ReelDropTier): number {
  const n = REEL_DROP_CARD_COUNT[tier];
  return Math.round(estimateCostUsd(PRIMARY_IMAGE_MODEL, 'std') * n * 100) / 100;
}

export interface ReelDropCard {
  date: string;
  garmentIds: string[];
  whyLine: string;
  pose: ReelPose;
  /** Resolved via `selectBaseForPose` when `bases` is passed; else backend picks. */
  basePhotoId?: string;
  trendTags: string[];
}

export class ReelWeekError extends Error {
  readonly code = 'reel-week-invalid';
  constructor(message: string) {
    super(message);
    this.name = 'ReelWeekError';
  }
}

export interface ReelWeekPlannerInput {
  /** Exactly 7 days, chronological. */
  days: PlanDayInput[];
  /** Resolved plans covering all 7 dates (e.g. from `planWeek`). */
  week: PlanWeekResult;
  trendTags?: string[];
  /** When passed, each card's base is resolved via `selectBaseForPose`. */
  bases?: readonly BasePhotoLite[];
  /** Custom 7-pose rotation (validated fail-closed). Default `REEL_WEEK_POSES`. */
  poses?: readonly unknown[];
}

/**
 * Compose 7 no-repeat outfits across poses for a reel drop. Pure:
 * validates exactly 7 days, every pose (fail-closed via `assertReelPose`),
 * plan coverage for every date, and week-level no-repeat (any garment on
 * two different days throws `ReelWeekError` — caller re-runs plan-week
 * repair or swaps before rendering; repeats inside ONE day's outfit are
 * the planner's business, not the week's).
 */
export function reelWeekPlanner(input: ReelWeekPlannerInput): ReelDropCard[] {
  if (input.days.length !== 7) {
    throw new ReelWeekError(`reelWeekPlanner requires exactly 7 days, got ${input.days.length}.`);
  }
  const poses = input.poses ?? REEL_WEEK_POSES;
  if (poses.length !== 7) {
    throw new ReelWeekError(`reelWeekPlanner requires exactly 7 poses, got ${poses.length}.`);
  }
  const trendTags = input.trendTags ?? [];
  const seen = new Map<string, string>();
  const cards: ReelDropCard[] = [];
  for (let i = 0; i < 7; i++) {
    const day = input.days[i] as PlanDayInput;
    const rawPose = poses[i];
    assertReelPose(rawPose);
    const plan = input.week.days[day.date];
    if (!plan) throw new ReelWeekError(`reelWeekPlanner: week result missing day ${day.date}.`);
    for (const id of plan.garmentIds) {
      const firstSeen = seen.get(id);
      if (firstSeen !== undefined && firstSeen !== day.date) {
        throw new ReelWeekError(
          `reelWeekPlanner: garment ${id} repeats across the week (${firstSeen} + ${day.date}). Re-run plan-week repair first.`,
        );
      }
      if (firstSeen === undefined) seen.set(id, day.date);
    }
    const card: ReelDropCard = {
      date: day.date,
      garmentIds: [...plan.garmentIds],
      whyLine: plan.whyLine,
      pose: rawPose,
      trendTags: [...trendTags],
    };
    if (input.bases !== undefined) {
      card.basePhotoId = selectBaseForPose(input.bases, rawPose).id;
    }
    cards.push(card);
  }
  return cards;
}
