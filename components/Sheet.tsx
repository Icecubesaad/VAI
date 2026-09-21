import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { hapticFor } from '../lib/haptics';
import { PremiumCTA } from './Button';
import { PressScale } from './PressScale';

export type PaywallPlan = 'monthly' | 'yearly';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  onPurchase: (plan: PaywallPlan, withTrial: boolean) => void;
  onRestore: () => void;
  /** Analytics placement, e.g. 'aha-peak' | 'quota-exhausted' | 'settings' */
  placement?: string;
  initialPlan?: PaywallPlan;
  purchasing?: boolean;
  restoring?: boolean;
  testID?: string;
};

export const PLAN_META: Record<PaywallPlan, { id: string; title: string; price: string; perMonth: string }> = {
  monthly: { id: 'vai_premium_monthly', title: 'Monthly', price: '$4.99/mo', perMonth: '$4.99 per month' },
  yearly: { id: 'vai_premium_yearly', title: 'Yearly', price: '$39.99/yr', perMonth: '$3.33 per month' },
};

/** Honest same-screen trial copy (pack §7/§9) — varies by selected plan. */
export function trialLine(plan: PaywallPlan, withTrial: boolean): string {
  if (!withTrial) return plan === 'monthly' ? 'Starts today · $4.99/mo · cancel anytime' : 'Starts today · $39.99/yr · cancel anytime';
  return plan === 'monthly'
    ? '7 days free, then $4.99/mo · cancel anytime · no charge today'
    : '7 days free, then $39.99/yr · cancel anytime · no charge today';
}

const BENEFITS: string[] = [
  '30 AI try-ons a month (~1 a day)',
  'Priority render queue',
  'Restyle loop — refine any look',
  'Closet gap analysis + shop picks',
  'Cancel anytime, keep all your data',
];

const PlanCard = memo(function PlanCard({
  plan,
  selected,
  onSelect,
  disabled = false,
  testID,
}: {
  plan: PaywallPlan;
  selected: boolean;
  onSelect: (p: PaywallPlan) => void;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const meta = PLAN_META[plan];
  const isYearly = plan === 'yearly';
  return (
    <PressScale
      testID={testID ?? `paywall-plan-${plan}`}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`${meta.title}, ${meta.price}${isYearly ? ', best value' : ''}${selected ? ', selected' : ''}`}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        void hapticFor.select();
        onSelect(plan);
      }}
      className={`flex-1 rounded-lg border-2 p-md active:opacity-90 ${
        selected ? 'border-terracotta bg-terracottaWash/40' : 'border-line bg-card'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <View className="flex-row items-center justify-between">
        <Text className={`text-[15px] font-bold ${selected ? 'text-terracottaDeep' : 'text-ink'}`}>
          {meta.title}
        </Text>
        {isYearly ? (
          <View className="rounded-pill bg-goldWash px-sm py-[2px]">
            <Text className="text-[11px] font-bold text-gold">Best value</Text>
          </View>
        ) : null}
      </View>
      <Text className="mt-[2px] text-[17px] font-bold text-ink">{meta.price}</Text>
      <Text className="text-[12px] text-inkSoft">{meta.perMonth}</Text>
    </PressScale>
  );
});

/**
 * Paywall bottom-sheet. CORRECTED caps only (pack §7): 30 renders/mo,
 * never "unlimited"; $39.99/yr floor. Trial terms on the same screen
 * as the offer (store compliance §9). Memoized; slide/fade use the
 * native driver; lists are static so there is no scroll jank.
 */
export const Sheet = memo(function Sheet({
  visible,
  onClose,
  onPurchase,
  onRestore,
  initialPlan = 'yearly',
  purchasing = false,
  restoring = false,
  testID,
}: SheetProps): React.JSX.Element {
  const [plan, setPlan] = useState<PaywallPlan>(initialPlan);
  const [withTrial, setWithTrial] = useState(true);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  const handleSelect = useCallback((p: PaywallPlan) => setPlan(p), []);
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View testID={testID ?? 'paywall-sheet'} className="flex-1 justify-end bg-scrim">
        <Pressable
          testID="paywall-dismiss-cta"
          accessibilityRole="button"
          accessibilityLabel="Dismiss paywall"
          disabled={purchasing}
          onPress={onClose}
          className="absolute inset-0"
        />
        <Animated.View
          style={{ transform: [{ translateY }] }}
          className="max-h-[92%] rounded-t-xl bg-paper pb-2xl pt-sm"
          accessible
          accessibilityRole="alert"
          accessibilityLabel="VAI Premium paywall"
        >
          <View className="mx-auto mb-sm h-[5px] w-[40px] rounded-pill bg-line" aria-hidden />
          <SafeAreaView edges={['bottom']}>
          <ScrollView contentContainerClassName="gap-y-lg px-xl pb-md" showsVerticalScrollIndicator={false}>
            <View className="gap-y-[4px]">
              <Text className="font-display text-[30px] leading-[36px] font-semibold text-ink">VAI Premium</Text>
              <Text className="text-[16px] font-semibold leading-[24px] text-terracotta">
                {withTrial ? 'Start your 7-day free trial' : 'Unlock your full wardrobe'}
              </Text>
            </View>

            <View className="gap-y-[10px]">
              {BENEFITS.map((b) => (
                <View key={b} className="flex-row items-start gap-x-sm">
                  <Text className="text-[15px] font-bold text-sage" aria-hidden>
                    ✓
                  </Text>
                  <Text className="flex-1 text-[15px] leading-[22px] text-ink">{b}</Text>
                </View>
              ))}
            </View>

            <View className="flex-row gap-x-sm">
              <PlanCard plan="monthly" selected={plan === 'monthly'} onSelect={handleSelect} disabled={purchasing} />
              <PlanCard plan="yearly" selected={plan === 'yearly'} onSelect={handleSelect} disabled={purchasing} />
            </View>

            <View className="flex-row items-center justify-between rounded-lg border border-line bg-card px-md py-sm">
              <View className="flex-1 gap-y-[2px] pr-sm">
                <Text className="text-[15px] font-semibold text-ink">7-day free trial</Text>
                <Text className="text-[13px] leading-[18px] text-inkSoft">Card required · reminder on day 5</Text>
              </View>
              <Switch
                value={withTrial}
                disabled={purchasing}
                onValueChange={(v) => {
                  void hapticFor.select();
                  setWithTrial(v);
                }}
                trackColor={{ true: '#3A2331', false: '#2C252C' }}
                accessibilityRole="switch"
                accessibilityLabel="7-day free trial"
                accessibilityState={{ checked: withTrial, disabled: purchasing }}
              />
            </View>

            <View className="gap-y-sm">
              <PremiumCTA
                title={withTrial ? 'Start free trial' : `Get Premium ${PLAN_META[plan].price}`}
                onPress={() => onPurchase(plan, withTrial)}
                loading={purchasing}
                testID="paywall-purchase"
              />
              {/* Trial terms on the SAME screen as the offer (§9). */}
              <Text className="text-center text-[13px] leading-[18px] text-inkSoft">{trialLine(plan, withTrial)}</Text>
            </View>

            <View className="flex-row items-center justify-center gap-x-lg">
              <PressScale
                testID="paywall-restore-cta"
                accessibilityRole="button"
                accessibilityLabel="Restore purchases"
                accessibilityState={{ disabled: restoring, busy: restoring }}
                disabled={restoring}
                hitSlop={12}
                onPress={() => {
                  void hapticFor.select();
                  onRestore();
                }}
                className={`py-sm active:opacity-70 ${restoring ? 'opacity-50' : ''}`}
              >
                <Text className="text-[14px] font-semibold text-ink underline">
                  {restoring ? 'Restoring…' : 'Restore purchases'}
                </Text>
              </PressScale>
              <PressScale
                testID="paywall-privacy-cta"
                accessibilityRole="link"
                accessibilityLabel="Privacy policy"
                hitSlop={12}
                onPress={() => void Linking.openURL('https://vai.style/privacy')}
                className="py-sm active:opacity-70"
              >
                <Text className="text-[14px] text-inkSoft underline">Privacy</Text>
              </PressScale>
              <PressScale
                testID="paywall-terms-cta"
                accessibilityRole="link"
                accessibilityLabel="Terms of service"
                hitSlop={12}
                onPress={() => void Linking.openURL('https://vai.style/terms')}
                className="py-sm active:opacity-70"
              >
                <Text className="text-[14px] text-inkSoft underline">Terms</Text>
              </PressScale>
            </View>
            <Text className="text-center text-[12px] leading-[16px] text-muted">
              Downgrading keeps everything — extra items become read-only until you upgrade.
            </Text>
          </ScrollView>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
});

/** Alias the frontend may import — same component, monetization name. */
export const PaywallSheet = Sheet;
