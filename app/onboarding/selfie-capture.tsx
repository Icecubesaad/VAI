import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useTheme } from '@/theme';
import { BUCKETS, createSignedBasePhotoUrl, supabase } from '@/lib/supabase';
import { apiErrorCopy } from '@/lib/api';
import { ageGatePassed, useSession } from '@/store/session';

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

const GUIDE = ['Full-body in frame', 'Phone at chest height', 'Plain background', 'Daylight'];

/**
 * Mirror-selfie capture WITH guide overlay. On-device checks: resolution floor,
 * portrait/full-body framing, brightness/detail heuristic; fail = inline reason
 * + Retake. Consent line exact copy. Server re-validates blur/face/keypoints on
 * upload. Blocked until the P0 age gate passes (no body photo from under-13 or
 * non-consented 13–17).
 */
export default function SelfieCapture() {
  const router = useRouter();
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const setBasePhoto = useSession((s) => s.setBasePhoto);
  const setStep = useSession((s) => s.setOnboardingStep);
  // P0 age gate: body-photo flow stays closed until DOB (+ consent) passes.
  const ageBand = useSession((s) => s.ageBand);
  const parentalConsent = useSession((s) => s.parentalConsent);
  const gateOpen = ageGatePassed({ ageBand, parentalConsent });

  const [preview, setPreview] = useState<string | null>(null);
  const [fail, setFail] = useState<FailReason | null>(null);
  const [busy, setBusy] = useState<'capture' | 'upload' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!permission?.granted) void requestPermission();
  }, [permission?.granted, requestPermission]);

  const capture = useCallback(async () => {
    // Belt-and-braces: the render block below keeps the camera unmounted, but
    // never let a capture proceed without a passing age gate.
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
      // On-device quality gate (measurable signals; ML checks run server-side).
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
      // Lightweight brightness/detail heuristic: a quality-0.9 full-body photo
      // compresses well above ~50KB; far below that reads dark/blurry.
      // Best-effort only — the server re-validates blur/face/keypoints.
      try {
        const info = await FileSystem.getInfoAsync(photo.uri);
        if (info.exists && typeof info.size === 'number' && info.size < 50_000) {
          setPreview(photo.uri);
          setFail('too_dark');
          return;
        }
      } catch {
        // Non-fatal: proceed to upload and let the server re-validate.
      }
      setPreview(photo.uri);
    } catch {
      setError('Could not take the photo. Please try again.');
    } finally {
      setBusy(null);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!preview) return;
    if (!ageGatePassed(useSession.getState())) {
      setError('Complete the age check first — VAI is for ages 13 and up.');
      return;
    }
    // Retake loop guard: a quality-gated photo (too small / not portrait /
    // too dark) can never be confirmed — retake is the only way forward.
    // Only upload-failures keep "Use this photo" (retry the same bytes).
    if (fail !== null && fail !== 'upload_failed') {
      setError('This photo missed the guide — hit Retake for the best try-ons.');
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
      // Private `base` bucket (never public) — path `<uid>/base-<ts>.jpg`.
      const path = `${userId}/base-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from(BUCKETS.basePhotos)
        .upload(path, decode(b64), { contentType: 'image/jpeg', upsert: false });
      if (upErr) throw upErr;
      // Retake supersedes: deactivate prior active rows (best-effort — the
      // 30-day supersede sweep keys off `is_active=false`).
      try {
        await supabase
          .from('base_photos')
          .update({ is_active: false })
          .eq('user_id', userId)
          .eq('is_active', true);
      } catch {
        // Non-fatal: the new row below still becomes the active base.
      }
      // Store the STORAGE PATH (not a URL) — the pipeline mints signed URLs
      // server-side; the client mints a 1h signed URL for display only.
      const { data: row, error: rowErr } = await supabase
        .from('base_photos')
        .insert({ user_id: userId, url: path, is_active: true })
        .select('id,url')
        .single();
      if (rowErr) throw rowErr;
      const rec = row as { id: string; url: string };
      const signedUrl = await createSignedBasePhotoUrl(rec.url);
      setBasePhoto({ id: rec.id, url: signedUrl, path: rec.url });
      setStep('closet');
      router.replace('/onboarding/closet-min3');
    } catch (e) {
      const msg = apiErrorCopy(e).message;
      if (preview) setFail('upload_failed');
      setError(msg === 'Something went wrong' ? 'Upload failed. Check your connection and try again.' : msg);
    } finally {
      setBusy(null);
    }
  }, [preview, fail, router, setBasePhoto, setStep]);

  const retake = useCallback(() => {
    setPreview(null);
    setFail(null);
    setError(null);
  }, []);

  if (!permission) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="selfie-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="selfie-denied">
        <Text style={[styles.title, { color: colors.text }]}>Camera access needed</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          VAI uses your camera to photograph garments and your mirror selfie for try-ons only.
        </Text>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => void requestPermission()}
          testID="selfie-grant"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  // P0 age gate: never mount the body-photo camera until DOB (+ 13–17
  // parental consent) passes. Capture/confirm re-check via getState().
  if (!gateOpen) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="selfie-age-blocked">
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
          testID="selfie-age-back"
        >
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Back to sign-in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: '#000' }]} testID="selfie-screen">
      {preview ? (
        <Image source={{ uri: preview }} style={styles.full} contentFit="contain" />
      ) : (
        <CameraView ref={cameraRef} style={styles.full} facing="front">
          {/* Guide overlay: full-body silhouette frame */}
          <View style={styles.guide} pointerEvents="none" testID="selfie-guide">
            <View style={[styles.frame, { borderColor: '#fff' }]} />
            <View style={styles.checklist}>
              {GUIDE.map((g) => (
                <Text key={g} style={styles.guideText}>
                  ✓ {g}
                </Text>
              ))}
            </View>
          </View>
        </CameraView>
      )}

      <View style={styles.sheet}>
        {!!fail && (
          <Text style={[styles.fail, { color: colors.danger }]} testID="selfie-fail">
            {FAIL_COPY[fail]}
          </Text>
        )}
        {!!error && !fail && (
          <Text style={[styles.fail, { color: colors.danger }]} testID="selfie-error">
            {error}
          </Text>
        )}
        <Text style={[styles.consent, { color: colors.muted }]} testID="selfie-consent">
          Used only for your try-ons. Never public without opt-in.
        </Text>
        <Pressable
          onPress={() => {
            setStep('quiz');
            router.replace('/onboarding/quiz');
          }}
          testID="selfie-back"
        >
          <Text style={[styles.consent, { color: colors.muted }]}>← Back (photo is kept)</Text>
        </Pressable>
        {preview ? (
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.half, { backgroundColor: colors.surface }]} onPress={retake} testID="selfie-retake">
              <Text style={[styles.buttonText, { color: colors.text }]}>Retake</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.half, { backgroundColor: colors.primary }]}
              onPress={() => void confirm()}
              disabled={busy === 'upload'}
              testID="selfie-confirm"
            >
              {busy === 'upload' ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Use this photo</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => void capture()}
            disabled={busy === 'capture'}
            testID="selfie-capture"
          >
            {busy === 'capture' ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Capture</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  guide: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  frame: { width: 220, height: 420, borderWidth: 2, borderRadius: 110, borderStyle: 'dashed' },
  checklist: { gap: 4 },
  guideText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  sheet: { backgroundColor: '#FAF8F5', padding: 20, gap: 10, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  fail: { fontSize: 14, lineHeight: 20 },
  consent: { fontSize: 12 },
  row: { flexDirection: 'row', gap: 10 },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  half: { flex: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
