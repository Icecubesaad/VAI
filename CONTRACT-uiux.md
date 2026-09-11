# CONTRACT-uiux.md — UI/UX ↔ Frontend import contract (v1)

Frontend imports ONLY these names. UI/UX renames nothing without a major
bump + grep of `app/`. All paths use the `@/*` alias (`tsconfig.json`).

## Theme

| Import | File | Exports |
|---|---|---|
| `@/theme/tokens` | `theme/tokens.ts` | `tokens`, `colors`, `spacing`, `typeScale`, `radii`, `shadows`, types `ColorName`, `SpacingName`, `TypeName`, `RadiiName`, `ShadowName`, `Tokens` |
| `@/theme/ThemeProvider` | `theme/ThemeProvider.tsx` | `ThemeProvider`, `useTheme()` → `{ tokens, colorScheme: 'light' }` |

`tailwind.config.js` mirrors `theme/tokens.ts` hexes (Node can't require
`.ts`); change both. Light-mode only — no `dark:` variants in v1.

## Components

| Import | Exports |
|---|---|
| `@/components/Button` | `Button`, `PremiumCTA`, types `ButtonProps`, `ButtonVariant` (incl. `'dev'` dev-login style — onboarding debug entry only, never production paths), `ButtonSize`, `PremiumCTAProps` |
| `@/components/Card` | `Card`, type `CardProps` |
| `@/components/GarmentCard` | `GarmentCard`, types `Garment`, `GarmentCardProps` |
| `@/components/OutfitCard` | `OutfitCard`, type `OutfitCardProps` |
| `@/components/Badge` | `Badge`, types `BadgeProps`, `BadgeTone` |
| `@/components/CounterBadge` | `CounterBadge`, type `CounterBadgeProps` (`remaining`, `total`, `onUpgrade`) |
| `@/components/Sheet` | `Sheet`, alias `PaywallSheet`, helper `trialLine(plan, withTrial)`, const `PLAN_META`, types `SheetProps`, `PaywallPlan` (`'monthly' \| 'yearly'`) |
| `@/components/SelfieGuide` | `SelfieGuide`, types `SelfieGuideProps`, `SelfieCheck` |
| `@/components/Skeleton` | `Skeleton`, `SkeletonCard`, `SkeletonGrid`, `SkeletonHero`, `SkeletonTasteRow` (syncing-taste shimmer matching `InspirationRow`) |
| `@/components/EmptyState` | `EmptyState`, type `EmptyStateProps` (incl. `variant?: 'default' \| 'offline-cached'`) |
| `@/components/ErrorView` | `ErrorView`, type `ErrorViewProps` (`message`, `onRetry`, `retrying?`, `offline?`, `cached?` — cached adds the "last saved version" caption) |
| `@/components/ShareDNA` | `ShareDNA`, `captureShareDNA(ref)`, type `ShareDNAProps` |
| `@/components/Watermark` | `Watermark`, type `WatermarkProps` (`code`, `tone?`) |
| `@/components/ReelCard` | `ReelCard`, consts `REEL_POSE_LABEL`, `REEL_DISCLOSURE`, types `ReelCard` (card shape `{id,outfitId,renderId,imageUrl,pose,garmentIds,whyLine,trendTag?,costUsd,createdAt}`), `ReelCardProps` (`card,onWear,onTry,onShop,onSave,onRegenerate,saved` + optional `garmentThumbs,quotaLeft,quotaCap,onUpgrade,error,onRetry,retrying,loading`), `ReelPose` (`'front'\|'step'\|'detail'`) — barrel also aliases the type as `ReelCardData` |
| `@/components/PoseGuide` | `PoseGuide`, types `PoseGuideProps` (`pose,onPoseChange?,checks?,failureReason?,onCapture,onRetake?,capturing?`), `PoseGuidePose`, `PoseCheck` |
| `@/components/ReelSkeleton` | `ReelSkeleton` (full-screen pager shimmer matching `ReelCard`) |
| `@/components/PoseToggle` | `PoseToggle`, types `PoseToggleProps` (`mode,onChange,pinThumb?`), `PoseToggleMode` (`'mine' \| 'pin'`) |
| `@/components/PinGrid` | `PinGrid`, types `PinGridProps` (`pins,selectedId?,onSelect?,loading?,error?,onRetry?,retrying?,onEmptyAction?,emptyActionTitle?,scrollEnabled?`), `PinItem` (`{id,thumbUrl,fullUrl?,title?,poseMarked?,stanceLabel?}`) |
| `@/components/PinPoseCompare` | `PinPoseCompare`, type `PinPoseCompareProps` (`mineUrl?,pinUrl,pinTitle?,stanceLabel,stanceHint?,onUsePose,using?`) |
| `@/components/ShareBackSheet` | `ShareBackSheet`, helper `shareConfirmLabel(boardName)`, types `ShareBackSheetProps` (`visible,boards,selectedBoardId,onSelectBoard,onConfirm,posting?,postedUrl?,error?,onClose`), `ShareBackBoard` |
| `@/components/PinterestConsent` | `PinterestConsent`, type `PinterestConsentProps` (`secretOptIn?`) |
| `@/components/TasteCadence` | `TasteCadence`, types `TasteCadenceProps` (`value,onChange,lastSyncCaption?,syncing?,disabled?`), `TasteCadenceValue` (`'daily' \| 'weekly' \| 'off'`) — "Style refresh" row |
| `@/components/InspirationRow` | `InspirationRow`, type `InspirationRowProps` (`connected,username?,lastSyncCaption?,syncing?,boardCount?,onPress,onDisconnect?,disconnecting?`) — "Style inspiration" row |

> Pinterest invisible in v1: `PoseToggle`, `PinGrid`, `PinPoseCompare`,
> `ShareBackSheet`, `PinterestConsent` stay exported (@deprecated-in-v1, see
> `components/README.md`) but no v1 screen imports them — only the two rows
> above. Backend flows may reuse the deprecated set later.

## Lib

| Import | Exports |
|---|---|
| `@/lib/haptics` | `haptic(kind?)`, `hapticFor.{confirm,select,blocked,done}`, type `HapticKind` |
| `@/lib/watermark` | `buildWatermarkText(code)`, `buildReferralUrl(code)`, `WATERMARK_BASE_URL`, `AI_DISCLOSURE` |

## Product constants locked by this contract

- Plans: `vai_premium_monthly` $4.99 · `vai_premium_yearly` $39.99 (floor —
  never ship the blueprint's $29.99/yr).
- Free quota copy: `"X of 5 left"` lifetime renders; Premium = 30/mo, never
  "unlimited". Trial line: `"7 days free, then $4.99/mo · cancel anytime · no charge today"`.
- Watermark: `"Made with VAI · vai.style/r/<code>"` — may move, never remove.
- v2 (out of contract): dark mode, social feed, week plan, fragrance.
