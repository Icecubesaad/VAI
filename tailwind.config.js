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
        paper: '#FAF8F5',
        paperDeep: '#F2EDE5',
        card: '#FFFFFF',
        ink: '#1A1A1A',
        inkSoft: '#57504A',
        muted: '#8A8179',
        line: '#E7DED2',
        lineOnCard: '#EFE8DC',
        terracotta: '#C65D3B',
        terracottaDeep: '#A34A2C',
        terracottaWash: '#F8E7DC',
        sage: '#66855F',
        sageDeep: '#49663F',
        sageWash: '#E4EBE0',
        gold: '#A87E2A',
        goldWash: '#F4EAD2',
        danger: '#B3402E',
        dangerWash: '#F7E2DC',
        warn: '#A87E2A',
        appleBlack: '#000000',
        applePaper: '#FFFFFF',
      },
      spacing: {
        '2xs': '2px',
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '48px',
        '4xl': '64px',
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 4px 12px rgba(58, 46, 36, 0.08)',
        pop: '0 12px 24px rgba(58, 46, 36, 0.18)',
      },
      fontFamily: {
        display: ['Georgia', 'serif'],
        sans: ['System'],
      },
    },
  },
  plugins: [],
};
