import { useCallback, useEffect, useRef, useState , useMemo } from 'react';
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
  // Tier-aware badge values: the free-lifetime mirror pinned premium users to
  // "0 of 5 left — Upgrade" while their monthly pool had renders remaining.
  const tier = usePaywall((s) => s.tier);
  const freeLeft = useQuotas((s) => s.rendersLeftFree());
  const monthlyUsed = usePaywall((s) => s.monthlyUsed);
  const monthlyCap = usePaywall((s) => s.monthlyCap);
  const rendersLeft = tier === 'free' ? freeLeft : Math.max(0, monthlyCap - monthlyUsed);
  const quotaCap = tier === 'free' ? 5 : monthlyCap;
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

  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['plan-day', today] });
    void queryClient.invalidateQueries({ queryKey: ['outfit-renders'] });
  }, [queryClient, today]);

  const outfit: PlannedOutfit | undefined = outfitQuery.data;

  // Style my week: 7 AI-planned outfits (text-only plan — free for everyone).
  // Monday-start week key, mirroring the reel's week.
  const [weekOpen, setWeekOpen] = useState(false);
  const monday = (() => {
    const d = new Date(today + 'T00:00:00Z');
    const shift = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - shift);
    return d.toISOString().slice(0, 10);
  })();
  const weekQuery = useQuery({
    queryKey: ['plan-week', monday],
    queryFn: () => api.planWeek({ startDate: monday }),
    staleTime: 1000 * 60 * 30,
    enabled: weekOpen,
  });
  const week = weekQuery.data ?? null;

  // Renders for today's outfit + week days: once a look is rendered, the hero
  // and strip show the USER wearing it — not a flat garment shot.
  const outfitIdsForRenders = useMemo(
    () =>
      [
        ...(outfit ? [outfit.id] : []),
        ...((week ?? []) as PlannedOutfit[]).map((d) => d.id),
      ].filter(Boolean),
    [outfit, week],
  );
  const outfitIdKey = outfitIdsForRenders.join(',');
  const rendersQuery = useQuery({
    queryKey: ['outfit-renders', outfitIdKey],
    queryFn: () => api.getOutfitRenders(outfitIdsForRenders),
    enabled: outfitIdKey.length > 0,
    staleTime: 1000 * 60 * 5,
  });
  const renders = rendersQuery.data ?? {};
  const heroRender = outfit ? renders[outfit.id] : undefined;
  // "Saved ✓" was sticky across outfit changes (day rollover / pull-to-refresh
  // showed Saved for an outfit never saved) — reset when the hero id changes.
  useEffect(() => {
    setSaved(false);
    setSaveError(null);
  }, [outfit?.id]);

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
        <QuotaBadge
          left={rendersLeft}
          cap={quotaCap}
          onPress={() => {
            if (tier === 'free') router.push('/onboarding/paywall');
          }}
        />
      </View>

      <PressScale
        style={[styles.weekCta, { backgroundColor: colors.text }]}
        onPress={() => {
          void hapticFor.select();
          setWeekOpen(true);
        }}
        testID="home-style-week"
      >
        <Text style={[styles.weekCtaText, { color: colors.background }]}>
          {week ? 'My week' : 'Style my week'}
        </Text>
      </PressScale>

      {weekOpen && weekQuery.isPending ? (
        <View style={styles.state} testID="week-loading">
          <Text style={[styles.stateText, { color: colors.muted }]}>Styling your week…</Text>
        </View>
      ) : null}

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
            imageUrl={heroRender?.outputUrl ?? null}
            garmentImages={outfitGarments
              .map((g) => g.cutoutUrl ?? g.imageUrl)
              .filter((u): u is string => typeof u === 'string' && u.length > 0)}
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
              disabled={saved}
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

      {week && week.length > 0 ? (
        <View style={[styles.weekStrip, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="week-strip">
          <Text style={[styles.weekTitle, { color: colors.text }]}>Your week</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.weekRow}>
            {(week as PlannedOutfit[]).map((d) => {
              const day = new Date(d.date + 'T00:00:00Z');
              const label = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][day.getUTCDay()] ?? '';
              const dayNum = day.getUTCDate();
              const dayRender = renders[d.id]?.outputUrl;
              const first = d.garmentIds
                .map((id) => garments.find((g) => g.id === id))
                .find((g) => g !== undefined);
              const img = dayRender ?? (first ? first.cutoutUrl ?? first.imageUrl : null);
              const isToday = d.date === today;
              return (
                <View key={d.date} style={[styles.dayCard, isToday && { borderColor: colors.primary, borderWidth: 2 }]} testID={`week-day-${d.date}`}>
                  <Text style={[styles.dayLabel, { color: isToday ? colors.primary : colors.muted }]}>
                    {label} {dayNum}
                  </Text>
                  <View style={[styles.dayImg, { backgroundColor: colors.well ?? colors.border }]}>
                    {img ? (
                      <Image source={{ uri: img }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={150} />
                    ) : (
                      <Text style={[styles.dayNone, { color: colors.muted }]}>—</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

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
  weekCta: { borderRadius: 999, paddingVertical: 15, alignItems: 'center', marginTop: 14 },
  weekCtaText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
  weekStrip: { marginTop: 18, borderRadius: 20, borderWidth: 1, padding: 14 },
  weekTitle: { fontSize: 15, fontWeight: '800', marginBottom: 10 },
  weekRow: { gap: 10, paddingRight: 8 },
  dayCard: { width: 74, borderRadius: 14, borderWidth: 1, borderColor: 'transparent', paddingTop: 6 },
  dayLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  dayImg: { width: '100%', aspectRatio: 3 / 4, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  dayNone: { fontSize: 18 },

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
