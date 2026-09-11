# APP-LOADING-SPLASH.md — app-loading + splash strategy note

Goal: cold start (tap → interactive home) <2s p50, <3s p95 on Pixel 6a,
measured by `perf_cold_start.tti_ms` (PostHog) + Sentry `app.tti`.

## Existing config (no changes needed — founder turf, do not edit)

`app.json` already sets `newArchEnabled`, splash `backgroundColor #FAF8F5`,
`expo-router` + `expo-splash-screen` plugins. Keep `resizeMode: contain`.

## Strategy: cache-paint, then refresh

1. **Prevent autohide early.** Root layout module scope calls
   `SplashScreen.preventAutoHideAsync()` + `markAppLaunch()` BEFORE first
   render. If this races, the OS splash flashes — acceptable once, never a hang.
2. **Zero blocking network.** `hydrateCachesSync()` reads MMKV (mmap, ~ms):
   closet list, DNA, quota mirror, paywall status. First paint renders from
   cache with "syncing" affordances where stale (quota badge shows cached
   count + refreshes; it can only UNDER-grant because `guard()` fails closed
   on unknown state — no, it reads the mirror; server re-checks on submit).
3. **Two gates only: fonts + router mounted.** `awaitAppReady()` races these
   against a **4 s failsafe** — the splash ALWAYS hides. A stuck font must
   never trap the user on a static screen.
4. **Refresh post-paint, in order:** `paywall-status` → quota reconcile →
   closet delta (cursor/etag) → plan-day hero → prefetch next-outfit images.
   Prefetch runs at concurrency 4 (grids) / 2 (critical) and never during TTI.
5. **Push cold start:** same path + `fromPush: true` prop; after ready, route
   via `parseRenderDeepLink()` to the result, then `ingestStatus()`.

## What NOT to do

- No auth refresh, no RevenueCat sync, no PostHog flush before hide.
- No `Image.prefetch` before hide (steals decode + JS thread from first paint).
- No fake progress bar under the splash; static brand mark only.
- No `setTimeout(..., 2000)` "minimum splash time" — that IS the jank.

## Verification (QA gate before TestFlight)

- Airplane-mode launch → cached home in <2s, honest "offline" states, no hang.
- Fresh install → onboarding carousel in <2s (no cache to paint from; still
  only fonts + router gate).
- Kill-during-upload relaunch → resumable session resumes (see image-pipeline).
- Sentry: `app.tti` p50 <2000ms, p95 <3000ms over 100 cold starts, mid-tier Android.
