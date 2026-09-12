/**
 * VAI · Expo Push client (integrations turf).
 *
 * - Registration: permission → ExpoPushToken → upsert to `push_tokens`
 *   (Supabase REST; backend must explicitly expose the table to the Data API
 *   per the Apr-2026 change — see CONTRACT-integrations.md).
 * - Trial day-5 reminder: local scheduled notification at T+96h after trial
 *   start (pack §7) as a BACKUP; the server sends the authoritative push +
 *   email. Local is cancelled on convert/cancel/logout.
 * - Foreground/background router: `render-ready` (primary render completion
 *   path — renders take 10–55s IRL) + `price-drop` (v2 forward-compat: real
 *   code path today, server starts sending it in v2) + trial/referral +
 *   `week_ready` (Monday drop — routes to the reel tab via vai://outfit/<date>).
 * - Deep links on the `vai://` scheme (app.json `scheme: "vai"`).
 *
 * DEP: expo-notifications, expo-device (see DEPS-integrations.txt).
 * NOTE: app.json already declares the expo-notifications plugin + POST_NOTIFICATIONS.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { getPublicEnv } from './edge';
import { getSupabase, isBackendConfigured } from './supabase';

export type PushKind = 'render-ready' | 'trial-reminder' | 'price-drop' | 'referral' | 'week_ready' | 'generic';

export interface PushData {
  kind: PushKind;
  renderId?: string;
  productId?: string;
  placement?: string;
  /** Monday-drop key (`YYYY-MM-DD`) from the `week_ready` push (server: `week_of`). */
  week_of?: string;
  /** Fallback spelling some payloads use for the same Monday-drop key. */
  week_start?: string;
  [key: string]: unknown;
}

export interface DeepRoute {
  screen: 'tryon' | 'paywall' | 'shop' | 'outfit' | 'reel' | 'home';
  params: Record<string, string>;
}

/**
 * Parse a `vai://` deep link into a typed route. Returns null for foreign URLs.
 * Schemes: vai://tryon/<renderId> · vai://paywall?placement= · vai://shop/<productId>
 *          vai://outfit/<yyyy-mm-dd> · vai://reel[?weekOf=] · vai://shop/disclosure · vai://home
 */
export function parseDeepLink(url: string): DeepRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'vai:') return null;
  // URL('vai://tryon/abc') → host='tryon', pathname='/abc'.
  const first = parsed.host.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  if (first === 'tryon' && segments[0]) return { screen: 'tryon', params: { renderId: segments[0] } };
  if (first === 'paywall') return { screen: 'paywall', params: query };
  if (first === 'shop' && segments[0] === 'disclosure') return { screen: 'shop', params: { view: 'disclosure' } };
  if (first === 'shop' && segments[0]) return { screen: 'shop', params: { productId: segments[0], ...query } };
  if (first === 'outfit' && segments[0]) return { screen: 'outfit', params: { date: segments[0] } };
  if (first === 'reel') {
    const weekOf = query['weekOf'] ?? query['week_of'] ?? query['week_start'];
    return { screen: 'reel', params: weekOf ? { weekOf } : {} };
  }
  if (first === 'home' || first === '') return { screen: 'home', params: query };
  return null;
}

/**
 * Monday-drop key carried by a `week_ready` push. Reads the canonical
 * snake_case fields first (`week_of`, then `week_start`), then the camelCase
 * spellings some payloads use — returns undefined when absent/unparseable.
 */
export function weekOfFromPush(data: PushData): string | undefined {
  const raw =
    data.week_of ??
    data.week_start ??
    (typeof data['weekOf'] === 'string' ? (data['weekOf'] as string) : undefined) ??
    (typeof data['weekStart'] === 'string' ? (data['weekStart'] as string) : undefined);
  return raw && raw.length >= 8 ? raw : undefined;
}

export function deepLinkForPush(data: PushData): string {
  switch (data.kind) {
    case 'render-ready':
      return data.renderId ? `vai://tryon/${data.renderId}` : 'vai://home';
    case 'trial-reminder':
      return 'vai://paywall?placement=trial-reminder';
    case 'price-drop':
      return data.productId ? `vai://shop/${data.productId}?source=price-drop` : 'vai://shop/disclosure';
    case 'referral':
      return 'vai://home?sheet=referral';
    case 'week_ready': {
      const weekOf = weekOfFromPush(data);
      return weekOf ? `vai://outfit/${weekOf}` : 'vai://reel';
    }
    default:
      return 'vai://home';
  }
}

// ------------------------------------------------------- registration

export interface RegisterPushResult {
  expoToken: string;
  /** True when the token was persisted server-side. */
  saved: boolean;
}

/**
 * Register for push: physical-device guard → permissions → Expo token →
 * upsert into push_tokens(user_id, expo_token). Returns the token even if
 * the server save fails (caller retries save on next foreground).
 */
export async function registerPushToken(
  params: { userId: string; accessToken?: string | null },
): Promise<RegisterPushResult> {
  if (!Device.isDevice) {
    throw new Error('Push requires a physical device (simulators cannot receive tokens).');
  }
  const existing = await Notifications.getPermissionsAsync();
  const requested = existing.granted
    ? existing
    : await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
  if (!requested.granted) {
    throw new Error('Push permission denied. Enable notifications in Settings to get try-on-ready alerts.');
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('renders', {
      name: 'Try-on updates',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const projectId = Constants.expoConfig?.extra?.['eas']?.['projectId'] as string | undefined;
  const tokenRes = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  const expoToken = tokenRes.data;
  let saved = false;
  try {
    saved = await savePushToken(params.userId, expoToken, params.accessToken ?? null);
  } catch (e) {
    if (__DEV__) console.warn('[push] token save failed (retry on foreground):', e);
  }
  return { expoToken, saved };
}

async function savePushToken(userId: string, expoToken: string, accessToken: string | null): Promise<boolean> {
  if (!isBackendConfigured()) return false;
  const base = getPublicEnv('EXPO_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const anon = getPublicEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  // push_tokens is RLS-guarded to the owner: the request needs the caller's
  // JWT. Previously a missing accessToken produced a headerless insert that
  // could only ever 401 — resolve the session token as the fallback here so
  // the save can actually succeed.
  let token = accessToken;
  if (!token) {
    try {
      token = (await getSupabase().auth.getSession()).data.session?.access_token ?? null;
    } catch {
      token = null;
    }
  }
  if (!token) return false;
  const res = await fetch(`${base}/rest/v1/push_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anon,
      Authorization: `Bearer ${token}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ user_id: userId, expo_token: expoToken }),
  });
  return res.ok;
}

// ------------------------------------------------------- trial reminder

/** T+96h after trial start = day 5 of 7 (2 days before charge, pack §7). */
export const TRIAL_REMINDER_OFFSET_MS = 96 * 60 * 60 * 1000;

/**
 * Schedule the local day-5 trial reminder (backup to the server push+email).
 * Returns the notification id, or null when the fire date already passed.
 */
export async function scheduleTrialDay5Reminder(trialStartedAt: Date | string): Promise<string | null> {
  const start = trialStartedAt instanceof Date ? trialStartedAt : new Date(trialStartedAt);
  const fireAt = new Date(start.getTime() + TRIAL_REMINDER_OFFSET_MS);
  if (fireAt.getTime() <= Date.now() + 60_000) return null;
  const seconds = Math.max(60, Math.round((fireAt.getTime() - Date.now()) / 1000));
  return Notifications.scheduleNotificationAsync({
    content: {
      title: 'Your VAI trial ends in 2 days',
      body: 'Keep Premium for $4.99/mo, or keep your closet free forever. Cancel anytime.',
      data: { kind: 'trial-reminder' } satisfies PushData,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  });
}

export async function cancelScheduledReminders(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
}

// ------------------------------------------------------- router

export interface PushHandlers {
  onRenderReady?: (data: PushData & { renderId: string }) => void;
  onTrialReminder?: (data: PushData) => void;
  /** v2 forward-compat: wired end-to-end today; server starts emitting in v2. */
  onPriceDrop?: (data: PushData) => void;
  onReferral?: (data: PushData) => void;
  /** Monday "week ready" push — tap lands on the reel tab for the drop week. */
  onWeekReady?: (data: PushData) => void;
  onDeepLink?: (route: DeepRoute, data: PushData) => void;
  onGeneric?: (data: PushData) => void;
}

function pickWeekString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length >= 8 ? v : undefined;
}

export function normalizeData(raw: unknown): PushData {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const kind = o['kind'];
    const data: PushData = {
      kind:
        kind === 'render-ready' ||
        kind === 'trial-reminder' ||
        kind === 'price-drop' ||
        kind === 'referral' ||
        kind === 'week_ready'
          ? kind
          : 'generic',
    };
    if (typeof o['renderId'] === 'string') data.renderId = o['renderId'];
    if (typeof o['productId'] === 'string') data.productId = o['productId'];
    if (typeof o['placement'] === 'string') data.placement = o['placement'];
    // Preserve the drop-week key through to routing (server sends `week_of`;
    // accept `week_start` + camelCase spellings so no variant is dropped).
    const weekOf = pickWeekString(o['week_of']) ?? pickWeekString(o['weekOf']);
    if (weekOf) data.week_of = weekOf;
    const weekStart = pickWeekString(o['week_start']) ?? pickWeekString(o['weekStart']);
    if (weekStart) data.week_start = weekStart;
    return data;
  }
  return { kind: 'generic' };
}

function route(data: PushData, h: PushHandlers): void {
  switch (data.kind) {
    case 'render-ready':
      if (data.renderId) h.onRenderReady?.({ ...data, renderId: data.renderId });
      else h.onGeneric?.(data);
      break;
    case 'trial-reminder':
      h.onTrialReminder?.(data);
      break;
    case 'price-drop':
      h.onPriceDrop?.(data);
      break;
    case 'referral':
      h.onReferral?.(data);
      break;
    case 'week_ready':
      h.onWeekReady?.(data);
      break;
    default:
      h.onGeneric?.(data);
  }
  if (h.onDeepLink) {
    const parsed = parseDeepLink(deepLinkForPush(data));
    if (parsed) h.onDeepLink(parsed, data);
  }
}

/**
 * Attach foreground + response listeners. Returns an unsubscribe fn.
 * Tapping a notification routes to the deep link via onDeepLink.
 */
export function addNotificationRouter(handlers: PushHandlers): () => void {
  const subReceived = Notifications.addNotificationReceivedListener((n) => {
    route(normalizeData(n.request.content.data), handlers);
  });
  const subResponse = Notifications.addNotificationResponseReceivedListener((r) => {
    route(normalizeData(r.notification.request.content.data), handlers);
  });
  return () => {
    subReceived.remove();
    subResponse.remove();
  };
}

/** Foreground display policy: banners for render-ready + week-ready, list-only otherwise. */
export function defaultForegroundBehavior(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const kind = (n.request.content.data as Record<string, unknown> | undefined)?.['kind'];
      const isBanner = kind === 'render-ready' || kind === 'week_ready';
      return {
        shouldShowAlert: true,
        shouldShowBanner: isBanner,
        shouldShowList: true,
        shouldPlaySound: isBanner,
        shouldSetBadge: false,
      };
    },
  });
}
