// Taste-autopilot core (Deno, strict TS) — shared by `taste-build`
// (writer), `plan-day`/`plan-week` via plan.ts + `reel-drop` (readers).
//
// LAYERS: ingest (pinterest-sync worker, unchanged 0005 path) → extract
// (vocab tagger below, $0) → context-row (ONE taste_context row per user)
// → consume (planner/drop read that single row, never fan out to pins).
//
// The tag vocab is a server-side port of lib/ai/taste-seeds.ts (integrations
// turf owns the client copy). Keep the two lists in sync: only phrases in
// these vocabularies can become tags, so pin marketing fluff can never leak
// into prompts. Extraction is deterministic, offline-safe, $0 — no Gemini.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { badRequest } from "./http.ts";

/** Max pose refs kept per user (cap enforced in taste-build + 0006 CHECK). */
export const POSE_REF_CAP = 12;
/** A pose ref counts as "fresh" for pose_mode_default='auto' within this window. */
export const POSE_FRESH_DAYS = 14;
/** Taste extraction looks back this far (stability window, not a cursor). */
export const TASTE_LOOKBACK_DAYS = 90;

export type SyncCadence = "daily" | "weekly" | "off";
export type PoseModeDefault = "keep" | "adapt" | "auto";

export interface TastePrefs {
  userId: string;
  pinterestConnected: boolean;
  syncCadence: SyncCadence;
  poseModeDefault: PoseModeDefault;
  styleInfluence: number; // 0..100
}

export interface TasteContext {
  userId: string;
  seedTags: string[];
  poseRefIds: string[];
  styleNote: string | null;
  computedAt: string;
  weekOf: string;
}

const DEFAULT_PREFS: Omit<TastePrefs, "userId"> = {
  pinterestConnected: false,
  syncCadence: "weekly",
  poseModeDefault: "auto",
  styleInfluence: 60,
};

export function parseSyncCadence(v: unknown): SyncCadence {
  if (v === "daily" || v === "weekly" || v === "off") return v;
  throw badRequest("cadence_invalid", "sync_cadence must be 'daily' | 'weekly' | 'off'");
}

export function parsePoseModeDefault(v: unknown): PoseModeDefault {
  if (v === "keep" || v === "adapt" || v === "auto") return v;
  throw badRequest("pose_default_invalid", "pose_mode_default must be 'keep' | 'adapt' | 'auto'");
}

export function parseStyleInfluence(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100) {
    throw badRequest("influence_invalid", "style_influence must be an int 0..100");
  }
  return n;
}

/** UTC Monday (YYYY-MM-DD) of the week containing `d` — the context bucket. */
export function mondayOf(d: Date): string {
  const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = c.getUTCDay(); // 0=Sun..6=Sat
  c.setUTCDate(c.getUTCDate() - ((dow + 6) % 7));
  return c.toISOString().slice(0, 10);
}

export function isFreshIso(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return Date.now() - ms <= days * 86400000;
}

// ------------------------------------------------------------ vocab port
// Ported from lib/ai/taste-seeds.ts — keep the phrase lists identical.

/** Total tags (taste + fit) per context row. Same prompt budget as trend seeds. */
export const MAX_TASTE_SEEDS = 8;

const STYLE_ADJECTIVES: readonly string[] = [
  "minimalist", "minimal", "oversized", "tailored", "relaxed", "cropped",
  "vintage", "retro", "streetwear", "bohemian", "boho", "preppy", "classic",
  "edgy", "feminine", "elegant", "casual", "chic", "cozy", "sporty",
  "androgynous", "monochrome", "neutral", "pastel", "bold", "layered",
  "flowy", "structured", "fitted", "slouchy", "denim", "leather", "satin",
  "silk", "knit", "linen", "pleated", "cargo", "evening", "office",
  "quiet luxury", "old money", "y2k", "normcore", "cottagecore", "gorpcore",
];

const FIT_NOTES: readonly string[] = [
  "high waist", "wide leg", "full length", "long sleeve", "off shoulder",
  "high neck", "low rise", "midi", "maxi", "mini", "sleeveless",
  "turtleneck", "modest", "sheer", "bodycon", "boxy",
];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function collectPhrases(
  text: string,
  phrases: readonly string[],
  prefix: "taste" | "fit",
  seen: Set<string>,
  out: string[],
): void {
  const haystack = normalize(text);
  const hits: Array<{ at: number; tag: string }> = [];
  for (const phrase of phrases) {
    const at = haystack.indexOf(` ${phrase} `);
    if (at === -1) continue;
    const tag = `${prefix}:${phrase.replace(/\s+/g, "-")}`;
    if (!seen.has(tag)) hits.push({ at, tag });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const hit of hits) {
    seen.add(hit.tag);
    out.push(hit.tag);
  }
}

export interface TasteSeedPin {
  title?: string | null;
  description?: string | null;
}

/** Extract a taste-seed pack from board + pin text. Pure; empty-in → empty-out. */
export function tasteSeedPack(input: { boardName?: string | null; pins?: readonly TasteSeedPin[] }): { tags: string[] } {
  const tags: string[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  if (input.boardName?.trim()) sources.push(input.boardName);
  for (const pin of input.pins ?? []) {
    const text = `${pin.title ?? ""} ${pin.description ?? ""}`.trim();
    if (text) sources.push(text);
  }
  for (const text of sources) {
    collectPhrases(text, STYLE_ADJECTIVES, "taste", seen, tags);
    collectPhrases(text, FIT_NOTES, "fit", seen, tags);
    if (tags.length >= MAX_TASTE_SEEDS) break;
  }
  return { tags: tags.slice(0, MAX_TASTE_SEEDS) };
}

/** Scale the stored tags by style_influence: 0 → [], 100 → all 8. */
export function selectTasteTags(allTags: string[], influence: number): string[] {
  if (influence <= 0 || allTags.length === 0) return [];
  if (influence >= 100) return allTags.slice(0, MAX_TASTE_SEEDS);
  const n = Math.max(1, Math.round((allTags.length * influence) / 100));
  return allTags.slice(0, Math.min(n, MAX_TASTE_SEEDS));
}

// ------------------------------------------------------------ consume-side

interface PrefsRow {
  pinterest_connected: boolean;
  sync_cadence: string;
  pose_mode_default: string;
  style_influence: number;
}

/** Prefs with safe defaults (missing row / corrupt values → defaults, never throw). */
export async function readTastePrefs(sb: SupabaseClient, userId: string): Promise<TastePrefs> {
  const { data } = await sb.from("user_taste_prefs")
    .select("pinterest_connected,sync_cadence,pose_mode_default,style_influence")
    .eq("user_id", userId).maybeSingle<PrefsRow>();
  if (!data) return { userId, ...DEFAULT_PREFS };
  const syncCadence: SyncCadence =
    data.sync_cadence === "daily" || data.sync_cadence === "off" ? data.sync_cadence : "weekly";
  const poseModeDefault: PoseModeDefault =
    data.pose_mode_default === "keep" || data.pose_mode_default === "adapt" ? data.pose_mode_default : "auto";
  const styleInfluence =
    Number.isInteger(data.style_influence) && data.style_influence >= 0 && data.style_influence <= 100
      ? data.style_influence
      : DEFAULT_PREFS.styleInfluence;
  return {
    userId,
    pinterestConnected: data.pinterest_connected === true,
    syncCadence,
    poseModeDefault,
    styleInfluence,
  };
}

interface ContextRow {
  seed_tags: string[];
  pose_ref_ids: string[];
  style_note: string | null;
  computed_at: string;
  week_of: string;
}

/** The weekly built context in ONE indexed PK select. Null = never built. */
export async function readTasteContext(sb: SupabaseClient, userId: string): Promise<TasteContext | null> {
  const { data, error } = await sb.from("taste_context")
    .select("seed_tags,pose_ref_ids,style_note,computed_at,week_of")
    .eq("user_id", userId).maybeSingle<ContextRow>();
  if (error || !data) return null;
  return {
    userId,
    seedTags: Array.isArray(data.seed_tags) ? data.seed_tags.filter((t): t is string => typeof t === "string") : [],
    poseRefIds: Array.isArray(data.pose_ref_ids) ? data.pose_ref_ids.filter((t): t is string => typeof t === "string") : [],
    styleNote: typeof data.style_note === "string" ? data.style_note : null,
    computedAt: data.computed_at,
    weekOf: data.week_of,
  };
}

/**
 * Resolve the effective pose mode for one render/drop card.
 * 'keep' → keep. 'adapt' → adapt iff a pose ref exists. 'auto' → adapt iff
 * a FRESH pose ref exists (synced taste), else keep (never block the drop).
 */
export function resolveAutoPoseMode(
  def: PoseModeDefault,
  poseRefIds: string[],
  freshRefExists: boolean,
): "keep" | "adapt" {
  if (def === "keep") return "keep";
  if (def === "adapt") return poseRefIds.length > 0 ? "adapt" : "keep";
  return poseRefIds.length > 0 && freshRefExists ? "adapt" : "keep";
}

interface ClosetGarmentLike {
  category: string | null;
  subcat: string | null;
  colors: string[];
  fabric: string | null;
}

/**
 * Deterministic taste bonus for the planner scorer (offline-safe, $0).
 * Each applied tag whose words hit the garment's own attributes adds a
 * fraction of `influence`; capped so taste biases picks within the owned
 * closet but can never outvote season/formality fit.
 */
export function tasteBonus(g: ClosetGarmentLike, tags: string[], influence: number): number {
  if (tags.length === 0 || influence <= 0) return 0;
  const scale = influence / 100;
  const hay = [
    g.category ?? "",
    g.subcat ?? "",
    g.fabric ?? "",
    ...(g.colors ?? []),
  ].join(" ").toLowerCase();
  let hits = 0;
  for (const tag of tags) {
    const suffix = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    const words = suffix.split("-").filter((w) => w.length > 2);
    if (words.some((w) => hay.includes(w))) hits++;
  }
  return Math.min(hits * 0.5, 1.5) * scale;
}
