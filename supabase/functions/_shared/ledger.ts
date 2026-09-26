// Ledger writer (Deno, strict TS).
// `ledger` is the money source of truth; `entitlements` is the fast counter.
// Conventions: costs are NEGATIVE amount_cents, grants/purchases POSITIVE.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type LedgerType =
  | "sub"
  | "affiliate_cashback"
  | "referral_credit"
  | "render_cost";

export async function writeLedger(
  sb: SupabaseClient,
  entry: {
    userId: string;
    type: LedgerType;
    amountCents: number;
    meta?: Record<string, unknown>;
    required?: boolean;
  },
): Promise<void> {
  const { error } = await sb.from("ledger").insert({
    user_id: entry.userId,
    type: entry.type,
    amount_cents: entry.amountCents,
    meta: entry.meta ?? {},
  });
  if (error) {
    const { required, ...loggedEntry } = entry;
    console.error("[ledger] write failed", {
      ...loggedEntry,
      error: error.message,
    });
    if (required) throw error;
  }
}

export async function logRenderCost(
  sb: SupabaseClient,
  opts: {
    userId: string;
    renderId: string;
    provider: string;
    tier: string;
    pool: string;
    costUsd: number;
    latencyMs: number;
    gpuRuntimeSeconds?: number;
    required?: boolean;
  },
): Promise<void> {
  const meta: Record<string, unknown> = {
    render_id: opts.renderId,
    provider: opts.provider,
    tier: opts.tier,
    pool: opts.pool,
    latency_ms: opts.latencyMs,
  };
  if (opts.gpuRuntimeSeconds !== undefined) {
    meta.worker_runtime_seconds = opts.gpuRuntimeSeconds;
    meta.cost_basis = "worker_runtime_plus_startup_reserve";
  }
  await writeLedger(sb, {
    userId: opts.userId,
    type: "render_cost",
    amountCents: -Math.round(opts.costUsd * 100),
    meta,
    required: opts.required,
  });
}

/** Referral / promo grants are $0 ledger memos (audit trail for the 12mo cap). */
export async function logReferralGrant(
  sb: SupabaseClient,
  userId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeLedger(sb, {
    userId,
    type: "referral_credit",
    amountCents: 0,
    meta,
  });
}

/** Credit-pack purchase memo (revenue truth lives in RevenueCat/Stripe webhooks). */
export async function logPackPurchase(
  sb: SupabaseClient,
  userId: string,
  meta: { pack: string; std?: number; hd?: number; platform: string },
): Promise<void> {
  await writeLedger(sb, {
    userId,
    type: "sub",
    amountCents: 0,
    meta: { kind: "pack", ...meta },
  });
}

/** Sum of today's render COGS in USD (for MAX_DAILY_SPEND_USD guard). */
export async function todaySpendUsd(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await sb.from("ledger").select("amount_cents")
    .eq("type", "render_cost").gte("created_at", start.toISOString());
  if (error || !data) return 0;
  const rows = data as Array<{ amount_cents: number }>;
  return rows.reduce((sum, r) => sum + Math.abs(r.amount_cents), 0) / 100;
}

/**
 * Authoritative per-render cost in USD (positive number) for status/poll
 * responses. render_cost memos store NEGATIVE amount_cents; absent memo
 * (queued/cached rows) → null so callers can distinguish "free" from
 * "unknown".
 */
export async function renderCostUsd(
  sb: SupabaseClient,
  renderId: string,
): Promise<number | null> {
  const { data, error } = await sb.from("ledger").select("amount_cents")
    .eq("type", "render_cost").filter("meta->>render_id", "eq", renderId)
    .order("created_at", { ascending: false }).limit(1)
    .maybeSingle<{ amount_cents: number }>();
  if (error || !data) return null;
  return Math.abs(data.amount_cents) / 100;
}
