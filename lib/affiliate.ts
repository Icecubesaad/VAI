/**
 * VAI · affiliate commerce client (integrations turf).
 *
 * Aggregator-first (BUILD-PACK §7): ShopStyle Collective + LTK + Skimlinks
 * behind ONE server-side resolver (`aff_link_resolver` in the `shop-picks`
 * edge fn). Attribution: `subid=user_id` on every outbound URL.
 *
 * Affiliate = physical goods only → IAP-exempt (Apple/Google 30% does not
 * apply). Never sell affiliate goods through RevenueCat / in-app checkout.
 *
 * SECRETS (server-only, never here): SHOPSTYLE_KEY, LTK_AFFILIATE_ID,
 * SKIMLINKS_ACCOUNT (+ publisher tokens). The client only ever sees the
 * signed affiliate_url the server returns.
 */

import { callEdgeFunction, generateIdempotencyKey } from './edge';
import type { EdgeCallOptions } from './edge';
import { cosineSimilarity } from './ai/tagging';
import { track } from './analytics';

/** Store-compliance disclosure (pack §9) — render on EVERY shop card + footer. */
export const AFFILIATE_DISCLOSURE = 'We may earn commission — no extra cost to you.';
export const AFFILIATE_DISCLOSURE_PAGE = 'vai://shop/disclosure';

export const AFFILIATE_NETWORKS = ['shopstyle', 'ltk', 'skimlinks'] as const;
export type AffiliateNetwork = (typeof AFFILIATE_NETWORKS)[number];

export type ShopBadge = 'Fills gap' | 'Own similar';

export interface AffiliateProduct {
  retailer: string;
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  currency?: string;
  rating?: number;
  affiliateUrl: string;
  network: AffiliateNetwork;
  valueAddReason?: string;
  badge?: ShopBadge;
}

export interface ShopPicksInput {
  userId: string;
  outfitId?: string;
  /** Gap category from closet insights (e.g. "red tops"). */
  gap?: string;
  budgetBand?: string;
  limit?: number;
}

export interface TryOnToBuyInput {
  userId: string;
  renderId: string;
  product: Pick<AffiliateProduct, 'productId' | 'retailer' | 'price' | 'affiliateUrl'>;
  subTier: 'free' | 'premium';
}

export interface TryOnToBuyResult {
  /** click_id for the render_id → click_id attribution chain (pack §7). */
  clickId: string;
  outboundUrl: string;
}

async function newClickId(userId: string, renderId: string, productId: string): Promise<string> {
  const Crypto = (await import('expo-crypto')) as unknown as {
    randomUUID?: () => string;
  };
  const rand = Crypto.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const h = await generateIdempotencyKey([userId, renderId, productId, rand]);
  return h.slice(0, 32);
}

/**
 * Fetch picks via the `shop-picks` edge fn. The server signs URLs with
 * subid=user_id; the client never constructs affiliate URLs from scratch.
 */
export async function getShopPicks(
  input: ShopPicksInput,
  edgeOpts: EdgeCallOptions = {},
): Promise<AffiliateProduct[]> {
  const key = await generateIdempotencyKey([
    input.userId,
    input.outfitId ?? input.gap ?? 'browse',
    'shop-picks',
    // Budget/limit/gap changes were deduped to the first query's cached picks.
    input.budgetBand ?? '',
    String(input.limit ?? ''),
  ]);
  const res = await callEdgeFunction<{ picks: AffiliateProduct[] }>(
    'shop-picks',
    {
      user_id: input.userId,
      outfit_id: input.outfitId,
      gap: input.gap,
      budget_band: input.budgetBand,
      limit: input.limit ?? 12,
    },
    { timeoutMs: 20_000, retries: 1, ...edgeOpts, idempotencyKey: key },
  );
  return res.picks;
}

// ------------------------------------------------------- triggers

/**
 * Gap-fill trigger: show the gap carousel when a category has ≤ threshold
 * owned items (closet insights banner "6 black tops, no red" feeds this).
 */
export function shouldShowGapFill(
  ownedCountInCategory: number,
  threshold = 1,
): { show: boolean; reason?: string } {
  if (ownedCountInCategory <= threshold) {
    return { show: true, reason: `Only ${ownedCountInCategory} owned in this category — gap fill.` };
  }
  return { show: false };
}

export interface ClosetEmbedding {
  garmentId: string;
  embedding: readonly number[];
}

/**
 * Owned-complement trigger: a product earns the "Own similar" badge when its
 * embedding is within `threshold` cosine similarity of something owned
 * (default 0.82 — tune from commission/return data, never hardcode per-SKU).
 */
export function findOwnedComplement(
  productEmbedding: readonly number[],
  closet: ClosetEmbedding[],
  threshold = 0.82,
): { garmentId: string; similarity: number } | null {
  let best: { garmentId: string; similarity: number } | null = null;
  for (const c of closet) {
    let sim: number;
    try {
      sim = cosineSimilarity(productEmbedding, c.embedding);
    } catch {
      continue; // dim mismatch on one item must not kill the whole match
    }
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { garmentId: c.garmentId, similarity: sim };
    }
  }
  return best;
}

// ------------------------------------------------------- try-on → buy

/**
 * Try-on-to-buy (pack §7): the user buys AFTER seeing the render. Logs the
 * render_id → click_id chain twice — server-side (`shop-picks` click action,
 * best-effort) and PostHog `affiliate_click` (analytics source of truth) —
 * then returns the outbound URL for the in-app browser.
 */
export async function logTryOnToBuy(
  input: TryOnToBuyInput,
  edgeOpts: EdgeCallOptions = {},
): Promise<TryOnToBuyResult> {
  const clickId = await newClickId(input.userId, input.renderId, input.product.productId);
  // Server already signs subid=user_id; re-append defensively (idempotent).
  const outboundUrl = buildOutboundUrl(input.product.affiliateUrl, { clickId, subId: input.userId }) || input.product.affiliateUrl;
  // Server attribution is best-effort: a failed click-log must never block checkout.
  try {
    await callEdgeFunction('shop-picks', {
      action: 'click',
      user_id: input.userId,
      render_id: input.renderId,
      click_id: clickId,
      product_id: input.product.productId,
      retailer: input.product.retailer,
    }, { timeoutMs: 10_000, retries: 0, ...edgeOpts });
  } catch (e) {
    if (__DEV__) console.warn('[affiliate] click-log failed (non-blocking):', e);
  }
  track('affiliate_click', {
    user_id: input.userId,
    tier: input.subTier,
    render_id: input.renderId,
    click_id: clickId,
    product_id: input.product.productId,
    retailer: input.product.retailer,
    price: input.product.price,
  });
  return { clickId, outboundUrl };
}

/**
 * Append attribution params to a signed affiliate URL. Pass the server's
 * affiliateUrl as `base`; empty base returns '' (caller falls back to the
 * raw server URL). Never strips existing params (network signature intact).
 */
export function buildOutboundUrl(
  base: string,
  params: { clickId: string; subId: string },
): string {
  if (!base) return '';
  try {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}subid=${encodeURIComponent(params.subId)}&click_id=${encodeURIComponent(params.clickId)}`;
  } catch {
    return base;
  }
}
