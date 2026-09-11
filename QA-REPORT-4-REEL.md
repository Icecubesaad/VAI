# QA-REPORT-4-REEL — Style Reel (REPORT ONLY, no code touched)

- Env: `tsc --noEmit` green (verified read-only, zero output). Workdir `VAI-app/`.
- Scope: `app/(tabs)/reel.tsx`, `app/pose-pack.tsx`, `store/reel.ts`, `components/ReelCard.tsx` + `PoseGuide.tsx` + `ReelSkeleton.tsx`, `lib/perf/reel-prefetch.ts` + `lists.ts` + `quotas.ts`, `lib/ai/poses.ts` + `planner.ts` reel parts, `supabase/functions/reel-drop` + `reel-regenerate` + migration `0003`, `lib/analytics.ts`, plus `_layout.tsx`, `lib/push.ts`, `inngest.md`, `_shared/{reel,restyle,pipeline,http}.ts`, `lib/api.ts` as traced evidence.

## Gate verdicts

| # | Gate | Verdict | Key evidence |
|---|------|---------|--------------|
| 1 | Contract shape unity (ReelCard/WeeklyDrop client≡server) | **PASS** (2×P2 notes) | 10-field `ReelCard` identical in `_shared/reel.ts:26-37`, `lib/api.ts:179-190`, `components/ReelCard.tsx:13-24`; `WeeklyDrop` identical (`_shared/reel.ts:39-43` vs `api.ts:192-196`); snake↔camel mapper `api.ts:406-433`; single read path `reel.ts:157-185` |
| 2 | Pose rotation only over captured poses | **FAIL** (P0-1) | Rotation filter itself correct — `reel-drop/index.ts:168-173` (`REEL_POSES.filter(has)`, `base_missing` if none, `rotation[i % len]`). **But** it reads the `pose` *column* (`index.ts:80-90`); capture writes only `pose_meta.pose` (`pose-pack.tsx:199-205`) → rotation collapses to front-only via NULL→front (`index.ts:86`) |
| 3 | Quota enforcement (3 vs 5-lifetime; 7 vs 30/mo; 402+upgrade; no bypass) | **PASS** w/ P1 | Pre-flight 402 `free_exhausted`/`monthly_exhausted` + `upgrade:true` before spend (`reel-drop:138-149`, `http.ts:46-50`); per-card `consumeAllowance` + race refund (`index.ts:231-275`); client regen gates `rendersLeft`→paywall (`reel.tsx:364-372`); no credit-granting API (`quotas.ts:4-8`). Regen weekly budget mismatch → P1-2 |
| 4 | Pager perf recipe | **PASS** (P2 nit) | No banned props — deliberate omission documented (`lists.ts:196-227`); `drawDistance`=1 screen (`lists.ts:224`); prefetch ±1 full / ±2 thumb (`reel-prefetch.ts:39-42,136-157`); cooperative fling cancel (`reel.tsx:232-247`, `reel-prefetch.ts:163-216`); offline skip + copy (`reel-prefetch.ts:188-191`, `reel.tsx:492-496`) |
| 5 | Pose-lock anti-mangle | **PASS** (P2 note) | Framing-only directives (`poses.ts:77-89`), step explicit "Do NOT invent a mid-stride pose" (`poses.ts:82-84`), lock-first prompt (`poses.ts:101-107`), `FACE_POSE_DIRECTIVES` (`gemini.ts:133-136`), pipeline hard constraints (`pipeline.ts:137-138`), restyle preserve-suffix (`restyle.ts:188`) |
| 6 | Cost math ($0.20 / $0.47 / 1 credit) | **PASS** | `COST_STD_USD=0.067` (`quotas.ts:27`, `_shared/gemini.ts:11`); teaser `3×`=0.201 (`quotas.ts:227-232`), premium `7×`=0.469 (`quotas.ts:233-234`); display estimate `planner.ts:467-470`; pending-estimate const `reel.ts:59`; regen "1 credit ALWAYS" (`reel-regenerate:8-12`) |
| 7 | Deep link `vai://outfit/<date>` → reel; Monday push handled | **PARTIAL FAIL** (P1-1) | Link path PASS: hostname+path parsing + `weekOf`/`week_start` fallback (`_layout.tsx:84-100`), warm+cold routing (`_layout.tsx:141-153,204-210`), in-week→Monday normalization (`reel.tsx:53-58`). Push payload FAIL: server sends `{kind:"week_ready", week_of}` (`inngest.md:139-144`) but client `PushKind` lacks it (`push.ts:25`), `normalizeData` drops `week_of` (`push.ts:187-202`), `deepLinkForPush`→home (`push.ts:69-82`), no notification-router wiring in `_layout` |
| 8 | Empty states (no poses / no drop / error / offline) | **PASS** | Pose-empty CTA (`reel.tsx:502-510`), drop-empty "Style my week" (`reel.tsx:515-524`), error+retry (`reel.tsx:511-514`), offline banner (`reel.tsx:492-496`), stale-drop notice (`reel.tsx:527-531`), skeleton (`reel.tsx:498-501`), pose-pack denied/age-blocked/loading/complete (`pose-pack.tsx:226-294`) |
| 9 | Analytics events fire with `cost_usd` | **FAIL** (P1-3) | `weekly_drop_started/completed` carry summed `cost_usd` (`reel.tsx:65-67,186-194,410-415`; types `analytics.ts:102-104`) BUT may sum pending-card **estimates** while labeled authoritative; `reel_card_regenerated` has **no `cost_usd`** (`analytics.ts:106`, call site `reel.tsx:385-391`) despite costing 1 credit; `reel_opened/card_viewed/wear/shop` fire correctly (`reel.tsx:160-166,219-226,274-281,317-322`) |

## Defects

**P0-1 — Pose capture never reaches the server rotation (drop degrades to front-only).**
`pose-pack.tsx:199-205` inserts `pose_meta:{pose}` and supersedes on `pose_meta` (`:187-198`); `store/reel.ts:180-199` reads `pose_meta`; but `reel-drop/index.ts:80-90` selects the `pose` *column* added in `0003_reel.sql:30-31`. Fresh step/detail captures are invisible server-side; legacy NULL→front (`index.ts:86`) forces `rotation=[front]` → 3/7 all-front cards while the client pose gate shows "complete". No backfill/trigger/sync found anywhere. Fix direction: write the `pose` column on confirm (and/or read `pose_meta` server-side).

**P1-1 — Monday "week ready" push tap does not land on the reel.**
Server payload `{kind:"week_ready", week_of}` (`inngest.md:139-144`) vs client: kind not in `PushKind` (`push.ts:25`), `normalizeData` coerces to `generic` and drops `week_of` (`push.ts:187-202`), `deepLinkForPush` defaults to `vai://home` (`push.ts:69-82`); `_layout.tsx` only handles `Linking` URLs, never notification responses. The `vai://outfit/<date>` link itself works — the push path just never produces/routes it.

**P1-2 — Regen budget: client 3/week vs server 1/day + 3/session-chain, no server weekly counter.**
Client mirror `MAX_REGENERATES_PER_WEEK=3` (`store/reel.ts:11,135-139`, copy `reel.tsx:557-559`) vs server free daily slot + session-chain cap, no weekly counter (`restyle.ts:90-127`). Free user attempting a 2nd same-day regen gets `restyle_daily_exhausted` 402 while UI shows budget left; direct-API callers bypass the weekly cap entirely ("server is truth" violated for this budget).

**P1-3 — Analytics cost attribution gaps.**
(a) `weekly_drop_completed` fires on drop display (`reel.tsx:176-194`) when cards may still be pending (`imageUrl:""`, estimate `costUsd`), so the "REQUIRED server-authoritative" sum (`analytics.ts:103-104`) can be estimate-based. (b) `reel_card_regenerated` omits `cost_usd` (`analytics.ts:106`; `reel.tsx:385-391`) though every regen costs 1 credit (`reel-regenerate:8-12`).

**P2-1 — Fail-closed erosion in `lib/api.ts`.** `toReelPose` silently defaults unknown→`'front'` (`api.ts:400-403`) vs fail-closed `assertReelPose` (`poses.ts:60-68`); `mapWeeklyDrop` defaults any non-`teaser` tier→`'full'` (`api.ts:431`) — a corrupt tier renders premium "Full drop" copy to free users.

**P2-2 — `ReelCard` image skips the perf recipe's own props.** Plain `expo-image` without `recyclingKey`/`priority` (`ReelCard.tsx:275-281`) though `reelFullProps`/`reelThumbProps` exist for exactly this (`reel-prefetch.ts:103-120`) — recycled pager views can flash previous photo under fling.

**P2-3 — "Detail" capture guidance contradicts itself.** Seated pose + "Sit tall" (`PoseGuide.tsx:44-50,76-89`) vs "Step closer — frame waist to shoes" (`pose-pack.tsx:47-50`) vs "three-quarter crop" (`poses.ts:85-88`). Sitting users get a standing-crop directive downstream.

**P2-4 — Spec nit: reel is the 5th tab, not 6th.** Order Today·Closet·TryOn·Shop·**Reel**·Profile (`app/(tabs)/_layout.tsx:24-37`).

**P2-5 — "Style my week" has no client pre-gate.** `handleStyleWeek` POSTs blind (`reel.tsx:405-418`); exhausted users learn via generic `fetchError` instead of the paywall sheet (regen path does gate, `:364-372`).

## Notes / out of scope
- `trial`→`premium` analytics mapping (`reel.tsx:61-63`) is intentional; `wear-it-today` RPC + CPW mirror (`reel.tsx:256-294`) and save-local-truth (`:334-339`) look right; `MAX` poses forbidden in drops (`quotas.ts:237-239`) respected (drop tier hardcodes `std`, `reel-drop:250`).
- Suggested fix order: P0-1 → P1-1 → P1-2/P1-3 → P2 batch.
