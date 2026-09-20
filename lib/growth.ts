/**
 * VAI · Growth engineering glue (GTM turf).
 *
 * Retention pings, once-only funnel markers and the store-review ask —
 * MMKV-backed via `mmkvStorage`, best-effort: growth mechanics must never
 * block or crash a flow (same law as analytics — events are evidence, not flow).
 */

import * as StoreReview from 'expo-store-review';
import { track } from './analytics';
import { mmkvStorage } from '../store/mmkv';
import type { SubTier } from './billing';

function read(key: string): string | null {
  try {
    const v = mmkvStorage.getItem(key);
    // MMKV is sync; an async storage fallback degrades to a miss.
    return v instanceof Promise ? null : v;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    mmkvStorage.setItem(key, value);
  } catch {
    /* storage failed — growth state is best-effort */
  }
}

/** Mark T0 for the onboarding funnel (first "Get started" tap, once). */
export function markOnboardStart(): void {
  if (read('gtm.onboardStartAt') !== null) return;
  write('gtm.onboardStartAt', JSON.stringify(Date.now()));
}

/** Seconds elapsed since onboard start (undefined before it started). */
export function onboardDurationS(): number | undefined {
  const raw = read('gtm.onboardStartAt');
  if (raw === null) return undefined;
  const t0 = Number(JSON.parse(raw));
  if (!Number.isFinite(t0)) return undefined;
  return Math.max(0, Math.round((Date.now() - t0) / 1000));
}

/** True exactly once per key (per install). */
export function once(key: string): boolean {
  const k = `gtm.once.${key}`;
  if (read(k) !== null) return false;
  write(k, '1');
  return true;
}

/** Day 1/7/30 retention pings — one per bucket per install. */
export function retentionPingIfDue(userId: string, tier: SubTier): void {
  try {
    const now = Date.now();
    const rawInstall = read('gtm.installAt');
    if (rawInstall === null) {
      write('gtm.installAt', JSON.stringify(now));
      return; // day 0 — nothing due yet
    }
    const installAt = Number(JSON.parse(rawInstall));
    if (!Number.isFinite(installAt)) return;
    const days = Math.floor((now - installAt) / 86_400_000);
    for (const day of [1, 7, 30] as const) {
      if (days >= day && once(`ret.${userId}.${day}`)) {
        track('retention_ping', { user_id: userId, tier, day });
      }
    }
  } catch {
    /* never crash boot for analytics */
  }
}

/** Count a finished render; returns the running install-lifetime count. */
export function noteRenderSuccess(): number {
  const raw = read('gtm.rendersOk');
  const prev = raw !== null ? Number(JSON.parse(raw)) : 0;
  const n = (Number.isFinite(prev) ? prev : 0) + 1;
  write('gtm.rendersOk', JSON.stringify(n));
  return n;
}

/**
 * In-app review ask at delight peaks (3rd and 10th successful render —
 * never on the first, never after a failure). One ask per threshold.
 */
export async function maybeRequestReview(): Promise<void> {
  try {
    const n = noteRenderSuccess();
    if (n !== 3 && n !== 10) return;
    if (!once(`review.${n}`)) return;
    if (!(await StoreReview.isAvailableAsync())) return;
    await StoreReview.requestReview();
  } catch {
    /* store review is best-effort */
  }
}
