# QA-REPORT-3 — Billing · Deletion · Security regression (REPORT ONLY)

Scope: trace-only. Green base: `tsc` 0, expo-doctor 21/21. Read: `README.md`, `docs/SECURITY.md`, `docs/PRIVACY-LABELS.md`, `INTEGRATION-REPORT.md`, then traced listed paths.

## Gate 1 — BILLING: FAIL (1×P0, 2×P1, 2×P2)

- PASS — RC webhook mapping + HMAC + dedupe: `INITIAL_PURCHASE→trialing/active`, `RENEWAL/PRODUCT_CHANGE/UNCANCELLATION→active`, `CANCELLATION→active-paid-thru + auto_renew=false`, `BILLING_ISSUE→past_due`, `EXPIRATION→expired` (`billing-rc/index.ts:74-98`); Bearer verify `timingSafeEqual`, fail-closed 500 when unconfigured (`:47-51`); ledger `provider_event_id` dedupe (`:67`, `_shared/billing.ts:82-88,94`); `requireUserExists` (`:116`); `service_role` upsert + $0 memo (`_shared/billing.ts:90-132`).
- PASS (partial) — Apple/Google mappings correct (`billing-apple/index.ts:103-126`; `billing-google/index.ts:179-198`), identity fail-safe `mapped:false` no-retry-storm (`billing-apple:137-141`; `billing-google:214-224`).
- **P1-1 — Apple/Google verify fail-open when env unset.** Bundle check skipped (`billing-apple:77-83`), OIDC skipped (`billing-google:52-62`), package check skipped (`:158-165`) — all warn+continue. Forged events still need valid JWS structure + (Google) Google-iss OIDC, but operator-misconfig = unsigned path. Require env at deploy; return 500 like RC.
- **P1-2 — No x5c chain verify (Apple) / no OIDC signature verify (Google).** Structural JWS decode only (`_shared/billing.ts:61-67`; headers note `billing-apple:10-12`). Acceptable while RC is system-of-record; must close before direct path becomes primary.
- PASS — Stripe packs: raw-body HMAC + 300s tolerance + `timingSafeEqual` (`billing-stripe:49-60`); `grantPackCredits` dedupe + entitlement increment (`:87-94`, `_shared/billing.ts:142-195`); refund memo-only stated (`billing-stripe:98-107`).
- **P1-3 — Pack-key prefix risk.** `PACKS` keys are `credits_10|credits_25|hd_single` (`_shared/billing.ts:136-140`); client product IDs are `vai_credits_10…` (`lib/billing.ts:33-39`). If Stripe `metadata.pack` carries the store product ID, `grantPackCredits` throws `pack_unknown`. Normalize `vai_` prefix or document exact metadata contract.
- **P0-1 — paywall-status quota truth unreachable from BOTH clients (INTEGRATION P0-4 still open).** Server returns canonical flat camelCase (`paywall-status/index.ts:80-98`: `rendersLeft/rendersCap/trialEndsAt…`). `lib/billing.ts:188-217` reads snake_case `renders_left/renders_cap/trial_ends_at` → `undefined`; `lib/api.ts:125-137` expects `lifetimeUsed/lifetimeCap/monthlyUsed/monthlyCap` + `trial` tier which server never sends; `store/paywall.ts:98-112` consumes the `api` shape. `fetchStatus`/`getPaywallStatus` cannot populate; hard-paywall + trial UI never converge. Server side itself is correct (JWT `requireUser`, cross-user reject `:57-59`, `getEntitlementState`, `hardBlocked` `:97`).
- PASS — client never gates on client tier: RC `CustomerInfo` merge display-only (`lib/billing.ts:197-229,281-283`); quota consumed server-side atomic RPC after `requireUser` (`render-tryon/index.ts:298,370-383`); `getRender` owner-scoped (`lib/api.ts:229-241`).
- PASS — win-back store-owned (identifiers only `lib/billing.ts:72-76`, redeem via RC sheet / Play center `:296-310`). **P2-1** `minDaysSinceChurn` display-only; **P2-2** double-tap: buttons `disabled={purchasing}` (`paywall.tsx:137,164`) but `startTrial`/`restore` (`store/paywall.ts:132-200`) have no in-function re-entrancy guard.
- PASS — restore-with-no-sub copy handled (`store/paywall.ts:179-185`), blocked only by P0-1.

## Gate 2 — DELETION: PASS with P1 retention gaps

- PASS — UI→`DELETE /account`: server-first, local wipe only after resolve (`profile.tsx:66-124`); `api.requestDeletion` sends `DELETE` + `{mode}` (`lib/api.ts:263-272`); server accepts DELETE+POST (`account/index.ts:152`), validates mode (`:155-156`).
- PASS — queue drain FIFO incl. pre-existing (`:168-191`), purge counts returned (`:215`); photos mode purges `base/`+`renders/` + rows only, garments stay per screen copy (`:79-89` vs `profile.tsx:71`); account mode purges all prefixes + rows + `push_tokens` (reminders die) (`:91-128`); **anonymize BEFORE `deleteUser`** (`:207-208`, fn `:131-146` incl. age columns).
- **P1-4 — 13mo dispute retention impossible.** `auth.deleteUser` cascade wipes `ledger`+`subscriptions` immediately; only a `console.log` memo survives (`:197-206`, stated tradeoff `:23-27`). Needs `ledger_archive` (0003) if legal requires.
- **P1-5 — retention sweepers still spec-only.** Renders 90d / inactive-account 12mo have predicates (`created_at` backfilled `0002:21-26`) but no shipped sweeper/cron (only `buckets.md:67-68`, `inngest.md:101` prose). `purge_after` 30d horizon itself correct (`0002:53`, echoed `account:215`, shown `profile.tsx:101-106`).

## Gate 3 — SECURITY REGRESSION: PASS with P1/P2 items

- PASS — RLS: all tables enabled (`0001:405-423`) + `deletion_requests` (`0002:56-64`, insert/select-own, transitions service-role-only); system tables select-own (`0001:469-478`); anon nothing (`:483-497`); quota RPCs `service_role`-only (`:500-502`) + `bump_restyle_daily` (`0002:103-104`); all DEFINER fns `search_path=public` (`0001:284,295,367,384`; `0002:91`); users UPDATE narrowed to `(email,name,avatar_url,country)` (`0002:14-15`).
- PASS — secret hygiene: grep `lib/`+`app/` = zero `GEMINI/FASHN/STRIPE_SECRET/SERVICE_ROLE` values; only allowlisted `EXPO_PUBLIC_*` (Supabase URL/anon, PostHog, RC iOS/Android, Sentry) + `assertNoClientGeminiKey` guard (`lib/ai/gemini.ts:179-184`). **P2-3** doc nit: `lib/edge.ts:13` says `SKIMLINKS_ACCOUNT`, truth `SKIMLINKS_PUB_ID`.
- PASS — webhook HMAC paths exist (RC/Stripe/Inngest `verifyInngestSignature` `render-tryon:251`); Apple/Google partial per P1-1/P1-2.
- PASS (with gaps) — referral fraud: self-block (`referral-credit:30`), single-link unique + `23505` double-tap-safe (`:33-44`), proof 3 items + 1 done try-on (`:47-68`), 12mo inviter cap invitee-still-paid (`:71-97`). **P1-6** no rate limit on `VAI-XXXXXX` guessing (unchanged). **P2-4** count-then-credit TOCTOU (`:71-99`).
- PASS — quota bypass impossible; restyle TOCTOU FIXED bump-first atomic (`_shared/restyle.ts:117-127`, `_shared/quota.ts:178-187`, `0002:90-104`). **P2-5** legacy read-modify-write fallback remains (`quota.ts:188-200`); remove post-0002.
- **P0-2 — age gate missing (SECURITY P0-006 still open).** Columns exist server-owned (`0002:33-40`) and anonymized on delete, but `rg birth_year|parental_consent|age_band app lib store` = zero hits: no DOB step, no u13 refuse, no 13–17 consent. Ship-blocker per §6 / 17+ rating.

## Gate 4 — EDGE CASES: PASS with 2×P2

- PASS — offline/airplane: transport throw → `NETWORK` "You appear to be offline" (`lib/api.ts:190-199,263-272`), copy map (`:287-291`), offline stats line (`profile.tsx:159-163`); `edge.ts` network/timeout `EdgeError` (`:227-246`).
- PASS — signed URLs: `BUCKETS.basePhotos='base'` fixed (`lib/supabase.ts:35-40`), selfie upload + 1h mint (`selfie-capture.tsx:87,110`), server re-mint (`pipeline.ts:229-235`). **P2-6** `https` passthrough unsigned (`pipeline.ts:231`) — expired public URL for a private object breaks provider fetch; low risk while stored values are paths.
- PASS — push-token missing: server no-op + dead-token prune, never throws (`_shared/push.ts:20-27,49-51`); client returns `{token, saved:false}` + foreground retry (`lib/push.ts:97-129`).
- PASS — trial expiry mid-render by design: `isPremiumSub` time-gated (`quota.ts:53-59`, SQL `0001:319-324`); allowance consumed atomically at enqueue; in-flight not revoked. **P2-7** reminder math still off: T+96h (`lib/billing.ts:68`, `lib/push.ts:150`) = day 4 of 7, copy says "2 days before" (`billing.ts:64`, `push.ts:162-163`) — use T+120h or fix copy.

## Verdict: NO-GO (P0-1 client shape split, P0-2 age gate). Server billing/deletion cores are sound; wire the two client readers to the canonical shape, enforce webhook env, add DOB gate, then re-run acceptance (trial→render→6th-render block→restore→delete).
