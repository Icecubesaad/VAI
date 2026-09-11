# CONTRACT — integrations turf (`lib/ai/*`, `lib/edge.ts`, `lib/billing.ts`, `lib/affiliate.ts`, `lib/push.ts`, `lib/analytics.ts`, `lib/sentry.ts`)

Owner: integrations engineer. Other engineers: import these modules, do not fork them. Changes to request/response shapes below require a contract bump + heads-up in the PR.

Stack (verified Sep 2026): Gemini `gemini-3.1-flash-image` (Nano Banana 2) PRIMARY → `gemini-3-pro-image` fallback → FASHN fallback-only.
Divergence from BUILD-PACK §1/§5 (which says FASHN primary): this contract ships Gemini-primary per README + brief. Backend `render-tryon` MUST route Gemini first.

## 1. Imports for other engineers

```ts
import { tryon, restyle, buildRestylePrompt, pollRender, getRenderStatus, estimateCostUsd,
  PRIMARY_IMAGE_MODEL, GEMINI_IMAGE_COST_USD, MAX_RESTYLES_PER_SESSION } from '@/lib/ai/gemini';
import { planDay, planWeek, generateWhyLine, validatePlan, PLAN_DAY_SYSTEM_PROMPT,
  trendSeedPack, reelWeekPlanner, estimateWeeklyDropCostUsd,
  REEL_DROP_CARD_COUNT, MAX_TREND_SEEDS } from '@/lib/ai/planner';
import { buildPosePrompt, selectBaseForPose, parseReelPose, isReelPose,
  REEL_POSES, REEL_WEEK_POSES, POSE_FRAMING_DIRECTIVES,
  UnknownPoseError, NoBasePhotoError } from '@/lib/ai/poses';
import { buildPoseTransferPrompt, isPoseMode, DEFAULT_POSE_MODE, POSE_MODES,
  POSE_ADAPT_COST_USD, PoseTransferError } from '@/lib/ai/pose-transfer';
import { validateRenderGarments, assertRenderGarments, isPinReferenceRole,
  assertPinReferenceRole, PIN_REFERENCE_ROLES,
  ClosetGuardError, PinReferenceRoleError } from '@/lib/ai/closet-guard';
import { tasteSeedPack, MAX_TASTE_SEEDS } from '@/lib/ai/taste-seeds';
import { buildPinCopy, PIN_TITLE_MAX, PIN_DESCRIPTION_MAX, PIN_ALT_MAX } from '@/lib/ai/pinterest-share';
import { requestAutoTag, requestEmbedding, cosineSimilarity, validateGarmentTag } from '@/lib/ai/tagging';
import { callEdgeFunction, generateIdempotencyKey, EdgeError } from '@/lib/edge';
import { initBilling, getPaywallStatus, purchaseSubscription, purchaseCreditPack,
  restorePurchases, isHardPaywalled, ENTITLEMENT_ID, PRODUCT_IDS, CREDIT_PACKS,
  TRIAL_COPY, getWinBackOffer } from '@/lib/billing';
import { getShopPicks, logTryOnToBuy, shouldShowGapFill, findOwnedComplement,
  AFFILIATE_DISCLOSURE } from '@/lib/affiliate';
import { registerPushToken, addNotificationRouter, scheduleTrialDay5Reminder,
  parseDeepLink, defaultForegroundBehavior } from '@/lib/push';
import { initAnalytics, track, setAnalyticsTier, renderCostProps, ANALYTICS_EVENTS } from '@/lib/analytics';
import { initSentry, captureError, setSentryUser } from '@/lib/sentry';
```

Auth convention: every edge-calling function accepts `EdgeCallOptions { authToken?, getAccessToken? }` last. Frontend passes the Supabase session JWT. No module here stores tokens.

## 2. Edge-function protocols (backend must implement)

### `render-tryon` — request
`{ base_photo_id?, base_photo_url?, garment_refs: [{garmentId?, imageUrl, category?}], mode: 'tryon'|'restyle'|'compare', tier: 'std'|'max', resolution: '0.5K'|'1K'|'2K'|'4K', model_hint: 'gemini-3.1-flash-image'|'gemini-3-pro-image', outfit_id?, day: 'YYYY-MM-DD', fallback_of? }`
+ `idempotency_key` (body) and `X-Idempotency-Key` (header). Identical key → cached URL, 0 cost.
### `render-tryon` — response
`{ render_id, status: 'queued'|'processing'|'done'|'failed', cached?, model?, output_url?, cost_usd?, fallback_eligible?, error_code? }`
Status poll: same fn with `{ action: 'status', render_id }`.
Server rules (§5): quota check first; only `done` decrements quota/ledger; 90s timeout → failed + 1 std retry; compare = ONE Max render tiled.

### `restyle` — request
`{ render_id, note, rewritten_prompt, prompt_tags: string[], photo_conditions: {lighting?, background?, pose?, priorFailTags?}, tier, model_hint }` + idempotency.
Response = render-tryon response + `{ rewritten_prompt? }`. Server enforces max 3/session.

### `plan-day` — request
`{ date, weather: {tempC, condition, precipitationChancePct?, windKph?}, event?, owned_garment_ids, history, laundry_blocked_ids, style?, prompt }`.
Response: `{ garment_ids, why_line, score?, gap_note? }` (strict JSON, temp 0).
Optional repair pass: same shape + `prompt` containing `REPAIR` violations block.

### `plan-week` — request `{ days: [plan-day shape × 7] }`. Response `{ days: { [date]: plan-day response } }`.

### `auto-tag` — request `{ image_url?, image_base64?, prompt }` → `{ tag_json: object|string, cutout_url?, embedding?: number[512], repaired? }`.
Repair: `{ repair: true, raw }`. Embed: `{ action: 'embed', image_url?|garment_id? }` → `{ embedding: number[], model? }`.

### `shop-picks` — request `{ user_id, outfit_id?, gap?, budget_band?, limit? }` → `{ picks: [{retailer, productId|product_id, title, imageUrl|image_url, price, currency?, rating?, affiliateUrl|affiliate_url (signed, subid=user_id), network, valueAddReason?, badge?}] }`.
Click log: `{ action: 'click', user_id, render_id, click_id, product_id, retailer }` → `{ ok: true }` (best-effort).
Field-name note: server may use snake_case; client normalizes? NO — server MUST return the camelCase names in `AffiliateProduct` (contract).

### `paywall-status` — request `{ user_id }` → `{ tier: 'free'|'premium', trialing, trial_ends_at?, renders_left, renders_cap, quota_resets_at }`. Server is tier/quota truth.

### REST `push_tokens`
`POST /rest/v1/push_tokens { user_id, expo_token }` with `Prefer: resolution=merge-duplicates`. Backend must explicitly expose `push_tokens` to the Data API (Apr-2026 change).

## 3. Billing (RevenueCat)

Entitlement `premium`. Products: `vai_premium_monthly` $4.99, `vai_premium_yearly` $39.99, `vai_credits_10` $1.99, `vai_credits_25` $4.99, `vai_hd_single` $0.99. Caps: free = 5 lifetime renders then `isHardPaywalled()===true` → upgrade sheet; premium = 30/mo. Trial 7d card-required (store intro offer); copy in `TRIAL_COPY`; local reminder backup via `scheduleTrialDay5Reminder`. Win-back: `getWinBackOffer(daysSinceChurn)` (D+3 50%-off-2mo, D+30 free week); codes configured in App Store Connect / Play Console. Log purchases with analytics events (`trial_started`, `credits_purchased`, …) in UI layer.

## 4. Analytics (PostHog)

38 events in `ANALYTICS_EVENTS` (§10 + retention_ping{day:1|7|30} + 7 reel events in §8 + 6 pinterest events in §10); 20 core funnel events in `CORE_20_EVENTS` (unchanged — reel + pinterest events are NOT core funnel). `track(event, props)` is compile-time typed per event. REQUIRED on render events: `render_model` + `cost_usd` (server-authoritative). REQUIRED on weekly-drop events (`weekly_drop_started/completed`): `card_count` + `cost_usd` (server-authoritative sum). Use `renderCostProps()`.

## 5. Push + deep links

Scheme `vai://`: `tryon/<renderId>`, `paywall?placement=`, `shop/<productId>`, `shop/disclosure`, `outfit/<date>`, `home`. Notification `data.kind`: `render-ready|trial-reminder|price-drop|referral`. Price-drop is v2 forward-compat (handler wired, server silent until v2).

## 6. Env vars

PUBLIC (client, `.env`): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`, (`EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_HOST` — founder to add, see blockers).
SERVER-ONLY (Supabase secrets, never client): `GEMINI_API_KEY`, `FASHN_API_KEY`, `SHOPSTYLE_KEY`, `LTK_AFFILIATE_ID`, `SKIMLINKS_ACCOUNT`, `STRIPE_SECRET`, `RESEND_KEY`, `POSTHOG_SERVER_KEY`, RevenueCat secret.

## 7. Error taxonomy

`EdgeError { fn, status, code, retryable }` (codes: network/timeout/unauthorized/forbidden/not-found/conflict-duplicate/rate-limited/quota-exhausted/upstream-failed/upstream-timeout/bad-request/server). `quota-exhausted` → paywall sheet, never silent retry. `BillingError { code, userCancelled }` — never show error UI for `user-cancelled`. `AutoTagError { excerpt }` → review queue + Sentry. `RestyleLimitError` → keep-best sheet. `UnknownPoseError { code:'unknown-pose' }` → fail-closed, never silently default a pose. `NoBasePhotoError { code:'no-base-photo' }` → capture-base-photo prompt. `ReelWeekError { code:'reel-week-invalid' }` → re-run plan-week repair, never render a repeated week.

## 8. Pose Pack + reel drops (`lib/ai/poses.ts`, planner reel exports)

IRON LAW: pose is LOCKED to the base photo, never AI-invented (invented stances mangle limbs). Every pose prompt = `FACE_POSE_DIRECTIVES` (gemini.ts) + appended per-pose framing directive (framing/crop/attitude ONLY):

| Pose | Framing directive (`POSE_FRAMING_DIRECTIVES`) |
|---|---|
| `front` | Full-body straight-on fit check, head to shoes, garments fully in frame |
| `step` | Street-style energy via crop/scene ONLY — same stance/stride/limbs/face, never invent mid-stride |
| `detail` | 3/4 crop on texture/stitching/accessories, face+body locked |

- `REEL_POSES = ['front','step','detail']`. `isReelPose()` / `parseReelPose()` / `assertReelPose()` validate; unknown poses throw `UnknownPoseError` fail-closed (no silent default). `buildPosePrompt(pose)` → `{ prompt, tags:['pose:<pose>'] }` (pure, server may reuse verbatim).
- `selectBaseForPose(bases, pose)` (pure): active rows first → prefer row with matching `pose` → else newest active base. Reads `BasePhotoLite { id, url, pose?, is_active, created_at? }`. Throws `NoBasePhotoError` on empty. BACKEND OWNS: `base_photos.pose` text migration (pre-migration rows omit it = untagged; selector keeps working).
- `trendSeedPack({ trends?, budgetBand?, season? })` → `{ tags, promptBlock }` (pure; trends trimmed/deduped/capped at `MAX_TREND_SEEDS`=6, e.g. `trend:Office Siren`, `budget:Under $100`, `season:FW26`). Empty input → `{ tags:[], promptBlock:'' }`. BACKEND OWNS: `plan-week` appends `promptBlock` to each day prompt when provided (owned-only still wins, trends never conjure garments).
- `reelWeekPlanner({ days×7, week, trendTags?, bases?, poses? })` → 7 `ReelDropCard { date, garmentIds, whyLine, pose, basePhotoId?, trendTags }` (pure). Default rotation `REEL_WEEK_POSES` (front/step/detail/front/step/detail/front). Throws `ReelWeekError` on: ≠7 days/poses, missing day in week result, or any garment on 2 different days (caller re-runs plan-week repair first). `bases` passed → per-card `basePhotoId` via `selectBaseForPose`; omitted → backend picks.
- Reel analytics (props snake_case per file convention): `reel_opened{source?,week_start?}`, `weekly_drop_started/completed{card_count,cost_usd}` (cost_usd REQUIRED, server-authoritative), `reel_card_viewed{card_index,pose}`, `reel_card_regenerated{card_index?,pose?,render_id?}`, `reel_wear_it_today{date?,pose?}`, `reel_shop_tap{product_id?,retailer?,card_index?}`.
- Monday-7am "week ready" push (BACKEND SENDS — client `lib/push.ts` untouched): Expo push `{ title, body, data: { kind: 'week-ready', week_start: 'YYYY-MM-DD', card_count: 3|7 } }`, tap deep-links `vai://outfit/<week_start Monday>`. NOTE: current client `normalizeData` folds unknown kinds to `generic` (→ `vai://home`), so until the push owner adds a `week-ready` kind + router case, the frontend should route via `onGeneric` + `data.week_start`. Follow-up, not this contract's code.

## 9. Weekly-drop unit costs (flash-image @ std $0.067, `estimateWeeklyDropCostUsd` = display only)

| Drop | Cards | Math | Cost |
|---|---|---|---|
| Free teaser | 3 (`REEL_DROP_CARD_COUNT.free`) | 3 × $0.067 | **$0.20** |
| Premium full week | 7 (`REEL_DROP_CARD_COUNT.premium`) | 7 × $0.067 | **$0.47** |

Authoritative per-render `cost_usd` comes from the edge fn; weekly-drop analytics carry the server-authoritative sum, never this estimate. Max-tier/2K drops cost 2× (see `GEMINI_IMAGE_COST_USD`); cached/failed renders cost $0.

## 10. Pinterest taste graph (`lib/ai/pose-transfer.ts`, `closet-guard.ts`, `taste-seeds.ts`, `pinterest-share.ts`)

Seam with backend: BACKEND OWNS OAuth, board sync, and resolving the pin `image_url` server-side. The client/AI side never fetches pin URLs — it receives the already-resolved reference string + `pose_mode`, and owns only the prompt + guard modules below. `render-tryon` accepts optional `pose_mode: 'keep'|'adapt'` (+ server-resolved `pose_ref_pin_id`) and optional `taste_prompt_block` (appended to the render/planner prompt like the reel `promptBlock`; owned-only still wins).

- Pose modes: `keep` (DEFAULT, `DEFAULT_POSE_MODE` — pose locked to the base photo via `poses.ts`) vs `adapt` (explicit per-render opt-in via `buildPoseTransferPrompt({basePhoto, outfitGarments, poseRefImageUrl, stanceNote?})`). No skeleton conditioning anywhere — adapt is reference-image + instruction on `gemini-3.1-flash-image` only.
- Prompt order (contract-pinned): (1) preservation block FIRST (`FACE_POSE_DIRECTIVES` imported from gemini.ts, never forked — face identity, body shape, skin tone), (2) stance/framing adaptation (mirror stance angles, camera height, crop energy — never the reference person's body/face/clothes), (3) owned-garment dressing block, (4) anti-copy rules (no logos/watermarks/overlaid text from the reference). Fail-closed via `PoseTransferError { code:'pose-transfer-invalid' }`.
- Closet guard (fail-closed): `validateRenderGarments(refs, closet)` → `{ok:true} | {ok:false, reason}` (throwing variant `assertRenderGarments` → `ClosetGuardError { code:'closet-guard' }`). Every `garment_ref` must carry a `garmentId` resolving to an ACTIVE owned closet entry; id-less refs fail. Pin images may NEVER contribute garments — reference role ∈ `{pose, style}` only (`assertPinReferenceRole` → `PinReferenceRoleError { code:'bad-pin-role' }`), and any `garment_ref.imageUrl` matching a known pin URL (`opts.pinImageUrls`) fails closed.
- Taste seeds: `tasteSeedPack({boardName?, pins?})` → `{tags, promptBlock}` (pure; vocab-based style adjectives `taste:*` + coverage/fit notes `fit:*`, deduped, first-seen order, capped at `MAX_TASTE_SEEDS`=8; empty-in → empty-out). Feeds the planner exactly like `trendSeedPack`.
- Share-back: `buildPinCopy({garmentLabels, trendTags?, whyLine?})` → `{title ≤100, description ≤800, altText ≤500}` (pure, never throws on thin input; honest copy — names only supplied labels, never invents brands; no affiliate/sponsored language so no paid-partnership disclosure is triggered; states the image is a VAI virtual try-on).
- Unit cost: adapt = 1 credit (~$0.068, `POSE_ADAPT_COST_USD` = same class as restyle — display only, server `cost_usd` authoritative). No new quota bucket.
- Pinterest analytics (props snake_case, NOT core funnel): `pinterest_connected{source?}`, `pinterest_disconnected`, `boards_synced{count}`, `pose_mode_selected{pose_mode:keep|adapt,render_id?}`, `taste_seed_applied{seed_count,board?}`, `pin_shared{render_id?}`.
