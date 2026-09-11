/**
 * VAI · PostHog analytics wrapper (integrations turf).
 *
 * Covers every BUILD-PACK §10 event. Base props on (almost) every event:
 * user_id, tier (subscription tier: free|premium). Render events additionally
 * carry render_model + cost_usd (REQUIRED — unit-economics auditing depends
 * on it). cost_usd is the server-authoritative value, never the estimate.
 *
 * DEP: posthog-react-native (lazy-imported; missing key or SDK ⇒ buffered
 * no-op so analytics can never crash the app — events are evidence, not flow).
 */

import type { SubTier } from './billing';
import type { ReelPose } from './ai/poses';

// ------------------------------------------------------- event taxonomy (§10)

export const ANALYTICS_EVENTS = [
  'onboard_started',
  'onboard_completed',
  'quiz_completed',
  'closet_item_added',
  'aha_first_outfit',
  'aha_first_tryon',
  'render_requested',
  'render_succeeded',
  'render_failed',
  'restyle_tapped',
  'paywall_seen',
  'trial_started',
  'trial_cancelled',
  'trial_converted',
  'subscription_renewed',
  'subscription_churned',
  'credits_purchased',
  'credits_consumed',
  'affiliate_click',
  'affiliate_order',
  'wishlist_added',
  'referral_sent',
  'referral_accepted',
  'referral_rewarded',
  'retention_ping',
  'reel_opened',
  'weekly_drop_started',
  'weekly_drop_completed',
  'reel_card_viewed',
  'reel_card_regenerated',
  'reel_wear_it_today',
  'reel_shop_tap',
  // Pinterest taste graph (contract §10) — NOT core funnel.
  'pinterest_connected',
  'pinterest_disconnected',
  'boards_synced',
  'pose_mode_selected',
  'taste_seed_applied',
  'pin_shared',
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** The 20 core funnel events (retention/referral-tail tracked separately). */
export const CORE_20_EVENTS: AnalyticsEvent[] = [
  'onboard_started', 'onboard_completed', 'quiz_completed', 'closet_item_added',
  'aha_first_outfit', 'aha_first_tryon', 'render_requested', 'render_succeeded',
  'render_failed', 'restyle_tapped', 'paywall_seen', 'trial_started',
  'trial_cancelled', 'trial_converted', 'subscription_renewed', 'subscription_churned',
  'credits_purchased', 'credits_consumed', 'affiliate_click', 'affiliate_order',
];

interface BaseProps {
  user_id: string;
  tier: SubTier;
}

interface RenderCostProps extends BaseProps {
  render_model: string;
  /** Server-authoritative USD cost of this call (0 for cached/failed-free). */
  cost_usd: number;
}

export interface AnalyticsPropsMap {
  onboard_started: BaseProps & { source?: string };
  onboard_completed: BaseProps & { duration_s?: number };
  quiz_completed: BaseProps & { quiz_version?: number };
  closet_item_added: BaseProps & { count: number; source?: 'camera' | 'bulk' | 'receipt' | 'shop' };
  aha_first_outfit: BaseProps;
  aha_first_tryon: BaseProps;
  render_requested: BaseProps & { render_id?: string; render_tier?: 'std' | 'max'; mode?: string; restyle_n?: number };
  render_succeeded: RenderCostProps & { render_id: string; latency_ms: number; restyle_n?: number; cached?: boolean };
  render_failed: RenderCostProps & { render_id?: string; error_code?: string; latency_ms?: number };
  restyle_tapped: BaseProps & { render_id: string; restyle_n: number };
  paywall_seen: BaseProps & { placement: string; renders_left?: number };
  trial_started: BaseProps;
  trial_cancelled: BaseProps & { days_in?: number };
  trial_converted: BaseProps;
  subscription_renewed: BaseProps & { product_id?: string };
  subscription_churned: BaseProps & { days_subscribed?: number };
  credits_purchased: BaseProps & { pack_id: string; credits: number };
  credits_consumed: BaseProps & { credits: number; render_id?: string; cost_usd?: number };
  affiliate_click: BaseProps & { render_id?: string; click_id?: string; product_id?: string; retailer?: string; price?: number };
  affiliate_order: BaseProps & { click_id?: string; commission_cents?: number; retailer?: string };
  wishlist_added: BaseProps & { product_id: string; target_price?: number };
  referral_sent: BaseProps & { code?: string };
  referral_accepted: BaseProps & { code?: string };
  referral_rewarded: BaseProps & { months?: number };
  retention_ping: BaseProps & { day: 1 | 7 | 30 };
  reel_opened: BaseProps & { source?: string; week_start?: string };
  /**
   * cost_usd REQUIRED, server-authoritative (sum of the drop's render costs).
   * Pending cards carry the $0.067 estimate until their renders land
   * (server contract: `imageUrl: ""`), so callers MUST exclude them from the
   * sum and set `is_estimated: true` + `pending_count` instead of reporting
   * estimates as authoritative. `is_estimated` absent/false = final.
   */
  weekly_drop_started: BaseProps & { card_count: number; cost_usd: number; is_estimated?: boolean; pending_count?: number };
  /** cost_usd REQUIRED, server-authoritative (actuals, post-render — same pending rule as started). */
  weekly_drop_completed: BaseProps & { card_count: number; cost_usd: number; is_estimated?: boolean; pending_count?: number };
  reel_card_viewed: BaseProps & { card_index: number; pose: ReelPose };
  /** cost_usd REQUIRED — every regen costs 1 credit (server-authoritative card cost). */
  reel_card_regenerated: BaseProps & { card_index?: number; pose?: ReelPose; render_id?: string; cost_usd: number };
  reel_wear_it_today: BaseProps & { date?: string; pose?: ReelPose };
  reel_shop_tap: BaseProps & { product_id?: string; retailer?: string; card_index?: number };
  pinterest_connected: BaseProps & { source?: string };
  pinterest_disconnected: BaseProps;
  boards_synced: BaseProps & { count: number };
  pose_mode_selected: BaseProps & { pose_mode: 'keep' | 'adapt'; render_id?: string };
  taste_seed_applied: BaseProps & { seed_count: number; board?: string };
  pin_shared: BaseProps & { render_id?: string };
}

// ------------------------------------------------------- client

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PostHogClient = any;

let client: PostHogClient | null = null;
let context: { userId: string; tier: SubTier } = { userId: 'anonymous', tier: 'free' };
let enabled = false;
const buffer: Array<{ event: string; props: Record<string, unknown> }> = [];

async function getClient(): Promise<PostHogClient | null> {
  if (client) return client;
  const apiKey = process.env['EXPO_PUBLIC_POSTHOG_KEY'];
  if (!apiKey) {
    if (__DEV__) console.warn('[analytics] EXPO_PUBLIC_POSTHOG_KEY missing — events buffered, not sent.');
    return null;
  }
  try {
    const { PostHog } = await import('posthog-react-native');
    client = new PostHog(apiKey, {
      host: process.env['EXPO_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
    });
    enabled = true;
    for (const b of buffer.splice(0)) {
      try {
        await client.capture(b.event, b.props);
      } catch {
        /* drop on floor — analytics never blocks */
      }
    }
    return client;
  } catch {
    if (__DEV__) console.warn('[analytics] posthog-react-native unavailable — events buffered.');
    return null;
  }
}

/**
 * Identify the user + set subscription tier context (call after login and
 * after every tier change so funnels split free vs premium correctly).
 */
export async function initAnalytics(userId: string, tier: SubTier): Promise<void> {
  context = { userId, tier };
  const c = await getClient();
  if (!c) return;
  try {
    await c.identify(userId, { tier });
  } catch {
    /* non-blocking */
  }
}

export function setAnalyticsTier(tier: SubTier): void {
  context.tier = tier;
  if (client && enabled) {
    try {
      client.register?.({ tier });
    } catch {
      /* non-blocking */
    }
  }
}

/** Type-safe track: props are checked per event at compile time. */
export function track<E extends AnalyticsEvent>(event: E, props: AnalyticsPropsMap[E]): void {
  const merged = { ...props, user_id: props.user_id || context.userId } as Record<string, unknown>;
  if (!('tier' in merged) || merged['tier'] === undefined) merged['tier'] = context.tier;
  if (client && enabled) {
    try {
      void client.capture(event, merged);
      return;
    } catch {
      /* fall through to buffer */
    }
  }
  buffer.push({ event, props: merged });
  if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
  void getClient();
}

/** Build the REQUIRED cost props for render events from a server result. */
export function renderCostProps(
  userId: string,
  tier: SubTier,
  renderModel: string,
  costUsd: number,
): RenderCostProps {
  return { user_id: userId, tier, render_model: renderModel, cost_usd: costUsd };
}

/**
 * Edge-fn render result subset that carries the authoritative cost
 * attribution. Mirrors `TryOnResult` (lib/ai/gemini.ts) structurally so this
 * module stays import-cycle free — any object with `model` + `costUsd`
 * satisfies it, including `getRenderStatus()` / `pollRender()` results.
 */
export interface RenderResultLike {
  model: string;
  costUsd: number;
}

/**
 * Bridge: edge-fn response → REQUIRED render-event cost props.
 * Pass the `TryOnResult` straight through — `render_model` + `cost_usd` stay
 * server-authoritative end-to-end (edge fn `cost_usd` → `TryOnResult.costUsd`
 * → here → PostHog; the same value is written to the `ledger` as
 * `render_cost` by the pipeline). Cached / failed-free renders report
 * `cost_usd: 0` — never the pre-flight estimate.
 */
export function renderCostPropsFromResult(
  userId: string,
  tier: SubTier,
  result: RenderResultLike,
): RenderCostProps {
  return renderCostProps(userId, tier, result.model, result.costUsd);
}

/** Flush queued events (call on background/quit). */
export async function flushAnalytics(): Promise<void> {
  try {
    await client?.flush?.();
  } catch {
    /* non-blocking */
  }
}

/** Clear identity on logout (PostHog reset). */
export async function resetAnalytics(): Promise<void> {
  context = { userId: 'anonymous', tier: 'free' };
  try {
    await client?.reset?.();
  } catch {
    /* non-blocking */
  }
}
