import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, tokenColors } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { PressScale, QuotaBadge, SkeletonHero, InspirationStrip } from '@/components';
import { LookCard } from '@/components/LookCard';
import { Icon } from '@/components/icons';
import { api, apiErrorCopy, type PlannedOutfit, type ReelCard as ReelCardData } from '@/lib/api';
import { track } from '@/lib/analytics';
import { hapticFor } from '@/lib/haptics';
import { comboKey, comboLabel, buildCombos, type Occasion } from '@/lib/outfit-combos';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';
import { useQuotas } from '@/store/quotas';
import { useCloset, selectClosetList } from '@/store/closet';
import { useReel } from '@/store/reel';
import { useComboRenders } from '@/store/combos';

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

const OCCASIONS: Array<{ key: Occasion | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'casual', label: 'Casual' },
  { key: 'office', label: 'Office' },
  { key: 'party', label: 'Party' },
  { key: 'sport', label: 'Sport' },
];

interface FeedEntry {
  key: string;
  garmentIds: string[];
  label: string;
  /** AI picture of the user in this combo (null → collage + render chip). */
  uri: string | null;
  isToday: boolean;
  occasion: Occasion;
  onPress: () => void;
  onSave?: () => void;
  saved?: boolean;
}

/**
 * Home — "Find your best outfit" (inspo: uppercase occasion tabs, uniform
 * white look cards in a two-column grid, hero outfit pinned on top). Every
 * card is YOU wearing a combo from your closet (finished renders first;
 * unbuilt combos show the pieces with a render affordance). The planner hero
 * pins full-width above the grid, keeping the plan → try-on loop front-page.
 */
export default function PlannerHome() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
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
  const [occasion, setOccasion] = useState<Occasion | 'all'>('all');
  // "What's today?" — optional event label the planner dresses for
  // (dinner, interview, gym…). Sent as `occasion` to plan-day; empty =
  // everyday default. Part of the plan query key so changing it re-plans.
  const [todayEvent, setTodayEvent] = useState('');

  const today = new Date().toISOString().slice(0, 10);
  const outfitQuery = useQuery({
    // Weather: no expo-location in this build, so the server falls back to
    // 20°C default (plan.ts getWeather). When location lands, add lat/lon
    // here + to the key — the wire already supports it.
    queryKey: ['plan-day', today, todayEvent.trim() || null],
    queryFn: () =>
      api.planDay({
        date: today,
        ...(todayEvent.trim() ? { eventLabel: todayEvent.trim() } : {}),
      }),
    staleTime: 1000 * 60 * 60, // hero outfit is stable for the day
  });

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

  // Renders for today's outfit + week days: once a look is rendered, the
  // cards show the USER wearing it — not a flat garment shot.
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

  // "Saved ✓" was sticky across outfit changes (day rollover / pull-to-refresh
  // showed Saved for an outfit never saved) — reset when the hero id changes.
  useEffect(() => {
    setSaved(false);
    setSaveError(null);
  }, [outfit?.id]);

  const outfitGarments = (outfit?.garmentIds ?? [])
    .map((id) => garments.find((g) => g.id === id))
    .filter((g) => g !== undefined);

  // -- feed: combos from the closet, dressed with every real render ---------
  const reelDrop = useReel((s) => s.drop);
  const savedIds = useReel((s) => s.savedIds);
  const toggleSaveReel = useReel((s) => s.toggleSave);
  const comboRenders = useComboRenders((s) => s.renders);

  // Weekly-drop looks that match a combo by garment set become feed renders.
  useEffect(() => {
    if (!reelDrop) return;
    const entries: Record<string, { url: string; renderId: string }> = {};
    for (const c of reelDrop.cards) {
      if (c.imageUrl) entries[comboKey(c.garmentIds)] = { url: c.imageUrl, renderId: c.renderId };
    }
    if (Object.keys(entries).length > 0) useComboRenders.getState().seed(entries);
  }, [reelDrop]);

  const combos = useMemo(() => buildCombos(garments), [garments]);
  const planComboKey = outfit ? comboKey(outfit.garmentIds) : null;

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

  const entries = useMemo<FeedEntry[]>(() => {
    const list: FeedEntry[] = [];
    if (outfit) {
      const uri = renders[outfit.id]?.outputUrl ?? comboRenders[planComboKey ?? '']?.url ?? null;
      list.push({
        key: `plan-${outfit.id}`,
        garmentIds: outfit.garmentIds,
        label: comboLabel(outfit.garmentIds, garments),
        uri,
        isToday: true,
        occasion: 'casual',
        onPress: () => {
          void hapticFor.select();
          router.push({
            pathname: '/(tabs)/tryon',
            params: {
              outfitId: outfit.id,
              garmentIds: outfit.garmentIds.join(','),
            },
          });
        },
        onSave: handleSave,
        saved,
      });
    }
    for (const c of combos) {
      if (c.id === planComboKey) continue;
      const reelMatch = (reelDrop?.cards ?? []).find(
        (rc: ReelCardData) => rc.imageUrl && rc.garmentIds.length === c.garmentIds.length && comboKey(rc.garmentIds) === c.id,
      );
      const uri = comboRenders[c.id]?.url ?? null;
      list.push({
        key: c.id,
        garmentIds: c.garmentIds,
        label: c.label,
        uri,
        isToday: false,
        occasion: c.occasion,
        onPress: () => {
          void hapticFor.select();
          router.push({
            pathname: '/(tabs)/tryon',
            params: { garmentIds: c.garmentIds.join(',') },
          });
        },
        onSave: reelMatch
          ? () => {
              if (!(savedIds[c.id] === true)) void hapticFor.done();
              toggleSaveReel(c.id);
            }
          : undefined,
        saved: reelMatch ? savedIds[c.id] === true : false,
      });
    }
    // Finished looks of you first, then the unrendered rack.
    return list
      .sort((a, b) => Number(b.uri !== null) - Number(a.uri !== null))
      .sort((a, b) => Number(b.isToday) - Number(a.isToday));
  }, [outfit, renders, comboRenders, planComboKey, garments, combos, reelDrop, savedIds, toggleSaveReel, router, handleSave, saved]);

  const visible = useMemo(
    () => (occasion === 'all' ? entries : entries.filter((e) => e.isToday || e.occasion === occasion)),
    [entries, occasion],
  );

  // The hero is TODAY'S render of the user wearing the plan — pulled out of
  // the feed entirely so it can take the full-bleed cover slot. The grid
  // below only carries the other ways to wear the closet.
  const heroEntry = useMemo(() => visible.find((e) => e.isToday) ?? null, [visible]);
  const gridEntries = useMemo(() => visible.filter((e) => !e.isToday), [visible]);

  // Two balanced columns for the masonry.
  const columns = useMemo(() => {
    const left: FeedEntry[] = [];
    const right: FeedEntry[] = [];
    gridEntries.forEach((e, i) => (i % 2 === 0 ? left : right).push(e));
    return [left, right];
  }, [gridEntries]);

  const garmentUris = useCallback(
    (ids: string[]) =>
      ids
        .map((id) => garments.find((g) => g.id === id))
        .filter((g): g is NonNullable<typeof g> => g !== undefined)
        .map((g) => g.cutoutUrl ?? g.imageUrl)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    [garments],
  );

  const hasClosetBase = garments.length >= 3;

  const renderCell = (e: FeedEntry) => (
    <View key={e.key} style={styles.cell}>
      <LookCard
        uri={e.uri}
        fallbackUris={garmentUris(e.garmentIds)}
        label={e.label}
        aspect={e.uri ? 3 / 4 : 1}
        isToday={false}
        saved={e.saved}
        onSave={e.onSave}
        onPress={e.onPress}
        testID={`home-look-${e.key.slice(0, 8)}`}
      />
    </View>
  );

  const dateLabel = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <View style={styles.root} testID="planner-home">
      <MeshGradient variant="home" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}
        refreshControl={<RefreshControl refreshing={outfitQuery.isFetching} onRefresh={onRefresh} />}
        testID="planner-home-scroll"
      >
        {/* Cover masthead: the date as an italic-serif line, hairline rule,
            then the headline as the cover line. Quota + profile stay quiet. */}
        <View style={styles.headerTop}>
          <Text style={styles.dateLine}>{dateLabel}</Text>
          <View style={styles.headerRight}>
            <QuotaBadge
              left={rendersLeft}
              cap={quotaCap}
              onPress={() => {
                if (tier === 'free') {
                  router.push({ pathname: '/onboarding/paywall', params: { placement: 'home' } });
                }
              }}
            />
            <Pressable
              onPress={() => router.push('/profile')}
              testID="home-profile"
              accessibilityRole="button"
              accessibilityLabel="Open profile and settings"
              hitSlop={10}
              style={styles.profileHit}
            >
              <Icon name="profile" color={tokenColors.ink} size={22} />
            </Pressable>
          </View>
        </View>
        <View style={styles.mastheadRule} />

        {/* THE COVER — you, wearing today's plan. Full-bleed 4:5, glass chips
            on the photo, the stylist's why-line over the scrim. No render
            yet: the pieces compose the card and the CTA is the point. */}
        {!outfitQuery.isPending && !outfitQuery.isError && hasClosetBase && heroEntry ? (
          <View style={styles.heroWrap} testID="home-hero">
            <PressScale
              scaleTo={0.98}
              onPress={heroEntry.onPress}
              style={[styles.heroCard, !heroEntry.uri ? styles.heroCardDark : null]}
              testID="home-tryon"
              accessibilityRole="button"
              accessibilityLabel={`Today's outfit, ${heroEntry.label}. Open the changing room.`}
            >
              {heroEntry.uri ? (
                <Image
                  source={{ uri: heroEntry.uri }}
                  style={styles.heroMedia}
                  contentFit="cover"
                  transition={250}
                  accessibilityLabel="AI photo of you wearing today's outfit"
                />
              ) : (
                <View style={[styles.heroMedia, styles.heroCollage]} testID="home-hero-collage">
                  <View style={styles.heroCollageGlow} aria-hidden />
                  {garmentUris(heroEntry.garmentIds).slice(0, 2).map((u, i) => (
                    <Image
                      key={u}
                      source={{ uri: u }}
                      style={[styles.heroCollageImg, i === 1 ? styles.heroCollageSecond : null]}
                      contentFit="contain"
                      transition={150}
                    />
                  ))}
                </View>
              )}

              {/* top glass chips: Today · weather · event */}
              <View style={styles.heroChipsRow}>
                <View style={styles.heroChipToday}>
                  <Text style={styles.heroChipTodayText}>Today</Text>
                </View>
                {!!outfit?.weatherSummary && (
                  <View style={styles.heroChipGlass} testID="weather-chip">
                    <Text style={styles.heroChipGlassText}>{outfit.weatherSummary}</Text>
                  </View>
                )}
                {!!outfit?.eventLabel && (
                  <View style={styles.heroChipGlass} testID="event-chip">
                    <Text style={styles.heroChipGlassText}>{outfit.eventLabel}</Text>
                  </View>
                )}
              </View>
              {heroEntry.onSave ? (
                <PressScale
                  scaleTo={0.88}
                  hitSlop={10}
                  onPress={heroEntry.onSave}
                  style={styles.heroHeart}
                  testID="home-hero-save"
                  accessibilityRole="button"
                  accessibilityLabel={heroEntry.saved ? 'Remove from saved looks' : "Save today's look"}
                  accessibilityState={{ selected: heroEntry.saved }}
                >
                  <Icon
                    name={heroEntry.saved ? 'heartSolid' : 'heart'}
                    color={heroEntry.saved ? '#E34D78' : '#FFFFFF'}
                    size={19}
                    strokeWidth={2}
                  />
                </PressScale>
              ) : null}

              {/* bottom: scrim → label → why-line → CTA */}
              <LinearGradient
                pointerEvents="none"
                colors={['rgba(18,12,34,0)', 'rgba(18,12,34,0.52)', 'rgba(18,12,34,0.85)']}
                locations={[0, 0.45, 1]}
                style={styles.heroScrim}
              />
              <View style={styles.heroOverlay}>
                <Text style={styles.heroLabel} numberOfLines={1}>
                  {heroEntry.label}
                </Text>
                {!!outfit?.whyLine ? (
                  <Text style={styles.heroWhy} numberOfLines={2} testID="why-line">
                    {outfit.whyLine}
                  </Text>
                ) : null}
                <View style={[styles.heroCta, !heroEntry.uri ? styles.heroCtaViolet : null]}>
                  <Text style={[styles.heroCtaText, !heroEntry.uri ? styles.heroCtaTextViolet : null]}>
                    {heroEntry.uri ? 'Open the changing room' : 'See it on you'}
                  </Text>
                  <Icon name="tryon" color={heroEntry.uri ? tokenColors.stage : '#FFFFFF'} size={16} strokeWidth={2} />
                </View>
              </View>
            </PressScale>
            {heroEntry.onSave ? (
              <PressScale
                scaleTo={0.88}
                hitSlop={10}
                onPress={heroEntry.onSave}
                style={styles.heroHeart}
                testID="home-hero-save"
                accessibilityRole="button"
                accessibilityLabel={heroEntry.saved ? 'Remove from saved looks' : "Save today's look"}
                accessibilityState={{ selected: heroEntry.saved }}
              >
                <Icon
                  name={heroEntry.saved ? 'heartSolid' : 'heart'}
                  color={heroEntry.saved ? '#E34D78' : '#FFFFFF'}
                  size={19}
                  strokeWidth={2}
                />
              </PressScale>
            ) : null}
          </View>
        ) : null}

        {/* occasion filters + style my week */}
        <Pressable
          onPress={() => {
            // Inline event toggle: tap to set today's occasion, tap again to
            // clear. No keyboard, no modal — one tap re-plans the hero.
            void hapticFor.select();
            setTodayEvent((prev) => (prev ? '' : 'Night out'));
          }}
          testID="home-today-event"
          accessibilityRole="button"
          accessibilityState={{ selected: todayEvent.trim().length > 0 }}
          accessibilityLabel={
            todayEvent ? `Today is ${todayEvent}. Tap to clear.` : "What's today? Tap for a night-out plan."
          }
          style={[styles.eventToggle, todayEvent ? { backgroundColor: tokenColors.oxblood } : null]}
        >
          <Icon name="sparkles" color={todayEvent ? '#FFFFFF' : tokenColors.oxblood} size={14} strokeWidth={1.9} />
          <Text style={[styles.eventToggleText, todayEvent ? styles.eventToggleTextOn : null]}>
            {todayEvent ? `Today: ${todayEvent}` : "What's today?"}
          </Text>
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          testID="home-filters"
        >
          {OCCASIONS.map((o) => {
            const active = occasion === o.key;
            return (
              <Pressable
                key={o.key}
                onPress={() => {
                  void hapticFor.select();
                  setOccasion(o.key);
                }}
                style={styles.filterHit}
                testID={`home-filter-${o.key}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${o.label === 'All' ? 'all looks' : o.label + ' looks'}`}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{o.label}</Text>
                {active ? <View style={styles.filterUnderline} /> : null}
              </Pressable>
            );
          })}
          <PressScale
            scaleTo={0.95}
            onPress={() => {
              void hapticFor.select();
              setWeekOpen(true);
            }}
            style={styles.weekChip}
            testID="home-style-week"
            accessibilityRole="button"
            accessibilityLabel="Style my week"
          >
            <Icon name="sparkles" color={tokenColors.oxblood} size={14} strokeWidth={1.9} />
            <Text style={styles.weekChipText}>{week ? 'My week' : 'Style my week'}</Text>
          </PressScale>
        </ScrollView>

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
        ) : !hasClosetBase ? (
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
        ) : gridEntries.length === 0 ? (
          <View style={styles.state} testID="home-empty-filter">
            <Text style={[styles.stateTitle, { color: colors.text }]}>Nothing here yet</Text>
            <Text style={[styles.stateText, { color: colors.muted }]}>
              No {occasion} looks beyond today's — try another filter.
            </Text>
          </View>
        ) : (
          <View testID="home-grid">
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {heroEntry ? 'More ways to wear it' : 'Ways to wear your closet'}
            </Text>
            <View style={styles.grid}>
              {columns.map((col, ci) => (
                <View key={ci} style={styles.column}>
                  {col.map(renderCell)}
                </View>
              ))}
            </View>
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

        {!!saveError && (
          <View style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.error, { color: colors.danger }]}>{saveError}</Text>
          </View>
        )}

        {/* Static inspiration rack (pre-AI stand-in for the Pinterest scrape).
            Tapping a vibe re-plans the hero toward it — same path as the
            "What's today?" toggle, so the strip is functional on day one. */}
        <InspirationStrip
          onPick={(tag) => {
            void hapticFor.select();
            setTodayEvent(tag);
          }}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 20 },

  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  profileHit: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // THE COVER — full-bleed 4:5, near-sharp media radius, plum-dyed lift.
  // THE COVER — edge-to-edge media (bleeds past the 20px gutter), near-sharp.
  // The photo owns the screen; nothing between masthead and cover but air.
  heroWrap: { marginTop: 6, marginHorizontal: -20, position: 'relative' },
  heroCard: {
    width: '100%',
    aspectRatio: 4 / 5,
    overflow: 'hidden',
    backgroundColor: tokenColors.well,
  },
  // Unrendered: the card goes to the dark studio stage — plum-black, spotlit
  // pieces, violet CTA. The empty state IS the dramatic moment, and it shares
  // the reel/changing-room language.
  heroCardDark: { backgroundColor: tokenColors.stage },
  heroMedia: { width: '100%', height: '100%' },
  heroCollage: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingBottom: 110, // clears the scrim zone so pieces sit optically centered
  },
  heroCollageGlow: {
    position: 'absolute',
    top: '10%',
    left: '14%',
    width: '72%',
    height: '58%',
    borderRadius: 999,
    backgroundColor: 'rgba(139,108,242,0.26)',
  },
  heroCollageImg: { width: '56%', height: '58%' },
  heroCollageSecond: { width: '36%', height: '40%', marginLeft: -12 },
  heroChipsRow: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 56,
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  heroChipToday: {
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  heroChipTodayText: { color: tokenColors.ink, fontSize: 11, lineHeight: 14, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  heroChipGlass: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  heroChipGlassText: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  heroHeart: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(18,12,34,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  heroScrim: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '55%' },
  heroOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20 },
  heroLabel: { color: 'rgba(255,255,255,0.82)', fontSize: 13, lineHeight: 17, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  // The stylist's line on the cover — italic serif over the photo scrim.
  heroWhy: {
    color: '#FFFFFF',
    fontSize: 19,
    lineHeight: 25,
    fontFamily: 'PlayfairDisplay_700Bold_Italic',
    marginTop: 4,
    textShadowColor: 'rgba(18,12,34,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  heroCta: {
    marginTop: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingVertical: 13,
    paddingHorizontal: 20,
  },
  heroCtaViolet: { backgroundColor: tokenColors.terracottaDeep },
  heroCtaText: { color: tokenColors.stage, fontSize: 14, lineHeight: 18, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  heroCtaTextViolet: { color: '#FFFFFF' },

  sectionTitle: {
    fontSize: 21,
    lineHeight: 26,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: -0.2,
    marginTop: 24,
    marginBottom: 12,
  },
  // Masthead date — italic serif, sentence case, plum. No pill box: the date
  // is a line of copy, not chrome.
  dateLine: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: 'PlayfairDisplay_700Bold_Italic',
    color: tokenColors.oxblood,
  },
  // The cover rule — one hairline separating masthead from cover line.
  mastheadRule: {
    height: 1,
    backgroundColor: tokenColors.line,
    marginBottom: 16,
  },

  // Filter tabs: sentence-case text tabs with an underline on the active tab —
  // editorial nav, not pill boxes and never ALL-CAPS (a templated tell).
  filterRow: { gap: 2, paddingVertical: 12, paddingRight: 20, alignItems: 'center' },
  // "What's today?" toggle — reuses the week-chip pill language so the two
  // planner affordances read as one family. Active = filled plum.
  eventToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    marginTop: 10,
    backgroundColor: tokenColors.oxbloodWash,
    borderWidth: 1,
    borderColor: 'rgba(74,44,146,0.25)',
  },
  eventToggleText: { fontSize: 13, lineHeight: 17, fontWeight: '600', fontFamily: 'Poppins_600SemiBold', color: tokenColors.oxblood },
  eventToggleTextOn: { color: '#FFFFFF' },
  filterHit: { paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  filterText: { fontSize: 14, lineHeight: 19, fontWeight: '500', fontFamily: 'Poppins_500Medium', color: tokenColors.inkSoft },
  filterTextActive: { color: tokenColors.ink, fontFamily: 'Poppins_600SemiBold', fontWeight: '600' },
  filterUnderline: { marginTop: 3, width: 20, height: 2.5, borderRadius: 1.5, backgroundColor: tokenColors.terracottaDeep },
  weekChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    backgroundColor: tokenColors.oxbloodWash,
    borderWidth: 1,
    borderColor: 'rgba(74,44,146,0.25)',
  },
  weekChipText: { fontSize: 13, lineHeight: 17, fontWeight: '600', fontFamily: 'Poppins_600SemiBold', color: tokenColors.oxblood },

  grid: { flexDirection: 'row', gap: 12, marginTop: 2 },
  column: { flex: 1, gap: 12 },
  cell: { gap: 6 },

  weekStrip: {
    marginTop: 20,
    borderRadius: 20,
    borderWidth: 1,
    padding: 14,
    shadowColor: '#3A2030',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  weekTitle: { fontSize: 19, lineHeight: 24, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2, marginBottom: 10 },
  weekRow: { gap: 10, paddingRight: 8 },
  dayCard: { width: 74, borderRadius: 14, borderWidth: 1, borderColor: 'transparent', paddingTop: 6 },
  dayLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  dayImg: { width: '100%', aspectRatio: 3 / 4, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  dayNone: { fontSize: 18 },

  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2 },
  stateText: { fontSize: 14, lineHeight: 21, textAlign: 'center', paddingHorizontal: 24 },
  button: { borderRadius: 999, paddingVertical: 14, alignItems: 'center', marginTop: 6, paddingHorizontal: 24 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  error: { fontSize: 13, lineHeight: 18 },
});
