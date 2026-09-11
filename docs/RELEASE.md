# VAI Release Guide

Stack: Expo SDK 57 · RN 0.86 · React 19.2 · bundle `com.vai.stylist` · EAS Build/Submit/Update.

## 0. One-time setup (release engineer)

```bash
npm install -g eas-cli
eas login
eas init            # creates the EAS project + extra.eas.projectId in app.json (BLOCKER until done)
eas update:configure  # sets runtimeVersion {"policy":"appVersion"} + updates.url (BLOCKER until done)
eas secret:create   # one per EXPO_PUBLIC_* key below + server keys used at build time
```

GitHub: add `EXPO_TOKEN` (Expo access token) to repo secrets if you later add
build/submit jobs. CI (`ci.yml`) needs no secrets.

Apple: paid Developer Program membership, App Store Connect record for
`com.vai.stylist`, TestFlight internal group. Google: Play Console app for
`com.vai.stylist`, first AAB uploaded manually, internal track testers list.

## 1. Dev-client builds → tester phones

Expo Go is **not supported** (see §4). Testers install a dev-client build:

```bash
# Android tester (APK, direct install link/QR)
eas build --profile development --platform android
# iOS tester (must register the device FIRST — ad-hoc signing)
eas device:create
eas build --profile development --platform ios
```

Share the EAS build page link/QR. Tester flow: install build → `npx expo start`
on your machine → scan QR in the dev-client → JS loads from your machine.
For testers who just need the latest committed JS without your laptop running,
use the `preview` profile instead:

```bash
eas build --profile preview --platform android   # APK, install from link
eas device:create                                # iOS ad-hoc, once per device
eas build --profile preview --platform ios       # IPA, install from link
```

Preview builds pull JS from the `preview` update channel — no laptop needed.

## 2. TestFlight (internal) + Play (internal track)

```bash
./scripts/bump-version.sh X.Y.Z   # keep app.json + package.json in sync
git commit -am "release: X.Y.Z" && git push

eas build --profile production --platform ios
eas submit --platform ios          # → TestFlight; add to internal group in App Store Connect

eas build --profile production --platform android
eas submit --platform android      # → Play Console internal track; promote to testers list
```

`autoIncrement: true` (production) bumps iOS buildNumber / Android versionCode
against the **remote** (`appVersionSource: remote`) counter — no manual
versionCode bookkeeping. Never hand-edit buildNumber/versionCode; resolve
conflicts by rebuilding.

## 3. Secrets / env discipline

- `eas.json` `env` carries **non-secret build wiring only**: `APP_ENV` /
  `EXPO_PUBLIC_APP_ENV` (`development|preview|production`).
- Everything key-like (`EXPO_PUBLIC_SUPABASE_URL`,
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_POSTHOG_KEY`,
  `EXPO_PUBLIC_REVENUECAT_*`) ships via **`eas secret:create`** (build-time) /
  local `.env` (dev, gitignored). Never paste secrets into `eas.json`, CI yaml,
  or chat logs.
- Server-only keys (`GEMINI_API_KEY`, `FASHN_API_KEY`, `SHOPSTYLE_KEY`,
  `LTK_AFFILIATE_ID`, `RESEND_KEY`, `STRIPE_SECRET`) stay in **Supabase Edge
  Function secrets** — they must never be `EXPO_PUBLIC_*`.

## 4. Why Expo Go is NOT supported

Expo Go ships a fixed native runtime. VAI needs custom native code that Expo Go
does not contain: dev-client itself, camera capture, RevenueCat purchases
(`react-native-purchases`), push notifications, MMKV, Sentry, PostHog. Opening
VAI in Expo Go fails on those native modules. All testing uses dev-client
(§1), preview, or store builds.

## 5. Version bump procedure

1. `./scripts/bump-version.sh X.Y.Z` (bumps `app.json` `expo.version` +
   `package.json` `version` together — CI fails on drift).
2. Commit + push (CI `requireCommit: true` in eas.json also blocks dirty builds).
3. Build production binaries (§2) — required, because with the `appVersion`
   runtime policy the new version is a **new runtime** and old binaries cannot
   consume its updates.
4. Publish the update to the matching channel: `eas update --branch production`.

## 6. OTA policy (expo-updates / EAS Update)

Channels: `development` / `preview` / `production`, matching the build profile
of the same name. Runtime policy: `appVersion` (set by `eas update:configure`).

### MAY ship OTA (`eas update --branch <production|preview>`)

- JS/TS logic, navigation, gating, quota copy, paywall text/ordering
- Styling, assets, images, copy, localization
- Supabase-driven content reachable through existing Edge Functions / tables
- PostHog event names (additive)

### MUST be a native rebuild (new binary + store/internal distribution)

- Adding/removing/upgrading any native module or Expo config plugin
  (camera, purchases, notifications, Sentry, MMKV, FlashList, expo-image…)
- Any `app.json` key that affects native code: `plugins`, `permissions`,
  `ios.infoPlist`, `android.permissions`, `scheme`, icons/splash, `newArchEnabled`
- Expo SDK upgrade, `expo.version` bump (new runtime by policy)
- Push credential / signing changes, bundle id / package rename
- Anything `expo doctor` flags as a native-dependency mismatch

Rule of thumb: **if `npx expo prebuild` output would differ, it is not OTA-able.**

### Rollback

There is no in-place "undo" — a rollback is a **new update**:

1. Find the last-good update group: `eas update:list --branch production`.
2. Preferred: `git checkout <last-good-tag>` + `eas update --branch production`
   so the rollback is reproducible from source.
3. Alternative: EAS dashboard → Updates → channel → **Republish** the older
   update group.
4. If the bad change touched native code (§6 native list), OTA rollback is
   impossible — rebuild, resubmit, and expedite review.

Never republish across runtimes: an update built for runtime `1.2.0` will not
install on binaries built for `1.1.0` (and must not be forced to).
