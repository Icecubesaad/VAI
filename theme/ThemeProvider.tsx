import React, { createContext, useContext, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { tokens, type Tokens } from './tokens';

type ThemeContextValue = {
  tokens: Tokens;
  /** v1 is light-mode only; field exists so v2 dark mode is additive. */
  colorScheme: 'light';
};

const ThemeContext = createContext<ThemeContextValue>({ tokens, colorScheme: 'light' });

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

type ThemeProviderProps = {
  children: React.ReactNode;
};

/**
 * VAI theme provider — light-mode only in v1.
 *
 * Composition order in app/_layout.tsx (after `npx gluestack-ui init`):
 *
 * ```tsx
 * import '../global.css';
 * import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
 * import { ThemeProvider } from '@/theme/ThemeProvider';
 *
 * export default function RootLayout() {
 *   return (
 *     <GluestackUIProvider mode="light">
 *       <ThemeProvider>{/* expo-router Slot / Stack *\/}</ThemeProvider>
 *     </GluestackUIProvider>
 *   );
 * }
 * ```
 *
 * Before the gluestack CLI has run, ThemeProvider works standalone —
 * all VAI components consume `useTheme()` tokens, never gluestack internals,
 * so nothing breaks either way.
 */
export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const value = useMemo<ThemeContextValue>(() => ({ tokens, colorScheme: 'light' }), []);
  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style="dark" />
      {children}
    </ThemeContext.Provider>
  );
}
