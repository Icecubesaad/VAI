import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useTheme } from '@/theme';
import { Button, PoseGuide } from '@/components';
import type { PoseCheck } from '@/components';
import { BUCKETS, supabase } from '@/lib/supabase';
import { apiErrorCopy, type ReelPose } from '@/lib/api';
import { ageGatePassed, useSession } from '@/store/session';
import { fetchPoseStatus } from '@/store/reel';

type FailReason = 'too_small' | 'not_portrait' | 'too_dark' | 'upload_failed';

const FAIL_COPY: Record<FailReason, string> = {
  too_small:
    'Photo looks too low-resolution — hold steady, use daylight, and keep the phone at chest height.',
  not_portrait:
    'We need a full-body portrait shot — step back until head to shoes fits inside the guide.',
  too_dark:
    'Photo looks too dark or blurry — move to daylight or a brighter room and hold steady.',
  upload_failed: 'Upload failed. Check your connection and try again.',
};

/** Map the shared selfie quality gates onto PoseGuide's live-check keys. */
const CHECK_KEY: Record<Exclude<FailReason, 'upload_failed'>, PoseCheck['key']> = {
  too_small: 'blur',
  not_portrait: 'pose',
  too_dark: 'light',
};

const STEPS: Array<{ pose: ReelPose; title: string; hint: string }> = [
  {
    pose: 'front',
    title: 'Front',
    hint: 'Face the camera square-on, arms relaxed, head to shoes in frame.',
  },
  {
    pose: 'step',
    title: 'Step',
    hint: 'Take one natural step to the side — mid-stride, full body in frame.',
  },
  {
    pose: 'detail',
    title: 'Detail',
    hint: 'Step closer — frame waist to shoes to show fabric and fit.',
  },
];

/**
 * Pose Pack: 3-step guided capture (front / step / detail) reusing the
 * SelfieGuide component + the selfie quality gates (resolution floor,
 * portrait framing, brightness heuristic) + the locked consent copy.
 * Uploads go to the PRIVATE `base` bucket; pose is stored per photo in
 * `pose_meta` with one active row per pose (retakes supersede same-pose).
 * Entries: reel empty state, profile settings, post-onboarding nudge.
 */
export default function PosePack() {
  const router = useRouter();
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  const ageBand = useSession((s) => s.ageBand);
  const parentalConsent = useSession((s) => s.parentalConsent);
  const setStep = useSession((s) => s.setOnboardingStep);
  const gateOpen = ageGatePassed({ ageBand, parentalConsent });

  const [stepIdx, setStepIdx] = useState(0);
  const [guided, setGuided] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [fail, setFail] = useState<FailReason | null>(null);
  const [busy, setBusy] = useState<'capture' | 'upload' | 'loading' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const step = STEPS[stepIdx] ?? STEPS[0];
  if (!step) throw new Error('pose-pack: no steps');

  // Surface the last quality-gate failure inside the guide (same copy as
  // selfie-capture — one capture language across the app).
  const poseChecks: PoseCheck[] =
    fail && fail !== 'upload_failed'
      ? [{ key: CHECK_KEY[fail], ok: false, hint: FAIL_COPY[fail] }]
      : [];

  useEffect(() => {
    if (!permission?.granted) void requestPermission();
  }, [permission?.granted, requestPermission]);

  // Resume at the first pose still missing an active photo.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchPoseStatus();
        if (cancelled) return;
        const firstMissing = STEPS.findIndex((s) => !status[s.pose]);
        if (firstMissing === -1) {
          setComplete(true);
        } else {
          setStepIdx(firstMissing);
        }
      } catch {
        // Start at step 0; per-step upload errors surface inline.
      } finally {
        if (!cancelled) setBusy((b) => (b === 'loading' ? null : b));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetShot = useCallback(() => {
    setPreview(null);
    setFail(null);
    setError(null);
  }, []);

  const capture = useCallback(async () => {
    if (!ageGatePassed(useSession.getState())) {
      setError('Complete the age check first — VAI is for ages 13 and up.');
      return;
    }
    setFail(null);
    setError(null);
    setBusy('capture');
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9, skipProcessing: false });
      if (!photo?.uri) throw new Error('no-photo');
      if (photo.width < 720 || photo.height < 720) {
        setPreview(photo.uri);
        setFail('too_small');
        return;
      }
      if (photo.height < photo.width * 1.2) {
        setPreview(photo.uri);
        setFail('not_portrait');
        return;
      }
      try {
        const info = await FileSystem.getInfoAsync(photo.uri);
        if (info.exists && typeof info.size === 'number' && info.size < 50_000) {
          setPreview(photo.uri);
          setFail('too_dark');
          return;
        }
      } catch {
        // Non-fatal: the server re-validates blur/face/keypoints.
      }
      setPreview(photo.uri);
    } catch {
      setError('Could not take the photo. Please try again.');
    } finally {
      setBusy(null);
    }
  }, []);

  const confirm = useCallback(async () => {
    const current = STEPS[stepIdx] ?? STEPS[0];
    if (!current || !preview) return;
    if (!ageGatePassed(useSession.getState())) {
      setError('Complete the age check first — VAI is for ages 13 and up.');
      return;
    }
    setFail(null);
    setError(null);
    setBusy('upload');
    try {
      const userId = useSession.getState().userId;
      if (!userId) throw new Error('auth');
      const b64 = await FileSystem.readAsStringAsync(preview, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Private `base` bucket (never public) — path `<uid>/pose-<pose>-<ts>.jpg`.
      const path = `${userId}/pose-${current.pose}-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from(BUCKETS.basePhotos)
        .upload(path, decode(b64), { contentType: 'image/jpeg', upsert: false });
      if (upErr) throw upErr;
      // One active row per pose: supersede prior same-pose actives, then insert.
      try {
        const { data: actives } = await supabase
          .from('base_photos')
          .select('id,pose_meta')
          .eq('user_id', userId)
          .eq('is_active', true);
        const rows = (actives ?? []) as Array<{ id: string; pose_meta?: { pose?: unknown } | null }>;
        for (const row of rows.filter((r) => r.pose_meta?.pose === current.pose)) {
          await supabase.from('base_photos').update({ is_active: false }).eq('id', row.id);
        }
      } catch {
        // Non-fatal: the new row below still becomes an active pose photo.
      }
      const { error: rowErr } = await supabase.from('base_photos').insert({
        user_id: userId,
        url: path,
        pose_meta: { pose: current.pose },
        is_active: true,
        consent_social: false,
      });
      if (rowErr) throw rowErr;
      // Advance: next missing pose, or the done screen.
      const status = await fetchPoseStatus();
      const nextMissing = STEPS.findIndex((s) => !status[s.pose]);
      resetShot();
      setGuided(false);
      if (nextMissing === -1) {
        setComplete(true);
      } else {
        setStepIdx(nextMissing);
      }
    } catch (e) {
      if (preview) setFail('upload_failed');
      const msg = apiErrorCopy(e).message;
      setError(msg === 'Something went wrong' ? 'Upload failed. Check your connection and try again.' : msg);
    } finally {
      setBusy(null);
    }
  }, [preview, resetShot, stepIdx]);

  if (!permission) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="pose-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="pose-denied">
        <Text style={[styles.title, { color: colors.text }]}>Camera access needed</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          Pose photos power your weekly reel. They stay private — used only for your try-ons.
        </Text>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => void requestPermission()}
          testID="pose-grant"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  if (!gateOpen) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="pose-age-blocked">
        <Text style={[styles.title, { color: colors.text }]}>Age check first</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          VAI is for ages 13 and up (17+ in the App Store). Go back and enter your birth year —
          ages 13–17 need a parent or guardian to consent before this step.
        </Text>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => {
            setStep('auth');
            router.replace('/onboarding/auth');
          }}
          testID="pose-age-back"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Back to sign-in</Text>
        </Pressable>
      </View>
    );
  }

  if (complete) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="pose-complete">
        <Text style={[styles.title, { color: colors.text }]}>Pose pack complete</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          All 3 poses saved — front, step, detail. Your weekly reel will use them every Monday.
        </Text>
        <View style={styles.fullRow}>
          <Button title="See my reel" onPress={() => router.replace('/(tabs)/reel')} testID="pose-done" />
        </View>
      </View>
    );
  }

  if (busy === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="pose-checking">
        <ActivityIndicator size="large" />
        <Text style={[styles.body, { color: colors.muted }]}>Checking your poses…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="pose-pack">
      <View style={styles.head}>
        <Text style={[styles.kicker, { color: colors.muted }]} testID="pose-progress">
          Pose {stepIdx + 1} of {STEPS.length} — {step.title}
        </Text>
        <View style={styles.dots}>
          {STEPS.map((s, i) => (
            <View
              key={s.pose}
              style={[styles.dot, { backgroundColor: i <= stepIdx ? colors.primary : colors.border }]}
              testID={`pose-dot-${i}`}
            />
          ))}
        </View>
        <Text style={[styles.hint, { color: colors.text }]} testID="pose-hint">
          {step.hint}
        </Text>
      </View>

      {!guided ? (
        <View style={styles.guideWrap} testID={`pose-guide-${step.pose}`}>
          <PoseGuide
            pose={step.pose}
            onPoseChange={(p) => {
              const i = STEPS.findIndex((s) => s.pose === p);
              if (i >= 0) {
                resetShot();
                setGuided(false);
                setStepIdx(i);
              }
            }}
            checks={poseChecks}
            failureReason={fail ? FAIL_COPY[fail] : null}
            onCapture={() => setGuided(true)}
            capturing={false}
            testID="pose-pose-guide"
          />
        </View>
      ) : (
        <View style={styles.cameraWrap}>
          {preview ? (
            <Image source={{ uri: preview }} style={styles.full} contentFit="contain" />
          ) : (
            <CameraView ref={cameraRef} style={styles.full} facing="front">
              <View style={styles.frame} pointerEvents="none" testID="pose-frame">
                <View style={styles.frameBox} />
                <Text style={styles.frameText}>{step.hint}</Text>
              </View>
            </CameraView>
          )}
          <View style={styles.sheet}>
            {!!fail && (
              <Text style={[styles.fail, { color: colors.danger }]} testID="pose-fail">
                {FAIL_COPY[fail]}
              </Text>
            )}
            {!!error && !fail && (
              <Text style={[styles.fail, { color: colors.danger }]} testID="pose-error">
                {error}
              </Text>
            )}
            <Text style={[styles.consent, { color: colors.muted }]} testID="pose-consent">
              Used only for your try-ons. Never public without opt-in.
            </Text>
            {preview ? (
              <View style={styles.row}>
                <Pressable
                  style={[styles.button, styles.half, { backgroundColor: colors.surface }]}
                  onPress={resetShot}
                  testID="pose-retake"
                >
                  <Text style={[styles.buttonText, { color: colors.text }]}>Retake</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.half, { backgroundColor: colors.primary }]}
                  onPress={() => void confirm()}
                  disabled={busy === 'upload'}
                  testID="pose-confirm"
                >
                  {busy === 'upload' ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
                      Use this {step.title.toLowerCase()} photo
                    </Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <View style={styles.row}>
                <Pressable
                  style={[styles.button, styles.half, { backgroundColor: colors.surface }]}
                  onPress={() => setGuided(false)}
                  testID="pose-back-guide"
                >
                  <Text style={[styles.buttonText, { color: colors.text }]}>Guide</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.half, { backgroundColor: colors.primary }]}
                  onPress={() => void capture()}
                  disabled={busy === 'capture'}
                  testID="pose-capture"
                >
                  {busy === 'capture' ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Capture</Text>
                  )}
                </Pressable>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  head: { paddingHorizontal: 24, paddingTop: 64, gap: 8 },
  kicker: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  dots: { flexDirection: 'row', gap: 8 },
  dot: { flex: 1, height: 8, borderRadius: 4 },
  hint: { fontSize: 15, lineHeight: 22 },
  guideWrap: { flex: 1, marginTop: 12 },
  cameraWrap: { flex: 1, marginTop: 12, backgroundColor: '#000' },
  full: { flex: 1 },
  frame: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  frameBox: { width: 220, height: 420, borderWidth: 2, borderRadius: 110, borderStyle: 'dashed', borderColor: '#fff' },
  frameText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  sheet: { backgroundColor: '#FAF8F5', padding: 20, gap: 10, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  fail: { fontSize: 14, lineHeight: 20 },
  consent: { fontSize: 12 },
  row: { flexDirection: 'row', gap: 10 },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  half: { flex: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  fullRow: { width: '100%' },
});
