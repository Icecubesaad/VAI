import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { useTheme } from '@/theme';
import { Button } from '@/components/Button';
import { supabase } from '@/lib/supabase';
import { apiErrorCopy } from '@/lib/api';
import { ageBandForBirthYear, currentYear, useSession, type AgeBand } from '@/store/session';

const PRIVACY_URL = 'https://vai.style/privacy';
const U13_COPY =
  'VAI is for ages 13 and up (17+ in the App Store). Ask a parent or guardian — we cannot create your account yet.';
const CONSENT_COPY =
  'Ages 13–17 need a parent or guardian to consent. Please check the box with them before continuing.';

// Completes any pending web-auth session when the app is foregrounded
// from the OAuth redirect (required for `openAuthSessionAsync` on iOS).
WebBrowser.maybeCompleteAuthSession();

/**
 * Auth: Apple / Google / email via Supabase Auth.
 * Apple uses the native credential → signInWithIdToken; Google uses the
 * Supabase OAuth code-exchange; email uses password sign-in/up.
 */
export default function AuthScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const setAuth = useSession((s) => s.setAuth);
  const setStep = useSession((s) => s.setOnboardingStep);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('up');
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P0 age gate (docs/SECURITY.md §6 P0-006): DOB collected BEFORE auth.
  const [birthYearInput, setBirthYearInput] = useState('');
  const [parentalChecked, setParentalChecked] = useState(false);
  const [ageError, setAgeError] = useState<string | null>(null);

  /**
   * Validate the DOB gate before any auth attempt. Returns the gate payload
   * or null (error already surfaced). Under-13 is refused with kind copy;
   * 13–17 requires the parental-consent checkbox.
   */
  const readAgeGate = useCallback((): {
    birthYear: number;
    ageBand: AgeBand;
    parentalConsent: boolean;
  } | null => {
    const birthYear = Number.parseInt(birthYearInput.trim(), 10);
    const nowYear = currentYear();
    if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > nowYear) {
      setAgeError(`Enter your 4-digit birth year (1900–${nowYear}).`);
      return null;
    }
    const ageBand = ageBandForBirthYear(birthYear);
    if (ageBand === 'u13') {
      setAgeError(U13_COPY);
      return null;
    }
    if (ageBand === 'p13_17' && !parentalChecked) {
      setAgeError(CONSENT_COPY);
      return null;
    }
    setAgeError(null);
    return { birthYear, ageBand, parentalConsent: ageBand === 'p13_17' };
  }, [birthYearInput, parentalChecked]);

  const finish = useCallback(
    async (
      userId: string,
      userEmail: string | null,
      gate: { birthYear: number; ageBand: AgeBand; parentalConsent: boolean },
    ) => {
      setAuth({ userId, email: userEmail });
      const parentalConsentAt =
        gate.ageBand === 'p13_17' && gate.parentalConsent ? new Date().toISOString() : null;
      useSession.getState().setAgeGate({
        birthYear: gate.birthYear,
        ageBand: gate.ageBand,
        parentalConsent: gate.parentalConsent,
        parentalConsentAt,
      });
      // Server-side stamp (best-effort): auth user_metadata is server-owned.
      // The Edge worker copies it into users.birth_year/age_band/
      // parental_consent_at (migration 0002 SEC-006, excluded from the client
      // column grant so users cannot self-certify via the Data API).
      try {
        await supabase.auth.updateUser({
          data: {
            birth_year: gate.birthYear,
            age_band: gate.ageBand,
            parental_consent_at: parentalConsentAt,
          },
        });
      } catch {
        // Non-fatal: the local gate above already enforces the block.
      }
      // Progress continuity: a returning user re-signing-in keeps their
      // furthest funnel step (persisted in MMKV) instead of restarting quiz.
      const cur = useSession.getState().onboardingStep;
      const resume =
        cur === 'quiz' || cur === 'selfie' || cur === 'closet' || cur === 'firstOutfit' || cur === 'paywall'
          ? cur
          : cur === 'done'
            ? 'done'
            : 'quiz';
      setStep(resume);
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
    },
    [router, setAuth, setStep],
  );

  // Kind auth-error copy: map the common Supabase failures onto actionable
  // lines instead of raw server text.
  const fail = useCallback((e: unknown) => {
    if (e instanceof Error && e.message === 'canceled') return; // user dismissed native sheet
    const raw = e instanceof Error ? e.message : '';
    if (/invalid login credentials|invalid_login/i.test(raw)) {
      setError('Wrong email or password. Check both and try again — or create an account below.');
    } else if (/user already registered|already.*exists|email.*taken/i.test(raw)) {
      setError('An account with this email already exists. Tap “Already have an account? Sign in”.');
    } else if (/email not confirmed|confirm.*email|verification/i.test(raw)) {
      setError('Check your inbox to confirm your email, then sign in.');
    } else {
      setError(apiErrorCopy(e).message);
    }
    setBusy(null);
  }, []);

  const handleApple = useCallback(async () => {
    if (Platform.OS !== 'ios') {
      setError('Apple sign-in is available on iOS only — use Google or email.');
      return;
    }
    const gate = readAgeGate();
    if (!gate) return;
    setError(null);
    setBusy('apple');
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        ],
      });
      if (!cred.identityToken) throw new Error('Apple did not return a credential.');
      const { data, error: err } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: cred.identityToken,
      });
      if (err) throw err;
      const u = data.user;
      if (!u) throw new Error('Sign-in did not return a user.');
      await finish(u.id, u.email ?? null, gate);
    } catch (e) {
      fail(e);
    }
  }, [fail, finish, readAgeGate]);

  const handleGoogle = useCallback(async () => {
    const gate = readAgeGate();
    if (!gate) return;
    setError(null);
    setBusy('google');
    try {
      // Supabase JS v2 `signInWithOAuth` returns { data: { provider, url }, error }
      // — no session. Open the provider URL in a system browser session; the
      // PKCE code comes back on our deep link and the session is established
      // via `exchangeCodeForSession`, which also fires `onAuthStateChange`
      // (root layout) as the cross-screen fallback.
      const redirectTo = makeRedirectUri({ scheme: 'vai', path: 'auth/callback' });
      const { data, error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (err) throw err;
      if (!data.url) throw new Error('Could not start Google sign-in.');
      const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (res.type !== 'success') {
        // User dismissed the browser without completing — stay, no error copy.
        setBusy(null);
        return;
      }
      const codeMatch = /[?&]code=([^&]+)/.exec(res.url);
      const code = codeMatch?.[1] ? decodeURIComponent(codeMatch[1]) : null;
      if (!code) {
        setBusy(null);
        setError('Complete Google sign-in in the browser, then return here.');
        return;
      }
      const { data: exchanged, error: exchErr } =
        await supabase.auth.exchangeCodeForSession(code);
      if (exchErr) throw exchErr;
      const u = exchanged.session?.user ?? exchanged.user;
      if (!u) throw new Error('Sign-in did not return a user.');
      await finish(u.id, u.email ?? null, gate);
    } catch (e) {
      fail(e);
    }
  }, [fail, finish, readAgeGate]);

  const handleEmail = useCallback(async () => {
    const gate = readAgeGate();
    if (!gate) return;
    setError(null);
    const clean = email.trim().toLowerCase();
    if (!clean.includes('@') || password.length < 8) {
      setError('Enter a valid email and a password of 8+ characters.');
      return;
    }
    setBusy('email');
    try {
      const { data, error: err } =
        mode === 'up'
          ? await supabase.auth.signUp({ email: clean, password })
          : await supabase.auth.signInWithPassword({ email: clean, password });
      if (err) throw err;
      const u = data.user ?? (await supabase.auth.getUser()).data.user;
      if (!u) throw new Error('Check your email to confirm, then sign in.');
      await finish(u.id, u.email ?? clean, gate);
    } catch (e) {
      fail(e);
    }
  }, [email, password, mode, fail, finish]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="auth-screen">
      <Text style={[styles.title, { color: colors.text }]}>Your closet, your stylist</Text>
      <Text style={[styles.sub, { color: colors.muted }]}>
        Sign in to save your style DNA, closet and try-ons across devices.
      </Text>

      {/* P0 age gate (docs/SECURITY.md §6 P0-006): DOB BEFORE auth. Under-13 is
          refused; 13–17 requires the parental-consent checkbox. */}
      <Text style={[styles.ageLabel, { color: colors.muted }]}>Birth year</Text>
      <TextInput
        value={birthYearInput}
        onChangeText={(t) => {
          setBirthYearInput(t);
          setAgeError(null);
        }}
        placeholder="YYYY (e.g. 1999)"
        keyboardType="number-pad"
        maxLength={4}
        style={[styles.input, { borderColor: colors.border, color: colors.text }]}
        testID="auth-birth-year"
      />
      <Pressable
        onPress={() => {
          setParentalChecked((v) => !v);
          setAgeError(null);
        }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: parentalChecked }}
        accessibilityLabel="My parent or guardian consents to my VAI account"
        style={styles.checkRow}
        testID="auth-parental-consent"
      >
        <View
          style={[
            styles.checkBox,
            { borderColor: colors.border },
            parentalChecked && { backgroundColor: colors.primary, borderColor: colors.primary },
          ]}
        >
          {parentalChecked && (
            <Text style={[styles.checkMark, { color: colors.onPrimary }]}>✓</Text>
          )}
        </View>
        <Text style={[styles.checkText, { color: colors.muted }]}>
          My parent or guardian consents to my VAI account (required ages 13–17).
        </Text>
      </Pressable>
      {!!ageError && (
        <Text style={[styles.ageError, { color: colors.danger }]} testID="auth-age-error">
          {ageError}
        </Text>
      )}

      {Platform.OS === 'ios' && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={12}
          style={styles.apple}
          onPress={() => void handleApple()}
        />
      )}
      <Pressable
        style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
        onPress={() => void handleGoogle()}
        disabled={busy !== null}
        testID="auth-google"
      >
        {busy === 'google' ? (
          <ActivityIndicator />
        ) : (
          <Text style={[styles.buttonText, { color: colors.text }]}>Continue with Google</Text>
        )}
      </Pressable>

      <View style={styles.divider}>
        <Text style={[styles.dividerText, { color: colors.muted }]}>or with email</Text>
      </View>

      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        style={[styles.input, { borderColor: colors.border, color: colors.text }]}
        testID="auth-email"
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password (8+ characters)"
        secureTextEntry
        style={[styles.input, { borderColor: colors.border, color: colors.text }]}
        testID="auth-password"
      />
      <Pressable
        style={[styles.button, { backgroundColor: colors.primary }]}
        onPress={() => void handleEmail()}
        disabled={busy !== null}
        testID="auth-email-go"
      >
        {busy === 'email' ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
            {mode === 'up' ? 'Create account' : 'Sign in'}
          </Text>
        )}
      </Pressable>
      <Pressable onPress={() => setMode(mode === 'up' ? 'in' : 'up')} testID="auth-toggle">
        <Text style={[styles.toggle, { color: colors.muted }]}>
          {mode === 'up' ? 'Already have an account? Sign in' : 'New here? Create account'}
        </Text>
      </Pressable>
      <Pressable onPress={() => void Linking.openURL(PRIVACY_URL)} testID="auth-privacy">
        <Text style={[styles.toggle, { color: colors.muted }]}>Privacy policy</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          setStep('carousel');
          router.replace('/onboarding');
        }}
        testID="auth-back"
      >
        <Text style={[styles.toggle, { color: colors.muted }]}>Back</Text>
      </Pressable>

      {!!error && (
        <Text style={[styles.error, { color: colors.danger }]} testID="auth-error">
          {error}
        </Text>
      )}
      {busy === 'apple' && <ActivityIndicator testID="auth-apple-loading" />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 30, fontWeight: '800', fontFamily: 'Georgia' },
  sub: { fontSize: 15, lineHeight: 22, marginBottom: 12 },
  apple: { width: '100%', height: 52 },
  button: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  divider: { alignItems: 'center', marginVertical: 4 },
  dividerText: { fontSize: 13 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  toggle: { fontSize: 14, textAlign: 'center', marginTop: 4 },
  error: { fontSize: 13, textAlign: 'center', marginTop: 4 },
  ageLabel: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  checkBox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: { fontSize: 14, fontWeight: '800', lineHeight: 18 },
  checkText: { fontSize: 13, flex: 1, lineHeight: 18 },
  ageError: { fontSize: 13, textAlign: 'center', marginTop: 4 },
});
