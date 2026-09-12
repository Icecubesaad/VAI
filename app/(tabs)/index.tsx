import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useTheme } from '@/theme';
import { OutfitCard, PressScale, QuotaBadge, SkeletonHero } from '@/components';
import { api, apiErrorCopy, type PlannedOutfit } from '@/lib/api';
import { track } from '@/lib/analytics';
import { hapticFor } from '@/lib/haptics';
import { tasteSeedPack } from '@/lib/ai/taste-seeds';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';
import { useTaste } from '@/store/taste';
import { useQuotas } from '@/store/quotas';
import { useCloset, selectClosetList } from '@/store/closet';
import { fetchPoseStatus, missingPoses, useReel } from '@/store/reel';

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/**
 * Planner home: 1 hero outfit/day (owned only), weather + event chips,
 * "Why this works" line, Try-on / Restyle / Save.
 * Free: 1 outfit + 1 restyle/day. Quota badge "X of 5 left".
 */
export default function PlannerHome() {  const router = useRouter();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const rendersLeft = useQuotas((s) => s.rendersLeftFree());
  const recordOutfitPlanned = useQuotas((s) => s.recordOutfitPlanned);
  const garments = useCloset(selectClosetList);

  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const outfitQuery = useQuery({
    queryKey: ['plan-day', today],
    queryFn: () => api.planDay({ date: today }),
    staleTime: 1000 * 60 * 60, // hero outfit is stable for the day
  });
  const tasteConnected = useTaste((s) => s.connected);
  const tasteBoards = useTaste((s) => s.boards);

  // Post-onboarding pose-pack nudge: one dismissible card until all 3
  // poses have an active photo. Cheap (1h stale) + persisted dismissal.
  const poseNudgeDismissed = useReel((s) => s.poseNudgeDismissed);
  const dismissPoseNudge = useReel((s) => s.dismissPoseNudge);
  const poseQuery = useQuery({
    queryKey: ['pose-status'],
    queryFn: fetchPoseStatus,
    staleTime: 1000 * 60 * 60,
  });
  const showPoseNudge =
    !poseNudgeDismissed &&
    !poseQuery.isPending &&
    !poseQuery.isError &&
    !!poseQuery.data &&
    missingPoses(poseQuery.data).length > 0;

  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['plan-day', today] });
    void queryClient.invalidateQueries({ queryKey: ['pose-status'] });
  }, [queryClient, today]);

  const outfit: PlannedOutfit | undefined = outfitQuery.data;
  const outfitGarments = (outfit?.garmentIds ?? [])
    .map((id) => garments.find((g) => g.id === id))
    .filter((g) => g !== undefined);

  // Pinterest taste seeds feed the plan (gate 10): once per planned outfit,
  // while taste is connected, derive the seed pack from the synced board
  // names (same extractor the planner prompt uses) and report the seeds that
  // biased this plan. Empty pack = seeds fed nothing → no event.
  const seedFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!outfit || !tasteConnected || tasteBoards.length === 0) return;
    if (seedFiredRef.current === outfit.id) return;
    const pack = tasteSeedPack({ boardName: tasteBoards.map((b) => b.name).join(' ') });
    if (pack.tags.length === 0) return;
    const uid = useSession.getState().userId;
    if (!uid) return;
    seedFiredRef.current = outfit.id;
    const firstBoard = tasteBoards[0]?.name;
    track('taste_seed_applied', {
      user_id: uid,
      tier: toAnalyticsTier(usePaywall.getState().tier),
      seed_count: pack.tags.length,
      ...(firstBoard ? { board: firstBoard } : {}),
    });
  }, [outfit, tasteConnected, tasteBoards]);

  const handleSave = useCallback(() => {
    setSaveError(null);
    try {
      recordOutfitPlanned();
      setSaved(true);
      void hapticFor.done();
    } catch {
      setSaveError('Could not save this outfit. Please try again.');
    }
  }, [recordOutfitPlanned]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={outfitQuery.isFetching} onRefresh={onRefresh} />}
      testID="planner-home"
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Today&apos;s outfit</Text>
        <QuotaBadge left={rendersLeft} cap={5} onPress={() => router.push('/onboarding/paywall')} />
      </View>

      {showPoseNudge && (
        <View
          style={[styles.nudge, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="pose-nudge"
        >
          <Text style={[styles.nudgeText, { color: colors.text }]}>
            Your weekly reel needs {missingPoses(poseQuery.data!).length} more{' '}
            {missingPoses(poseQuery.data!).length === 1 ? 'pose' : 'poses'} — capture the pose pack
            for full-body looks.
          </Text>
          <View style={styles.nudgeRow}>
            <PressScale
              style={[styles.nudgeCta, { backgroundColor: colors.primary }]}
              onPress={() => {
                void hapticFor.select();
                router.push('/pose-pack');
              }}
              testID="pose-nudge-cta"
            >
              <Text style={[styles.nudgeCtaText, { color: colors.onPrimary }]}>Capture poses</Text>
            </PressScale>
            <Pressable onPress={dismissPoseNudge} hitSlop={12} testID="pose-nudge-dismiss">
              <Text style={[styles.nudgeDismiss, { color: colors.muted }]}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      )}

      {outfitQuery.isPending ? (
        <View style={styles.state} testID="home-loading">
          <View style={{ width: '100%' }}>
            <SkeletonHero />
          </View>
          <Text style={[styles.stateText, { color: colors.muted }]}>Planning your outfit…</Text>
        </View>
      ) : outfitQuery.isError ? (
        <View style={styles.state} testID="home-error">
          <Text style={[styles.stateTitle, { color: colors.text }]}>
            {apiErrorCopy(outfitQuery.error).title}
          </Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            {apiErrorCopy(outfitQuery.error).message}
          </Text>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => void outfitQuery.refetch()}
            testID="home-retry"
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Try again</Text>
          </Pressable>
        </View>
      ) : !outfit ? (
        <View style={styles.state} testID="home-empty">
          <Text style={[styles.stateTitle, { color: colors.text }]}>No outfit yet</Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Add at least 3 closet items and we&apos;ll plan your first look.
          </Text>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)/closet')}
            testID="home-empty-cta"
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Build my closet</Text>
          </Pressable>
        </View>
      ) : (
        <View testID="home-hero">
          <View style={styles.chips}>
            {!!outfit.weatherSummary && (
              <View style={[styles.chip, { borderColor: colors.border }]} testID="weather-chip">
                <Text style={[styles.chipText, { color: colors.text }]}>{outfit.weatherSummary}</Text>
              </View>
            )}
            {!!outfit.eventLabel && (
              <View style={[styles.chip, { borderColor: colors.border }]} testID="event-chip">
                <Text style={[styles.chipText, { color: colors.text }]}>{outfit.eventLabel}</Text>
              </View>
            )}
          </View>

          <OutfitCard
            outfitId={outfit.id}
            garmentImages={outfitGarments.map((g) => g.cutoutUrl ?? g.imageUrl)}
            whyLine={outfit.whyLine}
          />

          <Text style={[styles.why, { color: colors.muted }]} testID="why-line">
            {outfit.whyLine}
          </Text>

          <View style={styles.actions}>
            <PressScale
              style={[styles.button, { backgroundColor: colors.primary }]}
              // Forward the REAL plan-day outfit row (P0-1): the try-on
              // screen sends this id only when its garment set still equals
              // the selection — otherwise it falls back to garment_refs.
              onPress={() => {
                void hapticFor.select();
                router.push({
                  pathname: '/(tabs)/tryon',
                  params: {
                    outfitId: outfit.id,
                    garmentIds: outfit.garmentIds.join(','),
                  },
                });
              }}
              testID="home-tryon"
            >
              <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Try on</Text>
            </PressScale>
            <PressScale
              style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
              onPress={() => {
                void hapticFor.select();
                router.push('/(tabs)/tryon');
              }}
              testID="home-restyle"
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>Restyle</Text>
            </PressScale>
            <PressScale
              style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
              onPress={handleSave}
              testID="home-save"
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>
                {saved ? 'Saved ✓' : 'Save'}
              </Text>
            </PressScale>
          </View>
          {!!saveError && (
            <View style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.error, { color: colors.danger }]}>{saveError}</Text>
            </View>
          )}

          {/* Owned-garment thumbnails for transparency */}
          <View style={styles.thumbs}>
            {outfitGarments.map((g) => (
              <Image
                key={g.id}
                source={{ uri: g.cutoutUrl ?? g.imageUrl }}
                style={styles.thumb}
                contentFit="cover"
                accessibilityLabel={`${g.category} garment`}
              />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '700', fontFamily: 'Georgia' },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13 },
  why: { fontSize: 14, lineHeight: 20, marginTop: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  button: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13, lineHeight: 18 },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8 },
  nudge: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12, gap: 10 },
  nudgeText: { fontSize: 14, lineHeight: 20 },
  nudgeRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  nudgeCta: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center' },
  nudgeCtaText: { fontSize: 14, fontWeight: '700' },
  nudgeDismiss: { fontSize: 14, fontWeight: '600' },
  thumbs: { flexDirection: 'row', gap: 8, marginTop: 16, flexWrap: 'wrap' },
  thumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#EDE8E0' },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 18, fontWeight: '600' },
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
});
