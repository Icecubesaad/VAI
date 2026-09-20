import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tokenColors } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { PressScale } from '@/components/PressScale';
import { Icon } from '@/components/icons';
import { supabase } from '@/lib/supabase';
import { apiErrorCopy } from '@/lib/api';
import { ageBandForBirthYear, currentYear, useSession, type AgeBand } from '@/store/session';
import { useCloset } from '@/store/closet';
import { useQuiz } from '@/store/quiz';
import { useReel } from '@/store/reel';
import { useQuotas } from '@/store/quotas';
import { api } from '@/lib/api';
import { initAnalytics } from '@/lib/analytics';
import { setSentryUser } from '@/lib/sentry';
import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';

const PRIVACY_URL = 'https://vai.style/privacy';
const APP_NAME = 'VAI Stylist';
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
 *
 * Design (FasUrbane inspo): compact brand row up top, big mixed-case
 * greeting, side-by-side social buttons, OR divider, labeled fields with
 * passwords + reveal, inline remember/forgot row on sign-in, one dark pill
 * CTA, and the mode toggle as footer copy — all inside one white card on a
 * selective pastel ground.
 */
function gatePayload(gate: { birthYear: number; ageBand: AgeBand; parentalConsent: boolean }) {
  return {
    birthYear: gate.birthYear,
    ageBand: gate.ageBand,
    parentalConsent: gate.parentalConsent,
    parentalConsentAt:
      gate.ageBand === 'p13_17' && gate.parentalConsent ? new Date().toISOString() : null,
  };
}

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const setAuth = useSession((s) => s.setAuth);
  const setStep = useSession((s) => s.setOnboardingStep);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [mode, setMode] = useState<'in' | 'up'>('up');
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P0 age gate (docs/SECURITY.md §6 P0-006): DOB collected BEFORE auth.
  const [birthYearInput, setBirthYearInput] = useState('');
  const [parentalChecked, setParentalChecked] = useState(false);
  const [ageError, setAgeError] = useState<string | null>(null);

  /**
   * Validate the DOB gate before any auth attempt. Input is digit-sanitized at
   * entry (autofill/paste can smuggle spaces or separators that silently fail
   * parse), so a rejection here always means a genuinely bad year.
   */
  const readAgeGate = useCallback((): {
    birthYear: number;
    ageBand: AgeBand;
    parentalConsent: boolean;
  } | null => {
    const digits = birthYearInput.replace(/\D/g, '').slice(0, 4);
    const birthYear = digits.length === 4 ? Number.parseInt(digits, 10) : NaN;
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
      gate: { birthYear: number; ageBand: AgeBand; parentalConsent: boolean } | null,
    ) => {
      setAuth({ userId, email: userEmail });
      // Age gate is collected at SIGNUP only — a returning user signing in
      // never re-enters a birth year (their gate already cleared + is
      // server-stamped in user_metadata).
      if (gate) {
        useSession.getState().setAgeGate(gatePayload(gate));
      }
      // Cross-user bleed guard (shared devices): persisted funnel data (closet,
      // quiz DNA, base photo, quota mirror) may belong to whoever used the app
      // last. A DIFFERENT user signing in starts clean — never resumes
      // someone else's funnel step or data.
      const prevOwner = useSession.getState().funnelOwnerId;
      const isDifferentUser = prevOwner !== null && prevOwner !== userId;
      if (isDifferentUser) {
        useCloset.getState().clear();
        useQuiz.getState().reset();
        useReel.getState().reset();
        useQuotas.getState().reset();
        useSession.getState().setBasePhoto(null);
        useSession.getState().setOnboardingStep('quiz');
      }
      useSession.getState().setFunnelOwner(userId);
      setSentryUser(userId);
      void initAnalytics(userId, 'free').catch(() => undefined);
      // ATT prompt (iOS): requested in-context post sign-up, never at cold
      // launch — and required before any future IDFA-based attribution.
      if (Platform.OS === 'ios') {
        void requestTrackingPermissionsAsync().catch(() => undefined);
      }
      const parentalConsentAt = gate
        ? gate.ageBand === 'p13_17' && gate.parentalConsent
          ? new Date().toISOString()
          : null
        : null;

      // Server-side stamp (best-effort): auth user_metadata is server-owned.
      // The Edge worker copies it into users.birth_year/age_band/
      // parental_consent_at (migration 0002 SEC-006, excluded from the client
      // column grant so users cannot self-certify via the Data API).
      try {
        if (gate) {
          await supabase.auth.updateUser({
            data: {
              birth_year: gate.birthYear,
              age_band: gate.ageBand,
              parental_consent_at: parentalConsentAt,
            },
          });
        }
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
      // Register the inviter link NOW (was previously only reachable on the
      // paywall, which can be skipped): the server keeps it `pending` until
      // the 3-items+1-tryon proof and re-checks on every apply — no dead end.
      const { referredBy, referralRedeemed } = useSession.getState();
      if (referredBy && !referralRedeemed) {
        void api.applyReferral({ code: referredBy }).catch(() => undefined);
      }
    },
    [router, setAuth, setStep],
  );

  // Kind auth-error copy: map the common Supabase failures onto actionable
  // lines instead of raw server text.
  const fail = useCallback((e: unknown) => {
    const raw = e instanceof Error ? e.message : '';
    // User dismissed the native sheet. Apple's exact text is "The user
    // canceled the authorization attempt" — match loosely so every cancel
    // spelling is caught, and ALWAYS unblock the buttons.
    if (/cancel/i.test(raw)) {
      setBusy(null);
      return;
    }
    if (/provider is not enabled|unsupported provider/i.test(raw)) {
      setError('Google/Apple sign-in is not set up for this build yet — use email for now.');
      setBusy(null);
      return;
    }
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

  // Live age preview (no errors): shows what the entered year means and
  // whether consent is needed — a rejection is never a mystery.
  const digitsOnly = birthYearInput.replace(/\D/g, '').slice(0, 4);
  const previewYear = digitsOnly.length === 4 ? Number.parseInt(digitsOnly, 10) : null;
  const previewBand: AgeBand | null =
    previewYear !== null &&
    Number.isInteger(previewYear) &&
    previewYear >= 1900 &&
    previewYear <= currentYear()
      ? ageBandForBirthYear(previewYear)
      : null;
  const previewAge = previewYear !== null && previewBand !== null ? currentYear() - previewYear : null;
  // Consent box only matters for 13–17 — hidden for adults and empty input.
  const needsConsent = previewBand === 'p13_17';

  const handleApple = useCallback(async () => {
    if (busy !== null) return; // AppleAuthenticationButton has no disabled prop — guard here
    if (Platform.OS !== 'ios') {
      setError('Apple sign-in is available on iOS only — use Google or email.');
      return;
    }
    const gate = mode === 'up' ? readAgeGate() : null; // age gate = SIGNUP only
    if (mode === 'up' && !gate) return;
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
  }, [busy, fail, finish, readAgeGate, mode]);

  const handleGoogle = useCallback(async () => {
    if (busy !== null) return;
    const gate = mode === 'up' ? readAgeGate() : null;
    if (mode === 'up' && !gate) return;
    setError(null);
    setBusy('google');
    try {
      const redirectTo = makeRedirectUri({ scheme: 'vai', path: 'auth/callback' });
      if (Platform.OS === 'web') {
        // Web has no app to deep-link back to: full-page redirect. The
        // pending gate survives the reload in localStorage; /auth/callback
        // finishes onboarding routing (session auto-exchanges via
        // detectSessionInUrl on web). The redirect target must be allowlisted
        // in the Supabase dashboard (Authentication → URL configuration).
        try {
          localStorage.setItem('vai-pending-gate', JSON.stringify(gate));
        } catch {
          // Non-fatal: user re-enters the year after returning.
        }
        const { error: err } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo },
        });
        if (err) throw err;
        return; // browser is leaving; nothing more to do here.
      }
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
  }, [busy, fail, finish, readAgeGate]);

  const handleEmail = useCallback(async () => {
    if (busy !== null) return;
    const gate = mode === 'up' ? readAgeGate() : null;
    if (mode === 'up' && !gate) return;
    setError(null);
    const clean = email.trim().toLowerCase();
    if (
      !clean.includes('@') ||
      password.length < 8 ||
      (mode === 'up' && (firstName.trim().length === 0 || lastName.trim().length === 0))
    ) {
      setError(
        mode === 'up'
          ? 'Add your name, a valid email, and a password of 8+ characters.'
          : 'Enter a valid email and a password of 8+ characters.',
      );
      return;
    }
    setBusy('email');
    try {
      const { data, error: err } =
        mode === 'up'
          ? await supabase.auth.signUp({
              email: clean,
              password,
              options: {
                data: {
                  first_name: firstName.trim(),
                  last_name: lastName.trim(),
                  display_name: `${firstName.trim()} ${lastName.trim()}`.trim(),
                },
              },
            })
          : await supabase.auth.signInWithPassword({ email: clean, password });
      if (err) throw err;
      // No session = email confirmation still pending. STOP here: routing
      // onward with a user-but-no-session is what used to produce a cascade
      // of 401s ("Please sign in to continue") on every backend call.
      if (!data.session) {
        setBusy(null);
        setError(
          mode === 'up'
            ? 'Account created — check your inbox to confirm your email, then sign in.'
            : 'Check your inbox to confirm your email, then sign in.',
        );
        return;
      }
      const u = data.session.user;
      await finish(u.id, u.email ?? clean, gate);
    } catch (e) {
      fail(e);
    }
  }, [busy, email, password, firstName, lastName, mode, fail, finish, readAgeGate]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'up' ? 'in' : 'up'));
    setError(null);
    setAgeError(null);
  }, []);

  return (
    <View style={styles.root} testID="auth-screen">
      <MeshGradient variant="auth" />
      <PressScale
        style={[styles.backChip, { top: insets.top + 10 }]}
        onPress={() => {
          setStep('carousel');
          router.replace('/onboarding');
        }}
        testID="auth-back"
        accessibilityRole="button"
        accessibilityLabel="Back to the intro"
      >
        <Icon name="chevronLeft" color={tokenColors.ink} size={19} strokeWidth={2.1} />
      </PressScale>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          {/* brand row */}
          <View style={styles.brandRow} aria-hidden>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>V</Text>
            </View>
            <Text style={styles.brandName}>{APP_NAME}</Text>
          </View>

          <Text style={styles.title}>
            {mode === 'up' ? 'Create your account' : 'Welcome back'}
          </Text>
          <Text style={styles.sub}>
            {mode === 'up'
              ? 'Tell us who you are — your stylist takes it from there.'
              : 'Sign in with your account details.'}
          </Text>

          {/* social row — Google + Apple side by side like the inspo */}
          <View style={styles.socialRow}>
            <PressScale
              style={[styles.socialButton, styles.socialHalf]}
              onPress={() => void handleGoogle()}
              disabled={busy !== null}
              testID="auth-google"
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
            >
              {busy === 'google' ? (
                <ActivityIndicator color={tokenColors.ink} />
              ) : (
                <View style={styles.socialInner}>
                  <Text style={styles.googleG}>G</Text>
                  <Text style={styles.socialButtonText}>Google</Text>
                </View>
              )}
            </PressScale>
            {Platform.OS === 'ios' ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={26}
                style={styles.appleHalf}
                onPress={() => void handleApple()}
              />
            ) : (
              <PressScale
                style={[styles.socialButton, styles.socialHalf]}
                onPress={() => void handleApple()}
                disabled={busy !== null}
                testID="auth-apple"
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
              >
                <View style={styles.socialInner}>
                  <Text style={styles.appleGlyph}></Text>
                  <Text style={styles.socialButtonText}>Apple</Text>
                </View>
              </PressScale>
            )}
          </View>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          {mode === 'up' && (
            <View style={styles.nameRow}>
              <View style={styles.nameHalf}>
                <Text style={styles.fieldLabel}>First name</Text>
                <TextInput
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder="Devon"
                  placeholderTextColor={tokenColors.muted}
                  autoCapitalize="words"
                  style={styles.input}
                  testID="auth-first-name"
                />
              </View>
              <View style={styles.nameHalf}>
                <Text style={styles.fieldLabel}>Last name</Text>
                <TextInput
                  value={lastName}
                  onChangeText={setLastName}
                  placeholder="Lane"
                  placeholderTextColor={tokenColors.muted}
                  autoCapitalize="words"
                  style={styles.input}
                  testID="auth-last-name"
                />
              </View>
            </View>
          )}

          <Text style={styles.fieldLabel}>Email address</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Type your email here…"
            placeholderTextColor={tokenColors.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
            testID="auth-email"
          />
          <Text style={styles.fieldLabel}>Password</Text>
          <View style={styles.passwordWrap}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password…"
              placeholderTextColor={tokenColors.muted}
              secureTextEntry={!showPassword}
              style={[styles.input, styles.passwordInput]}
              testID="auth-password"
            />
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={10}
              style={styles.eyeBtn}
              testID="auth-password-toggle"
              accessibilityRole="button"
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            >
              <Text style={styles.eyeGlyph}>{showPassword ? '◉' : '◎'}</Text>
            </Pressable>
          </View>
          {mode === 'up' ? (
            <Text style={styles.helperLine}>Must contain at least 8 characters.</Text>
          ) : (
            <View style={styles.signinRow}>
              <Pressable
                onPress={() => setRememberMe((v) => !v)}
                style={styles.rememberRow}
                testID="auth-remember"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: rememberMe }}
                accessibilityLabel="Remember me"
              >
                <View style={[styles.miniBox, rememberMe && styles.miniBoxOn]}>
                  {rememberMe && <Icon name="check" color="#FFFFFF" size={11} strokeWidth={3} />}
                </View>
                <Text style={styles.rememberText}>Remember me</Text>
              </Pressable>
              <Text style={styles.forgotText}>Forgot password?</Text>
            </View>
          )}

          {/* P0 age gate (docs/SECURITY.md §6 P0-006): DOB at SIGNUP only — a
              returning user signing in never re-enters a birth year. Under-13 is
              refused; 13–17 requires the parental-consent checkbox. */}
          {mode === 'up' && (
            <>
              <Text style={styles.fieldLabel}>Birth year</Text>
              <View style={styles.ageRow}>
                <TextInput
                  value={birthYearInput}
                  onChangeText={(t) => {
                    setBirthYearInput(t.replace(/\D/g, '').slice(0, 4));
                    setAgeError(null);
                  }}
                  placeholder="YYYY"
                  placeholderTextColor={tokenColors.muted}
                  keyboardType="number-pad"
                  maxLength={4}
                  style={[styles.input, styles.ageInput]}
                  testID="auth-birth-year"
                />
                {previewAge !== null && previewBand !== null && (
                  <Text style={styles.agePreview} testID="auth-age-preview" numberOfLines={1}>
                    {previewBand === 'adult' ? `Age ${previewAge} · adult` : `Age ${previewAge} · consent needed`}
                  </Text>
                )}
              </View>
              {needsConsent && (
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
                      parentalChecked && { backgroundColor: tokenColors.terracotta, borderColor: tokenColors.terracotta },
                    ]}
                  >
                    {parentalChecked && (
                      <Icon name="check" color="#FFFFFF" size={13} strokeWidth={3} />
                    )}
                  </View>
                  <Text style={styles.checkText}>
                    A parent or guardian consents (required ages 13–17).
                  </Text>
                </Pressable>
              )}
              {!!ageError && (
                <Text style={styles.ageError} testID="auth-age-error">
                  {ageError}
                </Text>
              )}
            </>
          )}

          <PressScale
            style={styles.primaryButton}
            onPress={() => void handleEmail()}
            disabled={busy !== null}
            testID="auth-email-go"
            accessibilityRole="button"
            accessibilityLabel={mode === 'up' ? 'Create account' : 'Sign in'}
          >
            {busy === 'email' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {mode === 'up' ? 'Sign up' : 'Sign in'}
              </Text>
            )}
          </PressScale>

          {!!error && (
            <Text style={styles.error} testID="auth-error">
              {error}
            </Text>
          )}
          {busy === 'apple' && <ActivityIndicator testID="auth-apple-loading" />}
        </View>

        <Pressable onPress={toggleMode} testID="auth-toggle">
          <Text style={styles.toggle}>
            {mode === 'up' ? (
              <>
                Already have an account? <Text style={styles.toggleLink}>Sign in</Text>
              </>
            ) : (
              <>
                Don&apos;t have an account? <Text style={styles.toggleLink}>Sign up</Text>
              </>
            )}
          </Text>
        </Pressable>
        <Pressable onPress={() => void Linking.openURL(PRIVACY_URL)} testID="auth-privacy">
          <Text style={[styles.toggle, styles.privacy]}>Privacy policy</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { padding: 20, flexGrow: 1, justifyContent: 'center' },
  backChip: {
    position: 'absolute',
    left: 16,
    zIndex: 10,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3D2E75',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 32,
    borderWidth: 1,
    borderColor: tokenColors.line,
    padding: 24,
    gap: 12,
    shadowColor: '#3D2E75',
    shadowOpacity: 0.22,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: tokenColors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', fontFamily: 'Poppins_700Bold' },
  brandName: { color: tokenColors.ink, fontSize: 15, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  title: {
    color: tokenColors.ink,
    fontSize: 29,
    lineHeight: 35,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: -0.2,
    marginTop: 6,
  },
  sub: { color: tokenColors.inkSoft, fontSize: 13.5, lineHeight: 19 },

  socialRow: { flexDirection: 'row', gap: 10 },
  socialHalf: { flex: 1 },
  appleHalf: { flex: 1, height: 52 },
  socialButton: {
    height: 52,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: tokenColors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  socialInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  socialButtonText: { color: tokenColors.ink, fontSize: 15, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  googleG: { fontSize: 18, fontWeight: '800', color: '#4285F4' },
  appleGlyph: { fontSize: 19, color: tokenColors.ink },

  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 2 },
  dividerLine: { flex: 1, height: 1, backgroundColor: tokenColors.line },
  dividerText: { color: tokenColors.muted, fontSize: 12.5, fontWeight: '600' },

  nameRow: { flexDirection: 'row', gap: 10 },
  nameHalf: { flex: 1, gap: 6 },
  fieldLabel: {
    color: tokenColors.ink,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
  },
  helperLine: { color: tokenColors.muted, fontSize: 12, marginTop: -6 },
  signinRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rememberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniBox: {
    width: 19,
    height: 19,
    borderWidth: 1.5,
    borderRadius: 6,
    borderColor: tokenColors.line,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniBoxOn: { backgroundColor: tokenColors.terracotta, borderColor: tokenColors.terracotta },
  rememberText: { color: tokenColors.inkSoft, fontSize: 13, fontWeight: '600' },
  forgotText: { color: tokenColors.ink, fontSize: 13, fontWeight: '600' },

  passwordWrap: { position: 'relative', justifyContent: 'center' },
  passwordInput: { paddingRight: 46 },
  eyeBtn: { position: 'absolute', right: 6, padding: 10 },
  eyeGlyph: { fontSize: 17, color: tokenColors.muted },

  ageRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ageInput: { flex: 1 },
  agePreview: { color: tokenColors.inkSoft, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  ageError: { color: tokenColors.danger, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 2 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  checkBox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderRadius: 7,
    borderColor: tokenColors.line,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: tokenColors.inkSoft, fontSize: 13, flex: 1, lineHeight: 18 },

  apple: { width: '100%', height: 52 },

  input: {
    borderWidth: 1,
    borderColor: tokenColors.line,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: tokenColors.ink,
  },

  primaryButton: {
    height: 54,
    borderRadius: 999,
    backgroundColor: tokenColors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    shadowColor: '#3D2E75',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },

  toggle: { color: tokenColors.inkSoft, fontSize: 14, textAlign: 'center', marginTop: 14, fontWeight: '600' },
  toggleLink: { color: tokenColors.ink, fontWeight: '700' },
  privacy: { fontSize: 13, marginTop: 6, fontWeight: '400', opacity: 0.8 },
  error: { color: tokenColors.danger, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 4 },
});
