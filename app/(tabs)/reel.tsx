import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ViewToken } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import NetInfo from '@react-native-community/netinfo';
import { useTheme, tokenColors } from '@/theme';
import { ReelCard, ReelSkeleton } from '@/components';
import { PressScale } from '@/components/PressScale';
import { Icon } from '@/components/icons';
import { type ReelCard as ReelCardData, type ReelPose } from '@/lib/api';
import {
  COPY_REEL_OFFLINE_REGENERATE,
  ReelPrefetcher,
  canRegenerateReelCard,
  keyById,
  reelPagerSpec,
  reportQuotaBlocked,
  reportReelTti,
} from '@/lib/perf';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { selectClosetList, useCloset } from '@/store/closet';
import { usePaywall } from '@/store/paywall';
import { useSession } from '@/store/session';
import {
  MAX_REGENERATES_PER_WEEK,
  mondayOf,
  useReel,
} from '@/store/reel';

/** expo-router params can arrive as `string | string[]` — take the first non-empty. */
function firstParam(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (Array.isArray(v)) return v.find((x) => x.length > 0);
  return undefined;
}

/**
 * Normalize the incoming week param to its Monday drop key. The Monday push
 * deep-links `vai://outfit/<date>` with ANY in-week date — the drop itself is
 * always keyed by Monday, so Wednesday taps land on the same drop.
 */
function weekMondayOfParam(param: string | undefined): string {
  if (!param) return mondayOf();
  const d = new Date(param.length === 10 ? `${param}T00:00:00Z` : param);
  if (Number.isNaN(d.getTime())) return mondayOf();
  return mondayOf(d);
}

/** "2026-09-07" → "Sep 7" (UTC — the drop key is a UTC Monday). */
function prettyWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

function dropCostUsd(cards: ReelCardData[]): { cost_usd: number; pending_count: number; is_estimated: boolean } {
  // Server-authoritative drop cost ONLY (P1-3): pending cards read
  // `imageUrl: ""` + the $0.067 estimate until their renders land (server
  // contract), so they are excluded from the sum — estimates are never
  // reported as authoritative. `pending_count` / `is_estimated` mark partial
  // sums; unit-economics queries must filter `is_estimated !== true`.
  let cost = 0;
  let pending = 0;
  for (const c of cards) {
    if (c.imageUrl.length === 0) {
      pending += 1;
      continue;
    }
    if (Number.isFinite(c.costUsd)) cost += c.costUsd;
  }
  return { cost_usd: cost, pending_count: pending, is_estimated: pending > 0 };
}

// ---------------------------------------------------------------------------
// Screen: 6th tab — vertical full-screen pager, one canonical ReelCard per
// screen. Full-bleed editorial treatment: the pager fills the screen, the
// week header + banners float over it. Prefetch engine owns the current±1
// full / ±2 thumb window with cooperative cancel on flings (CONTRACT-perf.md
// reel pager recipe). Deep links `vai://reel` + `vai://outfit/<date>` land
// here (root layout).
// ---------------------------------------------------------------------------

/**
 * Module-scope: FlashList does not support changing `viewabilityConfig` on
 * the fly — this must stay a stable reference, never an inline object.
 * 70% of a full-screen card = exactly one card viewable per page.
 */
const REEL_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 70 };

type ReelPagerRowProps = {
  card: ReelCardData;
  pageH: number;
  garmentThumbs: Record<string, string>;
  garmentNames: Record<string, string>;
  index: number;
  count: number;
  active: boolean;
  onTry: (card: ReelCardData) => void;
  onSave: (cardId: string) => void;
  onRegenerate: (card: ReelCardData) => void;
};

/**
 * Memoized pager cell — the FlashList recycling boundary. Subscribes to its
 * OWN `saved` / `loading` bits so a save or regen-state change re-renders
 * exactly one row, never the whole pager. All callbacks are screen-stable and
 * take the card/id, so the per-row closures below only rebuild when THIS
 * row re-renders (its own props changed) instead of defeating the memo.
 */
const ReelPagerRow = memo(function ReelPagerRow({
  card,
  pageH,
  garmentThumbs,
  garmentNames,
  index,
  count,
  active,
  onTry,
  onSave,
  onRegenerate,
}: ReelPagerRowProps): React.JSX.Element {
  const saved = useReel((s) => s.savedIds[card.id] === true);
  const loading = useReel((s) => s.regeneratingId === card.id);
  const handleTry = useCallback(() => onTry(card), [onTry, card]);
  const handleSave = useCallback(() => onSave(card.id), [onSave, card.id]);
  const handleRegenerate = useCallback(() => onRegenerate(card), [onRegenerate, card]);
  return (
    <View style={{ height: pageH }} testID={`reel-page-${card.id}`}>
      <ReelCard
        card={card}
        onTry={handleTry}
        onSave={handleSave}
        onRegenerate={handleRegenerate}
        saved={saved}
        garmentThumbs={garmentThumbs}
        garmentNames={garmentNames}
        index={index}
        count={count}
        active={active}
        loading={loading}
        testID={`reel-card-${card.id}`}
      />
    </View>
  );
});

export default function ReelScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const params = useLocalSearchParams<{ weekOf?: string; source?: string }>();
  const weekOf = weekMondayOfParam(firstParam(params.weekOf));
  const source = firstParam(params.source);

  const garments = useCloset(selectClosetList);
  const drop = useReel((s) => s.drop);
  const cachedWeek = useReel((s) => s.weekOf);
  const fetching = useReel((s) => s.fetching);
  const fetchError = useReel((s) => s.fetchError);
  const regeneratingId = useReel((s) => s.regeneratingId);
  const regensLeft = useReel((s) => s.regeneratesLeft());
  const ensureWeek = useReel((s) => s.ensureWeek);
  const refreshWeek = useReel((s) => s.refreshWeek);
  const styleMyWeek = useReel((s) => s.styleMyWeek);
  const toggleSave = useReel((s) => s.toggleSave);


  const [listH, setListH] = useState<number | null>(null);
  const [wearError, setWearError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<ReelCardData | null>(null);
  const [regenNote, setRegenNote] = useState('');
  const [regenError, setRegenError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  // One prefetcher per screen (holds the cancel generation). Connectivity is
  // read through a ref so the stable pager callbacks never go stale.
  const onlineRef = useRef(true);
  const prefetcherRef = useRef<ReelPrefetcher | null>(null);
  if (prefetcherRef.current === null) {
    prefetcherRef.current = new ReelPrefetcher({ isOnline: () => onlineRef.current });
  }
  const dataRef = useRef<ReelCardData[]>([]);
  const lastIndexRef = useRef(0);
  // Last index already sent to the prefetcher — repeat viewability events for
  // the same page skip the update (no redundant prefetch windows on scroll).
  const updatedIndexRef = useRef(-1);
  // Prefetch adapter (perf ReelCard shape) memoized per drop in the effect
  // below, so viewability callbacks never allocate on the scroll path.
  const prefetchAdapterRef = useRef<{ id: string; fullResUrl: string; thumbUrl: string }[]>([]);
  // Wear guards live in refs, not state: the pager passes no worn state to
  // rows, so a state mirror would re-render the whole pager for zero visual
  // change (and destabilize handleWear → renderItem → every memo row).
  const wornRef = useRef<Set<string>>(new Set());
  const wearBusyRef = useRef<Set<string>>(new Set());
  const viewedRef = useRef<Set<string>>(new Set());
  const mountMsRef = useRef(Date.now());
  const ttiReportedRef = useRef(false);
  const ttiFromCacheRef = useRef(false);
  const completedWeekRef = useRef<string | null>(null);

  useEffect(() => {
    const sub = NetInfo.addEventListener((s) => {
      const on = s.isConnected ?? true;
      onlineRef.current = on;
      setOnline(on);
    });
    void NetInfo.fetch()
      .then((s) => {
        const on = s.isConnected ?? true;
        onlineRef.current = on;
        setOnline(on);
      })
      .catch(() => undefined);
    return () => sub();
  }, []);

  useEffect(() => {
    onlineRef.current = online;
  }, [online]);

  const load = useCallback(() => {
    void ensureWeek(weekOf).catch(() => undefined);
  }, [ensureWeek, weekOf]);
  useEffect(load, [load]);


  // Open attribution (once per mount) + snapshot whether the drop was already
  // cached (drives the TTI `from_cache` budget split).
  useEffect(() => {
    const st = useReel.getState();
    ttiFromCacheRef.current = st.drop !== null && st.weekOf === weekOf;
    const uid = useSession.getState().userId;
    if (uid) {
      track('reel_opened', {
        user_id: uid,
        tier: toAnalyticsTier(usePaywall.getState().tier),
        ...(source ? { source } : {}),
        week_start: weekOf,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = drop && cachedWeek === weekOf ? drop.cards : null;
  const pageH = listH ?? winH;

  // Pending drop cards (imageUrl "") render blank until the server finishes.
  // Poll every 8s while anything is pending (5-min cap) — previously the
  // cards stayed black until a manual refresh or app restart.
  useEffect(() => {
    if (!cards || cards.length === 0) return;
    if (!cards.some((c) => c.imageUrl.length === 0)) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(timer);
        return;
      }
      if (!onlineRef.current) return;
      void refreshWeek(weekOf).catch(() => undefined);
    }, 8_000);
    return () => clearInterval(timer);
  }, [cards, refreshWeek, weekOf]);

  // Scroll-path refs mirror the drop (no render-body assignment — concurrent
  // unsafe). The adapter is rebuilt per drop, not per viewability event, so
  // the scroll callbacks stay allocation-free. NOTE: the API exposes no
  // thumbnail variant for reel cards (imageUrl only, AVIF/WebP ≤ 350 KB by
  // contract), so thumbUrl reuses imageUrl — the prefetch queue dedupes.
  useEffect(() => {
    const list = cards ?? [];
    dataRef.current = list;
    prefetchAdapterRef.current = list.map((c) => ({
      id: c.id,
      fullResUrl: c.imageUrl,
      thumbUrl: c.imageUrl,
    }));
    updatedIndexRef.current = -1;
  }, [cards]);

  // First card interactive → TTI; drop on screen → weekly_drop_completed with
  // the server-authoritative cost sum (REQUIRED props — pending-card estimates
  // excluded via dropCostUsd, flagged estimated vs final).
  useEffect(() => {
    if (!cards || cards.length === 0) return;
    if (!ttiReportedRef.current) {
      ttiReportedRef.current = true;
      reportReelTti(Date.now() - mountMsRef.current, { fromCache: ttiFromCacheRef.current });
    }
    if (completedWeekRef.current !== weekOf) {
      completedWeekRef.current = weekOf;
      const uid = useSession.getState().userId;
      if (uid) {
        const cost = dropCostUsd(cards);
        track('weekly_drop_completed', {
          user_id: uid,
          tier: toAnalyticsTier(usePaywall.getState().tier),
          card_count: cards.length,
          cost_usd: cost.cost_usd,
          is_estimated: cost.is_estimated,
          pending_count: cost.pending_count,
        });
      }
    }
  }, [cards, weekOf]);

  const garmentThumbs = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of garments) map[g.id] = g.cutoutUrl ?? g.imageUrl;
    return map;
  }, [garments]);

  // Real piece names (closet categories) — the reel card title.
  const garmentNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of garments) map[g.id] = g.category.charAt(0).toUpperCase() + g.category.slice(1);
    return map;
  }, [garments]);

  const [activeIndex, setActiveIndex] = useState(0);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      const idx = typeof first?.index === 'number' ? first.index : 0;
      lastIndexRef.current = idx;
      setActiveIndex(idx);
      // Same-page repeats (settling, re-layout) skip the prefetch window
      // rebuild — the ±1 window for this index is already in flight/cached.
      if (idx !== updatedIndexRef.current) {
        updatedIndexRef.current = idx;
        const prefetchData = prefetchAdapterRef.current;
        if (prefetchData.length > 0) {
          prefetcherRef.current?.update(prefetchData, idx);
        }
      }
      const raw = first?.item as ReelCardData | undefined;
      const card = raw && typeof raw.id === 'string' ? raw : dataRef.current[idx];
      if (card && !viewedRef.current.has(card.id)) {
        viewedRef.current.add(card.id);
        const uid = useSession.getState().userId;
        if (uid) {
          track('reel_card_viewed', {
            user_id: uid,
            tier: toAnalyticsTier(usePaywall.getState().tier),
            card_index: idx,
            pose: card.pose,
          });
        }
      }
    },
    [],
  );

  const onMomentumBegin = useCallback(() => {
    prefetcherRef.current?.notifyFling(true);
  }, []);

  const onMomentumEnd = useCallback(() => {
    const p = prefetcherRef.current;
    if (!p) return;
    p.notifyFling(false);
    const data = prefetchAdapterRef.current;
    if (data.length > 0) {
      p.update(data, lastIndexRef.current);
      updatedIndexRef.current = lastIndexRef.current;
    }
  }, []);

  // Try → changing room with the card's render context (real outfit id only;
  // the studio falls back to garment_refs when it is absent).
  const handleTry = useCallback(
    (card: ReelCardData) => {
      // Wear-intent: the canonical "wear it today" moment (CONTRACT §10).
      const uid = useSession.getState().userId;
      if (uid) {
        track('reel_wear_it_today', {
          user_id: uid,
          tier: toAnalyticsTier(usePaywall.getState().tier),
          date: new Date().toISOString().slice(0, 10),
        });
      }
      router.push({
        pathname: '/(tabs)/tryon',
        params: {
          ...(card.outfitId ? { outfitId: card.outfitId } : {}),
          garmentIds: card.garmentIds.join(','),
        },
      });
    },
    [router],
  );

  // Shop → shop tab scoped to the card's outfit (gap items) + shop-tap event.
  const regenBusy = regenTarget !== null && regeneratingId === regenTarget.id;

  const submitRegen = useCallback(() => {
    const target = regenTarget;
    if (!target || (regeneratingId !== null && regeneratingId === target.id)) return;
    if (!canRegenerateReelCard(onlineRef.current)) {
      setRegenError(COPY_REEL_OFFLINE_REGENERATE);
      return;
    }
    const paywall = usePaywall.getState();
    if (paywall.rendersLeft <= 0) {
      reportQuotaBlocked(
        paywall.tier === 'free' ? 'free_lifetime_exhausted' : 'monthly_exhausted',
        'reel_regenerate',
      );
      setRegenTarget(null);
      router.push({ pathname: '/onboarding/paywall', params: { placement: 'reel_regenerate' } });
      return;
    }
    if (useReel.getState().regeneratesLeft() <= 0) {
      setRegenError(`Weekly remix budget used — ${MAX_REGENERATES_PER_WEEK} per week, resets Monday.`);
      return;
    }
    // Remixes render on the user's own base photo.
    setRegenError(null);
    void (async () => {
      const updated = await useReel.getState().regenerate(target.id, regenNote);
      if (updated) {
        const uid = useSession.getState().userId;
        if (uid) {
          const idx = useReel.getState().drop?.cards.findIndex((c) => c.id === updated.id) ?? -1;
          track('reel_card_regenerated', {
            user_id: uid,
            tier: toAnalyticsTier(usePaywall.getState().tier),
            ...(idx >= 0 ? { card_index: idx } : {}),
            pose: updated.pose,
            render_id: updated.renderId,
            cost_usd: updated.costUsd,
          });
        }
        setRegenTarget(null);
        setRegenNote('');
      } else if (useReel.getState().regeneratesLeft() <= 0) {
        setRegenError(`Weekly remix budget used — ${MAX_REGENERATES_PER_WEEK} per week, resets Monday.`);
      } else {
        setRegenError('Could not remix this look. Please try again.');
      }
    })();
  }, [regenTarget, regeneratingId, regenNote, router]);

  // "Style my week" → POST reel-drop. Client pre-gate (P2-5, mirrors the
  // regen path): offline → banner, exhausted
  // render pool → paywall — so exhausted users get the upsell sheet instead
  // of a generic fetch error. weekly_drop_started carries the
  // server-authoritative cost sum (REQUIRED — pending estimates excluded).
  const handleStyleWeek = useCallback(() => {
    if (fetching) return; // double-tap = two reel-drops = 7 renders each
    if (!onlineRef.current) {
      setBanner(COPY_REEL_OFFLINE_REGENERATE);
      return;
    }
    const paywall = usePaywall.getState();
    if (paywall.rendersLeft <= 0) {
      reportQuotaBlocked(
        paywall.tier === 'free' ? 'free_lifetime_exhausted' : 'monthly_exhausted',
        'reel_style_week',
      );
      router.push({ pathname: '/onboarding/paywall', params: { placement: 'reel_style_week' } });
      return;
    }
    setBanner(null);
    void (async () => {
      const fresh = await styleMyWeek(weekOf);
      const uid = useSession.getState().userId;
      if (uid && fresh && fresh.cards.length > 0) {
        const cost = dropCostUsd(fresh.cards);
        track('weekly_drop_started', {
          user_id: uid,
          tier: toAnalyticsTier(usePaywall.getState().tier),
          card_count: fresh.cards.length,
          cost_usd: cost.cost_usd,
          is_estimated: cost.is_estimated,
          pending_count: cost.pending_count,
        });
      }
    })();
  }, [styleMyWeek, weekOf, router, fetching]);

  const handleSave = useCallback(
    (cardId: string) => {
      void toggleSave(cardId);
    },
    [toggleSave],
  );
  const openRegen = useCallback((card: ReelCardData) => {
    setRegenTarget(card);
    setRegenNote('');
    setRegenError(null);
  }, []);

  // Thin + stable: every callback prop is screen-stable, so FlashList rows
  // keep their memo across scrolls. Per-row variance (saved/loading) is
  // subscribed inside ReelPagerRow, not threaded through here.
  const renderItem = useCallback(
    ({ item, index }: { item: ReelCardData; index: number }) => (
      <ReelPagerRow
        card={item}
        pageH={pageH}
        garmentThumbs={garmentThumbs}
        garmentNames={garmentNames}
        index={index}
        count={cards?.length ?? 0}
        active={index === activeIndex}
        onTry={handleTry}
        onSave={handleSave}
        onRegenerate={openRegen}
      />
    ),
    [pageH, garmentThumbs, garmentNames, cards, activeIndex, handleTry, handleSave, openRegen],
  );

  // External deps renderItem closes over (FlashList PureComponent contract:
  // rows re-render when data items change OR this reference changes).
  const pagerExtra = useMemo(
    () => ({ pageH, garmentThumbs }),
    [pageH, garmentThumbs],
  );

  const tierLabel =
    drop && cachedWeek === weekOf ? (drop.tier === 'teaser' ? ' · teaser' : ' · full drop') : '';

  return (
    <View style={styles.root} testID="reel-screen">
      {/* pager fills the screen; all chrome floats */}
      {fetching && cards === null ? (
        <View style={styles.fill} testID="reel-loading">
          <ReelSkeleton />
        </View>
      ) : fetchError && cards === null ? (
        <View style={[styles.fill, styles.state]} testID="reel-error">
          <Text style={styles.stateTitle}>Couldn&apos;t load your week</Text>
          <Text style={styles.stateBody}>{fetchError}</Text>
          <PressScale
            style={styles.stateCta}
            onPress={() => void refreshWeek(weekOf)}
            disabled={fetching}
            testID="reel-retry-week"
            accessibilityRole="button"
            accessibilityLabel="Try loading your week again"
          >
            <Text style={styles.stateCtaText}>{fetching ? 'Loading…' : 'Try again'}</Text>
          </PressScale>
        </View>
      ) : cards === null || cards.length === 0 ? (
        <View style={[styles.fill, styles.state]} testID="reel-drop-empty">
          <Text style={styles.stateGlyph} aria-hidden>✦</Text>
          <Text style={styles.stateTitle}>No drop yet this week</Text>
          <Text style={styles.stateBody}>
            Fresh looks land every Monday. Style your week now — seven outfits styled on your photo.
          </Text>
          <PressScale
            style={styles.stateCta}
            onPress={handleStyleWeek}
            disabled={fetching}
            testID="reel-style-week"
            accessibilityRole="button"
            accessibilityLabel="Style my week — seven outfits styled on your photo"
          >
            {fetching ? (
              <ActivityIndicator color={tokenColors.stage} />
            ) : (
              <Text style={styles.stateCtaText}>{fetching ? 'Styling…' : 'Style my week'}</Text>
            )}
          </PressScale>
          {!!fetchError && <Text style={[styles.stateError, { color: colors.danger }]}>{fetchError}</Text>}
        </View>
      ) : (
        <View
          style={styles.fill}
          testID="reel-pager"
          onLayout={(e) => setListH(e.nativeEvent.layout.height)}
        >
          {!!fetchError && (
            <Text style={[styles.stale, { top: insets.top + 92 }]} testID="reel-stale">
              Showing your saved drop — refresh failed.
            </Text>
          )}
          <FlashList
            {...reelPagerSpec(pageH)}
            data={cards}
            keyExtractor={keyById}
            renderItem={renderItem}
            extraData={pagerExtra}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={REEL_VIEWABILITY_CONFIG}
            onMomentumScrollBegin={onMomentumBegin}
            onMomentumScrollEnd={onMomentumEnd}
            showsVerticalScrollIndicator={false}
            decelerationRate="fast"
          />
        </View>
      )}

      {/* floating week header (the reference's centered product-detail title) */}
      <View pointerEvents="box-none" style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <PressScale
          style={styles.headerCircle}
          onPress={() => void refreshWeek(weekOf)}
          disabled={fetching}
          hitSlop={12}
          testID="reel-refresh"
          accessibilityRole="button"
          accessibilityLabel="Refresh weekly reel"
        >
          <Icon name="refresh" color="#FFFFFF" size={19} />
        </PressScale>
        <View pointerEvents="none" style={styles.headerTitles}>
          <Text style={styles.headerTitle}>Your week</Text>
          <Text style={styles.headerSub} testID="reel-week">
            Week of {prettyWeek(weekOf)}
            {tierLabel}
          </Text>
        </View>
        <View style={styles.headerSpacer} aria-hidden />
      </View>

      {/* banners — floating under the header */}
      <View pointerEvents="none" style={[styles.banners, { top: insets.top + 66 }]}>
        {!!banner && (
          <Text style={styles.banner} testID="reel-banner">
            {banner}
          </Text>
        )}
        {!!wearError && (
          <Text style={[styles.banner, { color: colors.danger }]} testID="reel-wear-error">
            {wearError}
          </Text>
        )}
        {!online && !banner && (
          <Text style={styles.banner} testID="reel-offline">
            You&apos;re offline — showing your saved drop.
          </Text>
        )}
      </View>

      {/* Remix note sheet: stylist note → POST reel-regenerate (1 credit). */}
      <Modal
        visible={regenTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setRegenTarget(null)}
      >
        <KeyboardAvoidingView
          style={styles.sheetScrim}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setRegenTarget(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss remix sheet"
            testID="regen-backdrop"
          />
          <SafeAreaView
            edges={['bottom']}
            style={styles.sheetBox}
            testID="regen-sheet"
          >
            <Text style={styles.sheetTitle}>Remix this look</Text>
            <Text style={styles.sheetSub} testID="regen-budget">
              {regensLeft} of {MAX_REGENERATES_PER_WEEK} remixes left this week · 1 credit each
            </Text>
            <TextInput
              value={regenNote}
              onChangeText={setRegenNote}
              placeholder="Note for the stylist (optional, e.g. warmer light)"
              maxLength={280}
              style={styles.regenInput}
              placeholderTextColor="rgba(255,255,255,0.45)"
              testID="regen-note"
            />
            {!!regenError && (
              <Text style={[styles.regenErrorText, { color: colors.danger }]} testID="regen-error">
                {regenError}
              </Text>
            )}
            <View style={styles.sheetRow}>
              <PressScale
                style={styles.sheetBtnGhost}
                onPress={() => setRegenTarget(null)}
                testID="regen-cancel"
              >
                <Text style={styles.sheetBtnGhostText}>Cancel</Text>
              </PressScale>
              <PressScale
                style={[styles.sheetBtnPrimary, (regenBusy || regensLeft <= 0) && styles.disabled]}
                onPress={submitRegen}
                disabled={regenBusy || regensLeft <= 0}
                testID="regen-submit"
              >
                {regenBusy ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.sheetBtnPrimaryText}>Remix</Text>
                )}
              </PressScale>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const GLASS = 'rgba(255,255,255,0.16)';
const GLASS_BORDER = 'rgba(255,255,255,0.22)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: tokenColors.stage },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  state: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40 },
  stateGlyph: { fontSize: 34, color: tokenColors.terracotta },
  stateTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    textAlign: 'center',
  },
  stateBody: { color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  stateCta: {
    marginTop: 12,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
  },
  stateCtaText: {
    color: tokenColors.stage,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },
  stateError: { fontSize: 13, textAlign: 'center', marginTop: 4 },

  header: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitles: { flex: 1, alignItems: 'center' },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    textShadowColor: 'rgba(15,10,28,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  headerSub: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  headerSpacer: { width: 42 },

  banners: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  banner: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
    backgroundColor: 'rgba(15,10,28,0.55)',
    overflow: 'hidden',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 6,
  },
  stale: {
    position: 'absolute',
    left: 16,
    right: 16,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    textAlign: 'center',
    zIndex: 10,
  },

  sheetScrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,6,20,0.6)' },
  sheetBox: {
    backgroundColor: tokenColors.stageLift,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 10,
  },
  sheetTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
  },
  sheetSub: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  regenInput: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: '#FFFFFF',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  regenErrorText: { fontSize: 13 },
  sheetRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  sheetBtnGhost: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  sheetBtnGhostText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  sheetBtnPrimary: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: tokenColors.terracottaDeep,
  },
  sheetBtnPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },
  disabled: { opacity: 0.5 },
});
