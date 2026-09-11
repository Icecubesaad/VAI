// Quota enforcement for VAI Edge Functions (Deno, strict TS).
// Single source of truth for the iron laws (mirrors consume_render_allowance):
//   FREE_LIFETIME_RENDERS = 5 (hard block, never daily refills)
//   PREMIUM_MONTHLY_RENDERS = 30 (never "unlimited")
//   HD/Max tier = consumable packs only (hd_credits), never subscription quota
//   Restyle = always 1 credit; free tier gets 1 restyle/day via render_quotas
// Quota is CONSUMED (RPC, row-locked) before queueing and REFUNDED only when a
// render terminally fails — failed predictions cost the user nothing.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { forbidden, paymentRequired } from "./http.ts";

export const FREE_LIFETIME_RENDERS = 5;
export const PREMIUM_MONTHLY_RENDERS = 30;
export const FREE_RESTYLES_PER_DAY = 1;
export const FREE_CLOSET_ITEMS = 50;
export const RESTYLE_MAX_PER_SESSION = 3;
/**
 * P1-2 — server weekly regen budget, mirrors the client
 * `MAX_REGENERATES_PER_WEEK = 3` (store/reel.ts). Server is truth: enforced in
 * the shared restyle core so BOTH `reel-regenerate` and direct `POST /restyle`
 * consume the same pool. Scope: ALL mode='restyle' renders (reel remixes +
 * general restyles) — counted in-code via the renders table, no schema needed.
 * Failed rows cost 0 (refunded) and do NOT consume weekly budget.
 */
export const RESTYLE_MAX_PER_WEEK = 3;

export type Tier = "free" | "premium";
export type RenderKind = "std" | "max";
/** Pool code returned by consume_render_allowance() — also the refund handle. */
export type PoolCode =
  | "ok_free"
  | "ok_monthly"
  | "ok_std_credit"
  | "ok_hd_credit";

export interface EntitlementState {
  tier: Tier;
  trialEndsAt: string | null;
  renewsAt: string | null;
  freeLifetimeUsed: number;
  periodRendersUsed: number;
  stdCredits: number;
  hdCredits: number;
  rendersLeft: number;
  canUseMax: boolean;
}

interface SubscriptionRow {
  status: string | null;
  trial_ends_at: string | null;
  renews_at: string | null;
}

interface EntitlementRow {
  free_lifetime_used: number;
  period_renders_used: number;
  std_credits: number;
  hd_credits: number;
}

export function isPremiumSub(s: SubscriptionRow | null, nowMs = Date.now()): boolean {
  if (!s) return false;
  if (s.status !== "trialing" && s.status !== "active") return false;
  const trial = s.trial_ends_at ? Date.parse(s.trial_ends_at) : 0;
  const renew = s.renews_at ? Date.parse(s.renews_at) : 0;
  return trial > nowMs || renew > nowMs;
}

export async function getEntitlementState(
  sb: SupabaseClient,
  userId: string,
): Promise<EntitlementState> {
  const [{ data: sub }, { data: ent }] = await Promise.all([
    sb.from("subscriptions").select("status,trial_ends_at,renews_at").eq("user_id", userId)
      .maybeSingle<SubscriptionRow>(),
    sb.from("entitlements")
      .select("free_lifetime_used,period_renders_used,std_credits,hd_credits").eq("user_id", userId)
      .maybeSingle<EntitlementRow>(),
  ]);
  const tier: Tier = isPremiumSub(sub) ? "premium" : "free";
  const e: EntitlementRow = ent ?? {
    free_lifetime_used: 0,
    period_renders_used: 0,
    std_credits: 0,
    hd_credits: 0,
  };
  const rendersLeft = tier === "free"
    ? Math.max(0, FREE_LIFETIME_RENDERS - e.free_lifetime_used)
    : Math.max(0, PREMIUM_MONTHLY_RENDERS - e.period_renders_used);
  return {
    tier,
    trialEndsAt: sub?.trial_ends_at ?? null,
    renewsAt: sub?.renews_at ?? null,
    freeLifetimeUsed: e.free_lifetime_used,
    periodRendersUsed: e.period_renders_used,
    stdCredits: e.std_credits,
    hdCredits: e.hd_credits,
    rendersLeft,
    canUseMax: e.hd_credits > 0,
  };
}

/**
 * Atomically consume one allowance unit for a render. Throws 402 with a
 * paywall payload when no pool can cover it. Returns the pool code for refund.
 */
export async function consumeAllowance(
  sb: SupabaseClient,
  userId: string,
  kind: RenderKind,
): Promise<PoolCode> {
  const { data, error } = await sb.rpc("consume_render_allowance", {
    p_user: userId,
    p_kind: kind,
    p_credits: 1,
  });
  if (error) throw error;
  const code = data as string;
  switch (code) {
    case "ok_free":
    case "ok_monthly":
    case "ok_std_credit":
    case "ok_hd_credit":
      return code;
    case "hd_requires_pack":
      throw paymentRequired("hd_requires_pack",
        "HD try-ons use credit packs — they're never included in Premium.", { kind });
    case "free_exhausted":
      throw paymentRequired("free_exhausted",
        "You've used all 5 free try-ons. Upgrade for 30 renders a month.", { kind });
    case "monthly_exhausted":
      throw paymentRequired("monthly_exhausted",
        "You've used all 30 renders this month. Top up with a credit pack.", { kind });
    default:
      throw paymentRequired("quota_exhausted", "Render quota exhausted.", { kind });
  }
}

/** Refund a consumed allowance (terminal render failure only). Never throws. */
export async function refundAllowance(
  sb: SupabaseClient,
  userId: string,
  pool: PoolCode,
): Promise<void> {
  const { error } = await sb.rpc("refund_render_allowance", {
    p_user: userId,
    p_pool: pool,
    p_credits: 1,
  });
  if (error) console.error("[quota] refund failed", { userId, pool, error: error.message });
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Monday (YYYY-MM-DD, UTC) of the week containing `d` — the weekly-budget key.
 * Mirrors the client `mondayOf()` (store/reel.ts) exactly (UTC, Monday-start)
 * so client and server reset on the same boundary.
 */
export function mondayOfUTC(d = new Date()): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - daysSinceMonday);
  return utc.toISOString().slice(0, 10);
}

/**
 * P1-2 — weekly restyle budget check (all tiers, server is truth).
 * Counts non-failed mode='restyle' renders since Monday 00:00 UTC; throws 403
 * `restyle_weekly_cap` (budget, NOT paywall — mirrors the session-cap shape)
 * when the 3/week pool is exhausted. Call AFTER the idempotency lookup so
 * idempotent replays (0 cost) never consume budget and are never blocked.
 * Returns the pre-request usage count.
 */
export async function checkRestyleWeeklyCap(
  sb: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<number> {
  const weekStart = mondayOfUTC(now);
  const { count, error } = await sb.from("renders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("mode", "restyle")
    .gte("created_at", `${weekStart}T00:00:00Z`)
    .neq("status", "failed");
  if (error) throw error;
  const used = count ?? 0;
  if (used >= RESTYLE_MAX_PER_WEEK) {
    throw forbidden("restyle_weekly_cap",
      "Weekly remix budget used — 3 per week, resets Monday.",
      { used, limit: RESTYLE_MAX_PER_WEEK, week_of: weekStart, resets_monday: true });
  }
  return used;
}

/**
 * Free tier: 1 restyle/day (render_quotas.restyles). Premium: restyles draw from
 * the normal monthly/credit allowance (consumed separately via consumeAllowance).
 * Returns today's restyle count. Throws 402/403 when the free daily slot is gone.
 */
export async function checkFreeRestyleDaily(
  sb: SupabaseClient,
  userId: string,
  tier: Tier,
): Promise<number> {
  const day = todayISO();
  const { data } = await sb.from("render_quotas").select("restyles").eq("user_id", userId)
    .eq("day", day).maybeSingle<{ restyles: number }>();
  const used = data?.restyles ?? 0;
  if (tier === "free" && used >= FREE_RESTYLES_PER_DAY) {
    throw paymentRequired("restyle_daily_exhausted",
      "Free includes 1 restyle a day. Upgrade for 30 renders a month.", { used });
  }
  return used;
}

/**
 * Increment today's restyle counter (free tier accounting) via the atomic
 * `bump_restyle_daily` RPC (0002, SEC-009) — a single-statement upsert, so
 * concurrent restyles cannot double-spend the 1/day free slot (P1-009).
 * Returns the post-bump count. Falls back to legacy read-modify-write only
 * if the RPC is missing (pre-0002 database) — callers must still treat the
 * return value as authoritative, never re-read-then-decide.
 */
export async function bumpRestyleDaily(
  sb: SupabaseClient,
  userId: string,
): Promise<number> {
  const day = todayISO();
  const { data, error } = await sb.rpc("bump_restyle_daily", {
    p_user: userId,
    p_day: day,
  });
  if (!error && typeof data === "number") return data;
  if (error) console.error("[quota] bump_restyle_daily RPC failed, legacy fallback", error.message);
  const { data: row } = await sb.from("render_quotas").select("restyles").eq("user_id", userId)
    .eq("day", day).maybeSingle<{ restyles: number }>();
  if (!row) {
    const { error: insErr } = await sb.from("render_quotas")
      .insert({ user_id: userId, day, restyles: 1 });
    if (insErr) console.error("[quota] restyle bump insert failed", insErr.message);
    return 1;
  }
  const { error: updErr } = await sb.from("render_quotas").update({ restyles: row.restyles + 1 })
    .eq("user_id", userId).eq("day", day);
  if (updErr) console.error("[quota] restyle bump update failed", updErr.message);
  return row.restyles + 1;
}

/** Free tier closet cap: 50 items (soft-deleted rows don't count). */
export async function checkClosetCap(sb: SupabaseClient, userId: string, tier: Tier): Promise<number> {
  const { count, error } = await sb.from("garments").select("id", { count: "exact", head: true })
    .eq("user_id", userId).is("deleted_at", null);
  if (error) throw error;
  const used = count ?? 0;
  if (tier === "free" && used >= FREE_CLOSET_ITEMS) {
    throw forbidden("closet_full",
      "Free closets hold 50 items. Upgrade or remove something to add more.",
      { used, limit: FREE_CLOSET_ITEMS });
  }
  return used;
}
