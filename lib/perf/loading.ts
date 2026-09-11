/**
 * VAI perf — app loading + splash orchestration for <2s cold start.
 *
 * Strategy (full rationale in APP-LOADING-SPLASH.md):
 *  1. `expo-splash-screen.preventAutoHideAsync()` runs in the root layout
 *     BEFORE first render (see CONTRACT-perf.md snippet — root layout is
 *     frontend turf, this module only provides the gate).
 *  2. `awaitAppReady()` races ALL readiness gates against a 4 s failsafe.
 *     The splash NEVER traps the user: on timeout we hide and let per-screen
 *     skeletons take over.
 *  3. Cold start does NOT fetch the network. It hydrates MMKV (sync, ~ms)
 *     and paints from cache; refresh happens post-paint.
 *  4. `prefetchCritical()` runs AFTER hide (needs the JS thread free).
 *
 * What counts as "ready": fonts loaded + MMKV hydrated + router mounted.
 * Everything else (closet refresh, quota sync, outfit plan) is post-paint.
 */
import * as SplashScreen from 'expo-splash-screen';
import { closetCache, dnaCache, paywallCache, quotaCache } from './cache';
import { prewarmCritical } from './image-pipeline';
import { PerfTimer, reportColdStart, reportError } from './telemetry';

/** Failsafe: splash hides no matter what after this. */
export const SPLASH_FAILSAFE_MS = 4000;

export interface AppReadyGates {
  /** Frontend: Font.loadAsync / useFonts resolution. */
  fontsLoaded: Promise<unknown>;
  /** Frontend: router root mounted (first route laid out). */
  routerMounted: Promise<unknown>;
  /** Above-the-fold image URLs to warm AFTER hide (hero outfit, base thumb). */
  criticalUrls?: string[];
  fromPush?: boolean;
}

export interface AppReadyResult {
  ttiMs: number;
  timedOut: boolean;
  hydrated: ('closet' | 'dna' | 'quota' | 'paywall')[];
}

const appLaunchMark = { t: 0 };

/** Call once at module scope of the root layout (before any render). */
export function markAppLaunch(): void {
  appLaunchMark.t = Date.now();
}

/**
 * Hydrate MMKV caches synchronously (no I/O wait — MMKV is mmap'd) and
 * record which namespaces have usable data for first paint.
 */
export function hydrateCachesSync(): AppReadyResult['hydrated'] {
  const out: AppReadyResult['hydrated'] = [];
  try {
    if (closetCache.read().stale) out.push('closet');
    if (dnaCache.read().stale) out.push('dna');
    if (quotaCache.read().stale) out.push('quota');
    if (paywallCache.read().stale) out.push('paywall');
  } catch (err) {
    reportError(err, { where: 'hydrateCachesSync' });
  }
  return out;
}

/**
 * Main gate. Resolves with timing info; ALWAYS hides the splash (ready or
 * failsafe). Callers must not gate navigation on this beyond first paint.
 */
export async function awaitAppReady(gates: AppReadyGates): Promise<AppReadyResult> {
  const timer = new PerfTimer('app.tti');
  const hydrated = hydrateCachesSync();

  const ready = Promise.all([gates.fontsLoaded, gates.routerMounted]).then(
    () => ({ timedOut: false as const }),
  );
  const failsafe = new Promise<{ timedOut: true }>((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), SPLASH_FAILSAFE_MS),
  );

  const outcome = await Promise.race([ready, failsafe]);

  try {
    await SplashScreen.hideAsync();
  } catch (err) {
    reportError(err, { where: 'SplashScreen.hideAsync' });
  }

  const ttiMs = timer.stop('app.tti');
  reportColdStart(ttiMs, { fromPush: gates.fromPush });

  // Post-hide: warm above-the-fold images without blocking interaction.
  if (gates.criticalUrls && gates.criticalUrls.length > 0) {
    prewarmCritical(gates.criticalUrls);
  }

  return { ttiMs, timedOut: outcome.timedOut, hydrated };
}
