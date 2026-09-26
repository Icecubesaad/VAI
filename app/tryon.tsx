import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useTheme } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { api, apiErrorCopy, type RenderJob } from '@/lib/api';
import { renderCostPropsFromResult, track } from '@/lib/analytics';
import { hapticFor } from '@/lib/haptics';
import { createSignedBasePhotoUrl } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useCloset, selectClosetList } from '@/store/closet';
import { usePaywall } from '@/store/paywall';

const POLL_MS = 4000;
const POLL_TIMEOUT_MS = 95_000;

function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/**
 * Wear-it-today: ONE render for the day's outfit. No combo rail, no manual
 * multi-pick — the studio's per-combo render surface was removed (founder
 * cost call). Reached from Today's hero only.
 */
export default function TryonScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ renderId?: string | string[]; outfitId?: string | string[]; garmentIds?: string | string[] }>();
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);

  const garments = useCloset(selectClosetList);
  const basePhotoId = useSession((s) => s.basePhotoId);
  const basePhotoUrl = useSession((s) => s.basePhotoUrl);
  const basePhotoPath = useSession((s) => s.basePhotoPath);
  const rendersLeft = usePaywall((s) => s.rendersLeft);

  const garmentIds = (first(params.garmentIds) ?? '').split(',').filter(Boolean);
  const outfitId = first(params.outfitId) ?? undefined;
  const picked = garmentIds.length > 0
    ? garmentIds.map((id) => garments.find((g) => g.id === id)).filter((g): g is NonNullable<typeof g> => !!g)
    : garments.slice(0, 3);

  const [phase, setPhase] = useState<'idle' | 'rendering' | 'done' | 'failed'>('idle');
  const [job, setJob] = useState<RenderJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseUri, setBaseUri] = useState<string | null>(basePhotoUrl);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => () => stopPoll(), []);

  useEffect(() => {
    if (baseUri || !basePhotoPath) return;
    void createSignedBasePhotoUrl(basePhotoPath).then(setBaseUri).catch(() => undefined);
  }, [baseUri, basePhotoPath]);

  const settle = useCallback((r: RenderJob, startedAt: number, uid: string, aTier: 'free' | 'premium') => {
    setJob(r);
    if (r.status === 'done') {
      stopPoll();
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
    } else if (r.status === 'failed') {
      stopPoll();
      setPhase('failed');
      setError(r.error ?? 'Render failed. Failed renders are free — please try again.');
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
      router.push({ pathname: '/onboarding/paywall', params: { placement: 'tryon_quota' } });
      return;
    }
    void hapticFor.confirm();
    setError(null);
    setPhase('rendering');
    const startedAt = Date.now();
    const aTier = toAnalyticsTier(paywall.tier);
    const day = new Date().toISOString().slice(0, 10);
    try {
      const idempotencyKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${uid}|${basePhotoId}|${[...new Set(picked.map((g) => g.id))].sort().join(',')}|${day}|tryon|std`,
      );
      const r = await api.requestTryon({
        ...(outfitId ? { outfitId } : {}),
        ...(basePhotoId ? { basePhotoId } : {}),
        garmentRefs: picked.map((g) => g.id),
        mode: 'tryon',
        tier: 'std',
        idempotencyKey,
        day,
      });
      if (uid) {
        track('render_requested', { user_id: uid, tier: aTier, render_id: r.id, render_tier: 'std', mode: 'tryon' });
      }
      pollRef.current = setInterval(() => {
        void api.getRender(r.id).then((s) => {
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            stopPoll();
            setPhase('failed');
            setError('Render timed out. We retried once on the standard queue — please try again.');
            return;
          }
          if (uid && (s.status === 'done' || s.status === 'failed')) settle(s, startedAt, uid, aTier);
        }).catch(() => undefined);
      }, POLL_MS);
    } catch (e) {
      setPhase('failed');
      const err = e as { code?: string };
      if (err?.code === 'QUOTA_EXCEEDED') {
        router.push({ pathname: '/onboarding/paywall', params: { placement: 'tryon_quota' } });
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
  }, [basePhotoId, outfitId, picked, router]);

  const done = phase === 'done' && job?.outputUrl;

  return (
    <View style={styles.root} testID="tryon-screen">
      <MeshGradient variant="stage" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.kicker, { color: colors.muted }]}>Wear it today</Text>
        <Text style={[styles.title, { color: colors.text }]}>One look. One render.</Text>

        {done ? (
          <Image source={{ uri: job!.outputUrl! }} style={styles.result} testID="tryon-result" />
        ) : (
          <>
            {baseUri ? (
              <Image source={{ uri: baseUri }} style={styles.base} testID="tryon-base" />
            ) : (
              <View style={[styles.base, styles.basePlaceholder]} testID="tryon-base-missing">
                <Text style={{ color: colors.muted }}>Take your mirror selfie first — back on Today.</Text>
              </View>
            )}
            <View style={styles.rack}>
              {picked.map((g) => (
                <Image key={g.id} source={{ uri: g.cutoutUrl ?? g.imageUrl }} style={styles.thumb} />
              ))}
            </View>
            {phase === 'rendering' ? (
              <View style={styles.rendering}>
                <ActivityIndicator color={colors.text} />
                <Text style={[styles.renderingText, { color: colors.muted }]}>Rendering on you — usually ~20s. Failed renders are free.</Text>
              </View>
            ) : (
              <Pressable
                style={[styles.cta, { backgroundColor: colors.primary }]}
                onPress={() => void start()}
                testID="tryon-generate"
                accessibilityRole="button"
                accessibilityLabel={`Try today's look on your photo — ${rendersLeft} renders left`}
              >
                <Text style={[styles.ctaText, { color: colors.onPrimary }]}>
                  Try it on · {rendersLeft} left
                </Text>
              </Pressable>
            )}
            {!!error && <Text style={[styles.error, { color: colors.danger }]} testID="tryon-error">{error}</Text>}
          </>
        )}

        <Pressable onPress={() => router.back()} testID="tryon-back" hitSlop={12}>
          <Text style={[styles.back, { color: colors.muted }]}>Back to Today</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 24, paddingTop: 64, paddingBottom: 48, gap: 16 },
  kicker: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.4 },
  base: { width: '100%', aspectRatio: 3 / 4, borderRadius: 16 },
  basePlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0E7EC' },
  rack: { flexDirection: 'row', gap: 10 },
  thumb: { width: 64, height: 84, borderRadius: 10 },
  cta: { borderRadius: 999, paddingVertical: 16, alignItems: 'center' },
  ctaText: { fontSize: 16, fontWeight: '700' },
  rendering: { alignItems: 'center', gap: 10, paddingVertical: 18 },
  renderingText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  result: { width: '100%', aspectRatio: 3 / 4, borderRadius: 16 },
  error: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  back: { fontSize: 14, textAlign: 'center', paddingVertical: 8 },
});
