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
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, tokenColors } from '@/theme';
import { api, apiErrorCopy } from '@/lib/api';
import { resetAnalytics } from '@/lib/analytics';
import { setSentryUser } from '@/lib/sentry';
import { logOutBilling } from '@/lib/billing';
import * as Notifications from 'expo-notifications';
import { clearAllOnLogout } from '@/lib/perf';
import { useSession } from '@/store/session';
import { useCloset } from '@/store/closet';
import { usePaywall } from '@/store/paywall';
import { useQuotas } from '@/store/quotas';
import { useReel } from '@/store/reel';
import { useQuiz } from '@/store/quiz';

const PRIVACY_URL = 'https://vai.style/privacy';

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
  const monthlyUsed = usePaywall((s) => s.monthlyUsed);
  const monthlyCap = usePaywall((s) => s.monthlyCap);

  const [busy, setBusy] = useState<'photos' | 'account' | 'logout' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const scoreQuery = useQuery({ queryKey: ['style-score'], queryFn: () => api.styleScore() });

  const wipeLocalState = useCallback(() => {
    useSession.getState().reset();
    useCloset.getState().clear();
    usePaywall.getState().reset();
    useQuotas.getState().reset();
    useReel.getState().reset();
    // Previously missed: quiz DNA, local notifications (the
    // day-5 trial reminder outlived logout), PostHog identity, Sentry user,
    // and RevenueCat attribution (purchases could land on the next signer).
    useQuiz.getState().reset();
    // Web has no native notifications module — the async rejection escapes a
    // sync try/catch (void promise), so attach .catch instead.
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined);
    void resetAnalytics().catch(() => undefined);
    try {
      setSentryUser(null);
    } catch {
      // Best-effort.
    }
    void logOutBilling().catch(() => undefined);
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

      <View style={styles.headerRule} />

      {/* Stat band — big Playfair numerals with hairline dividers. The numbers
          ARE the content here, so they get the masthead treatment. */}
      <View style={styles.statBand} testID="profile-stats">
        <View style={styles.statCell}>
          <Text style={[styles.statNum, { color: colors.text }]}>{closetCount}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>pieces</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={[styles.statNum, { color: colors.text }]}>
            {tier === 'free' ? `${lifetimeUsed}/5` : `${monthlyUsed}/${monthlyCap}`}
          </Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>
            {tier === 'free' ? 'lifetime renders' : 'renders this month'}
          </Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          {scoreQuery.isPending ? (
            <ActivityIndicator testID="stats-loading" size="small" />
          ) : (
            <Text style={[styles.statNum, { color: colors.text }]}>
              {scoreQuery.data ? scoreQuery.data.total : '—'}
            </Text>
          )}
          <Text style={[styles.statLabel, { color: colors.muted }]}>style score</Text>
        </View>
      </View>
      {scoreQuery.isError ? (
        <Text style={[styles.statNote, { color: colors.muted }]} testID="stats-error">
          Stats unavailable offline — showing closet counts.
        </Text>
      ) : null}
      {!!referralCode && (
        <Text style={[styles.statNote, { color: colors.muted }]}>
          vai.style/r/{referralCode} — friends get a month, you get a month.
        </Text>
      )}

      {/* Subscription — the violet lacquer card. Premium/trial read as owned;
          free reads as the upgrade invitation. */}
      <Pressable
        style={styles.subCard}
        onPress={() => router.push('/onboarding/paywall')}
        testID="subscription-row"
        accessibilityRole="button"
      >
        <LinearGradient
          colors={['#8B6CF2', '#6645D9']}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.subSheen} pointerEvents="none" />
        <View style={{ flex: 1 }}>
          <Text style={styles.subTitle}>
            {tier === 'premium' ? 'VAI Premium' : tier === 'trial' ? 'Free trial' : 'VAI Free'}
          </Text>
          <Text style={styles.subBody}>
            {tier === 'trial' && trialEndsAt
              ? `Trial ends ${new Date(trialEndsAt).toLocaleDateString()} — then $4.99/mo unless cancelled.`
              : tier === 'premium'
                ? '30 renders/mo included.'
                : '5 lifetime renders · 1 outfit a day.'}
          </Text>
        </View>
        <View style={styles.subPill}>
          <Text style={styles.subPillText}>{tier === 'free' ? 'Upgrade' : 'Manage'}</Text>
        </View>
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

      {/* Danger zone — quiet and sectioned, not a wall of red cards. */}
      <Text style={[styles.dangerTitle, { color: colors.muted }]}>Danger zone</Text>
      <View style={styles.dangerGroup}>
        <Pressable
          style={styles.dangerRow}
          onPress={handleDeletePhotos}
          disabled={busy !== null}
          testID="delete-photos"
          accessibilityRole="button"
        >
          <Text style={[styles.dangerText, { color: colors.danger }]}>
            {busy === 'photos' ? 'Deleting…' : 'Delete my photos'}
          </Text>
        </Pressable>
        <View style={styles.dangerDivider} />
        <Pressable
          style={styles.dangerRow}
          onPress={handleDeleteAccount}
          disabled={busy !== null}
          testID="delete-account"
          accessibilityRole="button"
        >
          <Text style={[styles.dangerText, { color: colors.danger }]}>
            {busy === 'account' ? 'Working…' : 'Delete account (30-day purge)'}
          </Text>
        </Pressable>
      </View>
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
        style={styles.logout}
        onPress={() => void handleLogout()}
        disabled={busy === 'logout'}
        testID="logout"
        accessibilityRole="button"
      >
        {busy === 'logout' ? (
          <ActivityIndicator color={tokenColors.ink} />
        ) : (
          <Text style={[styles.logoutText, { color: colors.text }]}>Log out</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingTop: 28, paddingBottom: 32 },
  header: { fontSize: 34, lineHeight: 40, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2 },
  email: { fontSize: 13, marginTop: 3 },
  // The atelier rule — same hairline as home + closet + shop.
  headerRule: { height: 1, backgroundColor: '#E6E0F5', marginTop: 14, marginBottom: 20 },

  // Stat band — masthead numerals separated by hairlines, no boxes.
  statBand: { flexDirection: 'row', alignItems: 'stretch' },
  statCell: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 4 },
  statNum: { fontSize: 30, lineHeight: 34, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  statLabel: { fontSize: 11.5, lineHeight: 15, fontWeight: '600' },
  statDivider: { width: 1, backgroundColor: '#E6E0F5', marginVertical: 6 },
  statNote: { fontSize: 12.5, lineHeight: 18, textAlign: 'center', marginTop: 10 },

  // Subscription — the violet lacquer card.
  subCard: {
    marginTop: 24,
    borderRadius: 22,
    paddingVertical: 18,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    overflow: 'hidden',
    shadowColor: '#6645D9',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 7,
  },
  subSheen: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.45)' },
  subTitle: { color: '#FFFFFF', fontSize: 18, lineHeight: 23, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  subBody: { color: 'rgba(255,255,255,0.82)', fontSize: 12.5, lineHeight: 17, marginTop: 3 },
  subPill: { borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.96)', paddingVertical: 9, paddingHorizontal: 15 },
  subPillText: { color: '#4A2C92', fontSize: 13, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },

  row: {
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 15,
    paddingHorizontal: 16,
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    shadowColor: '#44307E',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  rowText: { fontSize: 15, fontWeight: '600' },
  rowMain: { flex: 1, gap: 2 },
  rowSub: { fontSize: 13 },
  chev: { fontSize: 20 },

  // Danger zone — one quiet sectioned group, hairline-divided, not red cards.
  dangerTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4, marginTop: 26, marginBottom: 8 },
  dangerGroup: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#EFEAF9' },
  dangerRow: { paddingVertical: 15, paddingHorizontal: 2 },
  dangerText: { fontSize: 14.5, fontWeight: '600' },
  dangerDivider: { height: 1, backgroundColor: '#EFEAF9' },

  error: { fontSize: 13, marginTop: 8 },
  done: { fontSize: 13, marginTop: 8 },
  logout: {
    borderRadius: 999,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 26,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E6E0F5',
  },
  logoutText: { fontSize: 15, fontWeight: '600' },
});
