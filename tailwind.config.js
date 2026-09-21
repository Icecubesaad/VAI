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
        // BACKSTAGE EDITORIAL — mirrors theme/tokens.ts (noir ground, claret
        // accent, cream type; commerce surfaces go cream).
        paper: '#141114',
        paperDeep: '#1B161B',
        card: '#1F1A1F',
        well: '#241E24',
        ink: '#F3ECE4',
        inkSoft: '#C9BDC2',
        muted: '#93878F',
        line: '#2C252C',
        lineOnCard: '#332B33',
        terracotta: '#A63A4B',
        terracottaDeep: '#7E2438',
        terracottaWash: '#3A1620',
        oxblood: '#D9A5A0',
        oxbloodWash: '#33151D',
        sage: '#5FA777',
        sageDeep: '#3F7D57',
        sageWash: '#E1F2E7',
        gold: '#B28A1F',
        goldWash: '#F7EFD9',
        danger: '#D6455D',
        dangerWash: '#FBE1E6',
        warn: '#B28A1F',
        appleBlack: '#0E0B0E',
        applePaper: '#FFFFFF',
        stage: '#0E0B0E',
        stageLift: '#1C151B',
        scrim: 'rgba(10, 8, 10, 0.55)',
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
