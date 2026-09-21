/**
 * Tailwind config for NativeWind v4 (Tailwind v3).
 *
 * VALUES ARE A MIRROR of theme/tokens.ts (Node cannot require .ts here).
 * If you change a hex in tokens.ts, update it here too — CONTRACT-uiux.md
 * lists both. `nativewind/preset` is required (official setup).
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  // Class-based dark mode: v1 is light-only, and NativeWind's manual color
  // scheme API throws under the default 'media' strategy once global.css
  // loads ("Cannot manually set color scheme...").
  darkMode: 'class',
  // NOTE: update globs if you add new className-containing dirs.
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './theme/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // PLUM ATELIER — mirrors theme/tokens.ts (plum/blush family, from the
        // founder's FAVORITES reference: deep plum, cream-blush, dusty rose).
        paper: '#F4EFF2',
        paperDeep: '#ECE2E8',
        card: '#FFFFFF',
        well: '#F0E7EC',
        ink: '#1D141C',
        inkSoft: '#58474C',
        muted: '#9A8B92',
        line: '#E7DDE2',
        lineOnCard: '#F1E9ED',
        terracotta: '#3A2331',
        terracottaDeep: '#241820',
        terracottaWash: '#F3E5EC',
        oxblood: '#6B2E44',
        oxbloodWash: '#F5E3EA',
        sage: '#5FA777',
        sageDeep: '#3F7D57',
        sageWash: '#E1F2E7',
        gold: '#B28A1F',
        goldWash: '#F7EFD9',
        danger: '#D6455D',
        dangerWash: '#FBE1E6',
        warn: '#B28A1F',
        appleBlack: '#171014',
        applePaper: '#FFFFFF',
        stage: '#140D12',
        stageLift: '#26181F',
        scrim: 'rgba(29, 20, 28, 0.45)',
      },
      spacing: {
        '2xs': '2px',
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        gutter: '20px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '48px',
        '4xl': '64px',
      },
      borderRadius: {
        sm: '8px',
        media: '10px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 5px 14px rgba(58, 32, 48, 0.09)',
        lift: '0 9px 18px rgba(58, 32, 48, 0.13)',
        pop: '0 13px 26px rgba(46, 24, 34, 0.22)',
      },
      fontFamily: {
        display: ['PlayfairDisplay_700Bold', 'Georgia', 'serif'],
        editorial: ['PlayfairDisplay_700Bold_Italic', 'Georgia', 'serif'],
        sans: ['Poppins_400Regular', 'System'],
      },
    },
  },
  plugins: [],
};
