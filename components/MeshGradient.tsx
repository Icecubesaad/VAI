import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

/**
 * MeshGradient — the dreamy multi-color wash from the founder's reference:
 * a lavender ground (white on the onboarding hero) with big soft mint /
 * lemon / blush / violet glows
 * bleeding into each other. Rendered as SVG radial-gradient circles, so the
 * glows have NO rectangular seams (linear-gradient rectangles showed hard
 * diagonal edges once the purple ground stopped washing them out).
 * Every page gets a VARIANT so pages feel distinct while staying one family.
 * Absolute-fill; render as the first child of the screen root.
 */

type Glow = {
  /** rgb triple, e.g. '198,232,209' */
  rgb: string;
  opacity: number;
  /** Center + radius in viewport fractions. */
  cx: number;
  cy: number;
  r: number;
};

type Palette = {
  base: string;
  glows: Glow[];
  /** Content-zone fade — glossy purple keeps the ground colored (reference). */
  fade: [string, string, string];
};

// Hue family follows the PLUM ATELIER tokens (theme/tokens.ts): dusty rose,
// blush, mauve, champagne — every glow position/opacity stays untouched.
const MINT = '233,203,213';
const LEMON = '242,228,210';
const BLUSH = '240,197,221';
const LILAC = '231,209,224';
const PERIWINKLE = '196,156,176';
const SKY = '228,214,222';
const WHITE = '255,255,255';

const PALETTES: Record<string, Palette> = {
  // Onboarding entry — one continuous blurry wash, dusty rose into mauve
  // with a breath of blush. No shape should ever read as a shape.
  carousel: {
    base: '#D9B3C6',
    fade: ['rgba(233,205,220,0)', 'rgba(233,211,222,0.28)', 'rgba(240,228,234,0.5)'],
    glows: [
      { rgb: BLUSH, opacity: 0.7, cx: 0.12, cy: 0.1, r: 0.6 },
      { rgb: PERIWINKLE, opacity: 0.55, cx: 0.92, cy: 0.42, r: 0.65 },
      { rgb: LILAC, opacity: 0.8, cx: 0.3, cy: 0.62, r: 0.62 },
      { rgb: MINT, opacity: 0.5, cx: 0.85, cy: 0.98, r: 0.52 },
      { rgb: WHITE, opacity: 0.35, cx: 0.5, cy: 0.25, r: 0.42 },
    ],
  },
  // Onboarding hero — the phone reference: a white ground with selective
  // gloomy pastel glows (mint top-left, honey mid-left, rose right edge,
  // lilac + sky breathing along the bottom). Ink and photo cards sit on white.
  onboardingHero: {
    base: '#FFFFFF',
    fade: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.55)'],
    glows: [
      { rgb: '235,199,211', opacity: 0.75, cx: 0.04, cy: 0.07, r: 0.62 },
      { rgb: '240,215,180', opacity: 0.6, cx: 0.0, cy: 0.44, r: 0.55 },
      { rgb: '238,168,205', opacity: 0.7, cx: 0.99, cy: 0.36, r: 0.62 },
      { rgb: '226,196,216', opacity: 0.6, cx: 0.18, cy: 0.96, r: 0.6 },
      { rgb: '222,204,214', opacity: 0.55, cx: 0.92, cy: 0.92, r: 0.55 },
    ],
  },
  // Auth — the phone reference's selective-gradient language: a white
  // ground with dusty-rose and lilac breathing at the top corners, the form
  // card floating on white. (Was a full purple wash; the founder flagged
  // every screen reading as the same purple.)
  auth: {
    base: '#FFFFFF',
    fade: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.55)'],
    glows: [
      { rgb: BLUSH, opacity: 0.7, cx: 0.06, cy: 0.05, r: 0.6 },
      { rgb: LILAC, opacity: 0.6, cx: 0.96, cy: 0.08, r: 0.58 },
      { rgb: '240,215,180', opacity: 0.4, cx: 0.0, cy: 0.5, r: 0.5 },
      { rgb: SKY, opacity: 0.45, cx: 0.9, cy: 0.95, r: 0.55 },
    ],
  },
  // Quiz — the phone reference's selective-gradient language: white ground,
  // mint breathing top-left, blush at the right edge, lilac along the bottom
  // so chips and the rail stay readable. (Was a full purple wash.)
  quiz: {
    base: '#FFFFFF',
    fade: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.55)'],
    glows: [
      { rgb: MINT, opacity: 0.65, cx: 0.06, cy: 0.04, r: 0.58 },
      { rgb: BLUSH, opacity: 0.55, cx: 0.98, cy: 0.55, r: 0.58 },
      { rgb: LILAC, opacity: 0.55, cx: 0.3, cy: 0.97, r: 0.58 },
    ],
  },
  // Today — porcelain ground with a whisper of champagne/rose/mauve aura. Light
  // tab screens all share the paper base so the app reads as ONE calm canvas;
  // the AI photos carry the color now, not the background.
  home: {
    base: '#F4EFF2',
    fade: ['rgba(244,239,242,0)', 'rgba(244,239,242,0.3)', 'rgba(244,239,242,0.55)'],
    glows: [
      { rgb: LEMON, opacity: 0.22, cx: 0.92, cy: 0.05, r: 0.55 },
      { rgb: MINT, opacity: 0.18, cx: 0.06, cy: 0.95, r: 0.55 },
      { rgb: LILAC, opacity: 0.26, cx: 0.4, cy: 0.45, r: 0.5 },
    ],
  },
  // Closet — same porcelain canvas, mint breathing at the edges.
  closet: {
    base: '#F4EFF2',
    fade: ['rgba(244,239,242,0)', 'rgba(244,239,242,0.3)', 'rgba(244,239,242,0.55)'],
    glows: [
      { rgb: MINT, opacity: 0.2, cx: 0.06, cy: 0.08, r: 0.55 },
      { rgb: LILAC, opacity: 0.24, cx: 0.95, cy: 0.95, r: 0.55 },
    ],
  },
  // Shop — porcelain with a blush-forward warmth at the top corner.
  shop: {
    base: '#F4EFF2',
    fade: ['rgba(244,239,242,0)', 'rgba(244,239,242,0.3)', 'rgba(244,239,242,0.55)'],
    glows: [
      { rgb: BLUSH, opacity: 0.24, cx: 0.92, cy: 0.05, r: 0.55 },
      { rgb: SKY, opacity: 0.18, cx: 0.05, cy: 0.95, r: 0.52 },
      { rgb: LEMON, opacity: 0.14, cx: 0.45, cy: 0.5, r: 0.45 },
    ],
  },
  // Profile — porcelain with a peach/periwinkle dusk breath.
  profile: {
    base: '#F4EFF2',
    fade: ['rgba(244,239,242,0)', 'rgba(244,239,242,0.3)', 'rgba(244,239,242,0.55)'],
    glows: [
      { rgb: '236,196,186', opacity: 0.22, cx: 0.08, cy: 0.06, r: 0.52 },
      { rgb: PERIWINKLE, opacity: 0.18, cx: 0.95, cy: 0.95, r: 0.55 },
    ],
  },
  // Quiet panels (selfie / closet-min3 web) — the reference's white ground
  // with selective pastel breath at the corners (mint top-left, rose right,
  // lilac along the bottom). Same family as the carousel hero.
  quiet: {
    base: '#FFFFFF',
    fade: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.55)'],
    glows: [
      { rgb: MINT, opacity: 0.6, cx: 0.05, cy: 0.06, r: 0.58 },
      { rgb: BLUSH, opacity: 0.55, cx: 0.98, cy: 0.42, r: 0.58 },
      { rgb: LILAC, opacity: 0.55, cx: 0.25, cy: 0.97, r: 0.6 },
      { rgb: SKY, opacity: 0.4, cx: 0.92, cy: 0.94, r: 0.5 },
    ],
  },
};

export type MeshGradientVariant = keyof typeof PALETTES;

export const MeshGradient = memo(function MeshGradient({
  variant = 'carousel',
}: {
  variant?: MeshGradientVariant;
}): React.JSX.Element {
  const palette = PALETTES[variant] ?? PALETTES.carousel!;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
      aria-hidden
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.base }]} />
      {/* radial glows — extra-long falloff so no edge ever reads as a ring.
          width/height props are required: react-native-svg defaults to a
          300×150 viewport on web, which clipped the wash into a stripe. */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          {palette.glows.map((g, i) => (
            <RadialGradient key={i} id={`mesh-glow-${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={`rgb(${g.rgb})`} stopOpacity={g.opacity} />
              <Stop offset="0.45" stopColor={`rgb(${g.rgb})`} stopOpacity={g.opacity * 0.6} />
              <Stop offset="0.78" stopColor={`rgb(${g.rgb})`} stopOpacity={g.opacity * 0.16} />
              <Stop offset="1" stopColor={`rgb(${g.rgb})`} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {palette.glows.map((g, i) => (
          <Circle
            key={i}
            cx={`${g.cx * 100}%`}
            cy={`${g.cy * 100}%`}
            r={`${g.r * 100}%`}
            fill={`url(#mesh-glow-${i})`}
          />
        ))}
      </Svg>
      {/* the reference fade — full-width vertical wash (no seams: its edges
          are the screen edges), keeping the purple ground visible */}
      <LinearGradient
        colors={palette.fade}
        locations={[0, 0.42, 0.78]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});
