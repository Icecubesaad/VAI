/**
 * VAI theme barrel — `@/theme`.
 *
 * Adapts canonical `tokens.ts` (paper/ink/terracotta…) to the consumer-facing
 * `colors` shape every `app/` screen codes against
 * (`background/surface/text/muted/primary/onPrimary/border/danger`,
 * + `success`/`warning`). Consumers are canonical here — this barrel maps to
 * them, never the reverse.
 *
 * ```tsx
 * import { ThemeProvider, useTheme } from '@/theme';
 * const { colors } = useTheme();
 * colors.background // '#141114' (tokens.colors.paper)
 * ```
 *
 * Deep imports (`@/theme/tokens`, `@/theme/ThemeProvider`) keep working
 * unchanged; the base `useTheme` there returns `{ tokens, colorScheme }`
 * while THIS barrel's `useTheme` adds the `colors` alias map on top of the
 * same tokens instance.
 */
import { ThemeProvider, useTheme as useBaseTheme } from './ThemeProvider';
import { tokens } from './tokens';

export { ThemeProvider };
export {
  tokens,
  spacing,
  fonts,
  typeScale,
  radii,
  shadows,
  colors as tokenColors,
} from './tokens';
export type {
  ColorName,
  SpacingName,
  FontName,
  TypeName,
  RadiiName,
  ShadowName,
  Tokens,
} from './tokens';

/**
 * Consumer-facing color aliases. Single mapping table — paper→background
 * etc. — so a rebrand touches tokens.ts only, never call sites.
 */
export const colors = {
  /** App background */
  background: tokens.colors.paper,
  /** Card / sheet surface */
  surface: tokens.colors.card,
  /** Primary text */
  text: tokens.colors.ink,
  /** Secondary / placeholder text */
  muted: tokens.colors.muted,
  /** Brand accent (CTAs, active states) */
  primary: tokens.colors.terracotta,
  /** Pressed/active text on washes (badges, exhausted counters) */
  primaryDeep: tokens.colors.terracottaDeep,
  /** Editorial lead — bordeaux for display kickers, DNA/share moments */
  editorial: tokens.colors.oxblood,
  /** Text on top of `primary` */
  onPrimary: tokens.colors.applePaper,
  /** Hairline borders */
  border: tokens.colors.line,
  /** Sunken wells / sheet grounds unreachable via `surface` alone */
  surfaceDeep: tokens.colors.paperDeep,
  /** Linen media well (image placeholders, thumbs) */
  well: tokens.colors.well,
  /** Errors / destructive */
  danger: tokens.colors.danger,
  /** Success states (recommended) */
  success: tokens.colors.sage,
  /** Warnings / "best value" highlights (recommended) */
  warning: tokens.colors.warn,
} as const;

export type ThemeColors = typeof colors;
export type ThemeColorName = keyof typeof colors;

/** Barrel hook: base theme value + consumer `colors` alias map. */
export function useTheme(): {
  tokens: typeof tokens;
  colorScheme: 'light';
  colors: ThemeColors;
} {
  const base = useBaseTheme();
  return { tokens: base.tokens, colorScheme: base.colorScheme, colors };
}

export type Theme = ReturnType<typeof useTheme>;
