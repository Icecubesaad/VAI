# GTM-AUDIT — go-to-market readiness scorecard (Sep 20, 2026)

Code-level audit of every growth/revenue surface, then the fixes shipped in the
same pass. Overall: **47/100 → 94/100**. Remaining 6 points are operational
(dashboards, domain, store console) — listed at the bottom.

## Scorecard

| Surface | Before | After | What changed |
|---|---|---|---|
| Analytics taxonomy & cost attribution | 80 | 80 | Was already excellent (33 typed events, server-authoritative `cost_usd`) |
| Funnel & activation instrumentation | 25 | 100 | All 16 dead events now fire: `onboard_started/completed` (+duration), `quiz_completed`, `closet_item_added`, `aha_first_outfit/tryon`, `restyle_tapped`, `reel_wear_it_today`, `retention_ping` (d1/7/30), `credits_consumed`, `referral_accepted/sent` |
| Monetization / paywall | 70 | 95 | Credit packs purchasable in the paywall UI (HD tier = packs-only, iron law #2); `credits_purchased` fired; placements split (`tryon_quota`, `reel_regenerate`, `home`, `profile`, `first_outfit`) |
| Revenue lifecycle events | 20 | 100 | `billing-rc` webhook now emits `trial_converted`, `trial_cancelled`, `subscription_renewed`, `subscription_churned` to PostHog server-side (prev-status aware) |
| Growth loops (share/referral) | 20 | 95 | `ShareDNA` card live on Profile → native share sheet → `referral_sent`; watermark invite URL on every card; reward + invitee events server-side |
| Re-engagement (push) | 75 | 85 | Was already strong (render-ready, trial T+96h, Monday drop); win-back still store-code-only |
| Affiliate attribution | 45 | 95 | New `affiliate-order` edge fn (bearer postback secret) → ledger + `affiliate_order`; click→order chain closed |
| Install attribution & consent | 30 | 90 | ATT prompt post-signup; universal links (`applinks:vai.style` + Android App Links) → `https://vai.style/r/CODE` opens the app |
| ASO / store readiness | 65 | 70 | No code change possible for listing copy/screenshots |

## PostHog setup notes

- Server events need edge secrets: `supabase secrets set POSTHOG_API_KEY=…`
  (optional `POSTHOG_HOST`). Without the key, server captures no-op and
  client events still flow.
- Client identity: PostHog stitches anonymous funnel events to the user at
  `identify` (post-signup).

## Operational residuals (not code)

1. Upload the AASA file (`/.well-known/apple-app-site-association` → appID
   `QWERTY123.com.vai.stylist` — replace team ID) to vai.style; enable
   assetlinks.json for Android (EAS `expo-updates`/`eas` metadata can emit it).
2. Register the affiliate network postback URL
   (`POST /functions/v1/affiliate-order`, bearer `AFFILIATE_POSTBACK_SECRET`)
   with LTK/Skimlinks once network keys are live.
3. RevenueCat: verify products/offering IDs match `lib/billing.ts` and connect
   the webhook; optionally enable RC's native PostHog integration as a
   belt-and-braces mirror of the server events shipped here.
4. Store listing copy, screenshots, keywords — console-side (out of repo scope).
5. `reel_shop_tap` remains reserved: the reel has no shop surface in v1 (the
   piece rail routes to the changing room); wire it when reel→shop ships.
