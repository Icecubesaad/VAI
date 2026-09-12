import '../global.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme';
import { getSupabase, isBackendConfigured } from '@/lib/supabase';
import { BackendMisconfiguredScreen, RootErrorBoundary } from '@/components/RootErrorBoundary';
import {
  addNotificationRouter,
  deepLinkForPush,
  normalizeData,
  type DeepRoute,
} from '@/lib/push';
import {
  awaitAppReady,
  hydrateCachesSync,
  markAppLaunch,
  parseRenderDeepLink,
} from '@/lib/perf';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';
import { registerPushToken } from '@/lib/push';
import { initAnalytics } from '@/lib/analytics';
import { initSentry, setSentryUser } from '@/lib/sentry';

// Perf loading recipe (CONTRACT-perf.md + APP-LOADING-SPLASH.md): mark launch
// + hold the OS splash BEFORE first render. `awaitAppReady` hides the splash
// (fonts + router gates raced against the 4s failsafe — never a hang).
// Guarded: a synchronous native-module failure here must not brick boot.
try {
  markAppLaunch();
  void SplashScreen.preventAutoHideAsync().catch(() => undefined);
} catch {
  /* timing/splash hold is best-effort — the boot gate still hides below */
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 60_000, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

/** Extract referral code from vai://r/<code>, vai://*?code=<code>, or https://vai.style/r/<code>. */
function extractReferralCode(url: string): string | null {
  const parsed = Linking.parse(url);
  const qp = parsed.queryParams;
  const qpCode =
    typeof qp?.code === 'string' ? qp.code : typeof qp?.ref === 'string' ? qp.ref : null;
  if (qpCode && qpCode.length >= 3) return qpCode;
  const segs = (parsed.path ?? '').split('/').filter(Boolean);
  // "vai://r/CODE" parses with hostname "r" and path "CODE" (expo-linking);
  // "https://vai.style/r/CODE" parses with hostname "vai.style" and path "r/CODE".
  if (parsed.hostname?.toLowerCase() === 'r' && segs[0]) return segs[0];
  if (segs.length >= 2 && segs[0]?.toLowerCase() === 'r' && segs[1]) return segs[1];
  return null;
}

/**
 * Render-result deep link for push-tap routing: perf recipe
 * `vai://tryon/<renderId>` (plus the `vai://render/<renderId>` form named in
 * CONTRACT-perf.md — both land on the try-on result screen).
 */
function extractRenderId(url: string): string | null {
  const viaRecipe = parseRenderDeepLink(url);
  if (viaRecipe) return viaRecipe;
  const legacyPrefix = 'vai://render/';
  if (url.startsWith(legacyPrefix)) {
    const id = url.slice(legacyPrefix.length).split(/[?#]/)[0];
    return id && id.length > 0 ? id : null;
  }
  return null;
}

/**
 * Weekly-reel deep link for the Monday push: `vai://reel` (optional
 * `?weekOf=YYYY-MM-DD`). expo-linking parses `vai://reel` with hostname
 * `reel` and an empty path, so both shapes are accepted.
 */
function extractReelWeek(url: string): string | null {
  const parsed = Linking.parse(url);
  const segs = (parsed.path ?? '').split('/').filter(Boolean);
  const isReel =
    parsed.hostname === 'reel' || segs[0]?.toLowerCase() === 'reel';
  if (!isReel) return null;
  const qp = parsed.queryParams;
  const weekOf = typeof qp?.weekOf === 'string' ? qp.weekOf : null;
  return weekOf && weekOf.length >= 8 ? weekOf : '';
}

/**
 * Monday "week ready" push tap: `vai://outfit/<Monday-date>` (CONTRACT
 * task spec — route to the reel tab; the reel screen normalizes any
 * in-week date down to its Monday). Accepts both the hostname form
 * (`vai://outfit/2026-09-07` → hostname `outfit`) and the path form,
 * plus `?weekOf=` / `?week_start=` fallbacks.
 */
function extractOutfitWeek(url: string): string | null {
  const parsed = Linking.parse(url);
  const segs = (parsed.path ?? '').split('/').filter(Boolean);
  const isOutfit =
    parsed.hostname === 'outfit' || segs[0]?.toLowerCase() === 'outfit';
  if (!isOutfit) return null;
  const head = segs[0]?.toLowerCase() === 'outfit' ? segs[1] : segs[0];
  if (head && head.length >= 8) return head;
  const qp = parsed.queryParams;
  const fallback =
    typeof qp?.weekOf === 'string'
      ? qp.weekOf
      : typeof qp?.week_start === 'string'
        ? qp.week_start
        : null;
  return fallback && fallback.length >= 8 ? fallback : '';
}

/** Deep-link listener: referral capture + stash render-result taps for post-paint routing. */
function useDeepLinks(onUrl: (url: string) => void) {
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) onUrl(url);
    });
    const sub = Linking.addEventListener('url', (e) => onUrl(e.url));
    return () => sub.remove();
  }, [onUrl]);
}

/**
 * Notification-tap router (P1-1): push taps never arrive as `Linking` URLs,
 * so the Monday `week_ready` push is wired here via the push router. Only
 * reel-bound routes are handled — `outfit` (the Monday-push
 * `vai://outfit/<date>`, any in-week date; the reel screen normalizes to its
 * Monday) and `reel` (dateless fallback `vai://reel`). All other push kinds
 * keep their existing behavior (untouched).
 */
function usePushRouter(
  onReelRoute: (route: DeepRoute) => void,
  onRenderRoute: (renderId: string) => void,
) {
  useEffect(() => {
    const unsub = addNotificationRouter({
      onDeepLink: (route) => {
        // render-ready taps were previously dropped here — the user paid a
        // credit and the finished render was invisible until they scrolled.
        if (route.screen === 'tryon') {
          const renderId = route.params['renderId'];
          if (renderId) onRenderRoute(renderId);
          return;
        }
        if (route.screen === 'outfit' || route.screen === 'reel') onReelRoute(route);
      },
    });
    return unsub;
  }, [onReelRoute, onRenderRoute]);
}

/**
 * Cold-start tap: when the app is launched from a killed state by tapping the
 * Monday push, the response listener above may attach after delivery — read
 * the last response imperatively and map it to the same deep link the router
 * would have produced. Returns null for non-reel pushes (untouched).
 */
async function lastPushReelLink(): Promise<string | null> {
  try {
    const res = await Notifications.getLastNotificationResponseAsync();
    if (!res) return null;
    const link = deepLinkForPush(normalizeData(res.notification.request.content.data));
    return link.startsWith('vai://outfit/') || link === 'vai://reel' || link.startsWith('vai://reel?')
      ? link
      : null;
  } catch {
    return null;
  }
}

/** Above-the-fold thumbs to warm AFTER the splash hides (never before paint). */
function pendingCriticalUrls(): string[] {
  try {
    const thumb = useSession.getState().basePhotoUrl;
    return thumb ? [thumb] : [];
  } catch {
    return [];
  }
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [backendError, setBackendError] = useState(false);
  const [bootError, setBootError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [bootTick, setBootTick] = useState(0);
  const rootNav = useRootNavigationState();
  const router = useRouter();
  const routerMounted = rootNav?.key != null;
  const bootedRef = useRef(false);
  const readyRef = useRef(false);
  const pendingRenderRef = useRef<string | null>(null);
  const pendingReelRef = useRef<string | null>(null);

  const setReferredBy = useSession((s) => s.setReferredBy);

  const routeReelWeek = useCallback(
    (reelWeek: string) => {
      // App already painted (warm push tap): route immediately, else stash.
      if (readyRef.current) {
        pendingReelRef.current = null;
        router.push(
          reelWeek ? { pathname: '/(tabs)/reel', params: { weekOf: reelWeek } } : '/(tabs)/reel',
        );
      } else {
        pendingReelRef.current = reelWeek;
      }
    },
    [router],
  );

  const handleUrl = useCallback(
    (url: string) => {
      const code = extractReferralCode(url);
      if (code) setReferredBy(code);
      const renderId = extractRenderId(url);
      if (renderId) pendingRenderRef.current = renderId;
      // Reel targets: `vai://reel` and the Monday-push `vai://outfit/<date>`.
      const reelWeek = extractReelWeek(url) ?? extractOutfitWeek(url);
      if (reelWeek !== null) routeReelWeek(reelWeek);
    },
    [setReferredBy, routeReelWeek],
  );
  useDeepLinks(handleUrl);

  // Monday-push taps arrive via the notification router (never Linking URLs).
  const handlePushRoute = useCallback(
    (route: DeepRoute) => {
      if (route.screen === 'outfit') routeReelWeek(route.params['date'] ?? '');
      else if (route.screen === 'reel') routeReelWeek(route.params['weekOf'] ?? '');
    },
    [routeReelWeek],
  );
  const routeRenderResult = useCallback(
    (renderId: string) => {
      if (readyRef.current) {
        router.push({ pathname: '/(tabs)/tryon', params: { renderId } });
      } else {
        pendingRenderRef.current = renderId; // boot gate routes it post-paint
      }
    },
    [router],
  );
  usePushRouter(handlePushRoute, routeRenderResult);

  // Supabase auth events → session store (boot-time session comes from the gate below).
  // Gated: without credentials there is no client to subscribe to.
  useEffect(() => {
    if (!isBackendConfigured()) return;
    let unsubscribe: (() => void) | null = null;
    try {
      const { data: sub } = getSupabase().auth.onAuthStateChange((event, session) => {
        const u = session?.user;
        if (u) {
          useSession.getState().setAuth({ userId: u.id, email: u.email ?? null });
        } else if (event === 'SIGNED_OUT') {
          // Session death while running (explicit logout or refresh-token
          // revocation): clear the dead identity — analytics, idempotency
          // keys and push-token saves all consume userId — and route back to
          // auth instead of letting every call 401 behind a signed-in UI.
          useSession.getState().clearAuth();
          if (useSession.getState().onboardingStep === 'done') {
            useSession.getState().setOnboardingStep('auth');
            try {
              router.replace('/onboarding/auth');
            } catch {
              /* router not mounted yet — boot gate routes on next start */
            }
          }
        }
      });
      unsubscribe = () => sub.subscription.unsubscribe();
    } catch {
      return;
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* listener teardown is best-effort */
      }
    };
  }, []);

  // Boot gate (APP-LOADING-SPLASH.md): backend check FIRST → MMKV sync
  // hydrate (zero blocking network) → session rehydrate → two-gate splash
  // hide → post-paint refresh in order (paywall-status → quota mirror merge
  // inside fetchStatus). Every path hides the splash, including error paths.
  useEffect(() => {
    if (bootedRef.current || !routerMounted) return;
    bootedRef.current = true;
    void (async () => {
      // Backend gate FIRST: never touch the supabase client without
      // credentials — render the error screen instead of crashing.
      if (!isBackendConfigured()) {
        try {
          await SplashScreen.hideAsync();
        } catch {
          /* never trap the user behind the splash */
        }
        setBackendError(true);
        return;
      }
      try {
        hydrateCachesSync();
        // Error reporting + product analytics init: both helpers previously
        // had ZERO callers — the billing funnel was completely unmeasurable.
        void initSentry().catch(() => undefined);
        const [sessionRes, initialUrl, pushLink] = await Promise.all([
          getSupabase().auth.getSession().catch(() => null),
          Linking.getInitialURL().catch(() => null),
          lastPushReelLink(),
        ]);
        const u = sessionRes?.data.session?.user;
        if (u) {
          useSession.getState().setAuth({ userId: u.id, email: u.email ?? null });
          setSentryUser(u.id);
          void initAnalytics(u.id, usePaywall.getState().tier === 'free' ? 'free' : 'premium').catch(
            () => undefined,
          );
          // Push registration was previously never called anywhere — no token
          // ever reached push_tokens, so render-ready pushes could not fire.
          // Fire-and-forget: permission prompt only on first run; the server
          // upsert (merge-duplicates) is idempotent on (user, token).
          void registerPushToken({ userId: u.id }).catch(() => undefined);
        } else {
          // Ghost-funnel guard: persisted MMKV can resume mid-funnel (quiz /
          // selfie / closet / paywall) with no session — every backend call
          // then 401s ("sign in to continue" on screens the user already
          // passed). Bounce to auth once, honestly, instead of the cascade.
          const step = useSession.getState().onboardingStep;
          if (
            step === 'quiz' ||
            step === 'selfie' ||
            step === 'closet' ||
            step === 'firstOutfit' ||
            step === 'paywall'
          ) {
            useSession.getState().setOnboardingStep('auth');
            useSession.getState().clearAuth();
          }
        }
        if (initialUrl) handleUrl(initialUrl);
        // Killed-state Monday-push tap: same reel routing via the stashed week.
        if (pushLink) handleUrl(pushLink);
        // Fonts gate: no font assets ship in v1 (UI/UX turf) — a resolved
        // promise keeps the two-gate shape so fonts plug in without restructuring.
        await awaitAppReady({
          fontsLoaded: Promise.resolve(),
          routerMounted: Promise.resolve(),
          criticalUrls: pendingCriticalUrls(),
          fromPush: pendingRenderRef.current != null,
        });
      } catch {
        // Unexpected boot failure: hide the splash and show the retryable
        // error screen instead of hanging on the boot spinner.
        try {
          await SplashScreen.hideAsync();
        } catch {
          /* never trap the user behind the splash */
        }
        setBootError(true);
        return;
      }
      setReady(true);
      readyRef.current = true;
      // Post-paint only: screens own closet delta / plan-day / prefetch.
      void usePaywall.getState().fetchStatus().catch(() => undefined);
      // Push-tap routing: render result, then it ingests status (see tryon screen).
      const renderId = pendingRenderRef.current;
      pendingRenderRef.current = null;
      if (renderId) {
        router.push({ pathname: '/(tabs)/tryon', params: { renderId } });
      }
      // Monday push: land on the weekly reel (reel screen owns the fetch).
      const reelWeek = pendingReelRef.current;
      pendingReelRef.current = null;
      if (!renderId && reelWeek !== null) {
        router.push(
          reelWeek ? { pathname: '/(tabs)/reel', params: { weekOf: reelWeek } } : '/(tabs)/reel',
        );
      }
    })();
  }, [routerMounted, handleUrl, router, bootTick]);

  // Backend-error retry: env is baked at build time, so this only succeeds
  // after a reinstall / OTA that restores vars — re-check without crashing.
  const handleBackendRetry = useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    setTimeout(() => {
      setRetrying(false);
      if (isBackendConfigured()) {
        setBackendError(false);
        setBootError(false);
        bootedRef.current = false;
        setBootTick((t) => t + 1);
      }
    }, 300);
  }, [retrying]);

  if (backendError) {
    return (
      <RootErrorBoundary>
        <BackendMisconfiguredScreen onRetry={handleBackendRetry} retrying={retrying} />
      </RootErrorBoundary>
    );
  }

  if (bootError) {
    return (
      <RootErrorBoundary>
        <BackendMisconfiguredScreen
          title="Something went wrong"
          message="VAI hit a problem while starting. Try again — if this keeps happening, reinstall the app or contact support."
          onRetry={handleBackendRetry}
          retrying={retrying}
          testID="root-boot-error"
        />
      </RootErrorBoundary>
    );
  }

  if (!ready) {
    return (
      <RootErrorBoundary>
        <View style={styles.boot} testID="root-boot">
          <ActivityIndicator size="large" />
        </View>
      </RootErrorBoundary>
    );
  }

  return (
    <RootErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="onboarding" />
              <Stack.Screen name="pose-pack" />
              <Stack.Screen name="pinterest-connect" />
              <Stack.Screen name="pinterest-boards" />
            </Stack>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </RootErrorBoundary>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FAF8F5' },
});
