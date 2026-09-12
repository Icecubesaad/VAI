// Reel weekly-drop contract + read path (Deno, strict TS) — shared by
// `reel-drop` (POST drop / GET reel-week) and `reel-regenerate`, so the two
// entry points can never drift on the card shape (cf. _shared/restyle.ts).
//
// CONTRACT (exact — all crews share it, do not reshape):
//   type ReelPose = 'front' | 'step' | 'detail';
//   interface ReelCard { id; outfitId; renderId; imageUrl; pose; garmentIds;
//     whyLine; trendTag?; costUsd; createdAt; }
//   interface WeeklyDrop { weekOf; cards; tier: 'teaser' | 'full'; }
//
// Card identity: `id` is STABLE per card slot (initially the render id);
// `renderId` is the underlying render (changes after reel-regenerate — the
// client swaps by `id`). Pending renders read `imageUrl: ""` + `costUsd` =
// one-std estimate ($0.067); poll GET reel-week (or the renders realtime
// feed) until filled. Once done, costUsd is ledger-authoritative.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { GEMINI_STD_COST_USD } from "./gemini.ts";
import { badRequest } from "./http.ts";
import { sha256Hex } from "./idempotency.ts";
import { renderCostUsd } from "./ledger.ts";
import { signedRenderUrl } from "./storage.ts";

export type ReelPose = "front" | "step" | "detail";
export type ReelTier = "teaser" | "full";

export interface ReelCard {
  id: string;
  outfitId: string;
  renderId: string;
  imageUrl: string;
  pose: ReelPose;
  garmentIds: string[];
  whyLine: string;
  trendTag?: string;
  costUsd: number;
  createdAt: string;
}

export interface WeeklyDrop {
  weekOf: string;
  cards: ReelCard[];
  tier: ReelTier;
}

/** Render row projection needed to build a card (never select *). */
export interface ReelRenderRow {
  id: string;
  outfit_id: string | null;
  output_url: string | null;
  /** Private-bucket path (0008) — minted into a 1h signed URL per response. */
  output_path: string | null;
  user_id: string;
  status: string;
  created_at: string;
  garment_refs: { garment_ids?: string[]; meta?: Record<string, unknown> } | null;
}

export const REEL_POSES: ReelPose[] = ["front", "step", "detail"];
export const REEL_TEASER_CARDS = 3;
export const REEL_FULL_CARDS = 7;
/** Pending-render estimate = one Gemini std image (gemini.ts, $0.067). */
export const REEL_EST_COST_USD = GEMINI_STD_COST_USD;

export function isReelPose(v: unknown): v is ReelPose {
  return v === "front" || v === "step" || v === "detail";
}

/**
 * CANONICAL pose resolution (P0-1 fix, 0004).
 *   Canonical source: `base_photos.pose` COLUMN (0003) — wins when valid.
 *   Legacy source: `base_photos.pose_meta.pose` (pre-0004 client path,
 *   pose-pack.tsx writes meta-only) — read as fallback so shipped step/detail
 *   captures actually rotate into drops.
 * A DB trigger (0004) backfills/syncs the column going forward, so over time
 * every row carries the column and the meta fallback becomes dead code — but
 * the fallback MUST stay for old rows / direct DB writes.
 */
export interface BasePhotoPoseRow {
  pose?: unknown;
  pose_meta?: { pose?: unknown } | null;
}

export function resolveBasePhotoPose(row: BasePhotoPoseRow): ReelPose | null {
  if (isReelPose(row.pose)) return row.pose;
  const metaPose = (row.pose_meta as { pose?: unknown } | null | undefined)?.pose;
  if (isReelPose(metaPose)) return metaPose;
  return null;
}

/** weekOf must be YYYY-MM-DD and a Monday (throws 400 otherwise). */
export function assertMondayWeek(weekOf: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    throw badRequest("week_invalid", "weekOf must be YYYY-MM-DD (a Monday)");
  }
  if (Number.isNaN(Date.parse(`${weekOf}T12:00:00Z`))) {
    throw badRequest("week_invalid", "weekOf is not a real calendar date", { weekOf });
  }
  const day = new Date(`${weekOf}T12:00:00Z`).getUTCDay();
  if (day !== 1) {
    throw badRequest("week_not_monday", "weekOf must be a Monday (YYYY-MM-DD)", { weekOf });
  }
}

export function addDaysIso(weekOf: string, n: number): string {
  const d = new Date(`${weekOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Per-card idempotency key: sha256(user|weekOf|dayIndex). */
export function buildReelKey(userId: string, weekOf: string, dayIndex: number): Promise<string> {
  return sha256Hex([userId, weekOf, String(dayIndex)]);
}

function metaPose(meta: Record<string, unknown>): ReelPose | undefined {
  const p = meta["pose"];
  return isReelPose(p) ? p : undefined;
}

function metaTrendTag(
  meta: Record<string, unknown>,
  fallback: string | null | undefined,
): string | undefined {
  const t = meta["trend_tag"];
  if (typeof t === "string" && t.length > 0) return t.slice(0, 64);
  if (typeof fallback === "string" && fallback.length > 0) return fallback.slice(0, 64);
  return undefined;
}

/** Map one render row (+ its outfit) to the exact ReelCard shape. */
export async function toReelCard(
  sb: SupabaseClient,
  row: ReelRenderRow,
  opts?: { cardId?: string; poseFallback?: ReelPose; trendFallback?: string | null },
): Promise<ReelCard> {
  const meta = (row.garment_refs?.meta ?? {}) as Record<string, unknown>;
  let garmentIds = Array.isArray(row.garment_refs?.garment_ids)
    ? (row.garment_refs?.garment_ids as string[]).filter((g): g is string => typeof g === "string")
    : [];
  let whyLine = "";
  if (row.outfit_id) {
    const { data: outfit } = await sb.from("outfits").select("id,garment_ids,why_line")
      .eq("id", row.outfit_id)
      .maybeSingle<{ id: string; garment_ids: string[]; why_line: string | null }>();
    if (outfit) {
      if (garmentIds.length === 0 && Array.isArray(outfit.garment_ids)) {
        garmentIds = outfit.garment_ids.filter((g): g is string => typeof g === "string");
      }
      whyLine = outfit.why_line ?? "";
    }
  }
  const done = row.status === "done";
  const cost = done ? (await renderCostUsd(sb, row.id)) ?? REEL_EST_COST_USD : REEL_EST_COST_USD;
  // Fresh 1h signed URL per response (0008) — cached clients self-heal on
  // their next refresh. Legacy rows (pre-0008) fall back to the stored URL.
  const imageUrl = (row.output_path
    ? await signedRenderUrl(sb, row.user_id, row.output_path)
    : row.output_url) ?? "";
  const card: ReelCard = {
    id: opts?.cardId ?? row.id,
    outfitId: row.outfit_id ?? "",
    renderId: row.id,
    imageUrl,
    pose: metaPose(meta) ?? opts?.poseFallback ?? "front",
    garmentIds,
    whyLine,
    costUsd: cost,
    createdAt: row.created_at,
  };
  const trend = metaTrendTag(meta, opts?.trendFallback);
  if (trend) card.trendTag = trend;
  return card;
}

interface ReelDropRow {
  week_of: string;
  tier: string;
  card_ids: string[];
  trend_tag: string | null;
}

/**
 * Single read path for POST replay + GET reel-week: reel_drops row → renders
 * (drop order = day_index asc at insert) → ReelCards. Vanished render rows
 * are skipped (no client delete path produces them; service_role cleanup only).
 */
export async function readWeeklyDrop(
  sb: SupabaseClient,
  userId: string,
  weekOf: string,
): Promise<WeeklyDrop | null> {
  const { data: drop, error } = await sb.from("reel_drops").select("week_of,tier,card_ids,trend_tag")
    .eq("user_id", userId).eq("week_of", weekOf)
    .maybeSingle<ReelDropRow>();
  if (error) throw error;
  if (!drop) return null;
  const tier: ReelTier = drop.tier === "full" ? "full" : "teaser";
  const ids = Array.isArray(drop.card_ids)
    ? drop.card_ids.filter((c): c is string => typeof c === "string")
    : [];
  if (ids.length === 0) return { weekOf: drop.week_of, cards: [], tier };
  const { data: rows, error: rErr } = await sb.from("renders")
    .select("id,user_id,outfit_id,output_url,output_path,status,created_at,garment_refs")
    .eq("user_id", userId).in("id", ids);
  if (rErr) throw rErr;
  const byId = new Map<string, ReelRenderRow>();
  for (const r of (rows ?? []) as ReelRenderRow[]) byId.set(r.id, r);
  const cards: ReelCard[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    cards.push(await toReelCard(sb, row, { trendFallback: drop.trend_tag }));
  }
  return { weekOf: drop.week_of, cards, tier };
}
