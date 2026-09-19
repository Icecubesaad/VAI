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
        // GLOSSED ATELIER — mirrors theme/tokens.ts (violet family, deepened).
        paper: '#FAF9FE',
        paperDeep: '#F1EDFB',
        card: '#FFFFFF',
        well: '#F0EBFA',
        ink: '#211C33',
        inkSoft: '#565170',
        muted: '#8B84A6',
        line: '#E6E0F5',
        lineOnCard: '#EFEAF9',
        terracotta: '#7C5CE8',
        terracottaDeep: '#6645D9',
        terracottaWash: '#EDE7FE',
        oxblood: '#4A2C92',
        oxbloodWash: '#ECE5FB',
        sage: '#5FA777',
        sageDeep: '#3F7D57',
        sageWash: '#E1F2E7',
        gold: '#B28A1F',
        goldWash: '#F7EFD9',
        danger: '#D6455D',
        dangerWash: '#FBE1E6',
        warn: '#B28A1F',
        appleBlack: '#16101F',
        applePaper: '#FFFFFF',
        stage: '#120C22',
        stageLift: '#1F1738',
        scrim: 'rgba(33, 28, 51, 0.45)',
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
        card: '0 5px 14px rgba(68, 48, 126, 0.09)',
        lift: '0 9px 18px rgba(68, 48, 126, 0.13)',
        pop: '0 13px 26px rgba(58, 38, 104, 0.22)',
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
