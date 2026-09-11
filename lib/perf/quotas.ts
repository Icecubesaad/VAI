/**
 * VAI perf — client mirror of server render quotas.
 *
 * IRON LAW: the server (`render-tryon` quota check + ledger) is the ONLY
 * granter. This module is a latency-hiding mirror that lets the UI hard-block
 * at 0 INSTANTLY (upgrade sheet, no wasted 10-55s queue hop) and reconcile
 * when the server answers. There is deliberately NO method here that adds
 * credits — if you need one, you are building a bypass. Don't.
 *
 * Caps (BUILD-PACK §7, mirrored from backend — change in both places):
 *  free:    5 LIFETIME renders, then hard paywall. Never daily refills.
 *  premium: 30 renders / month. Never "unlimited".
 *  packs:   consumable std credits (10 / 25) + HD single (Max tier).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { paywallCache, quotaCache, type StoredPaywall, type StoredQuota } from './cache';

// ---------------------------------------------------------------------------
// Constants (must match backend quotas + PERF-BUDGETS.md cost table)
// ---------------------------------------------------------------------------

export const FREE_LIFETIME_RENDER_CAP = 5;
export const FREE_CLOSET_ITEM_CAP = 50;
export const PREMIUM_MONTHLY_RENDER_CAP = 30;

export const COST_STD_USD = 0.067;
export const COST_FALLBACK_STD_USD = 0.075;
export const COST_MAX_USD_MIN = 0.15;
export const COST_MAX_USD_MAX = 0.38;

export type Tier = 'free' | 'trial' | 'premium';

export type QuotaBlockReason =
  | 'free_lifetime_exhausted' // 6th render -> upgrade sheet (acceptance gate)
  | 'monthly_exhausted'; // premium 30/mo spent -> packs or wait

export interface PaywallStatusResponse {
  tier: 'free' | 'premium';
  trial_ends_at: string | null;
  quotas_left: { renders: number };
  lifetime_renders_used: number;
  monthly_renders_used: number;
  pack_credits: number;
  resets_at: string | null;
  product_id: string | null;
  subscription_status: string | null;
}

export interface QuotaSnapshot extends StoredQuota {
  tier: Tier;
}

interface QuotaState {
  snapshot: QuotaSnapshot | null;
  lastSyncedAt: number | null;
  /** Overwrite mirror from a `paywall-status` response. Server wins, always. */
  syncFromServer: (s: PaywallStatusResponse) => void;
  /**
   * Optimistic decrement for instant badge updates ("4 of 5 left").
   * Returns false when already at 0 (caller must treat as blocked).
   */
  consumeOptimistic: () => boolean;
  /** Server answered with the true remainder — overwrite, clear drift. */
  reconcileServerLeft: (rendersLeft: number) => void;
  /** Pure read: may the UI offer Generate right now? */
  canRender: () => boolean;
  blockedReason: () => QuotaBlockReason | null;
  /**
   * THE gate. Every render entry point (try-on Generate, restyle, compare)
   * MUST call this first. Returns true when the tap may proceed; on false it
   * fires `onBlocked` (upgrade sheet) and the caller MUST NOT submit.
   */
  guard: (placement: string) => boolean;
}

function tierOf(s: PaywallStatusResponse): Tier {
  if (s.tier === 'premium') {
    return s.trial_ends_at && Date.parse(s.trial_ends_at) > Date.now()
      ? 'trial'
      : 'premium';
  }
  return 'free';
}

export function snapshotFromServer(s: PaywallStatusResponse): QuotaSnapshot {
  const tier = tierOf(s);
  const lifetimeCap = tier === 'free' ? FREE_LIFETIME_RENDER_CAP : null;
  const monthlyCap = tier === 'free' ? 0 : PREMIUM_MONTHLY_RENDER_CAP;
  return {
    tier,
    rendersLeft: Math.max(0, s.quotas_left.renders),
    monthlyUsed: s.monthly_renders_used,
    monthlyCap,
    lifetimeUsed: s.lifetime_renders_used,
    lifetimeCap,
    packCredits: s.pack_credits,
    resetsAt: s.resets_at,
    syncedAt: Date.now(),
  };
}

export function createQuotaStore(opts: {
  onBlocked: (reason: QuotaBlockReason, placement: string) => void;
}): StoreApi<QuotaState> {
  // quotaCache stores QuotaSnapshots (written by syncFromServer) but is typed
  // as StoredQuota — re-attach the required `tier`, dropping stale typeless rows.
  const cached = quotaCache.get() as (StoredQuota & { tier?: unknown }) | null;
  const initial: QuotaSnapshot | null =
    cached !== null && (cached.tier === 'free' || cached.tier === 'trial' || cached.tier === 'premium')
      ? (cached as QuotaSnapshot)
      : null;
  return createStore<QuotaState>()((set, get) => ({
    snapshot: initial,
    lastSyncedAt: initial?.syncedAt ?? null,

    syncFromServer: (s) => {
      const snapshot = snapshotFromServer(s);
      quotaCache.set(snapshot);
      const paywall: StoredPaywall = {
        tier: snapshot.tier,
        trialEndsAt: s.trial_ends_at,
        productId: s.product_id,
        status: s.subscription_status,
        syncedAt: Date.now(),
      };
      paywallCache.set(paywall);
      set({ snapshot, lastSyncedAt: Date.now() });
    },

    consumeOptimistic: () => {
      const { snapshot } = get();
      if (!snapshot || snapshot.rendersLeft <= 0) return false;
      const next = { ...snapshot, rendersLeft: snapshot.rendersLeft - 1 };
      quotaCache.set(next); // keep the mirror consistent for relaunch
      set({ snapshot: next });
      return true;
    },

    reconcileServerLeft: (rendersLeft) => {
      const { snapshot } = get();
      if (!snapshot) return;
      const next = { ...snapshot, rendersLeft: Math.max(0, rendersLeft) };
      quotaCache.set(next);
      set({ snapshot: next });
    },

    canRender: () => {
      const { snapshot } = get();
      return !!snapshot && snapshot.rendersLeft > 0;
    },

    blockedReason: () => {
      const { snapshot } = get();
      if (!snapshot || snapshot.rendersLeft > 0) return null;
      return snapshot.tier === 'free'
        ? 'free_lifetime_exhausted'
        : 'monthly_exhausted';
    },

    guard: (placement) => {
      const { canRender, blockedReason } = get();
      if (canRender()) return true;
      opts.onBlocked(blockedReason() ?? 'free_lifetime_exhausted', placement);
      return false;
    },
  }));
}

// ---------------------------------------------------------------------------
// Display copy (single source so badge + sheet + push agree)
// ---------------------------------------------------------------------------

export function quotaBadgeCopy(s: QuotaSnapshot | null): string {
  if (!s) return 'Checking renders…';
  if (s.tier === 'free' && s.lifetimeCap !== null) {
    return `${s.rendersLeft} of ${s.lifetimeCap} free renders left`;
  }
  return `${s.rendersLeft} renders left this month`;
}

export const QUOTA_BLOCK_COPY: Record<QuotaBlockReason, { title: string; body: string }> = {
  free_lifetime_exhausted: {
    title: 'You used your 5 free try-ons',
    body: 'Go Premium for 30 renders a month, or grab a credit pack for one-off HD looks.',
  },
  monthly_exhausted: {
    title: 'Monthly renders used up',
    body: 'Top up with a credit pack, or wait for your reset — your closet and outfits stay intact.',
  },
};

// ---------------------------------------------------------------------------
// React binding (frontend). Non-React callers use the vanilla store directly.
// ---------------------------------------------------------------------------

export function useQuota(
  store: StoreApi<QuotaState>,
): QuotaState;
export function useQuota<T>(
  store: StoreApi<QuotaState>,
  selector: (s: QuotaState) => T,
): T;
export function useQuota<T>(
  store: StoreApi<QuotaState>,
  selector?: (s: QuotaState) => T,
): QuotaState | T {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return selector
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      useStore(store, selector)
    : // eslint-disable-next-line react-hooks/rules-of-hooks
      useStore(store, (s) => s);
}

// ---------------------------------------------------------------------------
// Weekly-drop pool mirror (ADDITIVE — touches nothing above).
//
// The weekly drop is a server-granted pool (backend turf): each week ships
// one 7-card drop. Free sees a 3-card std teaser (CAC); premium unlocks all
// 7 against the 30/mo pool. Max-pose variants are FORBIDDEN in drops
// (cost control) — std tier only. This module is a latency-hiding READ
// mirror: parse + display + block-copy. The server remains the only granter;
// there is deliberately NO method here that adds weekly renders.
// ---------------------------------------------------------------------------

/** Free teaser: 3 std cards × $0.067 = $0.201 → ~$0.20 CAC per free user. */
export const WEEKLY_DROP_FREE_TEASER_COUNT = 3;
/** Premium: full 7-card drop, drawn from the 30/mo pool (never extra). */
export const WEEKLY_DROP_PREMIUM_COUNT = 7;
/** 3 × COST_STD_USD — server spend per free teaser served. */
export const WEEKLY_DROP_TEASER_COST_USD = 3 * COST_STD_USD;
/** 7 × COST_STD_USD = $0.469 → ~$0.47 against the 30/mo pool. */
export const WEEKLY_DROP_PREMIUM_COST_USD = 7 * COST_STD_USD;

/** Drops are std-only. Max-pose variants are forbidden in drops, always. */
export const WEEKLY_DROP_ALLOWED_TIERS = ['std'] as const;
export type WeeklyDropTier = (typeof WEEKLY_DROP_ALLOWED_TIERS)[number];
export const WEEKLY_DROP_ALLOW_MAX_POSE = false as const;

export function isWeeklyDropTierAllowed(tier: string): tier is WeeklyDropTier {
  return (WEEKLY_DROP_ALLOWED_TIERS as readonly string[]).includes(tier);
}

/** Client mirror of the server's weekly-drop allowance for this user/week. */
export interface WeeklyPoolSnapshot {
  /** Opaque week id from the server (e.g. `2026-W37`, Monday-anchored). */
  weekId: string;
  rendersLeft: number;
  rendersCap: number;
  syncedAt: number;
}

export type WeeklyDropBlockReason =
  | 'weekly_drop_exhausted' // week's cards spent → wait for next drop
  | 'weekly_drop_stale'; // weekId rolled over locally → re-sync, server wins

/**
 * Tolerant parser for the `weekly_pool` block of a `paywall-status`
 * response. Returns null when absent/malformed (caller treats as "no weekly
 * pool advertised" — never as granted). Server wins, always.
 */
export function weeklyPoolFromServer(input: unknown): WeeklyPoolSnapshot | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o['weekId'] !== 'string' || o['weekId'].length === 0) return null;
  if (typeof o['rendersLeft'] !== 'number' || typeof o['rendersCap'] !== 'number') {
    return null;
  }
  return {
    weekId: o['weekId'],
    rendersLeft: Math.max(0, Math.floor(o['rendersLeft'])),
    rendersCap: Math.max(0, Math.floor(o['rendersCap'])),
    syncedAt: Date.now(),
  };
}

/** Pure read: may the UI offer this week's drop card right now? */
export function canUseWeeklyDrop(pool: WeeklyPoolSnapshot | null): boolean {
  return !!pool && pool.rendersLeft > 0;
}

export function weeklyDropBlockedReason(
  pool: WeeklyPoolSnapshot | null,
  currentWeekId: string | null,
): WeeklyDropBlockReason | null {
  if (!pool) return null; // no pool advertised — not a weekly-drop surface
  if (currentWeekId !== null && pool.weekId !== currentWeekId) {
    return 'weekly_drop_stale';
  }
  return pool.rendersLeft > 0 ? null : 'weekly_drop_exhausted';
}

/** Cards visible for a tier this week (teaser vs full drop). */
export function weeklyDropVisibleCount(tier: Tier): number {
  return tier === 'free' ? WEEKLY_DROP_FREE_TEASER_COUNT : WEEKLY_DROP_PREMIUM_COUNT;
}

export const WEEKLY_DROP_BLOCK_COPY: Record<
  WeeklyDropBlockReason,
  { title: string; body: string }
> = {
  weekly_drop_exhausted: {
    title: "This week's drop is all yours",
    body: 'New looks land every week — your closet and outfits stay intact until then.',
  },
  weekly_drop_stale: {
    title: 'A fresh drop just landed',
    body: 'Syncing your weekly looks — one moment.',
  },
};
