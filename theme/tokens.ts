/**
 * VAI design tokens — v1, light-mode only.
 *
 * TOKEN PLAN (fashion-editorial, not SaaS) — kept in sync with
 * `tailwind.config.js` (Node can't require `.ts`; change both) and
 * `theme/index.ts` (semantic `useTheme()` aliases).
 *
 * Palette — 6 named leads:
 *   muslin/paper  #FAF8F5  app ground. Kept EXACT: `app.json` splash +
 *                   adaptive-icon backgrounds are this hex; any drift would
 *                   flash a seam on launch. Reframed as calico/muslin
 *                   (toile fabric), never "warm cream minimalism".
 *   ink           #1A1A1A  primary text. Kept EXACT (contract base).
 *   lacquer       #C65D3B  workhorse CTA (`terracotta` name kept for compat;
 *                   `Sheet.tsx` hardcodes this hex for the trial switch).
 *                   Voice shifts clay→lacquer through USAGE, not hue.
 *   oxblood       #6E2233  NEW editorial lead — bordeaux. Vogue-cover,
 *                   lipstick, wine; unmistakably fashion, collides with
 *                   neither lacquer nor danger brick. Display kickers,
 *                   DNA/share moments, "best value" seals.
 *   sage          #66855F  success only. Never decoration.
 *   gold          #A87E2A  ratings / value highlights. Never neon.
 * Supporting: paperDeep #F2EDE5 (inset wells), card #FFFFFF (crisp on
 * muslin), inkSoft #57504A, muted #8A8179, line #E7DED2 / lineOnCard
 * #EFE8DC (rules, not boxes), washes per accent, well #EDE8E0 (the
 * de-facto media-well hex, tokenized from 6 hardcoded call sites).
 *
 * Type roles — magazine energy:
 *   display   confident serif headline, tight tracking (-0.5). RN-correct
 *             single family name ('Georgia'); the old 'Georgia, serif'
 *             stack never resolved on native (RN takes one family).
 *   editorial NEW serif italic pull-line — VAI's why-lines
 *             ("Navy blazer echoes your sneakers…") ARE editorial copy;
 *             set them in this voice, sentence case, 19/28.
 *   kicker    NEW sentence-case section marker (13/18, +0.3 tracking).
 *             Replaces the ALL-CAPS tracked eyebrow habit: never uppercase
 *             a kicker, never stack one above every heading.
 *   eyebrow   LEGACY, restricted: micro-labels only (consent lines,
 *             offline captions). If it reads as chrome, delete it.
 *   body family stays system sans — legibility, zero load cost.
 * FONT GAP (no files in assets/, no useFonts gate in app/_layout):
 *   display/editorial render in Georgia on iOS, platform serif/sans
 *   fallback on Android. To go cross-platform: bundle an OFL editorial
 *   serif (e.g. Fraunces) via expo-font (already a dependency), gate in
 *   `app/_layout.tsx`, then point `fonts.display` at it. Until then,
 *   DO NOT ship a second serif — one fallback is a choice, two is drift.
 *
 * Layout concept — "rack, not dashboard": left-aligned, ragged-right
 * headlines; media full-bleed (3:4 closet, 4:5 hero) with quiet inset UI;
 * hairlines as RULES between sections, never boxes around everything;
 * section rhythm on the 4pt grid (xl/2xl), display moments get 3xl/4xl
 * air above. Gutter is 20 (`spacing.gutter`) — magazine margin, not 16.
 *
 * Radius hierarchy (one language, ranked — never one radius everywhere):
 *   media 10  product photography (lookbook prints stay near-sharp)
 *   sm 8      inner chips, thumbs-in-chips, checks
 *   md 12     buttons, inputs
 *   lg 16     cards, upsells
 *   xl 24     sheets, heroes
 *   pill 999  segments, pills, primary CTAs (fashion e-com convention)
 *
 * Shadow language — dyed-fabric depth, never default grey blur:
 *   shadowColor stays warm #3A2E24 on every tier. card = barely-there
 *   contact; lift = resting sheets / garment stacks; pop = modal + paywall.
 *
 * Principles:
 *   1. Type leads, chrome recedes. One memorable thing per screen.
 *   2. One confident red family (lacquer for action, oxblood for voice).
 *   3. Sentence case, always. No `A · B · C` meta strings, no `→` buttons.
 *   4. Tactile paper: warm shadows, hairline rules, linen wells.
 *
 * BACKWARD COMPAT: names are append-only (11+ app files + the whole kit
 * consume them). Shifting a hex is a rebrand; renaming/removing is a
 * breaking change. See CONTRACT-uiux.md.
 */

export const colors = {
  /** App background — muslin/calico ground. Splash-locked, do not drift. */
  paper: '#FAF8F5',
  /** Sunken background (sheets, inset wells) */
  paperDeep: '#F2EDE5',
  /** Card surface — always pure white on paper for crisp separation */
  card: '#FFFFFF',
  /** Linen media well — tokenized de-facto placeholder hex (see tryon/shop/reel) */
  well: '#EDE8E0',
  /** Primary text */
  ink: '#1A1A1A',
  /** Secondary text */
  inkSoft: '#57504A',
  /** Tertiary / placeholder text — min 4.5:1 on paper for body, decorative only below */
  muted: '#8A8179',
  /** Hairline rules on paper — use as dividers, not box outlines */
  line: '#E7DED2',
  /** Hairline borders on white cards */
  lineOnCard: '#EFE8DC',

  /** Brand workhorse — lacquer voice (CTAs, active states, selection rings) */
  terracotta: '#C65D3B',
  terracottaDeep: '#A34A2C',
  terracottaWash: '#F8E7DC',

  /** Editorial lead — bordeaux for display kickers, DNA/share moments, value seals */
  oxblood: '#6E2233',
  oxbloodWash: '#F5E4E6',

  /** Success / confirm — never decoration */
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

/** 4pt base grid + 20pt magazine gutter. Never use magic numbers in components — import from here. */
export const spacing = {
  '2xs': 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /** Magazine gutter — screen margins, display air */
  gutter: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

export type SpacingName = keyof typeof spacing;

/**
 * Single family names only — React Native resolves ONE font family per
 * style (comma stacks never worked on native). `fonts.display` is the
 * switch to flip once an expo-font serif lands in assets/.
 */
export const fonts = {
  /** Editorial serif — Georgia on iOS until the font-file gap is closed */
  display: 'Georgia',
  /** UI sans — system, zero load cost */
  sans: 'System',
} as const;

export type FontName = keyof typeof fonts;

/**
 * Type scale — line heights are paired, always set both.
 * Display/editorial use the serif for magazine moments (hero outfit, DNA
 * card, why-lines). UI body stays on the system sans for legibility.
 * Sentence case everywhere; kickers never uppercase.
 */
export const typeScale = {
  /** Confident magazine headline — tight tracking, air above (3xl/4xl) */
  display: { fontSize: 36, lineHeight: 40, fontFamily: 'Georgia', fontWeight: '600', letterSpacing: -0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  /** Serif italic pull-line — why-lines, style verdicts, empty-state invitations */
  editorial: { fontSize: 19, lineHeight: 28, fontFamily: 'Georgia', fontStyle: 'italic', fontWeight: '400' },
  /** Sentence-case section marker — never uppercase, never above every heading */
  kicker: { fontSize: 13, lineHeight: 18, fontWeight: '600', letterSpacing: 0.3 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyBold: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  /** LEGACY, restricted: micro-labels only (consent, offline captions). Prefer kicker. */
  eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1.2 },
} as const;

export type TypeName = keyof typeof typeScale;

/**
 * Radius hierarchy — ranked, not uniform. Media stays near-sharp
 * (lookbook prints), chrome goes soft, CTAs go pill.
 */
export const radii = {
  sm: 8,
  /** Product photography, pin cells, 3:4 / 4:5 media */
  media: 10,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export type RadiiName = keyof typeof radii;

/**
 * Shadows — warm-dyed (#3A2E24) on every tier, never grey blur. Android
 * reads `elevation` only; iOS reads the rest. card = contact, lift =
 * resting sheets/stacks, pop = modal + premium CTA.
 */
export const shadows = {
  card: {
    shadowColor: '#3A2E24',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  lift: {
    shadowColor: '#3A2E24',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
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
  fonts,
  typeScale,
  radii,
  shadows,
  /** v1 ships light-mode only. Dark mode = v2 (see CONTRACT-uiux.md). */
  mode: 'light' as const,
} as const;

export type Tokens = typeof tokens;
