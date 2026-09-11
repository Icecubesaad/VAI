# VAI Privacy Labels — Apple manifest + Play Data Safety (v1)

Source of truth for store submissions. Every entry traces to actual data use
(`file:line`). Age rating: **17+** (unrestricted photo/body-image AI + accounts);
**no under-13** (gate spec: `docs/SECURITY.md` §6, P0-006). Photo access =
 garment + mirror-selfie for try-ons only (`app.json:21-22`).

## 1. Apple Privacy Manifest (PrivacyInfo.xcprivacy)

App code collects via PostHog (`lib/analytics.ts:17-44`, 28 events), RevenueCat
(`lib/billing.ts`, purchase + renewal display), Expo push tokens
(`lib/push.ts:97-145`), Sentry (`lib/sentry.ts`, crash reports). No IDFA/ATT
call ships yet (P1-008) — either add `expo-tracking-transparency` or keep
`NSUserTrackingUsageDescription` (`app.json:23`) truthful to analytics-only use.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePhotosorVideos</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
        <string>NSPrivacyCollectedDataTypePurposeDeveloperAdvertising</string>
      </array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeUserID</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
        <string>NSPrivacyCollectedDataTypePurposeAnalytics</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeProductInteraction</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAnalytics</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeCrashData</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><false/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeOtherDataTypes</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
  </array>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>CA92.1</string></array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>C617.1</string></array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategorySystemBootTime</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>35F9.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

Why each row: Photos/Videos = garment + base selfies (`selfie-capture.tsx`,
`closet-min3.tsx`), linked, functionality-only, never public without opt-in
(`base_photos.consent_social` default false, `0001:93`). Email = Supabase Auth
+ trial/win-back email (`secrets.md:32,82`). UserID = `auth.uid` on every event
(`analytics.ts:55-58`). Product Interaction = funnel/render/affiliate events
(`analytics.ts:17-44`) incl. server-authoritative `cost_usd`. Crash Data =
Sentry, unlinked where possible (`sentry.ts:55-62` — note: `setSentryUser`
links id when called; declare linked=true if reviewer asks). OtherDataTypes =
style DNA/quiz/budget band + push token (`style_profiles`, `push_tokens`).
Tracking=false: no IDFA, no cross-app tracking; PostHog is first-party
analytics on our host. If ATT prompt is added later, flip to true + list
`us.i.posthog.com` (or self-hosted) domain here.

Required-reason APIs: UserDefaults (MMKV/zustand persist, `store/session.ts`),
file timestamps (expo-image disk cache), system boot time (PostHog/Sentry SDKs
standard). Confirm exact SDK reasons at submission (SDK 57, Sep 2026).

## 2. Google Play Data Safety

| Question | Answer (v1) |
|---|---|
| Data collected | Photos & videos (in-app selfies/garments), email address, user IDs, app interactions, crash logs, push tokens |
| Collected → shared? | Photos/videos: **not shared** (processed by Gemini/FASHN as service processors to render the try-on, not shared for ads). Email/IDs/interactions: shared with service providers only (Supabase, PostHog, RevenueCat, Sentry, Expo push) |
| Purposes | App functionality (try-ons, closet, plans), analytics (PostHog), developer communications (trial emails), fraud prevention (quotas, referral caps), personalization (style DNA) |
| Ephemeral processing? | No (photos stored until user deletes — declare stored) |
| Deletion | **In-app deletion: Delete My Photos + Delete Account (30-day purge)** in Profile (`profile.tsx`) — backend endpoints P0 in flight (`SECURITY.md` §3); requests honored via support until then |
| Encryption in transit / at rest | Yes (HTTPS everywhere; Supabase TLS + encrypted storage; tokens in SecureStore `lib/supabase.ts:13-18`) |
| Children | Not directed at children; 17+ rating; under-13 blocked at signup (gate spec `SECURITY.md` §6) |
| Independent security review | No |
| Financial / precise location / contacts / SMS | **None collected** (payments via StoreKit/Play Billing through RevenueCat — no card data touches the app, `lib/billing.ts:20`) |
| Affiliate disclosure | Physical goods only, IAP-exempt; "We may earn commission" on every shop card (`lib/affiliate.ts:22`) |

Reviewer notes to attach: base photos are private buckets + 1h signed URLs
(`buckets.md:16-18`); renders watermarked "Made with VAI"; trial copy honest
same-screen 7-day terms (`lib/billing.ts:60-68`); account-deletion path named
in-app with store-cancel reminder (`profile.tsx:71-82`).
