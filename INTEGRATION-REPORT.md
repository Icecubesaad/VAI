# INTEGRATION-REPORT.md — VAI v1 assembly audit (Sep 11, 2026)

Manager verdict: five solid deliveries, **zero working render paths**. No client can successfully call the backend today (3 different `render-tryon` shapes, 3 different `paywall-status` shapes, 2 missing barrels). Good news: caps/monetization/v1-cut are clean, Gemini-primary is correctly implemented server-side, and every P0 has a named owner and a small fix. Do the merge order below; do not parallelize the protocol fixes.

## Founder-confirmed decisions (law — inform all engineers)

1. **Gemini `gemini-3.1-flash-image` is PRIMARY for try-on, NOT FASHN.** Backend `render-tryon` pipeline (`supabase/functions/_shared/pipeline.ts`) already routes `gemini-flash → gemini-pro → fashn(-max)` — COMPLIANT. BUILD-PACK §1/§5 (FASHN-primary) is superseded by README + CONTRACT-integrations. FASHN residue is naming-only (P2 §6).
2. **Corrected caps are law: free 5 LIFETIME renders, premium 30/mo, no "unlimited" anywhere.** Grep for `unlimited` = 8 hits, ALL in "never unlimited" contexts (`README.md:39`, `CONTRACT-uiux.md:46`, `components/Sheet.tsx:93`, `app/onboarding/paywall.tsx:114`, `migrations/0001_schema.sql:8`, `lib/billing.ts:13`, `lib/perf/quotas.ts:12`, `quota.ts:4`). **Zero violations.** Free-5/premium-30 consistent in `store/quotas.ts`, `store/paywall.ts`, `quota.ts`, all copy. No `3/day` residue found.
3. **v1 cut holds.** No social/battles/fragrance/stylist-video/family-student implementation found. `lib/api.ts:246-249` explicitly blocks `feedRank`/`scentMatch` with `V2_NOT_AVAILABLE`. Only forward-compat stubs: `price-drop` push kind + deep links (server silent until v2) — acceptable, keep guarded.

## Staffing table

| Engineer | Delivered | Completeness | Gaps |
|---|---|---|---|
| Backend | `0001_schema.sql`, 9 edge fns, `_shared/` (auth/http/idempotency/pipeline/quota/gemini/fashn/ledger/push/plan), `buckets.md`, `secrets.md`, `inngest.md` | ~85% | Protocol shapes drift from both client contracts; `render-tryon` rejects `restyle` mode |
| Frontend | 5 tabs, 8 onboarding screens, 6 stores, `lib/api.ts`, `lib/supabase.ts`, `_layout.tsx` | ~80% | Imports point at 2 nonexistent barrels; billing handoff stubbed; analytics call sites TODO |
| UI/UX | `tokens.ts` + `tailwind.config.js` mirror, 13 components, `Sheet/PaywallSheet`, haptics/watermark libs, `components/README.md`, `babel.config.js` | ~70% | No barrels, no `RenderView`, 4 export-name drifts, no font assets, gluestack CLI not run |
| Perf | 8 `lib/perf/` modules, `PERF-BUDGETS.md`, `APP-LOADING-SPLASH.md` | ~90% | `telemetry.ts` hardcodes FASHN model names; frontend never adopted `loading.ts` recipe |
| Integrations | `lib/ai/` (gemini/planner/tagging), `edge.ts`, `billing.ts`, `affiliate.ts`, `push.ts`, `analytics.ts`, `sentry.ts` | ~85% | No `purchaseTrial`; affiliate snake_case normalizer missing; paywall client shapes stale |

## Contract mismatches

**P0-1 — No `@/theme` barrel + wrong `useTheme()` shape.** Files: `theme/` (no `index.ts`) vs 11 app files doing `const { colors } = useTheme()`. UI/UX returns `{tokens, colorScheme}`; frontend expects `colors.{background,surface,text,muted,primary,onPrimary,border,danger}` (all used in `paywall.tsx:91-164`). Runtime `undefined` on every screen; `tsc` fails repo-wide. **Owner: UI/UX** — add `theme/index.ts` re-exporting `ThemeProvider` + a `colors` alias map (paper→background etc.) or adopt tokens and migrate call sites. UI/UX owns theme per README.

**P0-2 — No `@/components` barrel + 4 name drifts, `RenderView` missing entirely.** Files: `components/` (no `index.ts`, no `RenderView.tsx`) vs `app/(tabs)/index|closet|tryon.tsx`, `app/onboarding/quiz|first-outfit.tsx`. CONTRACT-frontend wants `{OutfitCard,GarmentCard,RenderView,ShareCard(left/cap/onPress…),QuotaBadge(left/cap/onPress)}`; UI/UX ships per-file modules with `CounterBadge(remaining/total/onUpgrade)`, `ShareDNA≠ShareCard`, no `RenderView`, no `PaywallSheet` barrel (only `Sheet.tsx:235` alias). **Owner: UI/UX** — ship `components/index.ts` with alias exports + build `RenderView` (must include caption "AI try-on · may differ from fit" per CONTRACT-frontend §2).

**P0-3 — `render-tryon` 3-way protocol split; nothing can render.** Files: `lib/ai/gemini.ts:267-277` (sends `base_photo_url`, `garment_refs:[{garmentId,imageUrl}]`, `resolution`, `model_hint`, `day`, mode incl. `restyle`) vs `lib/api.ts:204-211` (sends camelCase `outfitId/basePhotoId/garmentRefs:string[]`) vs `supabase/functions/render-tryon/index.ts:22-30,113-118` (accepts ONLY `outfit_id|garment_ids[]`, `base_photo_id`, mode `tryon|compare`, `idempotency_key`, `note`). Gemini-style calls fail `garments_required`; restyle calls fail `mode_invalid`. **Owner: backend** (with integrations) — one contract bump: accept `garment_refs` objects + `base_photo_url` + `restyle` mode + `model_hint/resolution/day`, or formally reject and make both clients conform. Recommend adopting CONTRACT-integrations shape; pipeline already Gemini-primary.

**P0-4 — `paywall-status` 3-way shape split; quota truth unreconcilable.** Files: backend `paywall-status/index.ts:35-52` (GET, JWT auth → `{tier,trial_ends_at,quotas:{…},credits,hard_blocked}`) vs CONTRACT-integrations §2 (POST `{user_id}` → flat `{tier,trialing,renders_left,renders_cap,quota_resets_at}`) vs `lib/api.ts:240` (`{}` → flat camelCase with `lifetimeUsed/Cap,monthlyUsed/Cap`) vs `lib/billing.ts:202-210` (`{user_id}` → flat snake). `store/paywall.fetchStatus` consumes the lib/api shape the server never returns. **Owner: backend + integrations jointly** — pick ONE shape (recommend server's nested `quotas` envelope, it carries closet/restyle data the UI needs), update both clients + both contracts.

**P0-5 — `shop-picks` envelope + case mismatch.** Files: `shop-picks/index.ts:189-194` (returns `{shoppable,picks[] snake_case, nullable price/image/affiliate_url,gaps,disclosure}`) vs CONTRACT-integrations §2 (server MUST return camelCase `AffiliateProduct`) vs `lib/api.ts:230-231` (expects bare `ProductPick[]`). Null `affiliate_url`/`image_url` will crash card rendering. **Owner: backend** — return camelCase non-null-guarded picks (or integrations adds a normalizer + contract amendment noting it).

**P1-6 — Billing handoff unwired.** CONTRACT-frontend promises `purchaseTrial(): Promise<'trial'|'premium'>`; `lib/billing.ts` exports `purchaseSubscription/purchaseCreditPack/restorePurchases()->RCCustomerInfo`, no `purchaseTrial`. `paywall.tsx:62-69` is an honest stub ("Checkout is finishing setup"). No crash, but $0 trial revenue + store-rejection risk (restore path exists only via `fetchStatus`). **Owner: integrations** — add `purchaseTrial()` wrapper; frontend flips stub live.

**P1-7 — Cost-accounting drift (FASHN $0.075 vs Gemini $0.067).** `PERF-BUDGETS.md:50-78`, `pipeline.ts:19-20` (`EST_STD_USD=0.075`), spend formula all price std at FASHN rates; primary actually costs $0.067 (~12% overstatement — safe direction, but dashboard lies). **Owner: perf + backend** — rebase to Gemini pricing.

**P1-8 — `telemetry.ts:112` hardcodes `render_model: 'fashn-max'/'fashn-v1.6'`.** Breaks the analytics contract (server-authoritative `render_model`+`cost_usd` via `renderCostProps`). **Owner: perf** — take model from server response.

**P1-9 — `app/_layout.tsx` ignores the perf loading recipe.** Own boot gate (session only); no `markAppLaunch/awaitAppReady`, no 4s failsafe, no MMKV prewarm, no `parseRenderDeepLink` push routing. Cold-start <2s p50 gate at risk. **Owner: frontend** — adopt `CONTRACT-perf.md` root-layout recipe.

**P2-10 — FASHN naming residue (fallback order correct, labels stale).** `renders.fashn_id` / `fashn_cache_key` cols, `image-pipeline.ts:39` "FASHN crop", `cache.ts:184`, PERF-BUDGETS §3 title. Also declare Gemini models in App Review notes (build pack §9 still names FASHN). **Owner: backend** — rename at next migration; docs now.

**PASS (no action):** `babel.config.js` — preset order correct (expo first, nativewind second), no reanimated plugin to misplace, last-rule documented in comments. `package.json` — `expo-router|safe-area-context|screens: "*"` flagged as instructed; `npx expo install --fix` resolves to SDK 57 lines (DEPS-frontend already assumes this). v1-cut, caps, "never unlimited" — clean per above.

## Dep-install plan (one clean run, founder executes)

```bash
npx expo install --fix   # first: pins expo-router, safe-area-context, screens + all expo-* below to SDK 57
npx expo install expo-image expo-image-manipulator expo-image-picker expo-file-system expo-font \
  expo-apple-authentication expo-auth-session expo-camera expo-haptics expo-notifications expo-device
npm i @shopify/flash-list@^2.0.0 @tanstack/react-query@^5.0.0 @supabase/supabase-js@^2.45.0 \
  react-native-mmkv@^3.0.0 base64-arraybuffer@^1.0.2 nativewind tailwindcss@^3.4.17 \
  react-native-reanimated react-native-svg react-native-view-shot \
  @react-native-community/netinfo@^11.4.1 jpeg-js@^0.4.4 react-native-purchases@^8.9.0 \
  posthog-react-native@^4.4.0 @sentry/react-native@^7.5.0
npm i -D prettier-plugin-tailwindcss@^0.5.11 @types/jpeg-js
npx gluestack-ui@latest init; npx gluestack-ui@latest add button   # per DEPS-uiux.txt
# Backend (no npm): supabase-cli 2.x, inngest-cli 1.x; pgvector+pgcrypto via migration (already in 0001_schema.sql)
```

## Top 5 integration risks

1. **No render path works** (P0-3 + P0-4) — the aha-moment demo (outfit → try-on → paywall <5 min) is unachievable until the protocol summit lands.
2. **Every screen reads `colors.*` from a provider that returns `tokens`** (P0-1) — blank/undefined styling app-wide on first assembly.
3. **Quota truth split 3 ways** — free-6th-render hard-paywall (acceptance gate) can neither trigger nor be tested; margin protection is fictional until P0-4 closes.
4. **Billing stubbed** (P1-6) — TestFlight with a dead trial button + no `purchaseTrial` = rejection + $0 revenue; restore flow untested.
5. **Spend/telemetry lies** (P1-7 + P1-8) — FASHN-priced budgets + FASHN-labeled models hide real Gemini unit economics from the margin dashboard.

## Merge order for assembly

1. **Theme barrel** (P0-1, UI/UX, ~1h) — unblocks all rendering of UI.
2. **Components barrel + `RenderView`** (P0-2, UI/UX, ~half day) — unblocks `tsc --noEmit`.
3. **Edge-protocol summit** (P0-3 + P0-4 + P0-5, backend + integrations, same sitting, one contract bump) — THE critical path; nothing else integrates without it.
4. **Billing handoff** (P1-6, integrations + frontend) + **`_layout` loading recipe** (P1-9, frontend).
5. **Telemetry + budget rebase** (P1-7 + P1-8, perf + backend) + FASHN doc renames (P2-10).
6. **Dep install → `tsc --noEmit` → acceptance run** (cold start → trial → 3 items → outfit → try-on → 6th-render hard-block) → TestFlight gates (aha→trial ≥40%, trial→paid ≥15%, D7 ≥20%).
