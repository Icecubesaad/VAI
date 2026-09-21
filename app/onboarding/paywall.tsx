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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { api } from '@/lib/api';
import { useSession } from '@/store/session';
import { track } from '@/lib/analytics';
import { usePaywall } from '@/store/paywall';
import {
  BillingError,
  CREDIT_PACKS,
  initBilling,
  purchaseCreditPack,
  type CreditPack,
} from '@/lib/billing';

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
  const fetchError = usePaywall((s) => s.fetchError);
  const purchasing = usePaywall((s) => s.purchasing);
  const purchaseError = usePaywall((s) => s.purchaseError);
  const startTrial = usePaywall((s) => s.startTrial);
  const restore = usePaywall((s) => s.restore);
  const clearPurchaseError = usePaywall((s) => s.clearPurchaseError);
  const setStep = useSession((s) => s.setOnboardingStep);
  const referredBy = useSession((s) => s.referredBy);
  const referralRedeemed = useSession((s) => s.referralRedeemed);
  const markRedeemed = useSession((s) => s.setReferralRedeemed);
  // Deep-linked placements (vai://paywall?placement=) name WHERE the paywall
  // opened from — every router.push below passes one; default is onboarding.
  const params = useLocalSearchParams<{ placement?: string | string[] }>();
  const placement = Array.isArray(params.placement)
    ? params.placement[0]
    : params.placement;
  // Plan parity with the upgrade sheet: monthly $4.99 + yearly $39.99 (best
  // value). Both carry the 7-day intro offer; the trial line names the plan.
  const [plan, setPlan] = useState<PaywallPlan>('yearly');
  const [packBusy, setPackBusy] = useState<CreditPack['id'] | null>(null);
  const [packError, setPackError] = useState<string | null>(null);

  const onBuyPack = useCallback(
    async (pack: CreditPack) => {
      clearPurchaseError();
      setPackError(null);
      setPackBusy(pack.id);
      try {
        const uid = useSession.getState().userId;
        if (uid) await initBilling(uid);
        await purchaseCreditPack(pack.id);
        track('credits_purchased', {
          user_id: uid ?? 'anonymous',
          tier: usePaywall.getState().tier === 'free' ? 'free' : 'premium',
          pack_id: pack.id,
          credits: pack.credits,
        });
        void fetchStatus();
      } catch (e) {
        if (!(e instanceof BillingError && e.userCancelled)) {
          setPackError(e instanceof Error ? e.message : 'Could not complete the purchase — nothing was charged.');
        }
      } finally {
        setPackBusy(null);
      }
    },
    [clearPurchaseError, fetchStatus],
  );

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
    // The billing funnel's opening event — never emitted anywhere before,
    // so paywall views (and everything downstream) were unmeasurable.
    const st = usePaywall.getState();
    track('paywall_seen', {
      user_id: useSession.getState().userId ?? 'anonymous',
      tier: st.tier === 'free' ? 'free' : 'premium',
      placement: placement ?? 'onboarding',
      renders_left: st.rendersLeft,
    });
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
      style={[styles.root, { backgroundColor: 'transparent' }]}
      contentContainerStyle={styles.content}
      testID="paywall-screen"
    >
      <MeshGradient variant="auth" />
      <Text style={[styles.kicker, { color: colors.muted }]}>You have seen the magic. Keep it.</Text>
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

      {/* Credit packs — HD renders + top-ups (HD tier is packs-only, iron law #2). */}
      <View style={styles.packsRow} testID="credit-packs">
        {CREDIT_PACKS.map((pack) => (
          <Pressable
            key={pack.id}
            style={[styles.packCard, { borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void onBuyPack(pack)}
            disabled={packBusy !== null}
            testID={`credit-pack-${pack.credits}`}
            accessibilityRole="button"
            accessibilityLabel={`${pack.hd ? '1 HD render' : `${pack.credits} renders`}, ${pack.priceDisplay}`}
          >
            <Text style={[styles.packTitle, { color: colors.text }]}>
              {pack.hd ? '1 HD render' : `${pack.credits} renders`}
            </Text>
            <Text style={[styles.packPrice, { color: colors.muted }]}>{pack.priceDisplay}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[styles.plans, { color: colors.muted }]}>
        Credit packs — HD renders and top-ups, billed once per purchase.
      </Text>
      {!!packError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="credit-pack-error">
          {packError}
        </Text>
      )}

      {!!purchaseError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="paywall-error">
          {purchaseError}
        </Text>
      )}
      {!!fetchError && !fetching && !purchaseError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="paywall-status-error">
          {fetchError}
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
              <Text style={[styles.planTitle, { color: colors.text }]}>Yearly, best value</Text>
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
            <Text style={[styles.link, { color: colors.muted }]}>Continue with free renders</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 64, paddingBottom: 32 },
  kicker: { fontSize: 13, fontWeight: '700' },
  // The money moment gets the serif — commitment should feel like an atelier.
  title: { fontSize: 31, lineHeight: 37, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2, marginTop: 8 },
  counter: {
    borderRadius: 18,
    padding: 16,
    marginTop: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: '#F1E9ED',
    shadowColor: '#000000',
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  counterText: { fontSize: 20, lineHeight: 26, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  counterSub: { fontSize: 13, lineHeight: 18 },
  perks: { gap: 8, marginTop: 20 },
  perk: { fontSize: 15 },
  packsRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  packCard: { flex: 1, borderRadius: 16, padding: 14, gap: 2 },
  packTitle: { fontSize: 13, fontWeight: '700' },
  packPrice: { fontSize: 15, fontWeight: '700', fontFamily: 'Poppins_700Bold' },
  plansRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  planCard: { flex: 1, borderRadius: 16, padding: 14, gap: 2 },
  planTitle: { fontSize: 13, fontWeight: '700' },
  planPrice: { fontSize: 18, fontWeight: '700', fontFamily: 'Poppins_700Bold' },
  button: {
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
    shadowColor: '#000000',
    shadowOpacity: 0.34,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 5,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  trial: { fontSize: 13, textAlign: 'center', marginTop: 10 },
  plans: { fontSize: 12, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  error: { fontSize: 13, marginTop: 12, textAlign: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 20 },
  link: { fontSize: 13 },
  state: { paddingVertical: 16 },
});
