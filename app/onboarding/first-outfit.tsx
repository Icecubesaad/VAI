import { useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { EditorialReveal, OutfitCard, PressScale, SkeletonHero } from '@/components';
import { api, apiErrorCopy } from '@/lib/api';
import { hapticFor } from '@/lib/haptics';
import { useSession } from '@/store/session';
import { useCloset, selectClosetList } from '@/store/closet';
import { useQuiz } from '@/store/quiz';
import { usePaywall, shouldTriggerPaywall } from '@/store/paywall';
import { track } from '@/lib/analytics';
import { once as growthOnce } from '@/lib/growth';

/** Offline/AI-failure fallback: first 3 closet pieces + generic why-line. */
const FALLBACK_WHY = 'Starter look from your first pieces — AI styling refines as your closet grows.';

/**
 * First-outfit hero (aha moment). After seen → paywall gate:
 * quiz_done && closet>=3 && first_outfit_seen && !trial && !sub.
 */
export default function FirstOutfit() {
  const router = useRouter();
  const { colors } = useTheme();
  const garments = useCloset(selectClosetList);
  const count = useCloset((s) => s.order.length);
  const quizDone = useQuiz((s) => s.quizDone);
  const tier = usePaywall((s) => s.tier);
  const markSeen = useSession((s) => s.setFirstOutfitSeen);
  const setStep = useSession((s) => s.setOnboardingStep);

  const today = new Date().toISOString().slice(0, 10);
  const outfitQuery = useQuery({
    queryKey: ['plan-day', today],
    queryFn: () => api.planDay({ date: today }),
    staleTime: 1000 * 60 * 60,
  });

  const outfit = outfitQuery.data;
  const outfitGarments = (outfit?.garmentIds ?? [])
    .map((id) => garments.find((g) => g.id === id))
    .filter((g) => g !== undefined);

  // Fallback template when AI fails or returns nothing: never a dead end.
  // Closet items are local (MMKV) so this renders offline; Continue stays live.
  const fallbackImages = useMemo(
    () => garments.slice(0, 3).map((g) => g.cutoutUrl ?? g.imageUrl),
    [garments],
  );
  const showFallback = (outfitQuery.isError || (!outfitQuery.isPending && !outfit)) && fallbackImages.length > 0;

  // Activation event: the first AI-styled outfit lands (the aha moment).
  useEffect(() => {
    const uid = useSession.getState().userId;
    if (!uid || !(outfit || showFallback)) return;
    if (!growthOnce(`ahaOutfit.${uid}`)) return;
    track('aha_first_outfit', { user_id: uid, tier: 'free' });
  }, [outfit, showFallback]);

  const goBack = useCallback(() => {
    setStep('closet');
    router.replace('/onboarding/closet-min3');
  }, [router, setStep]);

  const goNext = useCallback(() => {
    markSeen();
    void hapticFor.confirm();
    const hit = shouldTriggerPaywall({
      quizDone,
      closetCount: count,
      firstOutfitSeen: true,
      tier,
    });
    if (hit) {
      usePaywall.getState().setPlacement('first_outfit');
      setStep('paywall');
      router.replace({ pathname: '/onboarding/paywall', params: { placement: 'first_outfit' } });
    } else {
      setStep('done');
      router.replace('/(tabs)');
    }
  }, [count, markSeen, quizDone, router, setStep, tier]);

  return (
    <View style={[styles.root, { backgroundColor: 'transparent' }]} testID="first-outfit">
      <MeshGradient variant="quiz" />
      <Text style={[styles.kicker, { color: colors.muted }]}>Your first outfit</Text>

      {outfitQuery.isPending && !showFallback ? (
        <View style={styles.state} testID="first-outfit-loading">
          <View style={{ width: '100%' }}>
            <SkeletonHero />
          </View>
          <Text style={[styles.body, { color: colors.muted }]}>
            Styling your first look from your {count} items…
          </Text>
        </View>
      ) : outfit ? (
        <EditorialReveal playKey={outfit.id}>
          <OutfitCard
            outfitId={outfit.id}
            garmentImages={outfitGarments.map((g) => g.cutoutUrl ?? g.imageUrl)}
            whyLine={outfit.whyLine}
            hero
          />
          <Text style={[styles.why, { color: colors.muted }]} testID="first-outfit-why">
            {outfit.whyLine}
          </Text>
        </EditorialReveal>
      ) : showFallback ? (
        <EditorialReveal playKey="local-fallback">
          <OutfitCard outfitId="local-fallback" garmentImages={fallbackImages} whyLine={FALLBACK_WHY} hero />
          <Text style={[styles.why, { color: colors.muted }]} testID="first-outfit-fallback">
            {outfitQuery.isError
              ? `${apiErrorCopy(outfitQuery.error).message} Showing your starter look instead — you can retry or continue.`
              : 'Starter look — not AI styled yet. Add a few more items and try again.'}
          </Text>
          {outfitQuery.isError && (
            <PressScale
              style={[styles.retry, { borderColor: colors.border, borderWidth: 1 }]}
              onPress={() => {
                void hapticFor.select();
                void outfitQuery.refetch();
              }}
              testID="first-outfit-retry"
            >
              <Text style={[styles.retryText, { color: colors.text }]}>Try again (free)</Text>
            </PressScale>
          )}
        </EditorialReveal>
      ) : (
        <View style={styles.state} testID="first-outfit-error">
          <Text style={[styles.title, { color: colors.text }]}>
            {outfitQuery.isError ? apiErrorCopy(outfitQuery.error).title : 'No outfit yet'}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            {outfitQuery.isError
              ? apiErrorCopy(outfitQuery.error).message
              : 'Starter look — not AI styled yet. Add a few more items and try again.'}
          </Text>
          {outfitQuery.isError && (
            <PressScale
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={() => {
                void hapticFor.select();
                void outfitQuery.refetch();
              }}
              testID="first-outfit-retry"
            >
              <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Try again (free)</Text>
            </PressScale>
          )}
        </View>
      )}

      <View>
        <PressScale
          style={[
            styles.button,
            { backgroundColor: outfit || showFallback ? colors.primary : colors.border },
          ]}
          onPress={goNext}
          disabled={!outfit && !showFallback}
          testID="first-outfit-continue"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Finish setup</Text>
        </PressScale>
        <Pressable onPress={goBack} testID="first-outfit-back">
          <Text style={[styles.back, { color: colors.muted }]}>Go back, items are kept</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64, justifyContent: 'space-between' },
  kicker: { fontSize: 13, fontWeight: '700' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2, textAlign: 'center' },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  // The stylist's verdict on the first outfit — italic serif pull-line.
  why: { fontSize: 16, lineHeight: 23, marginTop: 12, fontFamily: 'PlayfairDisplay_700Bold_Italic', textAlign: 'center' },
  state: { alignItems: 'center', gap: 12, paddingVertical: 48 },
  button: {
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#6645D9',
    shadowOpacity: 0.34,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 5,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  back: { fontSize: 14, textAlign: 'center', marginBottom: 16 },
  retry: { borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  retryText: { fontSize: 14, fontWeight: '600' },
});
