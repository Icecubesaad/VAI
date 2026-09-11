import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import * as Crypto from 'expo-crypto';
import { useTheme } from '@/theme';
import { QuotaBadge, RenderView } from '@/components';
import {
  ApiError,
  api,
  apiErrorCopy,
  type Garment,
  type RenderJob,
  type RenderMode,
  type RenderTier,
  type PoseMode,
} from '@/lib/api';
import { renderCostPropsFromResult, track } from '@/lib/analytics';
import { createSignedBasePhotoUrl, supabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useCloset, selectClosetList } from '@/store/closet';
import { useQuotas } from '@/store/quotas';
import { usePaywall } from '@/store/paywall';
import { useTaste } from '@/store/taste';
import { useTastePrefs } from '@/store/taste-prefs';

const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 95_000;

/** expo-router params can arrive as `string | string[]` — take the first non-empty. */
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
 * Try-on studio: base-photo thumb, outfit selector, Generate, 2-up compare.
 * Counter badge "X of 5 left" + one-tap upgrade. Free renders = std queue;
 * premium = priority + Max tier. Renders take 10–55s IRL — async poll, never
 * a fake countdown ("usually ~20s").
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
  // Style inspiration (invisible autopilot): no pose picker UI. Pose resolves
  // to auto — the user's own pose unless a fresh taste pose exists (then Pin
  // pose borrows it; "My poses only" in Settings forces keep). Share-back
  // stays behind an explicit user tap.
  const tasteConnected = useTaste((s) => s.connected);
  const tasteBoards = useTaste((s) => s.boards);
  const poseRefs = useTaste((s) => s.poseRefs);
  const posePreference = useTastePrefs((s) => s.poseModeDefault);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBoardId, setShareBoardId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const freshPosePin = useMemo(() => poseRefs[0] ?? null, [poseRefs]);
  // Auto: keep the user's pose unless a fresh taste pose exists.
  const poseMode: PoseMode = posePreference === 'auto' && freshPosePin ? 'adapt' : 'keep';
  const poseRefId = poseMode === 'adapt' ? (freshPosePin?.id ?? null) : null;
  const styledWithTaste = poseMode === 'adapt';

  const selectedGarments: Garment[] = useMemo(
    () =>
      selected
        .map((id) => garments.find((g) => g.id === id))
        .filter((g): g is Garment => g !== undefined),
    [selected, garments],
  );

  const rendersLeft = tier === 'free' ? rendersLeftFree : Math.max(0, monthlyCap - monthlyUsed);
  const cap = tier === 'free' ? 5 : monthlyCap;
  // Restyle builds on the finished parent render (no selection/base needed);
  // tryon/compare need garments + a base photo.
  const canGenerate =
    phase !== 'starting' &&
    phase !== 'rendering' &&
    (mode === 'restyle' || (selected.length > 0 && basePhotoId !== null)) &&
    (tier !== 'free' || rendersLeft > 0);

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
          .catch(() => {
            // Transient poll error: keep polling until timeout.
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
    // Auto pose always resolves (keep, or adapt with the fresh taste pin) —
    // no picker, no missing-ref state.
    setError(null);
    setPhase('starting');
    const startedAt = Date.now();
    // Settle helper shared by all three modes (done → mirror + track).
    const settleStart = (r: RenderJob) => {
      setJob(r);
      if (r.status === 'done') {
        setPhase('idle');
        recordRenderDone();
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
        // Idempotency mirrors the server key inputs (render|note|pose — the
        // shared restyle core hashes pose into promptHash, so the client key
        // must too or keep/adapt restyles of the same note would collide).
        const restyleKey = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          `${uid}|${job.id}|${note}|${poseMode}|${poseMode === 'adapt' ? (poseRefId ?? '') : ''}`,
        );
        // Pose carries through restyle (gate 5): keep = base photo, adapt =
        // borrow the pose from the selected pose-marked pin.
        const rr = await api.restyle({
          renderId: job.id,
          note,
          idempotencyKey: restyleKey,
          poseMode,
          ...(poseMode === 'adapt' && poseRefId ? { poseRefId } : {}),
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
      // Idempotency mirrors the server key inputs (user|base|outfit|day|mode|tier|pose).
      const idempotencyKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${uid}|${basePhotoId}|${[...selected].sort().join(',')}|${day}|${mode}|${tierChoice}|${poseMode}|${poseRefId ?? ''}`,
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
        poseMode,
        ...(poseMode === 'adapt' && poseRefId ? { poseRefId } : {}),
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
        router.push('/onboarding/paywall');
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
    poseMode,
    poseRefId,
    selected,
    job,
    restyleNote,
    heroOutfitId,
    heroGarmentIds,
    pollJob,
    recordRenderDone,
    router,
  ]);

  // Share-back: board picker → explicit confirm → pinterest-share.
  // Never auto-posts; the confirm button is the posting consent.
  const handleShare = useCallback(async () => {
    if (!job || job.status !== 'done' || !shareBoardId || sharing) return;
    setShareError(null);
    setSharing(true);
    try {
      const res = await api.pinterestShare({ renderId: job.id, boardId: shareBoardId });
      setSharedUrl(res.url);
      const uid = useSession.getState().userId;
      if (uid) {
        track('pin_shared', {
          user_id: uid,
          tier: toAnalyticsTier(usePaywall.getState().tier),
          render_id: job.id,
        });
      }
    } catch (e) {
      setShareError(apiErrorCopy(e).message);
    } finally {
      setSharing(false);
    }
  }, [job, shareBoardId, sharing]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }, []);

  const busy = phase === 'starting' || phase === 'rendering';

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="tryon-screen">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Try on</Text>
        <QuotaBadge left={rendersLeft} cap={cap} onPress={() => router.push('/onboarding/paywall')} />
      </View>

      {/* Base photo */}
      <View style={styles.baseRow}>
        {basePhotoUrl ? (
          <Image source={{ uri: basePhotoUrl }} style={styles.baseThumb} contentFit="cover" />
        ) : (
          <View style={[styles.baseThumb, styles.baseEmpty, { borderColor: colors.border }]}>
            <Text style={[styles.baseEmptyText, { color: colors.muted }]}>No photo</Text>
          </View>
        )}
        <View style={styles.baseMeta}>
          <Text style={[styles.baseTitle, { color: colors.text }]}>Base photo</Text>
          <Pressable onPress={() => router.push('/onboarding/selfie-capture')} testID="tryon-retake">
            <Text style={[styles.link, { color: colors.primary }]}>
              {basePhotoUrl ? 'Retake' : 'Take mirror selfie'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.modes}>
          {(['tryon', 'restyle', 'compare'] as RenderMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[
                styles.mode,
                { borderColor: colors.border },
                mode === m && { backgroundColor: colors.primary },
              ]}
              testID={`mode-${m}`}
            >
              <Text style={[styles.modeText, { color: mode === m ? colors.onPrimary : colors.text }]}>
                {m === 'tryon' ? 'Try-on' : m === 'restyle' ? 'Restyle' : 'Compare'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Restyle change-note (server requires a non-empty note; the P1-4
          guard above blocks Generate until this + a finished render exist). */}
      {mode === 'restyle' && (
        <TextInput
          value={restyleNote}
          onChangeText={setRestyleNote}
          placeholder="Describe the change (e.g. tuck it in, warmer light)"
          maxLength={280}
          style={[styles.note, { borderColor: colors.border, color: colors.text }]}
          testID="restyle-note"
        />
      )}

      {/* Outfit selector */}
      {garments.length === 0 ? (
        <View style={styles.state} testID="tryon-empty">
          <Text style={[styles.stateTitle, { color: colors.text }]}>Nothing to try on yet</Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Add garments to your closet first, then come back to see them on you.
          </Text>
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)/closet')}
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Go to closet</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={garments}
          horizontal
          keyExtractor={(g) => g.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.selector}
          renderItem={({ item }) => {
            const active = selected.includes(item.id);
            return (
              <Pressable onPress={() => toggleSelect(item.id)} testID={`select-${item.id}`}>
                <Image
                  source={{ uri: item.cutoutUrl ?? item.imageUrl }}
                  style={[styles.pick, active && { borderColor: colors.primary, borderWidth: 3 }]}
                  contentFit="cover"
                />
              </Pressable>
            );
          }}
        />
      )}

      <Pressable
        style={[
          styles.button,
          { backgroundColor: canGenerate ? colors.primary : colors.border },
          styles.generate,
        ]}
        onPress={() => void handleGenerate()}
        disabled={!canGenerate}
        testID="tryon-generate"
      >
        {phase === 'starting' ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
            {tier === 'free' && rendersLeft <= 0 ? 'Out of renders — Upgrade' : 'Generate'}
          </Text>
        )}
      </Pressable>
      {!!error && (
        <Text style={[styles.error, { color: colors.danger }]} testID="tryon-error">
          {error}
        </Text>
      )}

      {/* Result / 2-up compare */}
      {busy && (
        <View style={styles.state} testID="tryon-loading">
          <ActivityIndicator size="large" />
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Creating your try-on — usually ~20s. We&apos;ll notify you when it&apos;s ready.
          </Text>
        </View>
      )}
      {!!job && (job.status === 'done' || busy) && (
        <RenderView
          basePhotoUrl={basePhotoUrl}
          outputUrl={job.outputUrl ?? null}
          status={job.status}
          compare={mode === 'compare'}
          watermark
        />
      )}
      {!!job && job.status === 'done' && styledWithTaste && (
        <Text style={[styles.tasteCaption, { color: colors.muted }]} testID="taste-caption">
          Styled with your inspiration
        </Text>
      )}
      {!!job && job.status === 'done' && (
        <Pressable
          style={[styles.button, styles.shareBtn, { borderColor: colors.border, borderWidth: 1 }]}
          onPress={() => {
            setShareError(null);
            setSharedUrl(null);
            setShareBoardId(null);
            if (!tasteConnected) router.push('/pinterest-connect');
            else setShareOpen(true);
          }}
          testID="share-pinterest"
        >
          <Text style={[styles.buttonText, { color: colors.text }]}>Save to Pinterest</Text>
        </Pressable>
      )}
      {phase === 'failed' && !busy && (
        <Pressable
          style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
          onPress={() => void handleGenerate()}
          testID="tryon-retry"
        >
          <Text style={[styles.buttonText, { color: colors.text }]}>Retry (free)</Text>
        </Pressable>
      )}

      {/* Share-back: board picker → explicit confirm → pinterest-share. */}
      <Modal visible={shareOpen} transparent animationType="slide" onRequestClose={() => setShareOpen(false)}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { backgroundColor: colors.surface }]} testID="share-sheet">
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Save to Pinterest</Text>
            {tasteBoards.length === 0 ? (
              <View style={styles.sheetBody}>
                <Text style={[styles.sheetSub, { color: colors.muted }]}>
                  No boards synced yet — pick boards first, then save this look.
                </Text>
                <Pressable
                  style={[styles.button, { backgroundColor: colors.primary }]}
                  onPress={() => {
                    setShareOpen(false);
                    router.push('/pinterest-boards');
                  }}
                  testID="share-pick-boards"
                >
                  <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Choose boards</Text>
                </Pressable>
              </View>
            ) : sharedUrl ? (
              <View style={styles.sheetBody}>
                <Text style={[styles.sheetSub, { color: colors.text }]} testID="share-saved">
                  Saved to Pinterest ✓
                </Text>
                <Pressable
                  style={[styles.button, { backgroundColor: colors.primary }]}
                  onPress={() => void Linking.openURL(sharedUrl)}
                  testID="share-open"
                >
                  <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Open Pinterest</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
                  onPress={() => setShareOpen(false)}
                  testID="share-done"
                >
                  <Text style={[styles.buttonText, { color: colors.text }]}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.sheetBody}>
                {tasteBoards.map((b) => {
                  const active = b.boardId === shareBoardId;
                  return (
                    <Pressable
                      key={b.boardId}
                      style={[
                        styles.boardRow,
                        { borderColor: colors.border },
                        active && { borderColor: colors.primary },
                      ]}
                      onPress={() => setShareBoardId(b.boardId)}
                      testID={`share-board-${b.boardId}`}
                    >
                      <Text style={[styles.boardName, { color: colors.text }]} numberOfLines={1}>
                        {b.name}
                      </Text>
                      {active && <Text style={[styles.tickSm, { color: colors.primary }]}>✓</Text>}
                    </Pressable>
                  );
                })}
                {!!shareError && (
                  <Text style={[styles.error, { color: colors.danger }]} testID="share-error">
                    {shareError}
                  </Text>
                )}
                <Pressable
                  style={[
                    styles.button,
                    { backgroundColor: shareBoardId && !sharing ? colors.primary : colors.border },
                  ]}
                  onPress={() => void handleShare()}
                  disabled={!shareBoardId || sharing}
                  testID="share-confirm"
                >
                  {sharing ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
                      Confirm — save this look
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}
                  onPress={() => setShareOpen(false)}
                  testID="share-cancel"
                >
                  <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '700' },
  baseRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  baseThumb: { width: 56, height: 72, borderRadius: 10, backgroundColor: '#EDE8E0' },
  baseEmpty: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  baseEmptyText: { fontSize: 11 },
  baseMeta: { gap: 4 },
  baseTitle: { fontSize: 14, fontWeight: '600' },
  link: { fontSize: 13, fontWeight: '600' },
  modes: { flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' },
  mode: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  modeText: { fontSize: 12, fontWeight: '600' },
  note: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 12, fontSize: 14 },
  selector: { gap: 10, paddingVertical: 16 },
  pick: { width: 84, height: 84, borderRadius: 12, backgroundColor: '#EDE8E0' },
  button: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  generate: { marginTop: 4 },
  shareBtn: { marginTop: 10 },
  error: { fontSize: 13, marginTop: 8 },
  tasteCaption: { fontSize: 12, marginTop: 6, textAlign: 'center' },
  state: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  stateTitle: { fontSize: 18, fontWeight: '600' },
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  poseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  poseLabel: { fontSize: 13, fontWeight: '600' },
  poseSeg: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  poseSegText: { fontSize: 13, fontWeight: '600' },
  pinRow: { flexDirection: 'row', gap: 12, marginTop: 10, alignItems: 'center' },
  pinThumb: { width: 56, height: 72, borderRadius: 10, backgroundColor: '#EDE8E0' },
  pinMeta: { flex: 1, gap: 4 },
  pinText: { fontSize: 14, fontWeight: '600' },
  upsell: { borderRadius: 14, padding: 14, marginTop: 12, gap: 8 },
  upsellTitle: { fontSize: 16, fontWeight: '700' },
  upsellBody: { fontSize: 14, lineHeight: 20 },
  upsellRow: { flexDirection: 'row', gap: 10 },
  upsellBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  upsellBtnText: { fontSize: 15, fontWeight: '700' },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 12, maxHeight: '80%' },
  sheetTitle: { fontSize: 18, fontWeight: '700' },
  sheetSub: { fontSize: 14, lineHeight: 20 },
  sheetBody: { gap: 10 },
  pinGrid: { gap: 8 },
  pinCell: { width: 100, height: 140, borderRadius: 10, backgroundColor: '#EDE8E0' },
  boardRow: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  boardName: { fontSize: 15, fontWeight: '600', flex: 1 },
  tickSm: { fontSize: 16, fontWeight: '700' },
});
