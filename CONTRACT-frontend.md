# CONTRACT-frontend.md — exact import contract the frontend codes against
Frontend owns: `app/` router+tabs+funnel, `store/*`, `lib/supabase.ts`, `lib/api.ts`.
Everything below is owned by another engineer. Until it lands, `tsc --noEmit` fails
on these imports — that is expected; this file is the build order handshake.

## 1. `@/theme` (UI/UX owner)
```ts
import { ThemeProvider, useTheme } from '@/theme';
const { colors } = useTheme();
// colors MUST include: background, surface, text, muted, primary, onPrimary,
// border, danger (+ success, warning recommended). Base palette: bg #FAF8F5, ink #1A1A1A.
```
`ThemeProvider` wraps the app in `app/_layout.tsx` (no props). Also expected from
UI/UX: NativeWind+gluestack wiring, font assets for the splash+font gate, app icons.

## 2. `@/components` (UI/UX owner) — props the frontend passes TODAY
```ts
import { OutfitCard, GarmentCard, RenderView, ShareCard, QuotaBadge } from '@/components';

// Planner home hero + first-outfit hero
<OutfitCard outfitId={string} garmentImages={string[]} whyLine={string} hero?: boolean />

// Closet grid cell: photo/cat/colors/fabric/formality/season/wear-count/CPW
<GarmentCard garment={Garment} onDelete?: () => void />   // Garment type = lib/api.ts

// Try-on result: 2-up compare when compare=true; watermark overlay when watermark
<RenderView basePhotoUrl={string | null} outputUrl={string | null}
  status={'queued'|'processing'|'done'|'failed'} compare?: boolean watermark?: boolean />
// Must render the caption "AI try-on · may differ from fit" on every output.

// Quiz DNA teaser: shareable card, watermark `Made with VAI · vai.style/r/<code>`
<ShareCard teaser={string} labels={string[]} colorSeason={string} watermark?: boolean />

// Counter badge, exact copy "X of 5 left" on free tier; one-tap upgrade via onPress
<QuotaBadge left={number} cap={number} onPress?: () => void />
```
NOTE: build pack lists `PaywallSheet` — frontend v1 uses the full `onboarding/paywall`
route instead (trial copy + counters + restore). If UI/UX ships `PaywallSheet`,
`paywall.tsx` can embed it; props to support: `{ left, cap, onTrial, onRestore, onDismiss }`.

## 3. `@/lib/billing` (Integrations owner, RevenueCat `premium` entitlement)
```ts
import { purchaseTrial, restorePurchases } from '@/lib/billing';
// purchaseTrial(): Promise<'trial'|'premium'> — executes StoreKit2/Play Billing trial flow
// restorePurchases(): Promise<Tier>                        // Tier = lib/api.ts
```
`app/onboarding/paywall.tsx` calls these at the marked handoff (currently stubbed with
a visible notice — billing owner flips it live). Products: `vai_premium_monthly` $4.99,
`vai_premium_yearly` $39.99, consumable credit packs (10 std $1.99 / 25 std $4.99 / 1 HD $0.99).

## 4. `@/lib/analytics` (Integrations owner, PostHog)
```ts
import { track } from '@/lib/analytics';
// track(event: string, props?: { tier?, render_model?, cost_usd?, ... })
```
Frontend will emit (build pack §10): `onboard_started/completed, quiz_completed,
closet_item_added{count}, aha_first_outfit, aha_first_tryon,
render_requested/succeeded/failed{latency,restyle_n}, paywall_seen{placement},
trial_started/converted, credits_purchased/consumed, affiliate_click,
wishlist_added, referral_sent/accepted/rewarded`. Call sites are marked TODO(analytics).

## 5. `@/lib/ai` (Integrations owner, optional upgrade)
Selfie quality ML (blur / face / keypoints) currently runs server-side in `quiz-score`
after upload; on-device gate checks resolution+framing only. If lib-ai ships
`assessSelfie(localUri): Promise<{ok:boolean; reason?: string}>`, `selfie-capture.tsx`
will call it pre-upload. Do NOT change the FailReason copy contract without frontend.

## 6. Backend (Backend owner) — shapes `lib/api.ts` already assumes
- Tables (RLS `auth.uid()=user_id`, explicitly exposed per Apr-2026 Data API change):
  `users(referral_code, referred_by)`, `style_profiles`, `garments`, `base_photos`
  (INSERT by owner + SELECT), `outfits`, `renders` (SELECT id/status/output_url/error),
  `wishlist`, `subscriptions`, `referrals`, `render_quotas`.
- Storage buckets (public-read URLs via getPublicUrl): `base-photos`, `garments`, `renders`.
- Edge fns + payloads: `quiz-score{answers,s selfieUrl?}`, `auto-tag{imageUrl}`,
  `plan-day{date,eventLabel?}`, `plan-week{startDate}`, `render-tryon{outfitId,
  basePhotoId,garmentRefs,mode,tier,idempotencyKey}`, `restyle{renderId,note}`,
  `shop-picks{outfitId?,gapQuery?}`, `style-score{}`, `coach-day{day}`,
  `evaluate-instore{imageUrl}`, `paywall-status{}` → `{tier,trialEndsAt,rendersLeft,
  lifetimeUsed,lifetimeCap,monthlyUsed,monthlyCap}`, `referral-credit{code}`.
- Quota truth is server-side; only `done` renders decrement. `idempotency_key =
  sha256(user|base|outfit|day)` — client sends it, server honors it.

## 7. Copy locked from the build pack (do not reword without founder)
- Trial: "7 days free, then $4.99/mo · cancel anytime · no charge today"
- Counter: "X of 5 left" (free) · monthly "X of 30" (premium)
- Selfie consent: "Used only for your try-ons. Never public without opt-in."
- Render label: "AI try-on · may differ from fit" · timing: "usually ~20s" (never seconds)
- Affiliate footer: "We may earn commission — no extra cost to you"
- Delete account: 30-day purge notice + store-cancel reminder
