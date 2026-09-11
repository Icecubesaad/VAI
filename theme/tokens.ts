/**
 * VAI design tokens — v1, light-mode only.
 *
 * Warm minimalism: warm paper background, near-black ink, terracotta accent,
 * sage success. Editorial fashion tone (beats generic lavender-gradient apps):
 * generous whitespace, serif display moments, quiet hairline borders.
 *
 * Single source of truth: `tokens` for inline styles / StyleSheet, and
 * `tailwindThemeExtend` is spread into tailwind.config.js so NativeWind
 * classNames (bg-paper, text-ink, bg-terracotta …) resolve to the same values.
 */

export const colors = {
  /** App background */
  paper: '#FAF8F5',
  /** Sunken background (sheets, inset wells) */
  paperDeep: '#F2EDE5',
  /** Card surface — always pure white on paper for crisp separation */
  card: '#FFFFFF',
  /** Primary text */
  ink: '#1A1A1A',
  /** Secondary text */
  inkSoft: '#57504A',
  /** Tertiary / placeholder text — min 4.5:1 on paper for body, decorative only below */
  muted: '#8A8179',
  /** Hairline borders on paper */
  line: '#E7DED2',
  /** Hairline borders on white cards */
  lineOnCard: '#EFE8DC',

  /** Brand accent */
  terracotta: '#C65D3B',
  terracottaDeep: '#A34A2C',
  terracottaWash: '#F8E7DC',

  /** Success / confirm */
  sage: '#66855F',
  sageDeep: '#49663F',
  sageWash: '#E4EBE0',

  /** Ratings / "Best value" highlight — restrained gold, never neon */
  gold: '#A87E2A',
  goldWash: '#F4EAD2',

  danger: '#B3402E',
  dangerWash: '#F7E2DC',
  warn: '#A87E2A',

  /** Apple-pay-style premium CTA */
  appleBlack: '#000000',
  applePaper: '#FFFFFF',

  /** Scrim for sheets / overlays */
  scrim: 'rgba(26, 26, 26, 0.45)',
} as const;

export type ColorName = keyof typeof colors;

/** 4pt base grid. Never use magic numbers in components — import from here. */
export const spacing = {
  '2xs': 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

export type SpacingName = keyof typeof spacing;

/**
 * Type scale — line heights are paired, always set both.
 * Display uses a serif stack for editorial moments (hero outfit, DNA card).
 * UI body stays on the system sans for legibility + zero font-loading cost.
 */
export const typeScale = {
  display: { fontSize: 34, lineHeight: 40, fontFamily: 'Georgia, serif', fontWeight: '600' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyBold: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1.2 },
} as const;

export type TypeName = keyof typeof typeScale;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export type RadiiName = keyof typeof radii;

/**
 * Shadows — subtle and warm-tinted. Android reads `elevation` only;
 * iOS reads the rest. Keep card shadows barely-there; reserve `pop`
 * for sheets and the premium CTA.
 */
export const shadows = {
  card: {
    shadowColor: '#3A2E24',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  pop: {
    shadowColor: '#3A2E24',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  none: {
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
} as const;

export type ShadowName = keyof typeof shadows;

export const tokens = {
  colors,
  spacing,
  typeScale,
  radii,
  shadows,
  /** v1 ships light-mode only. Dark mode = v2 (see CONTRACT-uiux.md). */
  mode: 'light' as const,
} as const;

export type Tokens = typeof tokens;
