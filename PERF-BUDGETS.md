# VAI PERF-BUDGETS.md — performance + spend budgets (perf owner)

Targets: Expo SDK 57, Hermes, new architecture. Cold start <2s · 60fps lists ·
render-queue UX that survives 10–55s AI latency. Every budget below names its
measurement (PostHog event / Sentry metric); untracked budgets don't exist.

## 1. JS bundle (Hermes bytecode, production EAS build)

| Budget | Limit | Measured by |
|---|---|---|
| Initial route bundle (Brotli transfer) | ≤ 900 KB | EAS build artifact size (CI check) + `perf_cold_start.tti_ms` proxy |
| Total JS all routes, lazy-loaded (Brotli) | ≤ 2.5 MB | CI bundle-analyzer on every PR |
| Single new dependency | ≤ 50 KB Brotli, or perf-owner approval | `expo export --dump-sourcemap` diff in PR |
| No network on critical path | 0 blocking fetches before first paint | Sentry `app.tti` span has no `http` children |

Rules: Expo Router lazy routes; `expo-image`/`FlashList`/`MMKV` already pay
their way (below). No moment/lodash-style pulls. ML kits (face/pose) are
BANNED from the client — server verdicts via cache (see CONTRACT-perf.md).

## 2. Image weights per screen (transfer, cached after first load)

| Screen | Budget | How |
|---|---|---|
| Home hero (outfit + base thumb) | ≤ 350 KB total | hero prefetch, `heroImageProps` high priority |
| Closet grid (visible window, ~9 cells) | ≤ 300 KB (≤ 40 KB/thumb) | 3-col grid, WebP ≤1024px, low-priority thumbs |
| Try-on result | ≤ 500 KB | single std render ≤ 1K; Max only on compare/hero |
| DNA / share card | ≤ 150 KB | compressed export, watermark baked server-side |
| Onboarding (per screen) | ≤ 200 KB | static assets via `assetBundlePatterns`, no remote |
| Garment upload (hard gate) | < 200 KB WebP, 1024px | `compressGarmentPhoto()` throws above |
| Base photo (hard gate) | 1080×1920 JPEG q0.9 | `compressBasePhoto()` + `preflightBasePhoto()` |

Measured by: `perf_image_compressed{in_bytes,out_bytes}` (PostHog) per upload;
screen weights spot-checked in QA with Flipper/Network + Sentry `http` spans.

## 3. Render latency targets (Gemini reality: 10–55s, BUILD-PACK §5)

| Tier | p50 | p95 | Timeout / retry |
|---|---|---|---|
| std (`gemini-3.1-flash-image` 1K, default everywhere incl. free) | ≤ 20 s | ≤ 40 s | 90 s → failed → retry ONCE on std |
| Max (Flash 2K / `gemini-3-pro-image` fallback; premium / compare / hero only) | ≤ 35 s | ≤ 70 s | 90 s → failed, no auto-retry (cost) |
| Client poll window | — | 120 s | then push owns resolution (`pollingStopped`) |
| Perceived (skeleton → interactive) | < 300 ms | < 600 ms | optimistic job row, no spinners-on-white |

NEVER display seconds or % on screen. Copy: stages + "Usually ~20s — we'll
ping you when it's ready." (`RENDER_PROGRESS_STEPS`).
Measured by: `render_settled{latency_ms, outcome, render_model}` → PostHog
p50/p95 dashboard; Sentry `render.latency` measurement; acceptance gate
"render p95 tracked" = this dashboard exists before TestFlight.

## 4. Quota costs + MAX_DAILY_SPEND_USD (Gemini-rebased, Sep 2026)

| Action | Model / tier | Cost (USD) | Credits |
|---|---|---|---|
| try-on (std) | `gemini-3.1-flash-image` 1K | **$0.067** | 1 |
| restyle (std) | `gemini-3.1-flash-image` 1K | **~$0.068** | 1 |
| compare / hero (Max) | Flash 2K / `gemini-3-pro-image` | **$0.134–0.30** | 2–3 |
| legacy fallback (server-side chain only) | `fashn` | **$0.075 / $0.38** | — |
| failed / errored prediction | — | **$0** | 0 — only `done` decrements quota/ledger |
| identical re-request (same sha256 key) | — | **$0** | cached URL |
| compare mode | ONE Max render tiled | 1× Max | never 3 renders |

Caps: free = 5 lifetime renders (hard paywall at 6th) · premium/trial =
30/mo · packs = consumable std/HD only. Client hard-blocks at 0
(`quotas.ts guard()`); server re-checks (no bypass).

### Spend formula (evaluated daily in the backend cron; client mirrors caps)

```
blended_max_mix = 0.85 × 0.067 + 0.15 × 0.134   // Max capped at 15% of renders;
                = $0.07705 / render             // Max vehicle is Flash 2K; rare
                                                // pro-image excursions ($0.15–0.30)
                                                // are absorbed by the cap + breakers

MAX_DAILY_SPEND_USD =
    P × 1.0 × blended_max_mix        // premium subs × ~1 render/day
  + T × 1.0 × 0.067                  // trials (std-only, Max locked)
  + F × r_first × 0.067              // free DAU × first-render rate (~0.40 target)
  + E_packs × 0.067                  // expected pack redemptions that day

P = active premium subs · T = active trials · F = free DAU
r_first measured from aha_first_tryon funnel.
```

Breakers: spend ≥ 80% of cap → warn (#alerts) + lock Max to compare-only;
≥ 100% → force std everywhere, restyle 3→1 per session, prefetch off;
≥ 120% → freeze free teaser renders, hero compare → single std.
Recovery is automatic next UTC day; lowering caps needs founder sign-off.

## 5. List / interaction budgets

| Metric | Budget | Measured by |
|---|---|---|
| Sustained JS FPS, closet fling (Pixel 6a) | ≥ 55 | Sentry mobile `ui.slow_frames` + QA `perf_list_jank` |
| Blank cells per 100-row fling | < 1% | `perf_list_jank{blank_cells}` |
| Tap → Generate optimistic row | < 300 ms | `render_requested` → first `jobs[key]` paint (Sentry span) |
| Cold start tap → interactive | < 2 s p50, < 3 s p95 | `perf_cold_start.tti_ms` |

## 6. What to cut if exceeded (ordered kill-list, no meeting needed)

1. Max tier → compare/hero only (already default; lock the override flag).
2. Restyle 3/session → 1/session; fallback text tightened.
3. Outfit-image prefetch OFF (visible lists keep priority).
4. Compare 2-up → single std + "compare unlocks with Premium" upsell.
5. Free first-render teaser copy stays, but teaser IMAGE becomes cached sample.
6. Garment thumb quality 0.85 → 0.7 (still < 200 KB gate).
7. Week-strip lite → single hero day on low-RAM devices (< 3 GB).
8. As last resort: new free signups get 3 (not 5) lifetime renders —
   founder + backend change, App Review note updated.

## 7. Dashboard checklist (must exist before TestFlight)

PostHog: `perf_cold_start` (p50/p95 `tti_ms`), `render_settled` latency
histogram by `render_model`, `quota_blocked` by placement, funnel
render_requested → succeeded/failed with `cost_usd` sum per day vs
MAX_DAILY_SPEND_USD.
Sentry: `app.tti`, `render.latency`, `ui.slow_frames`, upload failure rate,
outbox dead-letters. Alert: daily spend ≥ 80% cap; render p95 > 60 s for 1 h.

## 8. Reel (weekly-drop vertical pager)

Pager: `reelPagerSpec(screenH)` in `lib/perf/lists.ts` (pagingEnabled,
snapToInterval = screen height, disableIntervalMomentum, drawDistance = 1
viewport ≈ windowSize 3). Prefetch engine: `lib/perf/reel-prefetch.ts`
(current ±1 full-res, ±2 thumbs, `memory-disk`, recyclingKey per card id,
generation-guarded cooperative cancel on flings — expo-image exposes no
cancel handle; in-flight resolves are dropped, never applied).

| Metric | Budget | Measured by |
|---|---|---|
| Per-card image weight (AVIF/WebP) | ≤ 350 KB | `perf_reel_prefetch.requested` batch audit + Flipper/Network spot-check |
| Drop prefetch in flight | ≤ 3 MB (count-enforced: ±1 full-res window, never the full 7) | `perf_reel_prefetch{prefetched,dropped,offline}` |
| TTI of reel tab from cache | < 1.5 s p50 | `perf_reel_tti{from_cache:true}` (PostHog) + Sentry `reel.tti` |
| Sustained scroll | 60 fps, blank cells < 1% per fling | `perf_list_jank{list:'reel',blank_cells,avg_js_fps}` + `ui.slow_frames` |
| Offline | cached drop scrolls; regenerate DISABLED with copy | `COPY_REEL_OFFLINE_REGENERATE`; `canRegenerateReelCard(false) === false` |

Rules: visible card loads at high priority (`reelFullProps`); prefetch at
default/low so it never starves decode. On fast flings: `notifyFling(true)`
cancels offscreen prefetch, `update()` rebuilds on momentum-end. Renders
NEVER enter an offline queue (iron law — hard-fail with airplane-mode copy).

## 9. Weekly-drop server cost table (Flash 1K std @ $0.067/img)

One drop = 7 std cards. Max-pose variants are FORBIDDEN in drops (std only —
`WEEKLY_DROP_ALLOW_MAX_POSE = false`, enforced server-side; client mirror in
`lib/perf/quotas.ts` is read-only).

| Surface | Cards | Cost (USD) | Against |
|---|---|---|---|
| Free teaser | 3 × $0.067 | **$0.201 → ~$0.20 CAC** | acquisition (not the 30/mo pool) |
| Premium full drop | 7 × $0.067 | **$0.469 → ~$0.47** | premium 30/mo pool (no extra grant) |
| Max-pose variant in drop | — | **FORBIDDEN** | never served, never billed |

Spend-guard interaction: at ≥ 120% of MAX_DAILY_SPEND_USD the backend freezes
free teaser renders first (teaser image becomes cached sample — kill-list #5);
premium drops degrade to thumbs + cached cards, never to Max tier. Mirror
only: `weeklyPoolFromServer()` / `canUseWeeklyDrop()` /
`weeklyDropBlockedReason()` in `lib/perf/quotas.ts` (additive, no granting).

## 10. Pinterest taste graph (board/pin sync, pin grids, pose-ref, share-back)

Engine: `lib/perf/pin-cache.ts` (URL variants, grid prefetcher, pose-ref
preload, sync gate, MMKV mirrors). Listing/pagination executes server-side
(edge fn, newest-first); the client owns pacing hints + caches + images only.

API quotas (server-enforced; client paces 10–100× under):
Trial 1000 req/day · Standard `org_read` 1000/min. Sync design respects both
via nightly/manual-only cadence + chunking + per-board caps + 429 backoff.

| Metric | Budget | Measured by |
|---|---|---|
| Pin thumb (236px rendition) | ≤ 60 KB transfer | `perf_pin_prefetch` batch audit + Flipper/Network spot-check |
| Pin full (736px rendition, detail + pose-ref) | ≤ 300 KB transfer | same audit; oversize fulls still display (grid uses thumbs, full on demand) |
| Grid prefetch in flight | ≤ ~780 KB (count-enforced: ±6 thumbs, never whole boards) | `perf_pin_prefetch{requested,prefetched,dropped,offline,surface:'grid'}` |
| Pose-ref preload before render call | ≤ 3 fulls (~900 KB max), 2-concurrency | `perf_pin_prefetch{surface:'pose-ref'}` |
| Board-picker TTI from cache | < 1.5 s p50 | `perf_pin_tti{from_cache:true}` (PostHog) + Sentry `pin.tti` |
| Sustained grid scroll | 60 fps, blank cells < 1% per fling | `perf_list_jank{list:'pins',blank_cells,avg_js_fps}` + `ui.slow_frames` |
| Offline | cached boards browse; sync DISABLED with copy | `COPY_PIN_OFFLINE_SYNC`; `canSyncPins(false) === false` |

Rules: pin CDN weights are UNKNOWN until fetched — the client never assumes;
`pinImageVariant()` rewrites only recognized width tokens
(236x/474x/564x/736x/1200x/originals) and passes anything else through
untouched. Visible cell loads at normal priority (`pinThumbProps`); prefetch
at low so it never starves decode; pose-ref full at high (`pinFullProps`).
On fast flings: `notifyFling(true)` cooperatively cancels offscreen prefetch
(same engine shape as reel — expo-image exposes no cancel handle; in-flight
resolves are dropped, never applied), `update()` rebuilds on momentum-end.
Pose-adapt renders NEVER enter an offline queue (iron law — hard-fail with
airplane-mode copy, same as all renders).

### Sync guardrails (client hints; server enforces)

| Rule | Value | Where |
|---|---|---|
| Cadence | nightly auto + manual pull ONLY — never on the foreground critical path (cold start, Generate submit, checkout in flight) | `shouldRunPinSync()` gate; auto runs additionally respect `PIN_SYNC_MIN_INTERVAL_MS` (12 h) |
| Chunking | 25 pins per chunk, one chunk persisted at a time (killed sync resumes from last chunk) | `chunkBoardSync()` |
| 429 backoff | honor server `Retry-After` first; else exponential 1 s → 30 s cap + jitter; stop after 5 attempts → "try again later" copy | `pinSyncBackoffDelayMs()` + `PIN_SYNC_BLOCK_COPY.rate_limited` |
| Per-board cap | max 100 pins per board per sync, newest-first (head kept, tail dropped; safe per page AND merged) | `capPinsNewestFirst()` + `MAX_PINS_PER_BOARD_PER_SYNC` |
| Disconnect | purge taste-graph keys ONLY (`pinterest:boards:v1`, `pinterest:pins:<boardId>:v1`); closet/quota/paywall untouched | `purgePinCachesOnDisconnect()` |

### Pose-adapt render cost (same as restyle — NO new quota class)

| Action | Model / tier | Cost (USD) | Credits |
|---|---|---|---|
| pose-adapt (pin pose-ref) | `gemini-3.1-flash-image` 1K std | **~$0.068** | 1 |
| share-back (Pin create) | Pinterest write, no render | **$0** | 0 — never decrements quota/ledger |

Why no new quota class: pose-adapt runs the SAME model at the SAME 1K std
tier and resolution as restyle — the pin image is an input reference, not a
model/tier change. Cost, latency (§3 std row), idempotency/dedup ($0
identical re-request), and failure ($0) behavior are identical; only the
idempotency key gains the pin id. The client therefore gates pose-adapt with
the existing quota guard (`guard('pose_adapt_generate')` against the same
std pool) and reports it via `render_settled` with the server-authoritative
`render_model`/`cost_usd`. Share-back is a Pinterest API write with no image
model call — $0, no quota interaction, offline → disabled with copy.

Spend-guard interaction: pose-adapt follows the standard breakers (§4) as a
std render (force-std freezes change nothing for it; it is std-only by
construction — never Max). Pinterest sync itself spends $0 render budget; at
≥ 100% of cap the backend may pause the AUTOMATIC nightly sync (manual pulls
still allowed) to protect API quota for pose-ref reads.

Dashboard additions (must exist before the Pinterest TestFlight): PostHog
`perf_pin_prefetch` by `surface`, `perf_pin_tti` p50/p95 split by
`from_cache`, sync outcomes (`too_soon` skips vs 429 hits); Sentry `pin.tti`.
Alert: board-picker cached p50 > 1.5 s for 1 h; sync 429 rate > 5% of runs.
