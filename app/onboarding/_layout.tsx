import { Stack } from 'expo-router';

/** Onboarding funnel: carousel → auth → quiz(4) → selfie → closet-min3 → first-outfit → paywall. */
export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="quiz" />
      <Stack.Screen name="selfie-capture" />
      <Stack.Screen name="closet-min3" />
      <Stack.Screen name="first-outfit" />
      <Stack.Screen name="paywall" />
    </Stack>
  );
}
