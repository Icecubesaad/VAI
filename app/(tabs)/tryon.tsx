import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import * as Crypto from 'expo-crypto';
import { useTheme } from '@/theme';
import { tokenColors } from '@/theme';
import { PressScale } from '@/components/PressScale';
import { Icon } from '@/components/icons';
import {
  ApiError,
  api,
  apiErrorCopy,
  type RenderJob,
  type RenderMode,
  type RenderTier,
  type Garment,
} from '@/lib/api';
import { renderCostPropsFromResult, track } from '@/lib/analytics';
import { maybeRequestReview, once as growthOnce } from '@/lib/growth';
import { hapticFor } from '@/lib/haptics';
import { createSignedBasePhotoUrl, supabase } from '@/lib/supabase';
import { comboKey, comboLabel, buildCombos, type OutfitCombo } from '@/lib/outfit-combos';
import { useSession } from '@/store/session';
import { useCloset, selectClosetList } from '@/store/closet';
import { MAX_RESTYLES_PER_SESSION, useQuotas } from '@/store/quotas';
import { usePaywall } from '@/store/paywall';
import { useReel } from '@/store/reel';
import { useComboRenders } from '@/store/combos';

const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 95_000;

/** Combo rail metrics — snap step = card + gap; offset multiples center a card. */
const CARD_W = 88;
const CARD_H = 112;
const RAIL_GAP = 10;
const RAIL_STEP = CARD_W + RAIL_GAP;/** expo-router params can arrive as `string | string[]` — take the first non-empty. */
function firstParam(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (Array.isArray(v)) return v.find((x) => x.length > 0) ?? null;
  return null;
}

/** Order-insensitive garment-set equality (hero/outfit match check). */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/**
 * Changing room: full-bleed mirror, snap-scroll rail of combos built from the
 * closet (founder reference §room). Centering a card wears that combo — when
 * a render of it exists (this session's renders, or a weekly-drop look
 * matched by garment set) the mirror swaps to it; otherwise "See it on me"
 * renders the centered look.
 */
export default function TryOnScreen() {
  const router = useRouter();
  // Push-tap tolerance (P1-2): accept camelCase + snake_case spellings —
  // the server push payload uses `render_ready`/`render_id`, the perf recipe
  // deep link uses `vai://tryon/<id>` → `renderId`, the planner passes
  // `outfitId`+`garmentIds`. Any spelling lands on the same result view.
  const params = useLocalSearchParams<{
    renderId?: string;
    render_id?: string;
    outfitId?: string;
    outfit_id?: string;
    garmentIds?: string;
    garment_ids?: string;
  }>();
  // `??` would keep a present-but-empty camel spelling over a filled snake
  // one — normalize each spelling first, then take the first non-empty.
  const deepLinkedRenderId = firstParam(params.renderId) ?? firstParam(params.render_id);
  // Real hero outfit forwarded by the planner (P0-1): only ever sent when
  // its garment set still equals the current selection — never fabricated.
  const heroOutfitId = firstParam(params.outfitId) ?? firstParam(params.outfit_id);
  const heroGarmentIds = useMemo(() => {
    const raw = firstParam(params.garmentIds) ?? firstParam(params.garment_ids);
    if (!raw) return null;
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : null;
  }, [params.garmentIds, params.garment_ids]);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const basePhotoId = useSession((s) => s.basePhotoId);
  const basePhotoUrl = useSession((s) => s.basePhotoUrl);
  const setBasePhoto = useSession((s) => s.setBasePhoto);
  const garments = useCloset(selectClosetList);
  const tier = usePaywall((s) => s.tier);
  const rendersLeftFree = useQuotas((s) => s.rendersLeftFree());
  const recordRenderDone = useQuotas((s) => s.recordRenderDone);
  const monthlyUsed = usePaywall((s) => s.monthlyUsed);
  const monthlyCap = usePaywall((s) => s.monthlyCap);

  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<RenderMode>('tryon');
  const [restyleNote, setRestyleNote] = useState('');
  const [job, setJob] = useState<RenderJob | null>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'rendering' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -- changing room: combo rail -------------------------------------------
  // A forwarded look (reel/planner handoff) leads the rail even when it isn't
  // one of the generated combos — the room opens wearing what was tapped.
  const combos = useMemo(() => {
    const built = buildCombos(garments);
    if (heroGarmentIds && !built.some((c) => c.id === comboKey(heroGarmentIds))) {
      return [
        {
          id: comboKey(heroGarmentIds),
          garmentIds: heroGarmentIds,
          label: comboLabel(heroGarmentIds, garments),
          formality: 0,
          occasion: 'casual' as const,
        },
        ...built,
      ];
    }
    return built;
  }, [garments, heroGarmentIds]);
  const garmentById = useMemo(() => {
    const map: Record<string, Garment> = {};
    for (const g of garments) map[g.id] = g;
    return map;
  }, [garments]);
  const comboRenders = useComboRenders((s) => s.renders);
  const reelDrop = useReel((s) => s.drop);
  const [comboIndex, setComboIndex] = useState(0);
  const comboIndexRef = useRef(0);
  // State, not just a ref: the initial-snap effect must re-run when the rail
  // lays out (layout lands after first effects — a ref alone never re-fires it).
  const [railLaidOut, setRailLaidOut] = useState(false);
  const railRef = useRef<FlatList<OutfitCombo> | null>(null);
  const initialSnapRef = useRef(false);
  // The combo a started render belongs to — its output joins the rail cache.
  const renderedComboKeyRef = useRef<string | null>(null);

  // Weekly-drop looks join the rail: match by garment set, fill gaps only.
  useEffect(() => {
    if (!reelDrop) return;
    const entries: Record<string, { url: string; renderId: string }> = {};
    for (const c of reelDrop.cards) {
      if (c.imageUrl) entries[comboKey(c.garmentIds)] = { url: c.imageUrl, renderId: c.renderId };
    }
    if (Object.keys(entries).length > 0) useComboRenders.getState().seed(entries);
  }, [reelDrop]);

  // Wore-it receipt state lives here (above applyCombo) so centering a
  // new combo can clear the last combo's receipt.
  const [woreBusy, setWoreBusy] = useState(false);
  const [woreDone, setWoreDone] = useState(false);

  const applyCombo = useCallback(
    (index: number) => {
      const combo = combos[index];
      if (!combo) return;
      comboIndexRef.current = index;
      setComboIndex(index);
      setSelected(combo.garmentIds);
      // New combo centered → the wore-it receipt belongs to the last one.
      setWoreDone(false);
    },
    [combos],
  );

  // Initial wear: the planner/reel handoff combo when forwarded, else the
  // first card — snapped without animation once the rail has laid out.
  useEffect(() => {
    if (combos.length === 0 || !railLaidOut || initialSnapRef.current) return;
    initialSnapRef.current = true;
    let idx = 0;
    if (heroGarmentIds) {
      const found = combos.findIndex((c) => c.id === comboKey(heroGarmentIds));
      if (found >= 0) idx = found;
    }
    railRef.current?.scrollToOffset({ offset: idx * RAIL_STEP, animated: false });
    applyCombo(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combos, heroGarmentIds, railLaidOut]);

  const onRailMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const idx = Math.min(combos.length - 1, Math.max(0, Math.round(x / RAIL_STEP)));
      if (idx !== comboIndexRef.current) {
        void hapticFor.select();
        applyCombo(idx);
      }
    },
    [applyCombo, combos.length],
  );

  // A finished render joins the rail cache under its combo — scrolling back
  // to that card now swaps the mirror to the render.
  useEffect(() => {
    if (!job || job.status !== 'done' || !job.outputUrl) return;
    const key =
      renderedComboKeyRef.current ??
      (combos[comboIndexRef.current]?.id ?? null);
    if (key) useComboRenders.getState().put(key, job.outputUrl, job.id);
  }, [job, combos]);

  // Planner handoff: pre-select the hero garments so Generate renders the
  // planned look (mount-only; the user can still change the selection, which
  // drops the hero outfit id via the same-set check in handleGenerate).
  const preselectedRef = useRef(false);
  useEffect(() => {
    if (preselectedRef.current) return;
    preselectedRef.current = true;
    if (heroGarmentIds && heroGarmentIds.length > 0) setSelected(heroGarmentIds);
  }, [heroGarmentIds]);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  // Private-bucket signed URLs expire (1h) — re-mint on mount via the stored
  // object path (row lookup for legacy sessions that only kept the row id),
  // then refresh the session so the thumb + Generate stay valid.
  const mintedRef = useRef(false);
  useEffect(() => {
    if (mintedRef.current || !basePhotoId) return;
    mintedRef.current = true;
    void (async () => {
      try {
        const st = useSession.getState();
        let path = st.basePhotoPath;
        if (!path) {
          const { data, error: rowErr } = await supabase
            .from('base_photos')
            .select('url')
            .eq('id', basePhotoId)
            .single();
          if (rowErr) return;
          path = (data as { url: string }).url;
        }
        if (!path) return;
        // Legacy rows stored a full public URL (pre-signed-URL pipeline) —
        // not a storage path, so it can't be re-minted; retake replaces it.
        if (path.startsWith('http')) return;
        const fresh = await createSignedBasePhotoUrl(path);
        if (fresh !== useSession.getState().basePhotoUrl) {
          setBasePhoto({ id: basePhotoId, url: fresh, path });
        }
      } catch {
        // Keep the cached URL — worst case the thumb 403s until retake.
      }
    })();
  }, [basePhotoId, setBasePhoto]);

  const rendersLeft = tier === 'free' ? rendersLeftFree : Math.max(0, monthlyCap - monthlyUsed);
  const cap = tier === 'free' ? 5 : monthlyCap;
  // Restyle builds on the finished parent render (no selection/base needed);
  // tryon/compare need garments + a base photo.
  // Quota exhaustion is NOT a disable condition: at 0 renders the button is
  // labeled "Get more renders" and routes to the paywall (handleGenerate).
  // The old quota clause disabled exactly that button — a dead end.
  const canGenerate =
    phase !== 'starting' &&
    phase !== 'rendering' &&
    (mode === 'restyle' || (selected.length > 0 && basePhotoId !== null));

  // Edge status poll (`action: 'status'` → server-authoritative cost/model).
  // Settles fire the REQUIRED render analytics with cost_usd (P0-3); failed
  // predictions cost 0 credits — quota is never decremented here.
  const pollJob = useCallback(
    (renderId: string, startedAt: number) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          stopPoll();
          setPhase('failed');
          setError('Render timed out. We retried once on the standard queue — please try again.');
          return;
        }
        void api
          .getRender(renderId)
          .then((r) => {
            setJob(r);
            const uid = useSession.getState().userId;
            const aTier = toAnalyticsTier(usePaywall.getState().tier);
            if (r.status === 'done') {
              stopPoll();
              setPhase('idle');
              recordRenderDone();
              usePaywall.getState().recordRenderSettled();
              if (uid) {
                track('render_succeeded', {
                  ...renderCostPropsFromResult(uid, aTier, {
                    model: r.model ?? 'unknown',
                    costUsd: r.costUsd ?? 0,
                  }),
                  render_id: r.id,
                  latency_ms: Date.now() - startedAt,
                  ...(r.cached !== undefined ? { cached: r.cached } : {}),
                });
                if (growthOnce(`ahaTryon.${uid}`)) {
                  track('aha_first_tryon', { user_id: uid, tier: aTier });
                }
                if (aTier !== 'free') {
                  track('credits_consumed', {
                    user_id: uid,
                    tier: aTier,
                    credits: 1,
                    render_id: r.id,
                    cost_usd: r.costUsd ?? 0,
                  });
                }
                void maybeRequestReview();
              }
            } else if (r.status === 'failed') {
              stopPoll();
              setPhase('failed');
              setError(r.error ?? 'Render failed. Failed renders are free — please try again.');
              if (uid) {
                track('render_failed', {
                  ...renderCostPropsFromResult(uid, aTier, {
                    model: r.model ?? 'unknown',
                    costUsd: 0,
                  }),
                  render_id: r.id,
                  error_code: r.error ?? 'render_failed',
                  latency_ms: Date.now() - startedAt,
                });
              }
            }
          })
          .catch((e: unknown) => {
            // Transient blips keep polling until timeout — but auth failures
            // and vanished renders are terminal: grinding to a false "Render
            // timed out" taught users to distrust the message.
            if (e instanceof ApiError && (e.code === 'UNAUTHENTICATED' || e.status === 404)) {
              stopPoll();
              setPhase('failed');
              setError(apiErrorCopy(e).message);
            }
          });
      }, POLL_MS);
    },
    [recordRenderDone, stopPoll],
  );

  // Push-tap entry: `/(tabs)/tryon?renderId=<id>` (or snake_case `render_id`
  // from the server push payload — see root layout push routing) loads that
  // render's server status into the result view.
  useEffect(() => {
    const rid = deepLinkedRenderId;
    if (!rid) return;
    setError(null);
    setPhase('rendering');
    void api
      .getRender(rid)
      .then((r) => {
        setJob(r);
        if (r.status === 'done') {
          setPhase('idle');
          // Mirror sync for renders that finished while the app was dead;
          // the next paywall-status fetch overwrites any double-count.
          // (No render_succeeded track here — the originating session owns
          // the funnel event; this is a resume, not a new settle.)
          recordRenderDone();
        } else if (r.status === 'failed') {
          setPhase('failed');
          setError(r.error ?? 'Render failed. Failed renders are free — please try again.');
        } else {
          pollJob(r.id, Date.now());
        }
      })
      .catch((e) => {
        setPhase('failed');
        setError(apiErrorCopy(e).message);
      });
  }, [deepLinkedRenderId, pollJob, recordRenderDone]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    if (tier === 'free' && rendersLeft <= 0) {
      router.push('/onboarding/paywall');
      return;
    }
    const uid = useSession.getState().userId;
    const aTier = toAnalyticsTier(tier);
    // P1-4 restyle guard: restyle REQUIRES a finished parent render
    // (render_id) + a change note + session budget — otherwise the server
    // 400s. Guard client-side with a message instead of a failed charge.
    if (mode === 'restyle') {
      if (useQuotas.getState().restylesLeft() <= 0) {
        setError('3 restyles per session — kept your best version. Start a new try-on to explore further.');
        return;
      }
      if (!job || job.status !== 'done' || !job.id) {
        setError('Pick a finished try-on to restyle — Generate a try-on first, then restyle it.');
        return;
      }
      if (restyleNote.trim().length === 0) {
        setError('Describe the change for your restyle (e.g. “tuck it in, warmer light”).');
        return;
      }
    } else if (basePhotoId === null) {
      return;
    }
    // Renders always use the user's own base-photo pose.
    setError(null);
    setPhase('starting');
    const startedAt = Date.now();
    renderedComboKeyRef.current =
      mode === 'restyle'
        ? renderedComboKeyRef.current
        : selected.length > 0
          ? comboKey(selected)
          : null;
    // Settle helper shared by all three modes (done → mirror + track).
    const settleStart = (r: RenderJob) => {
      setJob(r);
      if (r.status === 'done') {
        setPhase('idle');
        recordRenderDone();
        usePaywall.getState().recordRenderSettled();
        if (uid) {
          track('render_succeeded', {
            ...renderCostPropsFromResult(uid, aTier, {
              model: r.model ?? 'unknown',
              costUsd: r.costUsd ?? 0,
            }),
            render_id: r.id,
            latency_ms: Date.now() - startedAt,
            ...(r.cached !== undefined ? { cached: r.cached } : {}),
          });
          if (growthOnce(`ahaTryon.${uid}`)) {
            track('aha_first_tryon', { user_id: uid, tier: aTier });
          }
          if (aTier !== 'free') {
            track('credits_consumed', {
              user_id: uid,
              tier: aTier,
              credits: 1,
              render_id: r.id,
              cost_usd: r.costUsd ?? 0,
            });
          }
          void maybeRequestReview();
        }
      } else {
        setPhase('rendering');
        pollJob(r.id, startedAt);
      }
    };
    try {
      // Restyle taps route to the EXISTING finished render (P1-4).
      if (mode === 'restyle' && job && job.status === 'done') {
        const note = restyleNote.trim().slice(0, 280);
        if (uid) {
          track('restyle_tapped', {
            user_id: uid,
            tier: aTier,
            render_id: job.id,
            restyle_n: MAX_RESTYLES_PER_SESSION - useQuotas.getState().restylesLeft() + 1,
          });
        }
        // Idempotency mirrors the server key inputs (render|note).
        const restyleKey = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          `${uid}|${job.id}|${note}`,
        );
        const rr = await api.restyle({
          renderId: job.id,
          note,
          idempotencyKey: restyleKey,
        });
        useQuotas.getState().recordRestyle();
        if (uid) {
          track('render_requested', {
            user_id: uid,
            tier: aTier,
            render_id: rr.id,
            mode: 'restyle',
          });
        }
        settleStart(rr);
        return;
      }
      const tierChoice: RenderTier = tier === 'free' ? 'std' : mode === 'compare' ? 'max' : 'std';
      const day = todayKey();
      // Idempotency mirrors the server key inputs (user|base|outfit|day|mode|tier).
      const idempotencyKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${uid}|${basePhotoId}|${[...selected].sort().join(',')}|${day}|${mode}|${tierChoice}`,
      );
      // P0-1: a REAL outfit id only. Prefer the planner hero forwarded via
      // params (same garment set), else create/lookup via plan-day — the
      // server persists the hero row and returns its id. Anything else is
      // omitted (garment_refs path); ids are never fabricated from joined
      // garment ids (→ outfit_not_found on every Generate).
      let outfitId: string | undefined;
      if (heroOutfitId && heroGarmentIds && sameIdSet(heroGarmentIds, selected)) {
        outfitId = heroOutfitId;
      } else {
        try {
          const plan = await api.planDay({ date: day });
          if (plan.id && sameIdSet(plan.garmentIds, selected)) outfitId = plan.id;
        } catch {
          // Best-effort: the garment_refs path needs no outfit row.
        }
      }
      const r = await api.requestTryon({
        ...(outfitId ? { outfitId } : {}),
        ...(basePhotoId !== null ? { basePhotoId } : {}),
        garmentRefs: selected,
        mode,
        tier: tierChoice,
        idempotencyKey,
        day,
      });
      if (uid) {
        track('render_requested', {
          user_id: uid,
          tier: aTier,
          render_id: r.id,
          render_tier: tierChoice,
          mode,
        });
      }
      settleStart(r);
    } catch (e) {
      setPhase('failed');
      if (e instanceof ApiError && e.code === 'QUOTA_EXCEEDED') {
        router.push({ pathname: '/onboarding/paywall', params: { placement: 'tryon_quota' } });
        return;
      }
      setError(apiErrorCopy(e).message);
      if (uid) {
        track('render_failed', {
          ...renderCostPropsFromResult(uid, aTier, { model: 'unknown', costUsd: 0 }),
          error_code: e instanceof ApiError ? e.code : 'request_failed',
          latency_ms: Date.now() - startedAt,
        });
      }
    }
  }, [
    canGenerate,
    basePhotoId,
    tier,
    rendersLeft,
    mode,
    selected,
    job,
    restyleNote,
    heroOutfitId,
    heroGarmentIds,
    pollJob,
    recordRenderDone,
    router,
  ]);

  const busy = phase === 'starting' || phase === 'rendering';

  // Surprise me: jump the rail to another combo (rail snap wears it).
  const handleSurprise = useCallback(() => {
    if (combos.length === 0) return;
    void hapticFor.select();
    let idx = Math.floor(Math.random() * combos.length);
    if (combos.length > 1 && idx === comboIndexRef.current) idx = (idx + 1) % combos.length;
    railRef.current?.scrollToOffset({ offset: idx * RAIL_STEP, animated: true });
    applyCombo(idx);
  }, [combos, applyCombo]);

  // Wore it today: bumps wear_count on the centered combo's garments
  // (cost-per-wear + the planner's no-repeat signal). Best-effort direct
  // RPC — the outfits table already records plans; this records reality.
  // Haptic confirms; the button disables while the write is in flight.
  // (woreBusy/woreDone state lives above applyCombo so it can clear this.)
  const handleWoreIt = useCallback(() => {
    const combo = combos[comboIndexRef.current];
    if (!combo || combo.garmentIds.length === 0 || woreBusy) return;
    setWoreBusy(true);
    setWoreDone(false);
    void (async () => {
      try {
        const { error } = await supabase.rpc('increment_wear', { ids: combo.garmentIds });
        if (error) throw error;
        void hapticFor.done();
        setWoreDone(true);
      } catch {
        setError('Could not log this outfit. Check your connection and try again.');
      } finally {
        setWoreBusy(false);
      }
    })();
  }, [combos, woreBusy]);

  // Full-bleed mirror: the centered combo's render when one exists, else the
  // latest finished render, else the base photo.
  const activeCombo = combos[comboIndex] ?? null;
  const activeRender = activeCombo ? comboRenders[activeCombo.id] : undefined;
  const bgUri =
    activeRender?.url ??
    (job && job.status === 'done' ? job.outputUrl ?? basePhotoUrl : basePhotoUrl);
  const railPad = Math.max(16, (winW - CARD_W) / 2);

  const renderRailItem = useCallback(
    ({ item, index }: { item: OutfitCombo; index: number }) => {
      const pieces = item.garmentIds
        .map((id) => garmentById[id])
        .filter((g): g is Garment => g !== undefined);
      const main = pieces[0];
      const extras = pieces.slice(1, 3);
      const worn = index === comboIndex;
      return (
        <PressScale
          scaleTo={0.94}
          onPress={() => {
            railRef.current?.scrollToOffset({ offset: index * RAIL_STEP, animated: true });
            void hapticFor.select();
            applyCombo(index);
          }}
          testID={`combo-card-${index}`}
          accessibilityRole="button"
          accessibilityState={{ selected: worn }}
          accessibilityLabel={`Wear this combo: ${item.label}`}
        >
          <View style={[styles.comboCard, worn && styles.comboCardActive]}>
            {main ? (
              <Image
                source={{ uri: main.cutoutUrl ?? main.imageUrl }}
                style={styles.comboMain}
                contentFit={main.cutoutUrl ? 'contain' : 'cover'}
                transition={150}
              />
            ) : null}
            {extras.map((g, i) => (
              <View key={g.id} style={[styles.comboExtra, { bottom: 6 + i * 26 }]}>
                <Image
                  source={{ uri: g.cutoutUrl ?? g.imageUrl }}
                  style={styles.comboExtraImg}
                  contentFit={g.cutoutUrl ? 'contain' : 'cover'}
                  transition={150}
                />
              </View>
            ))}
          </View>
        </PressScale>
      );
    },
    [garmentById, comboIndex, applyCombo],
  );

  return (
    <View style={styles.root} testID="tryon-screen">
      {/* full-bleed mirror */}
      {bgUri ? (
        <Image
          source={{ uri: bgUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={350}
          accessibilityLabel={
            activeRender ? 'Your try-on for this look' : job && job.status === 'done' ? 'Your try-on result' : 'Your base photo'
          }
        />
      ) : (
        <View style={StyleSheet.absoluteFill} testID="tryon-empty-bg">
          <View style={styles.emptyStage}>
            <View style={styles.emptyStageGlow} aria-hidden />
            <Text style={styles.emptyStageTitle}>Your changing room</Text>
            <Text style={styles.emptyStageBody}>
              {garments.length === 0
                ? 'Add garments to your closet, take a mirror selfie, and see every look on you.'
                : 'One mirror selfie — every combo in your closet, rendered on you.'}
            </Text>
            <PressScale
              style={styles.emptyStageBtn}
              onPress={() => router.push(garments.length === 0 ? '/(tabs)/closet' : '/onboarding/selfie-capture')}
              testID="tryon-empty-cta"
              accessibilityRole="button"
            >
              <Text style={styles.emptyStageBtnText}>
                {garments.length === 0 ? 'Open your closet' : 'Take a mirror selfie'}
              </Text>
            </PressScale>
          </View>
        </View>
      )}

      {/* legibility scrims — soft fades, never hard bands */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0.55)', 'rgba(15,10,28,0.28)', 'rgba(15,10,28,0)']}
        locations={[0, 0.55, 1]}
        style={styles.scrimTop}
        aria-hidden
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0)', 'rgba(15,10,28,0.45)', 'rgba(15,10,28,0.72)']}
        locations={[0, 0.45, 1]}
        style={styles.scrimBottom}
        aria-hidden
      />

          {/* floating chrome: back · retake / title · quota */}
      <View style={[styles.chromeTop, { top: insets.top + 8 }]}>
        <PressScale
          style={styles.glassBtn}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.push('/(tabs)');
          }}
          testID="tryon-back"
          accessibilityRole="button"
          accessibilityLabel="Leave the changing room"
        >
          <Icon name="chevronLeft" color="#FFFFFF" size={20} strokeWidth={2.1} />
        </PressScale>
        <View style={styles.chromeTitleWrap} pointerEvents="none">
          <Text style={styles.chromeTitle}>Studio</Text>
        </View>
        <View style={styles.chromeRight}>
          <PressScale
            style={styles.glassBtn}
            onPress={() => router.push('/onboarding/selfie-capture')}
            testID="tryon-retake"
            accessibilityRole="button"
            accessibilityLabel="Retake your base photo"
          >
            <Icon name="tryon" color="#FFFFFF" size={19} />
          </PressScale>
          <PressScale
            style={styles.glassQuota}
            onPress={() => router.push('/onboarding/paywall')}
            testID="tryon-quota"
            accessibilityRole="button"
            accessibilityLabel={rendersLeft + ' of ' + cap + ' renders left. Upgrade for more.'}
          >
            <Text style={styles.glassQuotaText}>{rendersLeft + ' of ' + cap}</Text>
          </PressScale>
        </View>
      </View>

      {/* error + retry (over the mirror) */}
      {!!error && (
        <View style={styles.errorGlass} testID="tryon-error">
          <Text style={styles.errorGlassText} numberOfLines={3}>
            {error}
          </Text>
          {phase === 'failed' && !busy ? (
            <PressScale
              style={styles.retryPill}
              onPress={() => {
                void hapticFor.select();
                void handleGenerate();
              }}
              testID="tryon-retry"
            >
              <Text style={styles.retryPillText}>Retry (free)</Text>
            </PressScale>
          ) : null}
        </View>
      )}

      {/* render progress: honest server-state copy, centered over the mirror */}
      {busy ? (
        <View style={styles.progressGlass} testID="tryon-loading">
          <View style={styles.progressCard}>
            <ActivityIndicator color="#FFFFFF" />
            <Text style={styles.progressText}>
              {phase === 'starting'
                ? 'Sending to the studio…'
                : job && job.status === 'queued'
                  ? 'In the queue…'
                  : 'Rendering your look…'}
            </Text>
          </View>
        </View>
      ) : null}

      {/* bottom dock: look rail over a glass control bar (inspo: one
          violet AI Suggestion pill flanked by shuffle + gallery) */}
      <View pointerEvents="box-none" style={[styles.dock, { paddingBottom: insets.bottom + 16 }]}>
        {mode === 'restyle' ? (
          <TextInput
            value={restyleNote}
            onChangeText={setRestyleNote}
            placeholder="Describe the change (e.g. tuck it in, warmer light)"
            placeholderTextColor="rgba(255,255,255,0.55)"
            maxLength={280}
            style={styles.noteGlass}
            testID="restyle-note"
          />
        ) : null}
        {garments.length === 0 ? (
          <Text style={styles.dockHint} testID="tryon-empty">
            Add garments to your closet to build combos.
          </Text>
        ) : combos.length === 0 ? (
          <Text style={styles.dockHint} testID="tryon-empty">
            Add tops, bottoms or dresses and combos appear here.
          </Text>
        ) : (
          <>
            <View style={styles.wearingRow}>
              <Text style={styles.wearingLabel} numberOfLines={1}>
                {activeCombo?.label ?? ''}
              </Text>
              {activeRender ? (
                <View style={styles.onYouChip} testID="tryon-on-you">
                  <Icon name="check" color="#FFFFFF" size={11} strokeWidth={2.6} />
                  <Text style={styles.onYouText}>On you</Text>
                </View>
              ) : null}
              <PressScale
                style={[styles.woreBtn, woreDone ? styles.woreBtnDone : null]}
                onPress={handleWoreIt}
                disabled={woreBusy}
                testID="tryon-wore-it"
                accessibilityRole="button"
                accessibilityLabel={
                  woreDone ? 'Logged — you wore this today' : 'Log this as what you wore today'
                }
              >
                <Text style={styles.woreBtnText}>
                  {woreBusy ? 'Logging…' : woreDone ? 'Worn ✓' : 'Wore it'}
                </Text>
              </PressScale>
            </View>
            <View pointerEvents="box-none" onLayout={() => setRailLaidOut(true)}>
              <FlatList
                ref={railRef}
                data={combos}
                horizontal
                keyExtractor={(c) => c.id}
                showsHorizontalScrollIndicator={false}
                snapToInterval={RAIL_STEP}
                snapToAlignment="start"
                decelerationRate="fast"
                onMomentumScrollEnd={onRailMomentumEnd}
                contentContainerStyle={{ paddingHorizontal: railPad, gap: RAIL_GAP }}
                renderItem={renderRailItem}
                testID="tryon-combo-rail"
              />
            </View>
          </>
        )}
        {/* inspo control bar: one frosted bar, shuffle · AI Suggestion · gallery */}
        <View style={styles.controlBar}>
          <PressScale
            style={styles.controlIcon}
            onPress={handleSurprise}
            testID="tryon-surprise"
            accessibilityRole="button"
            accessibilityLabel="Pick a combo for me from my closet"
          >
            <Icon name="refresh" color="#FFFFFF" size={19} />
          </PressScale>
          <PressScale
            style={[styles.aiPill, { opacity: canGenerate || (tier === 'free' && rendersLeft <= 0) ? 1 : 0.55 }]}
            onPress={() => {
              void hapticFor.confirm();
              void handleGenerate();
            }}
            disabled={!canGenerate && !(tier === 'free' && rendersLeft <= 0)}
            testID="tryon-generate"
            accessibilityRole="button"
            accessibilityLabel={
              tier === 'free' && rendersLeft <= 0
                ? 'Get more renders'
                : mode === 'restyle'
                  ? 'Restyle this look'
                  : 'Render this look on your photo'
            }
          >
            {phase === 'starting' || phase === 'rendering' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <View style={styles.aiPillInner}>
                <Icon name="sparkles" color="#FFFFFF" size={16} />
                <Text style={styles.aiPillText}>
                  {tier === 'free' && rendersLeft <= 0
                    ? 'Get more renders'
                    : mode === 'restyle'
                      ? 'Restyle'
                      : 'AI Suggestion'}
                </Text>
              </View>
            )}
          </PressScale>
          <PressScale
            style={styles.controlIcon}
            onPress={() => router.push('/(tabs)/closet')}
            testID="tryon-wardrobe"
            accessibilityRole="button"
            accessibilityLabel="Open your closet"
          >
            <Icon name="closet" color="#FFFFFF" size={19} />
          </PressScale>
        </View>
      </View>
    </View>
  );
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: tokenColors.stage },
  center: { alignItems: 'center', justifyContent: 'center' },

  emptyStage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  // The violet spotlight behind the empty stage — the stage is never a void.
  emptyStageGlow: {
    position: 'absolute',
    width: '120%',
    height: '46%',
    top: '22%',
    borderRadius: 999,
    backgroundColor: 'rgba(124,92,232,0.16)',
  },
  emptyStageTitle: { color: '#FFFFFF', fontSize: 30, lineHeight: 36, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center' },
  emptyStageBody: { color: 'rgba(255,255,255,0.72)', fontSize: 14.5, lineHeight: 22, textAlign: 'center', fontFamily: 'PlayfairDisplay_700Bold_Italic', paddingHorizontal: 12 },
  emptyStageBtn: { marginTop: 10, borderRadius: 999, backgroundColor: '#FFFFFF', paddingVertical: 12, paddingHorizontal: 24 },
  emptyStageBtnText: { color: tokenColors.stage, fontSize: 14, fontWeight: '700' },

  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 140 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 330 },

  chromeTop: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chromeTitleWrap: { flex: 1, alignItems: 'center' },
  chromeTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    textShadowColor: 'rgba(15,10,28,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  chromeRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glassBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassQuota: {
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  glassQuotaText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },

  errorGlass: {
    position: 'absolute',
    top: 118,
    left: 24,
    right: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(23,14,40,0.85)',
    padding: 14,
    gap: 8,
  },
  errorGlassText: { color: '#FFFFFF', fontSize: 13, lineHeight: 18 },
  retryPill: { alignSelf: 'flex-start', borderRadius: 999, backgroundColor: '#FFFFFF', paddingVertical: 8, paddingHorizontal: 16 },
  retryPillText: { color: tokenColors.stage, fontSize: 13, fontWeight: '700' },

  progressGlass: { position: 'absolute', top: '44%', left: 0, right: 0, alignItems: 'center' },
  progressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(23,14,40,0.72)',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  progressText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },

  dock: { position: 'absolute', bottom: 0, left: 0, right: 0, gap: 12 },
  dockHint: { color: 'rgba(255,255,255,0.85)', fontSize: 14, textAlign: 'center', padding: 20 },

  wearingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  wearingLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
    textShadowColor: 'rgba(15,10,28,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  onYouChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  onYouText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  woreBtn: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  woreBtnDone: { backgroundColor: tokenColors.terracottaDeep, borderColor: tokenColors.terracottaDeep },
  woreBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },

  comboCard: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    overflow: 'hidden',
  },
  comboCardActive: { borderColor: tokenColors.terracottaDeep },
  comboMain: { width: '88%', height: '88%' },
  comboExtra: {
    position: 'absolute',
    left: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: 'rgba(23,17,38,0.14)',
    overflow: 'hidden',
  },
  comboExtraImg: { width: '100%', height: '100%' },

  noteGlass: {
    marginHorizontal: 16,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.16)',
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
  },

  pillRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, alignItems: 'center' },
  // Inspo control bar: one frosted glass bar — shuffle circle · violet AI
  // pill · closet circle. Replaces the two-detached-pills dock.
  controlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginHorizontal: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(23,17,38,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  controlIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiPill: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
    paddingVertical: 13,
    alignItems: 'center',
  },
  aiPillInner: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  aiPillText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  button: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13, lineHeight: 18 },
});
