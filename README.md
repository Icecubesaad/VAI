# VAI — AI Wardrobe Styling, Virtual Try-On & Social Commerce (v1 cut scope)

Full spec: `../VAI-BUILD-PACK.md` (mandatory reading for every engineer).
Reference mockups: `../VAI-mockups/`.

## Stack (verified Sep 2026 — do not downgrade)
| Layer | Choice |
|---|---|
| App | Expo SDK 57 (`expo@^57.0.0`, RN 0.86, React 19.2, Expo Router, new arch) |
| Styling/UI | NativeWind + gluestack-ui v3 (Tailwind) — UI/UX owner wires it |
| Images | expo-image everywhere, FlashList for grids, MMKV + zustand state |
| Image AI | Gemini `gemini-3.1-flash-image` (Nano Banana 2, ~$0.067/img, 0.5K/1K/2K/4K) primary; `gemini-3-pro-image` fallback; FASHN fallback only |
| Text/vision AI | Gemini Flash (outfit reasoning, auto-tag, quiz) via server only |
| Backend | Supabase (Postgres 15+, Auth incl. passkeys, Storage, Edge Functions, Realtime). NOTE Apr-2026 change: tables are NOT auto-exposed to Data API — expose explicitly. |
| Jobs | Inngest (render pipeline). Billing: RevenueCat (`premium` entitlement). Analytics: PostHog. Errors: Sentry. |

## Run it
```bash
npm install
npx expo install --fix        # align native deps to SDK 57
cp .env.example .env          # fill keys
supabase link + supabase db push
npx expo start                # dev client build needed for native modules (camera, purchases)
```
EAS dev-client required (Expo Go cannot run camera/purchases native modules).

## Ownership (no cross-edits without asking)
| Area | Owner files |
|---|---|
| Backend | `supabase/` (migrations, functions, buckets/policies, Inngest, quotas) |
| Frontend | `app/` (router, onboarding funnel, 5 tabs, funnel gates, quota badges) |
| UI/UX | `components/`, `theme/`, `assets/` (design system, paywall sheet, DNA card, watermark, haptics) |
| Performance | `lib/perf/*`, image pipeline, render-queue UX contract, perf budgets doc |
| Integrations | `lib/ai/*` (Gemini), `lib/billing.ts`, `lib/affiliate.ts`, `lib/push.ts`, `lib/analytics.ts` |
| Me (founder agent) | root configs, `VAI-BUILD-PACK.md`, release |

## Iron laws (from audited unit economics)
1. Free = 50 items · 1 outfit/day · **5 LIFETIME renders**, then hard paywall. Never daily refills.
2. Premium = **30 renders/mo**, never "unlimited". HD tier = credit packs only.
3. Renders take 10–55s IRL — async queue + push, never fake countdowns.
4. Apple 30% baked into every price. Affiliate = physical goods only (IAP-exempt).
5. v1 cuts: NO social feed, battles, fragrance, stylist video, family/student plans.
