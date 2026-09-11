import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '@/theme';
import { Button, ErrorView } from '@/components';
import { ApiError, api, apiErrorCopy } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';
import { useTaste } from '@/store/taste';

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/** OAuth redirect back into the app (matches the `vai` scheme in app.json). */
const PINTEREST_REDIRECT = 'vai://pinterest-callback';

type ConnectError = 'denied' | 'expired' | 'generic';
type Phase = 'idle' | 'auth-url' | 'browser' | 'callback';

const DENIED_COPY = {
  title: 'Pinterest access declined',
  message:
    'You closed Pinterest before approving (or declined access). VAI never posts without your explicit confirm — try again when ready.',
};
const EXPIRED_COPY = {
  title: 'This link expired',
  message: 'Pinterest login links are short-lived. Get a fresh one and try again.',
};
const SANDBOX_COPY =
  'Trial sandbox: Pinterest is still reviewing VAI, so only boards owned by approved test users may appear and syncing can be slow. Your taste still saves — full access unlocks on approval.';

function firstString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v)) {
    const hit = v.find((x): x is string => typeof x === 'string' && x.length > 0);
    return hit ?? null;
  }
  return null;
}

/** Map callback/auth failures onto the three covered states. */
function classifyConnectError(e: unknown): ConnectError {
  const msg = e instanceof Error ? e.message : '';
  if (/denied|declined|access_denied|forbidden|did not approve/i.test(msg)) return 'denied';
  if (/expir|invalid_grant|invalid_code|already.?used|stale/i.test(msg)) return 'expired';
  if (e instanceof ApiError && e.code === 'NETWORK') return 'generic';
  return 'generic';
}

/**
 * Pinterest OAuth connect: secret-boards opt-in BEFORE auth, then
 * `openAuthSessionAsync` to the backend auth-url with the
 * `vai://pinterest-callback` redirect. Covers denied / expired /
 * trial-sandbox states. Success lands on the board picker.
 */
export default function PinterestConnect() {
  const router = useRouter();
  const { colors } = useTheme();

  const [includeSecret, setIncludeSecret] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorKind, setErrorKind] = useState<ConnectError | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState(false);

  const busy = phase !== 'idle';

  const handleConnect = useCallback(async () => {
    if (busy) return;
    setErrorKind(null);
    setErrorMessage(null);
    setPhase('auth-url');
    let authUrl: string;
    try {
      const auth = await api.pinterestAuthUrl({
        redirectUri: PINTEREST_REDIRECT,
        includeSecret,
      });
      if (!auth.authUrl) {
        setPhase('idle');
        setErrorKind('expired');
        return;
      }
      setSandbox(auth.sandbox);
      authUrl = auth.authUrl;
    } catch (e) {
      setPhase('idle');
      const kind = classifyConnectError(e);
      setErrorKind(kind);
      if (kind === 'generic') setErrorMessage(apiErrorCopy(e).message);
      return;
    }

    setPhase('browser');
    let result: Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>;
    try {
      result = await WebBrowser.openAuthSessionAsync(authUrl, PINTEREST_REDIRECT);
    } catch {
      setPhase('idle');
      setErrorKind('generic');
      setErrorMessage('Could not open Pinterest. Check your connection and try again.');
      return;
    }
    if (result.type !== 'success') {
      // cancel + dismiss both mean the user left before approving.
      setPhase('idle');
      setErrorKind('denied');
      return;
    }
    const url = 'url' in result && typeof result.url === 'string' ? result.url : null;
    if (!url) {
      setPhase('idle');
      setErrorKind('denied');
      return;
    }
    const qp = Linking.parse(url).queryParams as unknown as Record<string, unknown>;
    if (firstString(qp['error'])) {
      setPhase('idle');
      setErrorKind('denied');
      return;
    }
    const code = firstString(qp['code']);
    const state = firstString(qp['state']);
    if (!code) {
      setPhase('idle');
      setErrorKind('expired');
      return;
    }

    setPhase('callback');
    try {
      const done = await api.pinterestCallback({ code, ...(state ? { state } : {}) });
      setSandbox(done.sandbox);
      useTaste.getState().setConnection({ username: done.username, boards: done.boards });
      const uid = useSession.getState().userId;
      if (uid) {
        track('pinterest_connected', {
          user_id: uid,
          tier: toAnalyticsTier(usePaywall.getState().tier),
        });
      }
      setPhase('idle');
      router.replace('/pinterest-boards');
    } catch (e) {
      setPhase('idle');
      const kind = classifyConnectError(e);
      setErrorKind(kind);
      if (kind === 'generic') setErrorMessage(apiErrorCopy(e).message);
    }
  }, [busy, includeSecret, router]);

  const retry = useCallback(() => {
    setErrorKind(null);
    setErrorMessage(null);
    void handleConnect();
  }, [handleConnect]);

  const busyLine =
    phase === 'auth-url'
      ? 'Getting a Pinterest login link…'
      : phase === 'browser'
        ? 'Waiting for Pinterest approval…'
        : phase === 'callback'
          ? 'Confirming with Pinterest…'
          : null;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      testID="pinterest-connect"
    >
      <Text style={[styles.kicker, { color: colors.muted }]}>Taste graph</Text>
      <Text style={[styles.title, { color: colors.text }]}>Connect Pinterest</Text>
      <Text style={[styles.body, { color: colors.muted }]}>
        VAI learns silhouettes, palettes, and poses from boards you pick. Reading only — nothing
        is ever posted without your explicit confirm.
      </Text>

      {/* Secret-boards opt-in BEFORE auth: private-board read needs consent. */}
      <Pressable
        style={[styles.checkRow, { borderColor: colors.border }]}
        onPress={() => setIncludeSecret((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: includeSecret }}
        testID="secret-toggle"
      >
        <View
          style={[
            styles.box,
            { borderColor: colors.border },
            includeSecret && { backgroundColor: colors.primary, borderColor: colors.primary },
          ]}
        >
          {includeSecret && <Text style={[styles.tick, { color: colors.onPrimary }]}>✓</Text>}
        </View>
        <View style={styles.checkText}>
          <Text style={[styles.checkTitle, { color: colors.text }]}>Include secret boards</Text>
          <Text style={[styles.checkBody, { color: colors.muted }]}>
            VAI reads your private boards only to learn your taste. Secret boards stay secret —
            they are never shared or posted.
          </Text>
        </View>
      </Pressable>

      {sandbox && (
        <Text style={[styles.sandbox, { color: colors.warning }]} testID="sandbox-notice">
          {SANDBOX_COPY}
        </Text>
      )}

      {errorKind === 'denied' && (
        <View style={styles.errorWrap} testID="connect-denied">
          <ErrorView title={DENIED_COPY.title} message={DENIED_COPY.message} onRetry={retry} />
        </View>
      )}
      {errorKind === 'expired' && (
        <View style={styles.errorWrap} testID="connect-expired">
          <ErrorView title={EXPIRED_COPY.title} message={EXPIRED_COPY.message} onRetry={retry} />
        </View>
      )}
      {errorKind === 'generic' && (
        <View style={styles.errorWrap} testID="connect-error">
          <ErrorView
            message={errorMessage ?? 'Could not reach Pinterest. Please try again.'}
            onRetry={retry}
            retrying={busy}
          />
        </View>
      )}

      <View style={styles.cta}>
        <Button
          title={busy ? 'Connecting…' : 'Continue with Pinterest'}
          onPress={() => void handleConnect()}
          loading={busy}
          testID="connect-button"
        />
        {!!busyLine && (
          <Text style={[styles.busy, { color: colors.muted }]} testID="connect-busy">
            {busyLine}
          </Text>
        )}
      </View>

      <Text style={[styles.foot, { color: colors.muted }]}>
        You can disconnect anytime in Settings — synced taste data is purged.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 64, gap: 12 },
  kicker: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  checkRow: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 8 },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  tick: { fontSize: 15, fontWeight: '700' },
  checkText: { flex: 1, gap: 4 },
  checkTitle: { fontSize: 15, fontWeight: '700' },
  checkBody: { fontSize: 13, lineHeight: 19 },
  sandbox: { fontSize: 13, lineHeight: 19 },
  errorWrap: { marginTop: 4 },
  cta: { marginTop: 8, gap: 8 },
  busy: { fontSize: 13, textAlign: 'center' },
  foot: { fontSize: 12, textAlign: 'center', marginTop: 8 },
});
