# QA-REPORT-2-CORELOOP — trace-by-reading (REPORT ONLY, no edits)

Scope: README.md + VAI-BUILD-PACK.md §4/§5/§11 vs code. Green baseline taken as given (tsc 0, doctor 21/21 — types pass; most defects below are wrong-but-typed `as`/cast shapes, which tsc cannot catch).

## Per-gate verdicts

| # | Gate | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Closet add: camera→compress→auto-tag→grid | **FAIL (P0+P1)** | camera single-item OK `app/onboarding/closet-min3.tsx:36-41`; **compress bypassed** (uploads raw q0.9 b64 `:46-52`, never calls `compressGarmentPhoto` — 200KB budget `lib/perf/image-pipeline.ts:31,224` unenforced); **auto-tag contract mismatch** (server returns `{garment,tags}` snake `supabase/functions/auto-tag/index.ts:132-138`, client reads flat camel `tag.cutoutUrl/tag.category` + mints `id: Date.now()` `closet-min3.tsx:55-71` — real id/category lost); grid/insights/cap OK `app/(tabs)/closet.tsx:24-47,83-87,125-132`; card fields OK `components/GarmentCard.tsx:37-91` |
| 2 | Insights banner | **PASS** | local `"…no red"` `:35-37` + server `analyzeGaps` `supabase/functions/shop-picks/index.ts:67-98` |
| 3 | Planner hero (chips, why-line) | **FAIL (P0)** | server returns snake `garment_ids/why_line/context` (`_shared/plan.ts:237-248`, `plan-day/index.ts:34-46` spreads `...plan`); client `PlannedOutfit` camel with **no mapper** (`lib/api.ts:91-100,211-212`) → `id/garmentIds/whyLine/weatherSummary/eventLabel` all `undefined`, hero renders empty. `eventLabel` sent but server has no such param (`plan-day:25-32`); weather needs `lat/lon` client never sends |
| 4 | Try-on generate | **FAIL (P0)** | `outfitId = selected.sort().join('_')` (`app/(tabs)/tryon.tsx:196`) is a fake id → server outfit lookup throws `outfit_not_found` (`render-tryon/index.ts:74-79`). **Every Generate fails by reading.** Response also snake (`render_id/output_url`) vs `RenderJob{id,outputUrl}` (`api.ts:106-111,217-224`) → `r.id` undefined → poll broken |
| 5 | Queue states queued/processing/done/failed | **PASS (server)** | enum `migrations/0001_schema.sql:27`; transitions+refund+simplify-retry `pipeline.ts:349-356,380-396,399-414`. Client poll handles done/failed+95s timeout `tryon.tsx:117-148` but polls direct-DB (see P0-3) |
| 6 | Push-ready | **PARTIAL (P1)** | server sends both pushes `pipeline.ts:379,416`, prunes dead tokens `push.ts:44-52`. BUT server data `{kind:"render_ready",render_id}` (`_shared/push.ts:58-70`) vs client expects `{kind:"render-ready",renderId}` (`lib/push.ts:187-208`) → `onRenderReady` never fires; `addNotificationRouter` **never wired in `app/`** — tap cold-opens to home, renderId lost (foreground poll is the only working path) |
| 7 | Compare | **PASS (server)** | ONE Max render `render-tryon:338-341`. Note P2-3: free compare → `hd_requires_pack` 402 with no client disclosure (`tryon.tsx:191` picks std, server forces max) |
| 8 | Restyle (3-cap, 1 credit) | **PASS** | routed not rejected `render-tryon:317-333` → shared core `_shared/restyle.ts`; 3/session+keep-best `:106-115`; always 1 credit `:155-165`; free 1/day bump-FIRST `:121-127`; client pre-check `lib/ai/gemini.ts:359` |
| 9 | Quota hard-block, 6th free render | **PASS** | `free_exhausted`→402 `quota.ts:120-122`; `hardBlocked` `paywall-status:97`; 402→`QUOTA_EXCEEDED`→paywall `api.ts:181-183`, `tryon.tsx:184-187,215-218`; store mirror `store/quotas.ts:13,68-69` |
| 10 | Idempotency dedup ($0 cached) | **PASS (server)** | key `sha256(user\|base\|outfit\|day\|mode\|tier)` `idempotency.ts:38-49`; identical key→cached 200 `render-tryon:361-368`; failed rows not reusable `:64-66`; restyle same `:141-153, restyle.ts` |
| 11 | Signed base-photo URLs | **PASS (code)** | path stored + 1h signed mint `selfie-capture.tsx:101-111`, re-mint `tryon.tsx:66-98`, server `signedUrl(sb,"base",…)` `pipeline.ts:326,339`. Zero `getPublicUrl` on `base` (hits are public `garments`/`renders` + stale docs — P2-1) |
| 12 | Shop cards + wishlist | **FAIL (P0 client / PASS server)** | server: disclosure `:148,255`, `subid=user_id` (`uid=` `:222`, skim `xcust` `:100-105`), null-URL filter `:219-225`, honest `shoppable:false` `:202-204`; client footer disclosure `shop.tsx:111-115`. BUT `api.shopPicks` casts envelope as `ProductPick[]` with no unwrap (`api.ts:243-244`) → grid fed an object. Wishlist = local `useState`, never writes `wishlist` table, `wishlist_added` never tracked (`shop.tsx:16-31`) |
| 13 | cost_usd end-to-end on render events | **FAIL (P0-3)** | server chain complete: `logRenderCost`→`render_cost` (`ledger.ts:22-46`), `renderCostUsd` resolver (`:83-93`), status `cost_usd` when done (`render-tryon:234-237`); `gemini.ts` preserves `costUsd` (`:326-348,399-406`); analytics types REQUIRE it (`analytics.ts:60-75,175-209`). BUT the shipped UI path uses `api.getRender` direct-DB with **no cost/model** (`api.ts:229-241`) and `tryon.tsx` has **zero `track()` calls** (only `track` in repo: `affiliate_click`, `affiliate.ts:176`) → PostHog `render_succeeded/failed`+`cost_usd` never fire |

## Iron-law greps (mandatory)

- `"unlimited"`: 11 hits, ALL in never-contexts (`README.md:39`, `CONTRACT-uiux.md:46`, `paywall.tsx:110`, `Sheet.tsx:93`, `0001_schema.sql:8`, `billing.ts:13`, `perf/quotas.ts:12`, `_shared/quota.ts:4`, reports). **Zero violations — PASS.**
- `"3/day"` / daily-refill logic: **zero** (only "never daily refills" comments + `FREE_RESTYLES_PER_DAY=1`, which is the legal restyle slot, `quota.ts:15`). Free renders = 5-lifetime pool `quota.ts:13,79-81` + `consume_render_allowance` `0001:294-361`. **PASS.**
- render-tryon rejects restyle? **No — routed** (`render-tryon:317-333` → shared core). **PASS.**

## Defects

**P0-1 Try-on Generate always fails** — fake `outfitId` (`tryon.tsx:196`) → `outfit_not_found` (`render-tryon:74-79`). Repro-by-reading: select any garments → Generate → 400. Fix: send `garmentRefs` only (no `outfitId`) unless a real outfit row exists.
**P0-2 Systemic snake→camel gap in `lib/api.ts`** — `requestTryon` (`:217-224`), `planDay` (`:211-212`), `shopPicks` (`:243-244`, envelope≠array), `autoTag` (`:208-209`, nested `{garment,tags}`) have no mappers. Breaks gates 1/3/4/12 at runtime despite green tsc. Fix: one response-mapping layer + round-trip test.
**P0-3 `cost_usd` never leaves the device path that ships** — `api.getRender` (`api.ts:229-241`) bypasses edge status; `tryon.tsx` never tracks render events. Unit-economics auditing blind. Fix: poll edge `action:status`, call `renderCostPropsFromResult` on settle.
**P1-1 No compress on closet add** — `closet-min3.tsx:46-52` vs `image-pipeline.ts:224` (`GARMENT_MAX_BYTES` `:31`). Oversize uploads, wasted bandwidth.
**P1-2 Push-tap deep link dead** — snake/kebab + `render_id`/`renderId` mismatch + `addNotificationRouter` unwired (`lib/push.ts` vs `_shared/push.ts:58-70`, `app/_layout.tsx:50-59` only handles URL opens).
**P1-3 Wishlist not persisted/tracked** — `shop.tsx:16-31`.
**P1-4 Try-on `restyle` mode without `render_id` → 400** — mode switcher (`tryon.tsx:254-270`) feeds `handleGenerate` which sends no `render_id`. Route restyle taps to an existing render or hide the mode until one exists.
**P2-1 Stale docs**: `CONTRACT-frontend.md:73` (wrong bucket names), `docs/SECURITY.md:182` (describes pre-fix `getPublicUrl`; code now correct). **P2-2** client idempotency keys omit mode/tier (`tryon.tsx:192-195`, `render-queue.ts:149-154`) vs server includes. **P2-3** compare→Max 402 undisclosed to free users. **P2-4** `eventLabel` + weather chips have no live data path.

## Note for QA-1/others

Server pipeline (quotas, idempotency, restyle caps, ledger, push-send, shop resolver, signed URLs) is the strongest area — nearly all core-loop breaks are in the **client contract-mapping layer** (`lib/api.ts` + two screens). Recommend QA-1 prioritize P0-2 mapping tests; analytics (P0-3) blocks launch-gate economics (trial→paid/D7 per BUILD-PACK §12 depend on render funnel data).
