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
 * FONT STACK (bundled via expo-font, gated in app/_layout.tsx):
 *   Playfair Display 700 (+700 Italic) is the display/editorial voice —
 *   glossed serif for hero headlines, why-lines, and verdicts. Poppins
 *   (400/500/600/700) stays the UI body family. Never introduce a third
 *   family; if a screen needs emphasis, reach for the italic serif.
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
  /**
   * GLOSSED ATELIER polish pass (on top of the founder's soft-purple
   * directive): the lavender family stays, but every value gains conviction.
   * Paper goes porcelain near-white so photography carries the screens;
   * ink deepens toward plum-black; the violet workhorse saturates so CTAs
   * stop reading washed-out. Names kept (append-only contract) — terracotta
   * carries the violet workhorse, oxblood the deep-plum voice.
   */
  paper: '#141114',
  paperDeep: '#1B161B',
  card: '#1F1A1F',
  well: '#241E24',
  ink: '#F3ECE4',
  inkSoft: '#C9BDC2',
  muted: '#93878F',
  line: '#2C252C',
  lineOnCard: '#332B33',

  /** Brand workhorse — glossed violet (CTAs, active states, selection rings) */
  terracotta: '#A63A4B',
  terracottaDeep: '#7E2438',
  terracottaWash: '#3A1620',

  /** Editorial lead — deep plum for kickers, DNA/share moments, value seals */
  oxblood: '#D9A5A0',
  oxbloodWash: '#33151D',

  /** Success / confirm — never decoration */
  sage: '#5FA777',
  sageDeep: '#3F7D57',
  sageWash: '#E1F2E7',

  /** Ratings / "Best value" highlight */
  gold: '#B28A1F',
  goldWash: '#F7EFD9',

  danger: '#D6455D',
  dangerWash: '#FBE1E6',
  warn: '#B28A1F',

  appleBlack: '#0E0B0E',
  applePaper: '#FFFFFF',

  /**
   * Immersive photo surfaces (reel, changing room) + the floating pill tab
   * bar — deep plum-black, never pure black: photos glow against it and the
   * white glass chrome keeps its violet cast.
   */
  stage: '#0E0B0E',
  stageLift: '#1C151B',

  scrim: 'rgba(10, 8, 10, 0.55)',
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
  /** Glossed serif display — Playfair 700, the atelier voice (bundled via expo-font) */
  display: 'PlayfairDisplay_700Bold',
  displayBold: 'PlayfairDisplay_700Bold',
  displayMedium: 'PlayfairDisplay_700Bold',
  /** Italic editorial serif — why-lines, style verdicts, pull quotes */
  editorial: 'PlayfairDisplay_700Bold_Italic',
  /** UI sans — Poppins for everything else; quiet, legible, already loaded */
  sans: 'Poppins_400Regular',
  sansMedium: 'Poppins_500Medium',
  sansSemi: 'Poppins_600SemiBold',
} as const;

export type FontName = keyof typeof fonts;

/**
 * Type scale — line heights are paired, always set both.
 * Display/editorial use the serif for magazine moments (hero outfit, DNA
 * card, why-lines). UI body stays on the system sans for legibility.
 * Sentence case everywhere; kickers never uppercase.
 */
export const typeScale = {
  /** Glossed serif headline — the atelier voice, tight tracking, air above */
  display: { fontSize: 34, lineHeight: 41, fontFamily: 'PlayfairDisplay_700Bold', fontWeight: '700', letterSpacing: -0.2 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  /** Serif italic pull-line — why-lines, style verdicts, empty-state invitations */
  editorial: { fontSize: 19, lineHeight: 28, fontFamily: 'PlayfairDisplay_700Bold_Italic', fontWeight: '700' },
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
 * Shadows — plum-dyed depth, never grey blur. Android reads `elevation`
 * only; iOS reads the rest. card = contact, lift = resting sheets/stacks,
 * pop = modal + premium CTA.
 */
export const shadows = {
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  lift: {
    shadowColor: '#000000',
    shadowOpacity: 0.13,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 9 },
    elevation: 4,
  },
  pop: {
    shadowColor: '#000000',
    shadowOpacity: 0.22,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 13 },
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
