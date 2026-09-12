import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { getSupabase } from '@/lib/supabase';
import { useSession, type AgeBand } from '@/store/session';

interface PendingGate {
  birthYear: number;
  ageBand: AgeBand;
  parentalConsent: boolean;
}

function readPendingGate(): PendingGate | null {
  try {
    const raw = localStorage.getItem('vai-pending-gate');
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<PendingGate>;
    if (typeof g.birthYear !== 'number' || (g.ageBand !== 'adult' && g.ageBand !== 'p13_17')) {
      return null;
    }
    return { birthYear: g.birthYear, ageBand: g.ageBand, parentalConsent: g.ageBand === 'p13_17' };
  } catch {
    return null;
  }
}

/**
 * Web OAuth return target (`/auth/callback`, registered as the Supabase
 * redirect URL). The client auto-exchanges the `code` in the URL
 * (detectSessionInUrl on web); this screen applies the pre-redirect age gate
 * and resumes the funnel. Native never lands here (vai:// deep link path).
 */
export default function AuthCallback() {
  const router = useRouter();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await getSupabase().auth.getSession();
        const u = data.session?.user;
        if (!u) {
          setError('Sign-in did not complete. Try again.');
          return;
        }
        useSession.getState().setAuth({ userId: u.id, email: u.email ?? null });
        const gate = readPendingGate();
        try {
          localStorage.removeItem('vai-pending-gate');
        } catch {
          // Non-fatal.
        }
        if (!gate) {
          // Session is fine but the age gate did not survive the redirect —
          // one quick stop at auth to complete it, then the funnel resumes.
          useSession.getState().setOnboardingStep('auth');
          router.replace('/onboarding/auth');
          return;
        }
        useSession.getState().setAgeGate({
          birthYear: gate.birthYear,
          ageBand: gate.ageBand,
          parentalConsent: gate.parentalConsent,
          parentalConsentAt:
            gate.ageBand === 'p13_17' && gate.parentalConsent ? new Date().toISOString() : null,
        });
        const cur = useSession.getState().onboardingStep;
        const resume =
          cur === 'quiz' || cur === 'selfie' || cur === 'closet' || cur === 'firstOutfit' || cur === 'paywall'
            ? cur
            : cur === 'done'
              ? 'done'
              : 'quiz';
        useSession.getState().setOnboardingStep(resume);
        router.replace(
          resume === 'done'
            ? '/(tabs)'
            : resume === 'selfie'
              ? '/onboarding/selfie-capture'
              : resume === 'closet'
                ? '/onboarding/closet-min3'
                : resume === 'firstOutfit'
                  ? '/onboarding/first-outfit'
                  : resume === 'paywall'
                    ? '/onboarding/paywall'
                    : '/onboarding/quiz',
        );
      } catch {
        setError('Sign-in did not complete. Try again.');
      }
    })();
  }, [router]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="auth-callback">
      {error ? (
        <>
          <Text style={[styles.title, { color: colors.text }]}>{error}</Text>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => router.replace('/onboarding/auth')}
            testID="auth-callback-back"
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Back to sign-in</Text>
          </Pressable>
        </>
      ) : (
        <ActivityIndicator size="large" testID="auth-callback-loading" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  button: { borderRadius: 14, paddingVertical: 16, paddingHorizontal: 32, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
