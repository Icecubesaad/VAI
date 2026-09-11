# VAI Security & Compliance — v1 ship gate

Owner: security & compliance crew. Verified by READING the files cited
(`file:line`). Severity: **P0** ship-blocker · **P1** fix before scale/review ·
**P2** polish. Status as of Sep 2026 audit.

Findings: **6 × P0 · 6 × P1 · 5 × P2 = 17 total.**
Top 3 ship-blockers: **P0-001/002** (deletion stubs) · **P0-004** (bucket
mismatch breaks selfie upload) · **P0-003** (billing webhooks missing).
Genuine-gap fixes shipped in `supabase/migrations/0002_rls_hardening.sql`
(§fixes). False alarms (checked, NOT filed): all 19 tables have RLS on +
owner policies (`0001_schema.sql:405-480`); all 4 `SECURITY DEFINER` fns set
`search_path = public` (`0001:284,295,367,384`); quota RPCs granted to
`service_role` only (`0001:500-502`); Inngest worker HMAC present
(`functions/_shared/pipeline.ts:62-78`).

## 1. Data map (what lives where)

| Data | Store | Access path | Sensitivity |
|---|---|---|---|
| Mirror-selfie base photo (biometric-adjacent) | Storage `base` (private) + `base_photos` row (`0001:518-523,86-94`) | Owner RLS (`0001:538-540`); pipeline via `service_role` + 1h signed URLs (`pipeline.ts:214-220`) | **High** — identifies a person |
| Original uploads pre-cutout | Storage `raw` (private) | Same owner-only pattern (`0001:534-536`) | High |
| Garment cutouts / originals | Storage `garments` (**public**) | Owner write, world read (`0001:543-550`) | Medium (wardrobe fingerprint) |
| Finished try-on renders (watermarked) | Storage `renders` (**public**) + `renders` rows | World read, owner delete (`0001:553-556`); row RLS owner-only (`0001:441-442`) | Medium-High (face + body) |
| Style DNA, quiz, outfits, wishlist | Postgres rows, owner RLS (`0001:429-466`) | Data API `authenticated` only, explicit grants (`0001:487-497`); anon gets nothing | Medium |
| Email, referral code | `users` row, owner RLS (`0001:426-427`) | Same as above | Medium |
| Subscriptions, ledger, quotas, entitlements | System tables, SELECT-own only (`0001:469-478`); writes via Edge fns | `service_role` only for writes | High (money truth) |
| Push tokens | `push_tokens`, owner RLS (`0001:480-481`) | Direct REST upsert from app (`lib/push.ts:131-145`) | Medium |
| Auth tokens | SecureStore on-device (`lib/supabase.ts:13-18`); never MMKV | OS keychain/keystore | High |

Out-of-scope v1 (no social feed): `posts`/`post_likes`/`post_saves` are
owner-only (`0001:447-459`) — correct for v1; v2 feed needs its own migration.

## 2. Retention

| Class | Rule | Enforcer (status) |
|---|---|---|
| Base selfie | Kept until user deletes (Delete Photos / Account) | **Missing** — see P0-001 |
| Renders (rows + objects) | 90d, then purge (failed rows 7d) | Partial: `buckets.md:57-68` cron spec'd, **no sweeper ships** (P1-012) |
| Inactive accounts (12mo no login) | Purge PII, keep anonymized ledger 13mo for disputes | **Missing** (P1-012) |
| Ledger / render_cost | 13mo for chargebacks/disputes (`buckets.md:68`) | Keep (do NOT purge with account until 13mo) |
| `raw/` originals with cutout | 90d | Same missing sweeper |
| Superseded base (retake) | Object deleted 30d after `is_active=false` | **Broken** — retake never flips old row (P2-016) |

`0002` enabler: `created_at` added to `base_photos` + `garments` (SEC-005/012)
— retention predicates and the pipeline ordering now have a column to use.

## 3. Deletion flow

**P0-001 — Delete My Photos is a local-only stub.** `app/(tabs)/profile.tsx:52-69`
clears MMKV state; no network call. Server photos, renders, and rows survive —
violates the screen's own promise ("removes your base photo and renders") and
GDPR Art. 17 / Apple Guideline 5.1.1(v).

**P0-002 — Delete Account is a support-email stub.** `profile.tsx:71-82` shows
"contact support@vai.style". No endpoint, no queue, no purge exists; the
"30-day purge" in `buckets.md:65` and `CONTRACT-frontend.md:89` is unimplemented.

**Spec (backend crew, P0):** ship `DELETE /functions/v1/account` with
`{ "mode": "photos" | "account" }` (auth via `requireUser`, `auth.ts:43`):
1. Validate mode; insert `deletion_requests{user_id, kind}` (`0002`, SEC-001/002).
2. `photos`: delete Storage prefixes `base/{uid}/*`, `renders/{uid}/*`
   (keep `garments/` — closet stays per screen copy `profile.tsx:56`);
   delete `base_photos` + `renders` rows; revoke signed URLs by rotation
   (keys are per-object, 1h TTL — no action beyond delete).
3. `account`: same as photos + `garments/`, `raw/` prefixes; call
   `supabase.auth.admin.deleteUser(uid)`; schedule `db_purged` at
   `requested_at + 30d` (Inngest cron); keep `ledger` rows 13mo (anonymize
   `user_id` only after dispute window); cancel server reminders.
4. Return `{ status, purge_after }`; client then clears MMKV + routes to
   `/onboarding/auth`. Response to pre-existing requests: process queue FIFO.
Frontend: replace `handleDeletePhotos`/`handleDeleteAccount` bodies with this
call (keep the confirm sheets + store-cancel reminder copy, `profile.tsx:75`).

`0002` enabler: `deletion_requests` table (insert+select-own for users,
transitions service_role-only).

## 4. Secrets hygiene

Server-only (Edge Function secrets, never `EXPO_PUBLIC_`, never imported
client-side — boundary documented `lib/edge.ts:8-16`, enforced by code: only
`EXPO_PUBLIC_*` read in `lib/`): `GEMINI_API_KEY`, `FASHN_API_KEY`,
`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `SHOPSTYLE_KEY`,
`LTK_AFFILIATE_ID`, `SKIMLINKS_PUB_ID`, `REVENUECAT_WEBHOOK_SECRET`,
`STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `RESEND_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (auto-injected; used only via `auth.ts:admin()`),
`ALLOW_SYNC_RENDER` (`false` in prod — the sync path is correctly gated,
`render-tryon/index.ts:83-87`).

EXPO_PUBLIC allowlist (safe to embed): `SUPABASE_URL`, `SUPABASE_ANON_KEY`
(RLS + explicit Data API exposure enforce access, `0001:483-497`),
`POSTHOG_KEY`, `REVENUECAT_IOS_KEY`, `REVENUECAT_ANDROID_KEY`, `SENTRY_DSN`
(public by design), `POSTHOG_HOST` (non-secret).

**P1-011 — allowlist drift:** `EXPO_PUBLIC_POSTHOG_HOST` (read
`lib/analytics.ts:114`) and `EXPO_PUBLIC_SENTRY_DSN` (read `lib/sentry.ts:28`)
are missing from `.env.example` (fixed: appended, comments-only). Name drift:
`lib/edge.ts:14` comment says `SKIMLINKS_ACCOUNT`; truth is
`SKIMLINKS_PUB_ID` (`supabase/secrets.md:8`, read `shop-picks/index.ts:73`) —
edge.ts is client code that never reads it (P2 doc nit, fix the comment).

**Webhook HMAC — verified present:** Inngest worker `?process=1` verifies hex
HMAC-SHA256 with timing-safe compare, fails closed without secret
(`pipeline.ts:62-78`, called `render-tryon/index.ts:65`). Stripe/RC/Apple/
Google verification snippets in `supabase/secrets.md:63-78` are **spec only** —
see P0-003. Secret rotation: 90d, immediate on leak (`secrets.md:40`).

## 5. Abuse controls

- **Quota bypass impossible client-side — VERIFIED.** Consume/refund/extend RPCs
  are `EXECUTE`-granted to `service_role` only (`0001:500-502`); both enqueue
  paths call them via the admin client after `requireUser`
  (`render-tryon/index.ts:120,162`; `restyle/index.ts:61,108`). Tier truth is
  server-read subscriptions (`quota.ts:61-71`); client `PaywallStatus`
  (`lib/billing.ts:202-229`) is display + server merge, never a gate.
  `getRender` reads own rows only under `renders_owner` (`lib/api.ts:216-228`).
- **Idempotency replay — VERIFIED SAFE.** Server key = sha256(user|base|outfit|
  day|mode|tier) (`_shared/idempotency.ts:37-48`); client keys ≥16 chars else
  server-computed (`render-tryon/index.ts:135-146`); lookup scoped per user
  (`idempotency.ts:50-60`); failed rows are NOT reusable so failures can't
  wedge retries (`idempotency.ts:63-65`); client retries only with a key
  (`lib/edge.ts:158-172`). Cross-user replay impossible (userId in hash +
  `eq(user_id)`).
- **Restyle cost — VERIFIED**, always 1 credit + free daily slot + 3/session
  chain cap with cycle guard (`restyle/index.ts:70-98,100-154`).
- **P1-009 — free-restyle daily TOCTOU.** `checkFreeRestyleDaily` then
  `bumpRestyleDaily` are separate read-modify-write round trips
  (`quota.ts:154-187`); concurrent restyles can double-spend the 1/day slot.
  Fix shipped: atomic `bump_restyle_daily(uuid,date)` in `0002` (SEC-009,
  `service_role`-only) — backend crew: call it from both helpers.
- **Referral fraud — mostly VERIFIED:** self-referral blocked, one link per
  invitee (unique), qualification proof (3 items + 1 done try-on), 12mo inviter
  cap with invitee-still-rewarded (`referral-credit/index.ts:30-111`),
  $0 ledger memos (`ledger.ts:48-55`). Gaps: **P1-010** no rate limit on code
  guessing (`VAI-XXXXXX`, `referral-credit/index.ts:24`) — add per-IP/user
  throttle at the edge; **P2-015** count-then-credit cap TOCTOU (`:71-97`) —
  colluding burst can overshoot 12mo by a small margin (accept or serialize).
- **P1-007 — users self-update over-broad.** Owner UPDATE covered
  `referral_code`/`referred_by`/`trial_ends_at` (`0001:426-427` + grant `:489`).
  Fixed in `0002` (SEC-007): `authenticated` keeps UPDATE on
  `(email,name,avatar_url,country)` only; referral/trial fields server-owned.

## 6. Minor safety

**P0-006 — no under-13 / 13–17 gate exists.** Onboarding runs
carousel → auth (`auth.tsx`, no DOB) → quiz (style questions only, `quiz.tsx:10-24`)
→ selfie (body photo of a potential minor, `selfie-capture.tsx`) with no age
prompt, no parental consent, no block. For an app processing mirror selfies /
body photos with possible minors this is a ship-blocker (App Store 17+ rating
requires the gate; GDPR Art. 8 / COPPA for under-13).
Spec (app + backend crew, P0): add a DOB step BEFORE auth; `u13` → refuse
signup with copy; `13–17` → require parental-consent checkbox + email receipt
(server stamps `parental_consent_at`), default `consent_social=false` (already
default, `0001:93`) and disable share/watermark-URL cards until 18 or verified
consent; `adult` → proceed. `0002` enabler: `birth_year`/`age_band`/
`parental_consent_at`/`age_verified_at` on `users` (SEC-006; band + timestamps
excluded from the client column grant so users can't self-certify). Store
rating: **17+**, no under-13 (mirror in `docs/PRIVACY-LABELS.md`).

## 7. P0-003 — billing webhooks unimplemented (full note)

`supabase/secrets.md:44-61` specifies `billing-rc` / `billing-apple` /
`billing-google` / `billing-stripe`, but **no such function directories exist**
(`supabase/functions/` holds only the 9 product fns). The ONLY writer of
`subscriptions` is `extend_subscription` via referrals
(`referral-credit/index.ts:75-90`; grep-verified, no other writers). Since
`paywall-status`/`getEntitlementState` derive tier from `subscriptions`
(`quota.ts:61-71`), every paying user reads as `free` — purchases never
entitle, trials never start server-side, and no webhook HMAC runs in
production. Ship-blocker for IAP trial + credit packs. Backend crew: implement
the four handlers per `secrets.md` verify column, writing via `service_role`
upserts to `subscriptions` + `ledger(type='sub')` memos only.

## 8. P0-004/005 — photo pipeline broken (full note)

(a) `lib/supabase.ts:30-34` sets `BUCKETS.basePhotos='base-photos'`, but the
migration creates `base` (private) + `raw` (`0001:518-531`); no `base-photos`
bucket exists → `selfie-capture.tsx:85-89` upload fails and onboarding stalls
at the selfie step. `CONTRACT-frontend.md:73` repeats the wrong name (stale).
Fix (frontend crew): `basePhotos:'base'`, add `raw:'raw'`; do NOT create a
second bucket (`0002` carries this as a comment guard). (b) Same screen reads
the private photo via `getPublicUrl` (`selfie-capture.tsx:89`); private buckets
need `createSignedUrl` (1h, as `buckets.md:16-18` already mandates) — and
`pipeline.ts:214-220` passes https URLs through unsigned, so a public URL for
a private object also breaks Gemini/FASHN fetches. Fix: store the storage path
in `base_photos.url`, mint signed URLs server-side. (c) `base_photos` has no
`created_at` (`0001:86-94`) while `processRender` orders by it
(`pipeline.ts:249-254`) → implicit-base renders error → 3 attempts → fail +
refund loop. Fixed in `0002` (SEC-005).

## 9. Fixes shipped in 0002 (genuine gaps only)

SEC-007 users column-grant narrowing · SEC-005/012 `created_at` backfill
columns + index · SEC-006 age-gate columns (server-owned) · SEC-001/002
`deletion_requests` queue (insert/select-own; transitions service_role-only) ·
SEC-013 `garments_owner_update` WITH CHECK + `renders_owner_update` ·
SEC-009 atomic `bump_restly_daily` (service_role-only) · `base-photos`
anti-duplication guard comment. NOT changed (no genuine gap): table RLS,
DEFINER search_paths, RPC grants, Inngest HMAC, posts owner-only, anon gets
nothing on the Data API.

## 10. P2 backlog

- **P2-013** fixed in `0002` (SEC-013, above).
- **P2-014** stale bucket docs: `buckets.md:13` path `cutout/{user_id}/…`
  contradicts enforced `{user_id}/…` (`0001:535-540`; app code
  `closet-min3.tsx:49` is correct) + `CONTRACT-frontend.md:73` wrong bucket
  name — fix docs, not policy.
- **P2-015** referral cap TOCTOU (see §5).
- **P2-016** retake never deactivates prior base (`selfie-capture.tsx:92`
  inserts `is_active:true` unconditionally) — server or client must flip old
  rows, else the `buckets.md:63` supersede rule never fires.
- **P2-018** trial-reminder math: T+96h of a 7-day trial fires day 4 (3 days
  before charge, `lib/billing.ts:68`), but copy promises "2 days before"
  (`billing.ts:64`) — align offset (T+120h) or copy.
- **P1-008** no ATT prompt despite `NSUserTrackingUsageDescription`
  (`app.json:23`) + PostHog; add `expo-tracking-transparency` request or drop
  tracking claims before review (see `docs/PRIVACY-LABELS.md`).
