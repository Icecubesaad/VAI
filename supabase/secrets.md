# VAI Secrets + webhooks

Server secrets live ONLY in Edge Function secrets — never `EXPO_PUBLIC_`.
Set them with:

```bash
supabase secrets set GEMINI_API_KEY=... FASHN_API_KEY=... INNGEST_EVENT_KEY=... \
  INNGEST_SIGNING_KEY=... SHOPSTYLE_KEY=... SKIMLINKS_PUB_ID=... \
  REVENUECAT_WEBHOOK_SECRET=... STRIPE_SECRET=... STRIPE_WEBHOOK_SECRET=... \
  RESEND_KEY=... ALLOW_SYNC_RENDER=false
supabase secrets set --env-file ./supabase/.env  # alternative
```

## Full env list

| Name | Scope | Used by | Notes |
|---|---|---|---|
| `SUPABASE_URL` | server (auto) | all fns | injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | server (auto) | all fns | bypasses RLS; never ship to client |
| `SUPABASE_ANON_KEY` | public | app | client init only |
| `GEMINI_API_KEY` | server | quiz/auto-tag/plan/render/restyle | primary image + all text/vision |
| `GEMINI_TEXT_MODEL` | server (opt) | quiz/auto-tag | default `gemini-3-flash` |
| `FASHN_API_KEY` | server | pipeline fallback | fallback-only per README |
| `INNGEST_EVENT_KEY` | server | render-tryon/restyle | POST events to `inn.gs` |
| `INNGEST_SIGNING_KEY` | server | render-tryon worker | HMAC-verify `?process=1` calls |
| `SHOPSTYLE_KEY` | server | shop-picks | without it: gap analysis only (`shoppable:false`) |
| `LTK_AFFILIATE_ID` | server | shop-picks (v2) | reserved; resolver contrast first |
| `SKIMLINKS_PUB_ID` | server (opt) | shop-picks | wraps click URLs + `xcust=user_id` |
| `REVENUECAT_WEBHOOK_SECRET` | server | billing webhook | verifies RC-signed events |
| `STRIPE_SECRET` | server | packs/real-worldSvcs | Stripe exempt from IAP (build pack §1) |
| `STRIPE_WEBHOOK_SECRET` | server | billing webhook | verifies `Stripe-Signature` |
| `RESEND_KEY` | server | trial/win-back email | Day-5 reminder, D+3/D+30 offers |
| `ALLOW_SYNC_RENDER` | server | render-tryon | `false` in prod; `true` for local dev |
| `APPLE_BUNDLE_ID` | server (opt, set it) | billing-apple | expected `bundleId` in App Store v2 notices; unset = check skipped (warn) |
| `ANDROID_PACKAGE_NAME` | server (opt, set it) | billing-google | expected RTDN `packageName`; unset = check skipped (warn) |
| `GOOGLE_PUBSUB_SERVICE_ACCOUNT` | server (opt, set it) | billing-google | enforced OIDC `email` claim on Pub/Sub pushes; unset = not enforced (warn) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | server (opt) | billing-google | service-account JSON (Play user lookup); unset = RTDN acked unmapped |
| `EXPO_PUBLIC_SUPABASE_URL` | public | app | — |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | public | app | — |
| `EXPO_PUBLIC_POSTHOG_KEY` | public | app | analytics (props: user_id, tier, render_model, cost_usd) |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY` | public | app | StoreKit2 entitlement `premium` |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` | public | app | Play Billing entitlement `premium` |

Rotation: 90d for API keys, immediate on leak (revoke → set → `functions deploy`).
No key material in git, logs, or error responses (workers return `bad_signature`,
never key prefixes).

## Reel weekly drop (no new secrets)

`reel-drop` / `reel-regenerate` ride the render pipeline — no additional
secrets. Required at runtime: `GEMINI_API_KEY` (image gen),
`INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` (queue + worker), and the
auto-injected `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. The Sunday/Monday
crons (supabase/inngest.md) call `POST /functions/v1/reel-drop` with the
service_role key — server only, never the client anon key.

> REMOVED (Pinterest strip): the Taste-autopilot and Pinterest-inspiration
> sections below were deleted with the feature. `taste-build`,
> `pinterest-sync`, and the nightly Pinterest/taste crons in
> supabase/inngest.md are dead — pause the crons and delete those functions
> before the next deploy, or a nightly job burns edge invocations for zero
> users.

## Webhook endpoints

Billing source of truth is **RevenueCat** (entitlement `premium`); Apple and
Google both funnel into it. Direct provider endpoints below are the fallback /
audit path. Handlers live in backend turf (edge fns) and write ONLY via
`service_role` → `subscriptions` + `ledger(type='sub')`.

| Provider | Endpoint | Verify | On success |
|---|---|---|---|
| RevenueCat | `POST /functions/v1/billing-rc` | `Authorization: Bearer REVENUECAT_WEBHOOK_SECRET` | upsert `subscriptions` (platform ios/android, status, renews_at) |
| Apple App Store Server Notifications v2 | `POST /functions/v1/billing-apple` | Apple-signed JWS (`signedPayload`, verify chain + `bundleId`) | forward-normalize → same upsert as RC |
| Google RTDN (Play) | `POST /functions/v1/billing-google` | Pub/Sub push OIDC JWT (`email` = service account) + `packageName` check | query Play Developer API → same upsert |
| Stripe | `POST /functions/v1/billing-stripe` | `Stripe-Signature` HMAC with `STRIPE_WEBHOOK_SECRET` (tolerance 300s) | credit packs → `entitlements.std/hd_credits` + ledger memo |
| FASHN | none (we poll) | n/a | `?process=1` worker is HMAC'd via `INNGEST_SIGNING_KEY` instead |

Status Sep 2026: all four billing handlers + the `DELETE /functions/v1/account`
deletion endpoint are IMPLEMENTED (`supabase/functions/billing-*/index.ts`,
`account/index.ts`, shared core in `_shared/billing.ts` + `_shared/restyle.ts`).
Apple JWS x5c chain verification is structural + bundleId + recency (full
chain-to-root deferred — RC cross-checks); Google user lookup needs
`GOOGLE_SERVICE_ACCOUNT_JSON` or RTDN is acked unmapped for reconciliation.

Apple 30% is baked into every price (§7): `vai_premium_monthly` $4.99,
`vai_premium_yearly` $39.99 floor. Credit packs are consumables
(10 std $1.99 · 25 std $4.99 · 1 HD $0.99, floor $1.99/pack).

### Verification snippets (reference for the billing handlers)

```ts
// Stripe: raw body + header (Edge: read req.text() BEFORE parsing)
const sig = req.headers.get("stripe-signature") ?? "";
const mac = await crypto.subtle.sign("HMAC",
  await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  enc(`${timestamp}.${rawBody}`));
const ok = timingSafeEqual(hex(mac), sig.split(",").find((p) => p.startsWith("v1="))?.slice(3) ?? "");

// Inngest worker: see _shared/pipeline.ts → verifyInngestSignature()
// (hex HMAC-SHA256 of raw body, header x-inngest-signature, timing-safe compare)

// RevenueCat: shared-secret bearer — constant-time compare, then trust event
// types INITIAL_PURCHASE / RENEWAL / CANCELLATION / EXPIRATION / BILLING_ISSUE.
```

Trial honesty (§7): 7-day, card required, same-screen copy, Day-5 push+email,
downgrade preserves data (overflow read-only). Win-back D+3 50%-off-2mo,
D+30 free week no card — both driven by `subscriptions.renews_at` + RESEND_KEY.
