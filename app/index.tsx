import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSession, type OnboardingStep } from '@/store/session';

const STEP_ROUTE: Record<Exclude<OnboardingStep, 'done'>, string> = {
  carousel: '/onboarding',
  auth: '/onboarding/auth',
  quiz: '/onboarding/quiz',
  selfie: '/onboarding/selfie-capture',
  closet: '/onboarding/closet-min3',
  firstOutfit: '/onboarding/first-outfit',
  paywall: '/onboarding/paywall',
};

/** Cold-start gate: signed-out → onboarding carousel; signed-in → resume funnel step or tabs. */
export default function IndexGate() {
  const router = useRouter();
  const userId = useSession((s) => s.userId);
  const step = useSession((s) => s.onboardingStep);

  useEffect(() => {
    if (!userId) {
      router.replace('/onboarding');
    } else if (step === 'done') {
      router.replace('/(tabs)');
    } else {
      // Unknown persisted step (schema drift from an older build / corrupt
      // write) must never crash the boot gate with router.replace(undefined).
      const route = STEP_ROUTE[step as Exclude<OnboardingStep, 'done'>];
      router.replace((route ?? '/onboarding') as '/onboarding');
    }
  }, [router, userId, step]);

  return (
    <View style={styles.root} testID="index-gate">
      <ActivityIndicator size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4EFF2' },
});
