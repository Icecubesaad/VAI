import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';

const TRIAL_COPY = '7 days free, then $4.99/mo · cancel anytime · no charge today';
const YEARLY_TRIAL_COPY = '7 days free, then $39.99/yr · cancel anytime · no charge today';
const DOWNGRADE_COPY =
  'Downgrading keeps everything — your closet, outfits and renders stay saved. Extra items over 50 become read-only until you upgrade.';
const PRIVACY_URL = 'https://vai.style/privacy';

type PaywallPlan = 'monthly' | 'yearly';

/**
 * Paywall at the aha-peak. Trigger: quiz_done && closet>=3 && first_outfit_seen
 * && !trial && !sub. Free = 5 LIFETIME renders (counter "X of 5 left").
 * Billing execution (RevenueCat) is owned by @/lib/billing — see CONTRACT §Billing.
 */
export default function PaywallScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const tier = usePaywall((s) => s.tier);
  const rendersLeft = usePaywall((s) => s.rendersLeft);
  const fetchStatus = usePaywall((s) => s.fetchStatus);
  const fetching = usePaywall((s) => s.fetching);
  const purchasing = usePaywall((s) => s.purchasing);
  const purchaseError = usePaywall((s) => s.purchaseError);
  const startTrial = usePaywall((s) => s.startTrial);
  const restore = usePaywall((s) => s.restore);
  const clearPurchaseError = usePaywall((s) => s.clearPurchaseError);
  const setStep = useSession((s) => s.setOnboardingStep);
  const referredBy = useSession((s) => s.referredBy);
  const referralRedeemed = useSession((s) => s.referralRedeemed);
  const markRedeemed = useSession((s) => s.setReferralRedeemed);
  // Plan parity with the upgrade sheet: monthly $4.99 + yearly $39.99 (best
  // value). Both carry the 7-day intro offer; the trial line names the plan.
  const [plan, setPlan] = useState<PaywallPlan>('yearly');

  const dismiss = useCallback(() => {
    setStep('done');
    router.replace('/(tabs)');
  }, [router, setStep]);

  // Billing handoff: lib/billing (RevenueCat `premium` entitlement) executes
  // the trial purchase; on success the store flips tier via paywall-status
  // merge and we dismiss into the app. User-cancelled = silent, stay put.
  const onTrial = useCallback(async () => {
    clearPurchaseError();
    const { purchased } = await startTrial(plan);
    if (purchased) {
      setStep('done');
      router.replace('/(tabs)');
    }
  }, [clearPurchaseError, plan, router, setStep, startTrial]);

  const onRestore = useCallback(async () => {
    clearPurchaseError();
    const { restored } = await restore();
    if (restored) {
      setStep('done');
      router.replace('/(tabs)');
    }
  }, [clearPurchaseError, restore, router, setStep]);

  useEffect(() => {
    void fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redeem captured referral code once (reward requires 3 items + 1 try-on server-side).
  useEffect(() => {
    if (referredBy && !referralRedeemed) {
      void api
        .applyReferral({ code: referredBy })
        .then(() => markRedeemed())
        .catch(() => {
          // Non-blocking: referral must never break the paywall.
        });
    }
  }, [referredBy, referralRedeemed, markRedeemed]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      testID="paywall-screen"
    >
      <Text style={[styles.kicker, { color: colors.muted }]}>You&apos;ve seen the magic — keep it</Text>
      <Text style={[styles.title, { color: colors.text }]}>Your closet, styled daily</Text>

      {fetching ? (
        <View style={styles.state} testID="paywall-loading">
          <ActivityIndicator />
        </View>
      ) : (
        <View style={[styles.counter, { backgroundColor: colors.surface }]} testID="paywall-counter">
          <Text style={[styles.counterText, { color: colors.text }]}>
            {tier === 'free'
              ? `${rendersLeft} of 5 left`
              : tier === 'trial'
                ? 'Trial active — 30 renders/mo included'
                : 'Premium active — 30 renders/mo included'}
          </Text>
          {tier === 'free' && (
            <Text style={[styles.counterSub, { color: colors.muted }]}>
              Free includes 5 lifetime renders, then it&apos;s upgrade time. Premium = 30
              renders/mo — never unlimited, always fast.
            </Text>
          )}
        </View>
      )}

      <View style={styles.perks}>
        {['1 hero outfit every morning', 'Mirror-selfie try-ons (usually ~20s)', 'Gap picks that stop duplicate buys'].map(
          (p) => (
            <Text key={p} style={[styles.perk, { color: colors.text }]}>
              ✓ {p}
            </Text>
          ),
        )}
      </View>

      {!!purchaseError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="paywall-error">
          {purchaseError}
        </Text>
      )}

      {tier === 'free' ? (
        <>
          <View style={styles.plansRow}>
            <Pressable
              style={[
                styles.planCard,
                { borderColor: colors.border, borderWidth: 1 },
                plan === 'monthly' && { backgroundColor: colors.surface, borderColor: colors.primary },
              ]}
              onPress={() => setPlan('monthly')}
              accessibilityRole="radio"
              accessibilityState={{ selected: plan === 'monthly' }}
              accessibilityLabel="Monthly, $4.99 per month"
              testID="paywall-plan-monthly"
            >
              <Text style={[styles.planTitle, { color: colors.text }]}>Monthly</Text>
              <Text style={[styles.planPrice, { color: colors.text }]}>$4.99/mo</Text>
            </Pressable>
            <Pressable
              style={[
                styles.planCard,
                { borderColor: colors.border, borderWidth: 1 },
                plan === 'yearly' && { backgroundColor: colors.surface, borderColor: colors.primary },
              ]}
              onPress={() => setPlan('yearly')}
              accessibilityRole="radio"
              accessibilityState={{ selected: plan === 'yearly' }}
              accessibilityLabel="Yearly, $39.99 per year, best value"
              testID="paywall-plan-yearly"
            >
              <Text style={[styles.planTitle, { color: colors.text }]}>Yearly · best value</Text>
              <Text style={[styles.planPrice, { color: colors.text }]}>$39.99/yr</Text>
              <Text style={[styles.plans, { color: colors.muted }]}>$3.33 per month</Text>
            </Pressable>
          </View>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => void onTrial()}
            disabled={purchasing}
            testID="paywall-trial"
          >
            {purchasing ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Start 7-day free trial</Text>
            )}
          </Pressable>
          <Text style={[styles.trial, { color: colors.muted }]} testID="trial-copy">
            {plan === 'yearly' ? YEARLY_TRIAL_COPY : TRIAL_COPY}
          </Text>
          <Text style={[styles.plans, { color: colors.muted }]}>
            Extra renders via credit packs from $1.99
          </Text>
          <Text style={[styles.plans, { color: colors.muted }]} testID="paywall-downgrade-note">
            {DOWNGRADE_COPY}
          </Text>
        </>
      ) : (
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={dismiss}
          testID="paywall-continue"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Continue</Text>
        </Pressable>
      )}

      <View style={styles.footer}>
        <Pressable onPress={() => void onRestore()} disabled={purchasing} testID="paywall-restore">
          <Text style={[styles.link, { color: colors.muted }]}>
            {purchasing ? 'Checking…' : 'Restore purchases'}
          </Text>
        </Pressable>
        <Pressable onPress={() => void Linking.openURL(PRIVACY_URL)} testID="paywall-privacy">
          <Text style={[styles.link, { color: colors.muted }]}>Privacy policy</Text>
        </Pressable>
        {tier === 'free' && (
          <Pressable onPress={dismiss} testID="paywall-dismiss">
            <Text style={[styles.link, { color: colors.muted }]}>Not now</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 64, paddingBottom: 32 },
  kicker: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '800', marginTop: 8 },
  counter: { borderRadius: 14, padding: 16, marginTop: 20, gap: 6 },
  counterText: { fontSize: 18, fontWeight: '800' },
  counterSub: { fontSize: 13, lineHeight: 18 },
  perks: { gap: 8, marginTop: 20 },
  perk: { fontSize: 15 },
  plansRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  planCard: { flex: 1, borderRadius: 12, padding: 14, gap: 2 },
  planTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  planPrice: { fontSize: 17, fontWeight: '800' },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  trial: { fontSize: 13, textAlign: 'center', marginTop: 10 },
  plans: { fontSize: 12, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  error: { fontSize: 13, marginTop: 12, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 20 },
  link: { fontSize: 13 },
  state: { paddingVertical: 16 },
});
