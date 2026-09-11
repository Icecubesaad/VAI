# CONTRACT-perf.md — what frontend / integrations import from lib/perf

Single entry: `@/lib/perf` (barrel). Perf owns these files; no cross-edits
without asking (README ownership table).

## Frontend imports

```ts
import {
  // image pipeline
  compressGarmentPhoto, compressBasePhoto, preflightBasePhoto,
  uploadWithRetry, ResumableUpload, remotePathFor,
  prefetchOutfitImages, prewarmCritical,
  // cache
  closetCache, dnaCache, quotaCache, paywallCache, mmkvKV,
  invalidateOnGarmentMutation, invalidateOnRenderSettled,
  invalidateOnPurchase, invalidateOnDnaChange,
  invalidateOnBasePhotoRetake, clearAllOnLogout,
  // quotas (create ONE store in app shell, pass down)
  createQuotaStore, useQuota, quotaBadgeCopy, QUOTA_BLOCK_COPY,
  // render queue (create ONE store in app shell, pass down)
  createRenderQueue, useRenderQueue, useRenderJob,
  RENDER_PROGRESS_STEPS, COPY_OFFLINE_RENDER,
  renderDeepLink, parseRenderDeepLink,
  // lists
  closetGridSpec, shopGridSpec, plannerRowSpec, listTuning,
  closetThumbProps, heroImageProps, keyById, closetItemType,
  CLOSET_GRID_COLUMNS,
  // reel pager (vertical snap paging — weekly drop)
  reelPagerSpec, ReelPrefetcher, reelPrefetchQueue,
  reelThumbProps, reelFullProps, canRegenerateReelCard,
  COPY_REEL_OFFLINE_REGENERATE,
  // pinterest taste graph (boards/pins image pipeline + sync guardrails)
  pinThumbUrl, pinFullUrl, pinThumbProps, pinFullProps,
  pinGridPrefetchQueue, PinPrefetcher, preloadPoseRefs,
  canSyncPins, shouldRunPinSync, chunkBoardSync, capPinsNewestFirst,
  pinSyncBackoffDelayMs, readPinBoards, readPinList,
  writePinBoards, writePinList, purgePinCachesOnDisconnect,
  COPY_PIN_OFFLINE_SYNC, MAX_PINS_PER_BOARD_PER_SYNC,
  // weekly-drop pool mirror (read-only; server grants)
  weeklyPoolFromServer, canUseWeeklyDrop, weeklyDropBlockedReason,
  weeklyDropVisibleCount, isWeeklyDropTierAllowed, WEEKLY_DROP_BLOCK_COPY,
  // loading (root layout only)
  markAppLaunch, awaitAppReady, SPLASH_FAILSAFE_MS,
  // telemetry
  initPerfTelemetry, PerfEvents, reportReelTti, reportPinBoardTti,
} from '@/lib/perf';
```

### Render entry-point recipe (try-on Generate, restyle, compare — ALL three)

```ts
if (!quotaStore.getState().guard('tryon_generate')) return; // opens upgrade sheet, $0 spent
const { job, blocked } = await renderQueue.getState().enqueue({
  userId, basePhotoId, outfitId, garmentIds, mode: 'tryon', tier: 'std', day,
});
if (blocked) { showToast(blocked.message); return; }
// paint optimistic skeleton from `job` immediately; stages from RENDER_PROGRESS_STEPS
```

### Root layout recipe (frontend turf, perf provides the gate)

```ts
// module scope, before any render:
import { markAppLaunch } from '@/lib/perf';
markAppLaunch();
SplashScreen.preventAutoHideAsync().catch(() => {});
// in effect after fonts + router mount:
awaitAppReady({ fontsLoaded, routerMounted, criticalUrls: [heroUrl, baseThumbUrl] });
```

### Base-photo capture recipe (onboarding selfie)

```ts
const gate = await preflightBasePhoto(localUri, { detector: serverFaceDetector });
if (!gate.ok && gate.needsServerCheck && gate.reasons.length === 1) {
  // route to server quiz-score verdict; show "Checking…" not Retake
} else if (!gate.ok) {
  // inline reason + Retake (map BasePhotoFailReason -> copy)
} else {
  const compressed = await compressBasePhoto(localUri);
}
```

### Reel pager recipe (weekly-drop tab — frontend turf, perf owns the engine)

```ts
// One prefetcher per reel screen (holds the cancel generation):
const prefetcher = new ReelPrefetcher({
  isOnline, // NetInfo probe from the app shell
  onEvent: (event, props) => analytics.capture(event, props), // perf_reel_prefetch
});
<FlashList
  {...reelPagerSpec(Dimensions.get('window').height)}
  data={cards}
  keyExtractor={keyById}
  renderItem={renderReelCard} // expo-image: reelFullProps(card.id) / reelThumbProps(card.id)
  onViewableItemsChanged={({ viewableItems }) => {
    const first = viewableItems[0];
    if (first?.index != null) prefetcher.update(cards, first.index);
  }}
  onMomentumScrollBegin={() => prefetcher.notifyFling(true)}
  onMomentumScrollEnd={() => prefetcher.notifyFling(false)}
/>
// Regenerate entry point MUST gate offline first:
if (!canRegenerateReelCard(isOnline())) { showToast(COPY_REEL_OFFLINE_REGENERATE); return; }
// TTI: time open → first card interactive into reportReelTti(ms, { fromCache }).
// Weekly pool: weeklyPoolFromServer(paywallStatus.weekly_pool) → canUseWeeklyDrop();
// blocked → WEEKLY_DROP_BLOCK_COPY[reason] + reportQuotaBlocked(reason, 'weekly_drop').
```

### Board-picker recipe (Pinterest tab — frontend turf, perf owns the engine)

```ts
// Cached-first paint (stale-while-revalidate; server is source of truth):
const { fresh, stale } = readPinBoards();
const boards = (fresh ?? stale)?.boards ?? [];
// TTI: time open → grid interactive into reportPinBoardTti(ms, { fromCache: !!fresh }).

// One prefetcher per board grid (holds the cancel generation):
const prefetcher = new PinPrefetcher({
  isOnline, // NetInfo probe from the app shell
  onEvent: (event, props) => analytics.capture(event, props), // perf_pin_prefetch
});
<FlashList
  data={pins}
  keyExtractor={keyById}
  renderItem={renderPinCell} // expo-image: pinThumbProps(pin.id), uri pinThumbUrl(pin.imageUrl)
  onViewableItemsChanged={({ viewableItems }) => {
    const first = viewableItems[0];
    if (first?.index != null) prefetcher.update(pins, first.index); // ±6 thumbs
  }}
  onMomentumScrollBegin={() => prefetcher.notifyFling(true)}
  onMomentumScrollEnd={() => prefetcher.notifyFling(false)}
/>
// Sync entry point (nightly job + manual pull — NEVER the critical path):
const gate = shouldRunPinSync({ isOnline: isOnline(), isForegroundCritical, lastSyncedAtMs, isManual });
if (!gate.allowed) { if (isManual) showToast(PIN_SYNC_BLOCK_COPY[gate.reason!].body); return; }
// Offline Boards tab: cached boards browse; Sync button disabled + COPY_PIN_OFFLINE_SYNC.
// Disconnect (settings): purgePinCachesOnDisconnect() — taste-graph keys only.
```

### Pose-ref preload recipe (pose-adapt render — same std pool, no new quota class)

```ts
// 1. Offline hard-fail FIRST (renders NEVER queue — iron law):
if (!isOnline()) { showToast(COPY_OFFLINE_RENDER); return; }
// 2. Warm the 736px pose-ref(s) into disk cache before the submit:
await preloadPoseRefs([pinFullUrl(pin.imageUrl)], { isOnline, onEvent: capturePinPrefetch });
// (never throws — `failed` only degrades the preview; the server fetches the canonical URL)
// 3. Standard quota gate against the SAME std pool (placement names the surface):
if (!quotaStore.getState().guard('pose_adapt_generate')) return; // 1 credit, ~$0.068
// 4. Enqueue as usual (integrations turf owns mode/tier mapping — tier MUST be std):
const { job, blocked } = await renderQueue.getState().enqueue({ ..., mode: 'tryon', tier: 'std', day });
// Share-back (Pin create) is $0 / 0 credits: integrations turf, no quota call, offline → disabled.
```

## Integrations must provide (perf never imports these — injected)

| Interface | Where | Notes |
|---|---|---|
| `FaceDetector.detectFaces()` | image-pipeline | Preferred: read cached `quiz-score` verdict from `dnaCache.faceVerdict`; offline → throw, client defers |
| `SmallFileTransport.putBytes()` | image-pipeline | Supabase Storage single-shot PUT (garments) |
| `ResumableTransport` (start/chunk/complete) | image-pipeline | Supabase tus resumable (base photos); persist via `mmkvKV`, key `'upload:base-photo:session'` |
| `RenderTransport.submitRender/fetchRenderStatus` | render-queue | Edge Fn `render-tryon`/`restyle`; submit MUST honor `idempotencyKey` (return cached URL, 0 cost) |
| `isOnline()` + reconnect hook | render-queue `createRenderQueue` | NetInfo; on reconnect call `flushOutbox(sender)` for NON-render actions only |
| `quotaGuard` | render-queue | `quotaStore.getState().guard` — same instance the badge reads |
| `onBlocked(reason, placement)` | quotas | Opens PaywallSheet; ALSO `reportQuotaBlocked` (telemetry) |
| `AnalyticsSink` + `ErrorSink` | `initPerfTelemetry()` at startup | PostHog capture + Sentry; every event gets `{user_id, tier}` added there |
| Push tap → router | app shell | `parseRenderDeepLink(url)` → navigate to result screen → `ingestStatus(id,'done',{outputUrl})` after fetch |
| Pinterest listing (boards/pins, newest-first) + 429 `Retry-After` | server edge fn (backend turf) | Client paces via `shouldRunPinSync`/`chunkBoardSync`/`capPinsNewestFirst`/`pinSyncBackoffDelayMs`; server paginates + enforces Trial 1000 req/day · `org_read` 1000/min |

## Shared constants

- Deep link: `vai://render/<renderId>` (push "Try-on ready" payload + tap).
- Idempotency: `sha256(user|base|outfit|day)` — compare mode sends ONE Max request.
  Pose-adapt extends the key with the pin id (`sha256(user|base|outfit|day|pin)`)
  but stays the same std cost class (1 credit, ~$0.068 — no new quota class).
- MMKV keys: `closet:list:v1` (5m) · `style:dna:v1` (24h) · `quota:mirror:v1` (60s) ·
  `paywall:status:v1` (5m) · `render-queue:outbox:v1` · `upload:base-photo:session` ·
  `pinterest:boards:v1` (24h) · `pinterest:pins:<boardId>:v1` (24h, purged on disconnect).
- Offline outbox types: `wishlist_add|wishlist_remove|outfit_save|wear_log|garment_delete`.
  Renders NEVER enter the outbox (hard-fail with airplane-mode copy).
