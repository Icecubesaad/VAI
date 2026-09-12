import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/theme';
import { InspirationRow, TasteCadence } from '@/components';
import { api, apiErrorCopy } from '@/lib/api';
import { track } from '@/lib/analytics';
import { clearAllOnLogout } from '@/lib/perf';
import { useSession } from '@/store/session';
import { useCloset } from '@/store/closet';
import { usePaywall } from '@/store/paywall';
import { useQuotas } from '@/store/quotas';
import { useReel } from '@/store/reel';
import { useTaste } from '@/store/taste';

const PRIVACY_URL = 'https://vai.style/privacy';

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/**
 * Profile/settings: private stats, subscription row, Retake base photo,
 * Delete My Photos + Delete Account (30-day purge), privacy policy, logout.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const email = useSession((s) => s.email);
  const referralCode = useSession((s) => s.referralCode);
  const closetCount = useCloset((s) => s.order.length);
  const tier = usePaywall((s) => s.tier);
  const trialEndsAt = usePaywall((s) => s.trialEndsAt);
  const lifetimeUsed = useQuotas((s) => s.lifetimeUsed);
  const tasteConnected = useTaste((s) => s.connected);
  const tasteUsername = useTaste((s) => s.username);
  const boardCount = useTaste((s) => s.boards.length);
  // Invisible-autopilot cadence (store/taste, MMKV default weekly):
  // local-first row below flushes best-effort via api.updateTastePrefs.
  const cadence = useTaste((s) => s.cadence);
  const setCadence = useTaste((s) => s.setCadence);
  const lastSyncedAt = useTaste((s) => s.lastSyncedAt);
  const lastSyncCaption = lastSyncedAt
    ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
    : null;

  const [busy, setBusy] = useState<'photos' | 'account' | 'logout' | 'pinterest' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const scoreQuery = useQuery({ queryKey: ['style-score'], queryFn: () => api.styleScore() });

  const wipeLocalState = useCallback(() => {
    useSession.getState().reset();
    useCloset.getState().clear();
    usePaywall.getState().reset();
    useQuotas.getState().reset();
    useReel.getState().reset();
    useTaste.getState().reset();
    try {
      clearAllOnLogout();
    } catch {
      // Cache wipe is best-effort; stores above are the UI truth.
    }
  }, []);

  const confirmDestructive = useCallback(
    (title: string, message: string, onYes: () => void) => {
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onYes },
      ]);
    },
    [],
  );

  const handleDeletePhotos = useCallback(() => {
    setActionError(null);
    setDoneMessage(null);
    confirmDestructive(
      'Delete my photos?',
      'This removes your base photo and renders. Your closet items stay. This cannot be undone.',
      () => {
        setBusy('photos');
        void (async () => {
          try {
            // Server purge first — local state clears ONLY after it confirms.
            await api.requestDeletion('photos');
            useSession.getState().setBasePhoto(null);
            setDoneMessage('Your base photo and renders were deleted. Your closet items stay.');
          } catch (e) {
            setActionError(apiErrorCopy(e).message);
          } finally {
            setBusy(null);
          }
        })();
      },
    );
  }, [confirmDestructive]);

  const handleDeleteAccount = useCallback(() => {
    setActionError(null);
    setDoneMessage(null);
    confirmDestructive(
      'Delete account?',
      'Your data enters a 30-day purge, then is permanently removed. Your subscription (if any) must still be cancelled in the App Store / Play Store.',
      () => {
        setBusy('account');
        void (async () => {
          try {
            const res = await api.requestDeletion('account');
            const purgeLine = res.purge_after
              ? ` Scheduled purge: ${new Date(res.purge_after).toLocaleDateString()}.`
              : '';
            const completion =
              `Your account data is queued for deletion and will be permanently removed within 30 days.${purgeLine} ` +
              'Remember to cancel your subscription in the App Store / Play Store — deletion does not cancel billing.';
            try {
              await api.signOut();
            } catch {
              // Session is dead server-side; continue wiping local state.
            }
            wipeLocalState();
            setBusy(null);
            Alert.alert('Account deletion started', completion, [
              { text: 'OK', onPress: () => router.replace('/onboarding/auth') },
            ]);
          } catch (e) {
            setActionError(apiErrorCopy(e).message);
            setBusy(null);
          }
        })();
      },
    );
  }, [confirmDestructive, router, wipeLocalState]);

  const handleDisconnectPinterest = useCallback(() => {
    setActionError(null);
    setDoneMessage(null);
    confirmDestructive(
      'Disconnect Pinterest?',
      'This removes your Pinterest boards and pose pins from this device and deletes synced taste data from VAI servers. Your closet and renders stay. This cannot be undone.',
      () => {
        setBusy('pinterest');
        void (async () => {
          try {
            // Server purge first — local taste clears ONLY after it confirms.
            await api.pinterestDisconnect();
            useTaste.getState().disconnect();
            const uid = useSession.getState().userId;
            if (uid) {
              track('pinterest_disconnected', {
                user_id: uid,
                tier: toAnalyticsTier(usePaywall.getState().tier),
              });
            }
            setDoneMessage('Pinterest disconnected — boards and pose pins purged.');
          } catch (e) {
            setActionError(apiErrorCopy(e).message);
          } finally {
            setBusy(null);
          }
        })();
      },
    );
  }, [confirmDestructive]);

  const handleLogout = useCallback(async () => {
    setActionError(null);
    setDoneMessage(null);
    setBusy('logout');
    try {
      await api.signOut();
      wipeLocalState();
      router.replace('/onboarding/auth');
    } catch (e) {
      setActionError(apiErrorCopy(e).message);
    } finally {
      setBusy(null);
    }
  }, [router, wipeLocalState]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      testID="profile-screen"
    >
      <Text style={[styles.header, { color: colors.text }]}>Profile</Text>
      {!!email && (
        <Text style={[styles.email, { color: colors.muted }]} testID="profile-email">
          {email}
        </Text>
      )}

      {/* Private stats */}
      <View style={[styles.card, { backgroundColor: colors.surface }]} testID="profile-stats">
        <Text style={[styles.cardTitle, { color: colors.text }]}>Your stats (private)</Text>
        {scoreQuery.isPending ? (
          <ActivityIndicator testID="stats-loading" />
        ) : scoreQuery.isError ? (
          <Text style={[styles.cardText, { color: colors.muted }]} testID="stats-error">
            Stats unavailable offline — showing closet counts.
          </Text>
        ) : null}
        <Text style={[styles.cardText, { color: colors.text }]}>
          Closet items: {closetCount}. Renders used: {lifetimeUsed} of 5 lifetime.
          {scoreQuery.data ? ` Style score: ${scoreQuery.data.total}.` : ''}
        </Text>
        {!!referralCode && (
          <Text style={[styles.cardText, { color: colors.muted }]}>
            Referral code: vai.style/r/{referralCode} — friends get a month, you get a month.
          </Text>
        )}
      </View>

      {/* Subscription row */}
      <Pressable
        style={[styles.card, { backgroundColor: colors.surface }]}
        onPress={() => router.push('/onboarding/paywall')}
        testID="subscription-row"
      >
        <Text style={[styles.cardTitle, { color: colors.text }]}>
          {tier === 'premium' ? 'VAI Premium ✓' : tier === 'trial' ? 'Free trial' : 'VAI Free'}
        </Text>
        <Text style={[styles.cardText, { color: colors.muted }]}>
          {tier === 'trial' && trialEndsAt
            ? `Trial ends ${new Date(trialEndsAt).toLocaleDateString()} — then $4.99/mo unless cancelled.`
            : tier === 'premium'
              ? '30 renders/mo included.'
              : '5 lifetime renders · 1 outfit/day. Tap to upgrade.'}
        </Text>
      </Pressable>

      {/* Base photo */}
      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={() => router.push('/onboarding/selfie-capture')}
        testID="profile-retake"
      >
        <Text style={[styles.rowText, { color: colors.text }]}>Retake base photo</Text>
        <Text style={[styles.chev, { color: colors.muted }]}>›</Text>
      </Pressable>

      {/* Style inspiration: row 1 of the two-row invisible-Pinterest surface
          (row 2 is TasteCadence below). Connect/disconnect only — try-on,
          reel and planner pickers are unwired; taste applies automatically. */}
      <InspirationRow
        connected={tasteConnected}
        username={tasteUsername}
        boardCount={boardCount}
        lastSyncCaption={lastSyncCaption}
        onPress={() => router.push(tasteConnected ? '/pinterest-boards' : '/pinterest-connect')}
        onDisconnect={tasteConnected ? handleDisconnectPinterest : undefined}
        disconnecting={busy === 'pinterest'}
        testID="pinterest"
      />

      {/* Style refresh cadence: row 2 of the two-row surface (Daily / Weekly /
          Off). Local-first — the store flushes taste-build best-effort and
          never throws, so this row stays interactive offline. */}
      <View style={styles.tasteRow} testID="taste-cadence-wrap">
        <TasteCadence
          value={cadence}
          onChange={(v) => setCadence(v)}
          lastSyncCaption={lastSyncCaption}
          testID="taste-cadence-row"
        />
      </View>

      {/* Pose pack (powers the Monday reel: front / step / detail) */}
      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={() => router.push('/pose-pack')}
        testID="profile-pose-pack"
      >
        <Text style={[styles.rowText, { color: colors.text }]}>Pose pack (3 poses)</Text>
        <Text style={[styles.chev, { color: colors.muted }]}>›</Text>
      </Pressable>

      {/* Danger zone (Pinterest disconnect lives in the InspirationRow above —
          sibling hit-area, server-purge-first; local taste clears only after
          the server confirms). */}
      <Text style={[styles.dangerTitle, { color: colors.danger }]}>Danger zone</Text>
      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={handleDeletePhotos}
        disabled={busy !== null}
        testID="delete-photos"
      >
        <Text style={[styles.rowText, { color: colors.danger }]}>
          {busy === 'photos' ? 'Deleting…' : 'Delete My Photos'}
        </Text>
      </Pressable>
      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={handleDeleteAccount}
        disabled={busy !== null}
        testID="delete-account"
      >
        <Text style={[styles.rowText, { color: colors.danger }]}>
          {busy === 'account' ? 'Working…' : 'Delete Account (30-day purge)'}
        </Text>
      </Pressable>
      {!!actionError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="profile-error">
          {actionError}
        </Text>
      )}
      {!!doneMessage && !actionError && (
        <Text style={[styles.done, { color: colors.text }]} testID="profile-done">
          {doneMessage}
        </Text>
      )}

      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={() => void Linking.openURL(PRIVACY_URL)}
        testID="privacy-link"
      >
        <Text style={[styles.rowText, { color: colors.text }]}>Privacy policy</Text>
        <Text style={[styles.chev, { color: colors.muted }]}>›</Text>
      </Pressable>

      <Pressable
        style={[styles.logout, { backgroundColor: colors.surface }]}
        onPress={() => void handleLogout()}
        disabled={busy === 'logout'}
        testID="logout"
      >
        {busy === 'logout' ? (
          <ActivityIndicator />
        ) : (
          <Text style={[styles.rowText, { color: colors.text }]}>Log out</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  header: { fontSize: 28, fontWeight: '700', fontFamily: 'Georgia' },
  email: { fontSize: 13, marginTop: 2 },
  card: { borderRadius: 14, padding: 14, marginTop: 12, gap: 6 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardText: { fontSize: 14, lineHeight: 20 },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowText: { fontSize: 15, fontWeight: '600' },
  rowMain: { flex: 1, gap: 2 },
  rowSub: { fontSize: 13 },
  chev: { fontSize: 20 },
  tasteRow: { marginTop: 10 },
  dangerTitle: { fontSize: 13, fontWeight: '700', marginTop: 20 },
  error: { fontSize: 13, marginTop: 8 },
  done: { fontSize: 13, marginTop: 8 },
  logout: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
});
