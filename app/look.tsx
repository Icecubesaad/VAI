import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useTheme, tokenColors } from '@/theme';
import { api, apiErrorCopy, type RenderJob } from '@/lib/api';
import { renderCostPropsFromResult, track } from '@/lib/analytics';
import { hapticFor } from '@/lib/haptics';
import { useSession } from '@/store/session';
import { useCloset, selectClosetList } from '@/store/closet';
import { usePaywall } from '@/store/paywall';

const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 95_000;

/**
 * Your Ensemble — the combination detail (inspo: the 220448 third panel).
 * ONE image per look: the user, full body, in the combination's best
 * garments, fresh editorial pose. Opened from a home card; the render fires
 * once per combo per day (idempotency key) — never a batch surface.
 */
export default function LookScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ garmentIds?: string | string[]; label?: string | string[]; why?: string | string[] }>();
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);

  const garments = useCloset(selectClosetList);
  const basePhotoId = useSession((s) => s.basePhotoId);
  const rendersLeft = usePaywall((s) => s.rendersLeft);

  const garmentIds = (first(params.garmentIds) ?? '').split(',').filter(Boolean);
  const label = first(params.label) ?? 'Your ensemble';
  const why = first(params.why) ?? null;
  const picked = (garmentIds.length > 0 ? garmentIds : garments.slice(0, 3).map((g) => g.id))
    .map((id) => garments.find((g) => g.id === id))
    .filter((g): g is NonNullable<typeof g> => !!g);

  const [phase, setPhase] = useState<'idle' | 'rendering' | 'done' | 'failed'>('idle');
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPoll(), []);

  const settle = useCallback((r: RenderJob, startedAt: number, uid: string, aTier: 'free' | 'premium') => {
    stopPoll();
    if (r.status === 'done') {
      setUri(r.outputUrl ?? null);
      setPhase('done');
      usePaywall.getState().recordRenderSettled();
      track('render_succeeded', {
        ...renderCostPropsFromResult(uid, aTier, { model: r.model ?? 'unknown', costUsd: r.costUsd ?? 0 }),
        render_id: r.id,
        latency_ms: Date.now() - startedAt,
      });
      if (aTier !== 'free') {
        track('credits_consumed', { user_id: uid, tier: aTier, credits: 1, render_id: r.id, cost_usd: r.costUsd ?? 0 });
      }
    } else {
      setPhase('failed');
      setError(r.error ?? 'Render failed — failed renders are free, try again.');
      track('render_failed', {
        ...renderCostPropsFromResult(uid, aTier, { model: r.model ?? 'unknown', costUsd: 0 }),
        render_id: r.id,
        error_code: r.error ?? 'render_failed',
        latency_ms: Date.now() - startedAt,
      });
    }
  }, []);

  const start = useCallback(async () => {
    const uid = useSession.getState().userId;
    const paywall = usePaywall.getState();
    if (paywall.rendersLeft <= 0) {
      router.push({ pathname: '/onboarding/paywall', params: { placement: 'look' } });
      return;
    }
    void hapticFor.confirm();
    setError(null);
    setPhase('rendering');
    const startedAt = Date.now();
    const aTier = paywall.tier === 'free' ? ('free' as const) : ('premium' as const);
    const day = new Date().toISOString().slice(0, 10);
    try {
      const idempotencyKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${uid}|${basePhotoId}|${[...new Set(picked.map((g) => g.id))].sort().join(',')}|${day}|tryon|std`,
      );
      const r = await api.requestTryon({
        ...(basePhotoId ? { basePhotoId } : {}),
        garmentRefs: picked.map((g) => g.id),
        mode: 'tryon',
        tier: 'std',
        idempotencyKey,
        day,
      });
      if (uid) track('render_requested', { user_id: uid, tier: aTier, render_id: r.id, render_tier: 'std', mode: 'tryon' });
      pollRef.current = setInterval(() => {
        void api.getRender(r.id).then((s) => {
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            stopPoll(); setPhase('failed');
            setError('Render timed out — please try again.');
            return;
          }
          if (uid && (s.status === 'done' || s.status === 'failed')) settle(s, startedAt, uid, aTier);
        }).catch(() => undefined);
      }, POLL_MS);
    } catch (e) {
      setPhase('failed');
      const err = e as { code?: string };
      if (err?.code === 'QUOTA_EXCEEDED') {
        router.push({ pathname: '/onboarding/paywall', params: { placement: 'look' } });
        return;
      }
      setError(apiErrorCopy(e).message);
      if (uid) {
        track('render_failed', {
          ...renderCostPropsFromResult(uid, aTier, { model: 'unknown', costUsd: 0 }),
          error_code: err?.code ?? 'request_failed',
          latency_ms: Date.now() - startedAt,
        });
      }
    }
  }, [basePhotoId, picked, router]);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.circle} hitSlop={8} testID="look-back" accessibilityRole="button" accessibilityLabel="Back">
            <Text style={styles.circleGlyph}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Your Ensemble</Text>
          <View style={styles.circle}>
            <Text style={styles.circleGlyph}>♡</Text>
          </View>
        </View>

        {!!why && <Text style={styles.why}>{why}</Text>}

        {phase === 'done' && uri ? (
          <Image source={{ uri }} style={styles.hero} testID="look-image" />
        ) : phase === 'rendering' ? (
          <View style={[styles.hero, styles.heroBusy]} testID="look-rendering">
            <ActivityIndicator color="#F3ECE4" />
            <Text style={styles.busyText}>Styling it on you — one look, one render.</Text>
          </View>
        ) : (
          <View style={[styles.hero, styles.heroPre]} testID="look-pre">
            <View style={styles.chipCluster}>
              {picked.slice(0, 3).map((g, i) => (
                <Image key={g.id} source={{ uri: g.cutoutUrl ?? g.imageUrl }} style={[styles.chip, i === 1 && styles.chipMid]} />
              ))}
            </View>
            <Pressable
              style={styles.aiPill}
              onPress={() => void start()}
              testID="look-render-cta"
              accessibilityRole="button"
              accessibilityLabel={`Render this look on your photo — ${rendersLeft} renders left`}
            >
              <Text style={styles.aiPillText}>✦ AI OUTFIT</Text>
            </Pressable>
          </View>
        )}

        {!!error && <Text style={styles.error} testID="look-error">{error}</Text>}

        {phase === 'done' && (
          <View style={styles.chipRow}>
            {picked.slice(0, 4).map((g) => (
              <Image key={g.id} source={{ uri: g.cutoutUrl ?? g.imageUrl }} style={styles.rowChip} />
            ))}
          </View>
        )}

        <Text style={styles.lookName} numberOfLines={2}>{label.toUpperCase()}</Text>

        <Pressable onPress={() => router.back()} style={styles.close} hitSlop={12} testID="look-close" accessibilityRole="button" accessibilityLabel="Close">
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: tokenColors.stage },
  content: { padding: 20, paddingTop: 56, paddingBottom: 40, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  circle: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  circleGlyph: { color: '#F3ECE4', fontSize: 20, lineHeight: 24 },
  headerTitle: { color: 'rgba(243,236,228,0.85)', fontSize: 14, fontWeight: '600' },
  why: {
    color: 'rgba(243,236,228,0.72)', fontSize: 13, lineHeight: 19,
    textAlign: 'center', paddingHorizontal: 18,
  },
  hero: { width: '100%', aspectRatio: 3 / 4, borderRadius: 18 },
  heroBusy: { alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: 'rgba(255,255,255,0.05)' },
  busyText: { color: 'rgba(243,236,228,0.7)', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  heroPre: { alignItems: 'center', justifyContent: 'center', gap: 22, backgroundColor: 'rgba(255,255,255,0.05)' },
  chipCluster: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  chip: { width: 68, height: 90, borderRadius: 10, transform: [{ rotate: '-5deg' }] },
  chipMid: { width: 84, height: 112, borderRadius: 12, transform: [{ rotate: '3deg' }] },
  aiPill: {
    borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10,
    backgroundColor: tokenColors.oxblood,
  },
  aiPillText: { color: '#F3ECE4', fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  error: { color: '#E37B8B', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  chipRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 4 },
  rowChip: { width: 52, height: 68, borderRadius: 8 },
  lookName: {
    color: '#F3ECE4', fontSize: 34, lineHeight: 40, fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.3,
    textAlign: 'center', marginTop: 6,
  },
  close: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 22, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)' },
  closeGlyph: { color: '#F3ECE4', fontSize: 15, fontWeight: '700' },
});
