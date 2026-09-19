/**
 * VAI components barrel — `@/components`.
 *
 * Canonical names follow CONTRACT-uiux (per-file modules); CONTRACT-frontend
 * aliases are exported alongside so `app/` call sites resolve with zero
 * rewrites:
 * - `QuotaBadge` → alias-shape of canonical `CounterBadge`
 * - `ShareCard` → quiz-teaser shape alongside canonical `ShareDNA`
 * - `RenderView` → try-on result view (P0-2, was missing entirely)
 * - `PaywallSheet` → alias of canonical `Sheet`
 * - `OutfitCard` / `GarmentCard` accept both canonical and frontend props
 * - `ReelCard` / `PoseGuide` / `ReelSkeleton` → looks-reel loop
 */
export { Button, PremiumCTA } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize, PremiumCTAProps } from './Button';

export { PressScale } from './PressScale';
export type { PressScaleProps } from './PressScale';

export { RenderProgress } from './RenderProgress';
export type { RenderProgressProps } from './RenderProgress';

export { ResultReveal, EditorialReveal } from './ResultReveal';
export type { ResultRevealProps, EditorialRevealProps } from './ResultReveal';

export { Card } from './Card';
export type { CardProps } from './Card';

export { GarmentCard } from './GarmentCard';
export type { Garment, GarmentCardProps } from './GarmentCard';

export { OutfitCard } from './OutfitCard';
export type { OutfitCardProps } from './OutfitCard';

export { Badge } from './Badge';
export type { BadgeProps, BadgeTone } from './Badge';

export { CounterBadge } from './CounterBadge';
export type { CounterBadgeProps } from './CounterBadge';

export { QuotaBadge } from './QuotaBadge';
export type { QuotaBadgeProps } from './QuotaBadge';

export { Sheet, PaywallSheet } from './Sheet';
export type { SheetProps, PaywallPlan } from './Sheet';
export { PLAN_META, trialLine } from './Sheet';

export { SelfieGuide } from './SelfieGuide';
export type { SelfieGuideProps, SelfieCheck } from './SelfieGuide';

export { Skeleton, SkeletonCard, SkeletonGrid, SkeletonHero } from './Skeleton';
export { SkeletonTasteRow } from './Skeleton';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { ErrorView } from './ErrorView';
export type { ErrorViewProps } from './ErrorView';

export { ShareDNA, captureShareDNA } from './ShareDNA';
export type { ShareDNAProps } from './ShareDNA';

export { ShareCard } from './ShareCard';
export type { ShareCardProps } from './ShareCard';

export { DnaFilmstrip } from './DnaFilmstrip';
export type { DnaLook } from './DnaFilmstrip';

export { RenderView } from './RenderView';
export type { RenderViewProps } from './RenderView';

export { Watermark } from './Watermark';
export type { WatermarkProps } from './Watermark';

export { ReelCard, REEL_DISCLOSURE } from './ReelCard';
export type { ReelCard as ReelCardData, ReelCardProps } from './ReelCard';

export { PoseGuide } from './PoseGuide';
export type { PoseGuideProps, PoseGuidePose, PoseCheck } from './PoseGuide';

export { InspirationStrip } from './InspirationStrip';

export { ReelSkeleton } from './ReelSkeleton';
