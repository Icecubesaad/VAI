/**
 * VAI · RevenueCat billing client (integrations turf).
 *
 * Entitlement: `premium`. Products (BUILD-PACK §7 — ship these, not the
 * blueprint numbers; Apple 30% baked in, 15% small-biz noted where relevant):
 * - vai_premium_monthly  $4.99  (net ≈$3.49)
 * - vai_premium_yearly   $39.99 (floor — blueprint's $29.99/yr was suicide)
 * - vai_credits_10       $1.99  (10 std renders)
 * - vai_credits_25       $4.99  (25 std renders)
 * - vai_hd_single        $0.99  (1 HD/Max render — packs only, never in sub)
 * Trial: 7-day full Premium, card required (store-configured intro offer).
 * Free: 50 items · 1 outfit/day · 5 LIFETIME renders, then hard paywall.
 * Premium: 30 renders/mo included (~1/day), NEVER "unlimited".
 *
 * Source of truth for tier/quotas is the server (`paywall-status` edge fn);
 * RevenueCat CustomerInfo is merged client-side for renewal UI only.
 *
 * SECRETS: RevenueCat PUBLIC SDK keys are EXPO_PUBLIC_REVENUECAT_IOS_KEY /
 * EXPO_PUBLIC_REVENUECAT_ANDROID_KEY (safe client-side). The RC SECRET key
 * stays server-side (webhooks). This module never handles card data.
 *
 * DEP: react-native-purchases (native module — EAS dev-client required,
 * Expo Go cannot run it). Purchases is lazy-imported so importing this
 * module never crashes Expo Go / Jest.
 */

import { Platform } from 'react-native';
import { callEdgeFunction } from './edge';
import type { EdgeCallOptions } from './edge';

export const ENTITLEMENT_ID = 'premium' as const;

export const PRODUCT_IDS = {
  monthly: 'vai_premium_monthly',
  yearly: 'vai_premium_yearly',
  credits10: 'vai_credits_10',
  credits25: 'vai_credits_25',
  hdSingle: 'vai_hd_single',
} as const;
export type ProductId = (typeof PRODUCT_IDS)[keyof typeof PRODUCT_IDS];

export interface CreditPack {
  id: Extract<ProductId, 'vai_credits_10' | 'vai_credits_25' | 'vai_hd_single'>;
  credits: number;
  hd: boolean;
  priceDisplay: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: PRODUCT_IDS.credits10, credits: 10, hd: false, priceDisplay: '$1.99' },
  { id: PRODUCT_IDS.credits25, credits: 25, hd: false, priceDisplay: '$4.99' },
  { id: PRODUCT_IDS.hdSingle, credits: 1, hd: true, priceDisplay: '$0.99' },
];

export const SUBSCRIPTION_PRICES = {
  [PRODUCT_IDS.monthly]: '$4.99/mo',
  [PRODUCT_IDS.yearly]: '$39.99/yr',
} as const;

/** Honest same-screen trial copy (pack §7) — render adjacent to the CTA. */
export const TRIAL_COPY = {
  title: '7 days free, then $4.99/mo',
  body: 'Full Premium for 7 days. Card required, no charge today. Cancel anytime in Settings — your closet and outfits are always kept.',
  reminder: 'We\u2019ll remind you 2 days before the trial ends.',
} as const;
export const TRIAL_DAYS = 7;
/** T+96h after trial start (= 2 days before end): push + email reminder. */
export const TRIAL_REMINDER_OFFSET_MS = 96 * 60 * 60 * 1000;

/** Win-back offer codes (pack §7). Codes themselves are configured in
 *  App Store Connect / Play Console; the strings here are the promo identifiers. */
export const WIN_BACK_OFFERS = {
  d3_50pct_2mo: { id: 'winback_d3_50pct_2mo', minDaysSinceChurn: 3, label: '50% off for 2 months' },
  d30_free_week: { id: 'winback_d30_free_week', minDaysSinceChurn: 30, label: '1 free Premium week, no card' },
} as const;
export type WinBackOfferId = keyof typeof WIN_BACK_OFFERS;

export type SubTier = 'free' | 'premium';

export interface PaywallStatus {
  tier: SubTier;
  trialing: boolean;
  trialEndsAt?: string;
  rendersLeft: number;
  rendersCap: number;
  quotaResetsAt: string;
  /** Renewal date from RevenueCat (display only). */
  renewsAt?: string;
  willRenew?: boolean;
}

export type BillingErrorCode =
  | 'user-cancelled'
  | 'network'
  | 'payment-deferred'
  | 'already-owned'
  | 'store-error'
  | 'not-configured'
  | 'purchase-invalid';

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly userCancelled: boolean;
  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.userCancelled = code === 'user-cancelled';
  }
}

// Minimal structural types for react-native-purchases (avoid hard dep at import).
interface RCPackage {
  identifier: string;
  product: { identifier: string };
}
interface RCOfferings {
  current?: { availablePackages: RCPackage[] } | null;
}
interface RCCustomerInfo {
  entitlements: { active: Record<string, { expirationDate?: string | null; willRenew?: boolean }> };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PurchasesModule = any;

let purchasesRef: PurchasesModule | null = null;
let configuredUserId: string | null = null;

async function loadPurchases(): Promise<PurchasesModule> {
  if (purchasesRef) return purchasesRef;
  try {
    const mod = await import('react-native-purchases');
    purchasesRef = mod.default ?? mod;
    return purchasesRef;
  } catch {
    throw new BillingError(
      'not-configured',
      'Purchases are not available in this build yet — your free renders still work.',
    );
  }
}

function publicKey(): string {
  if (Platform.OS === 'web') {
    // In-app purchases don't exist on web — short-circuit with the honest
    // not-configured error instead of falling through to the Android key.
    throw new BillingError(
      'not-configured',
      'Purchases are available in the mobile app — your free renders work here.',
    );
  }
  const key = Platform.OS === 'ios'
    ? process.env['EXPO_PUBLIC_REVENUECAT_IOS_KEY']
    : process.env['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'];
  if (!key) {
    throw new BillingError(
      'not-configured',
      'Purchases are not set up in this build yet — you can keep using free renders.',
    );
  }
  return key;
}

/**
 * Configure RevenueCat + bind the app user id (call once after login).
 * RevenueCat's contract is configure-ONCE per launch; a subsequent account
 * switch MUST go through `logIn` — re-calling `configure` is unsupported and
 * can misattribute purchases across accounts on a shared device.
 */
export async function initBilling(appUserId: string): Promise<void> {
  const Purchases = await loadPurchases();
  if (configuredUserId === null) {
    Purchases.configure({ apiKey: publicKey(), appUserID: appUserId });
    configuredUserId = appUserId;
  } else if (configuredUserId !== appUserId) {
    try {
      await Purchases.logIn(appUserId);
    } catch {
      // logIn can fail while offline — keep the previous attribution rather
      // than risk a misconfigured SDK; the next sign-in retries.
      return;
    }
    configuredUserId = appUserId;
  }
}

/**
 * Detach RevenueCat from the signed-out user (logout). Never throws — a
 * failed logOut must not block the rest of the logout wipe.
 */
export async function logOutBilling(): Promise<void> {
  if (configuredUserId === null) return;
  try {
    const Purchases = await loadPurchases();
    await Purchases.logOut();
  } catch {
    // Best-effort; configuredUserId stays so a later sign-in still switches.
  }
}

function mapPurchaseError(e: unknown): BillingError {
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error ? e.message : String(e);
  const c = typeof code === 'string' ? code : typeof code === 'number' ? String(code) : '';
  if (/USER_CANCELLED|1\b/.test(c) || /cancel/i.test(message)) {
    return new BillingError('user-cancelled', 'Purchase cancelled.');
  }
  if (/NETWORK|OFFLINE|TIMEOUT/i.test(c) || /network|offline|timeout/i.test(message)) {
    return new BillingError('network', 'Network error during purchase — nothing was charged. Try again.');
  }
  if (/PAYMENT_PENDING|DEFERRED/i.test(c)) {
    return new BillingError('payment-deferred', 'Payment is pending approval (e.g. Ask to Buy).');
  }
  if (/ALREADY_OWNED|ALREADY_PURCHASED/i.test(c)) {
    return new BillingError('already-owned', 'You already own this — restoring instead.');
  }
  return new BillingError('store-error', `Store error: ${message.slice(0, 200)}`);
}

/**
 * Canonical `paywall-status` server shape (flat camelCase — server wins):
 * `{ tier, trialing, trialEndsAt, renewsAt, rendersLeft, rendersCap,
 *    rendersUsedPeriod, quotaResetsAt, ..., hardBlocked }`.
 * snake_case fallbacks are read tolerantly during the transition; the
 * canonical camel names take precedence. (QA3 P0-1 — readers follow server.)
 */
interface PaywallStatusResponse {
  tier: SubTier;
  trialing: boolean;
  trialEndsAt?: string | null;
  trial_ends_at?: string;
  renewsAt?: string | null;
  rendersLeft?: number;
  renders_left?: number;
  rendersCap?: number;
  renders_cap?: number;
  quotaResetsAt?: string;
  quota_resets_at?: string;
}

/**
 * Fetch paywall state. Server (`paywall-status`) is the source of truth for
 * tier/trial/quotas; RevenueCat CustomerInfo only enriches renewal display.
 * Never gate on the client cache alone.
 */
export async function getPaywallStatus(
  params: { userId: string },
  edgeOpts: EdgeCallOptions = {},
): Promise<PaywallStatus> {
  const server = await callEdgeFunction<PaywallStatusResponse>(
    'paywall-status',
    { user_id: params.userId },
    { timeoutMs: 15_000, retries: 2, ...edgeOpts },
  );
  // Canonical camel first, snake fallback — server shape wins either way.
  const rendersLeft = server.rendersLeft ?? server.renders_left ?? 0;
  const rendersCap = server.rendersCap ?? server.renders_cap ?? 0;
  const status: PaywallStatus = {
    tier: server.tier,
    trialing: server.trialing,
    rendersLeft,
    rendersCap,
    quotaResetsAt: server.quotaResetsAt ?? server.quota_resets_at ?? '',
  };
  const trialEndsAt = server.trialEndsAt ?? server.trial_ends_at ?? undefined;
  if (typeof trialEndsAt === 'string') status.trialEndsAt = trialEndsAt;
  if (typeof server.renewsAt === 'string') status.renewsAt = server.renewsAt;
  try {
    const Purchases = await loadPurchases();
    const info = (await Purchases.getCustomerInfo()) as RCCustomerInfo;
    const ent = info.entitlements.active[ENTITLEMENT_ID];
    if (ent?.expirationDate) status.renewsAt = ent.expirationDate;
    if (ent?.willRenew !== undefined) status.willRenew = ent.willRenew;
  } catch {
    // Renewal display is best-effort; tier truth already came from server.
  }
  return status;
}

/** True when the free hard-paywall must show (5 lifetime renders consumed). */
export function isHardPaywalled(status: PaywallStatus): boolean {
  return status.tier === 'free' && status.rendersLeft <= 0;
}

async function purchasePackage(pkg: RCPackage): Promise<RCCustomerInfo> {
  const Purchases = await loadPurchases();
  try {
    const { customerInfo } = (await Purchases.purchasePackage(pkg)) as { customerInfo: RCCustomerInfo };
    return customerInfo;
  } catch (e) {
    throw mapPurchaseError(e);
  }
}

async function findPackage(productId: ProductId): Promise<RCPackage> {
  const Purchases = await loadPurchases();
  const offerings = (await Purchases.getOfferings()) as RCOfferings;
  const pkgs = offerings.current?.availablePackages ?? [];
  const found = pkgs.find(
    (p) => p.identifier === productId || p.product.identifier === productId,
  );
  if (!found) {
    throw new BillingError(
      'not-configured',
      `Product ${productId} not found in the current RevenueCat offering. Check the RC dashboard + store configuration.`,
    );
  }
  return found;
}

export async function purchaseSubscription(productId: ProductId): Promise<RCCustomerInfo> {
  return purchasePackage(await findPackage(productId));
}

export async function purchaseCreditPack(packId: CreditPack['id']): Promise<RCCustomerInfo> {
  return purchasePackage(await findPackage(packId));
}

/** Restore previous purchases (Settings + paywall "Restore" row). */
export async function restorePurchases(): Promise<RCCustomerInfo> {
  const Purchases = await loadPurchases();
  try {
    return (await Purchases.restorePurchases()) as RCCustomerInfo;
  } catch (e) {
    throw mapPurchaseError(e);
  }
}

/** Active premium (incl. trial) per RevenueCat — display helper only. */
export function hasPremiumEntitlement(info: RCCustomerInfo): boolean {
  return ENTITLEMENT_ID in info.entitlements.active;
}

/**
 * Pick the applicable win-back offer for a churned user, or null.
 * Redemption: iOS code-redemption sheet; Android forwards to the
 * subscription center (store promo codes are redeemed there).
 */
export function getWinBackOffer(daysSinceChurn: number): (typeof WIN_BACK_OFFERS)[WinBackOfferId] | null {
  if (daysSinceChurn >= WIN_BACK_OFFERS.d30_free_week.minDaysSinceChurn) return WIN_BACK_OFFERS.d30_free_week;
  if (daysSinceChurn >= WIN_BACK_OFFERS.d3_50pct_2mo.minDaysSinceChurn) return WIN_BACK_OFFERS.d3_50pct_2mo;
  return null;
}

export async function redeemWinBackOffer(): Promise<void> {
  const Purchases = await loadPurchases();
  if (Platform.OS === 'ios') {
    try {
      await Purchases.presentCodeRedemptionSheet();
    } catch (e) {
      throw mapPurchaseError(e);
    }
    return;
  }
  throw new BillingError(
    'purchase-invalid',
    'Win-back codes on Android are redeemed in the Play Store subscription center.',
  );
}

/** Forward CustomerInfo updates to a listener (paywall badge refresh). */
export async function addEntitlementListener(
  listener: (info: RCCustomerInfo) => void,
): Promise<() => void> {
  const Purchases = await loadPurchases();
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => Purchases.removeCustomerInfoUpdateListener(listener);
}
