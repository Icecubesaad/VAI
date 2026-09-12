import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

type BoundaryProps = {
  children: React.ReactNode;
};

type BoundaryState = {
  error: Error | null;
};

/**
 * Root error boundary — catches render crashes anywhere in the tree
 * (including ThemeProvider / QueryClientProvider / Stack) and swaps to a
 * retryable screen instead of the release-build blank screen after splash.
 * Plain StyleSheet UI only: the fallback cannot depend on theme or any
 * provider that may itself be the crash source.
 */
export class RootErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // The crash may have fired before boot hid the splash — never trap the
    // user behind it. Every error path in the startup sequence hides splash.
    SplashScreen.hideAsync().catch(() => undefined);
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[root-boundary]', error);
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <RootCrashScreen
          title="Something went wrong"
          message="VAI hit a problem while starting. Try again — if this keeps happening, reinstall the app or contact support."
          onRetry={this.handleRetry}
          retrying={false}
          testID="root-error"
        />
      );
    }
    return this.props.children;
  }
}

export type BootErrorScreenProps = {
  title?: string;
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
  testID?: string;
};

/**
 * Startup-failure screen (backend-misconfigured gate in app/_layout.tsx).
 * Same constraint as the boundary fallback: zero provider dependencies.
 */
export function BackendMisconfiguredScreen({
  title = "Can't reach VAI servers",
  message = 'VAI couldn\u2019t connect because this build is missing its server configuration. Check your connection and try again — if this keeps happening, reinstall the app or contact support.',
  onRetry,
  retrying = false,
  testID = 'root-backend-error',
}: BootErrorScreenProps): React.JSX.Element {
  return (
    <RootCrashScreen
      title={title}
      message={message}
      onRetry={onRetry}
      retrying={retrying}
      testID={testID}
    />
  );
}

function RootCrashScreen({
  title,
  message,
  onRetry,
  retrying,
  testID,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  retrying: boolean;
  testID: string;
}): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${message}`}
      style={styles.screen}
    >
      <View style={styles.mark} aria-hidden>
        <Text style={styles.markText}>!</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{message}</Text>
      <Pressable
        testID={`${testID}-retry`}
        accessibilityRole="button"
        accessibilityLabel={retrying ? 'Retrying' : 'Try again'}
        disabled={retrying}
        onPress={onRetry}
        style={[styles.retry, retrying ? styles.retryDisabled : null]}
      >
        <Text style={styles.retryText}>{retrying ? 'Retrying\u2026' : 'Try again'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAF8F5',
    paddingHorizontal: 32,
    gap: 12,
  },
  mark: {
    height: 56,
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    backgroundColor: '#F7E8E4',
    marginBottom: 4,
  },
  markText: { fontSize: 24, color: '#B3402A', fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600', color: '#1A1A1A', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, color: '#57504A', textAlign: 'center' },
  retry: {
    marginTop: 8,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#C65D3B',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  retryDisabled: { opacity: 0.6 },
  retryText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
