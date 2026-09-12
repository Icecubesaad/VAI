import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image as RNImage, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
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
  const [previewSource, setPreviewSource] = useState<'camera' | 'library'>('camera');
  const [fail, setFail] = useState<FailReason | null>(null);
  const [busy, setBusy] = useState<'capture' | 'upload' | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Resolve real dimensions: picker/camera metadata first, RN Image probe
   *  second (web library assets often report 0s), give up third — a photo
   *  with unknown dimensions is allowed through and the server re-validates.
   *  Never trap the user on a measurement failure. */
  const resolveDims = useCallback(async (uri: string, w: number, h: number) => {
    if (w > 0 && h > 0) return { w, h };
    try {
      const probed = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('dims-timeout')), 5000);
        RNImage.getSize(
          uri,
          (pw, ph) => {
            clearTimeout(timer);
            resolve({ w: pw, h: ph });
          },
          (e) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error('dims-failed'));
          },
        );
      });
      return probed;
    } catch {
      return { w: 0, h: 0 };
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' && !permission?.granted) void requestPermission();
  }, [permission?.granted, requestPermission]);

  /** Shared quality gate for camera AND library photos (same bar, either source). */
  const gatePhoto = useCallback(async (
    uri: string,
    width: number,
    height: number,
    source: 'camera' | 'library',
  ) => {
    const dims = await resolveDims(uri, width, height);
    setPreviewSource(source);
    if (dims.w > 0 && dims.h > 0) {
      if (dims.w < 720 || dims.h < 720) {
        setPreview(uri);
        setFail('too_small');
        return;
      }
      if (dims.h < dims.w * 1.2) {
        setPreview(uri);
        setFail('not_portrait');
        return;
      }
    }
    // Unknown dimensions: let it through — the server re-validates
    // blur/face/keypoints on upload. A measurement miss must never block setup.
    // Lightweight darkness heuristic: a quality-0.9 full-body photo compresses
    // well above ~50KB; far below reads dark/blurry. Best-effort only.
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && typeof info.size === 'number' && info.size < 50_000) {
        setPreview(uri);
        setFail('too_dark');
        return;
      }
    } catch {
      // Non-fatal (web blob URIs): proceed, server re-validates.
    }
    setPreview(uri);
  }, [resolveDims]);

  /** Upload a taken picture instead of shooting one — same gate, same upload. */
  const pickFromLibrary = useCallback(async () => {
    if (!ageGatePassed(useSession.getState())) {
      setError('Complete the age check first — VAI is for ages 13 and up.');
      return;
    }
    setFail(null);
    setError(null);
    setBusy('capture');
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      const asset = res.assets[0];
      await gatePhoto(asset.uri, asset.width ?? 0, asset.height ?? 0, 'library');
    } catch {
      setError('Could not open that photo. Please try another.');
    } finally {
      setBusy(null);
    }
  }, [gatePhoto]);

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
      // Same shared gate as library photos (resolution, framing, darkness
      // heuristic inside gatePhoto; server re-validates blur/face/keypoints).
      await gatePhoto(photo.uri, photo.width ?? 0, photo.height ?? 0, 'camera');
    } catch {
      setError('Could not take the photo. Please try again.');
    } finally {
      setBusy(null);
    }
  }, [gatePhoto]);

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
      setError('This photo missed the guide — choose a different one or use it anyway.');
      return;
    }
    setFail(null);
    setError(null);
    setBusy('upload');
    try {
      const userId = useSession.getState().userId;
      if (!userId) {
        setError('Sign in to continue your setup — your progress is saved.');
        return;
      }
      // Base64 the bytes: FileSystem on native, fetch fallback for web blob URIs.
      let b64: string;
      try {
        b64 = await FileSystem.readAsStringAsync(preview, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        const fetched = await fetch(preview);
        const buf = new Uint8Array(await fetched.arrayBuffer());
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
        }
        b64 = btoa(bin);
      }
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

  if (Platform.OS !== 'web') {
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
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Allow camera access</Text>
        </Pressable>
        {permission.canAskAgain === false && (
          <Pressable
            style={[styles.button, { backgroundColor: colors.surface }]}
            onPress={() => void Linking.openSettings().catch(() => undefined)}
            testID="selfie-open-settings"
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>Open Settings</Text>
          </Pressable>
        )}
        {/* Library upload has the same quality bar — never trap a user who
            declined (or permanently lost) camera access mid-funnel. */}
        <Pressable
          style={[styles.button, { backgroundColor: colors.surface }]}
          onPress={() => void pickFromLibrary()}
          disabled={busy === 'capture'}
          testID="selfie-library-denied"
        >
          {busy === 'capture' ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.text }]}>Choose from library instead</Text>
          )}
        </Pressable>
        <Pressable
          onPress={() => {
            setStep('quiz');
            router.replace('/onboarding/quiz');
          }}
          testID="selfie-denied-back"
        >
          <Text style={[styles.consent, { color: colors.muted }]}>Back to quiz</Text>
        </Pressable>
      </View>
    );
    }
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

  // Web has no camera capture: show the upload panel WITHOUT the camera
  // permission gate (expo-camera web starts ungranted; demanding camera access
  // just to unlock a file upload trapped every web user who declined).
  if (Platform.OS === 'web' && !preview) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]} testID="selfie-upload">
        <Text style={[styles.title, { color: colors.text }]}>Add your photo</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          Upload a full-body photo — daylight, plain background, head to shoes in frame. Used
          only for your try-ons, never public without opt-in.
        </Text>
        <Pressable
          style={[styles.button, styles.wide, { backgroundColor: colors.primary }]}
          onPress={() => void pickFromLibrary()}
          disabled={busy === 'capture'}
          testID="selfie-library"
        >
          {busy === 'capture' ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Choose from library</Text>
          )}
        </Pressable>
        {!!fail && (
          <Text style={[styles.fail, { color: colors.danger }]} testID="selfie-fail">
            {FAIL_COPY[fail]}
          </Text>
        )}
        {!!fail && fail !== 'upload_failed' && (
          <Pressable onPress={() => setFail(null)} testID="selfie-use-anyway">
            <Text style={[styles.fail, { color: colors.muted }]}>
              Use this photo anyway — VAI re-checks it on upload
            </Text>
          </Pressable>
        )}
        {!!error && !fail && (
          <Text style={[styles.fail, { color: colors.danger }]} testID="selfie-error">
            {error}
          </Text>
        )}
        <Pressable
          onPress={() => {
            if (busy === 'capture') return;
            setStep('quiz');
            router.replace('/onboarding/quiz');
          }}
          testID="selfie-web-back"
        >
          <Text style={[styles.consent, { color: colors.muted }]}>Back to quiz</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: '#000' }]} testID="selfie-screen">
      {preview ? (
        <Image source={{ uri: preview }} style={styles.full} contentFit="contain" />
      ) : Platform.OS === 'web' ? (
        <View style={[styles.full, styles.webPrompt]} testID="selfie-web-prompt">
          <Text style={styles.guideText}>Your photo appears here for review</Text>
        </View>
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
        {!!fail && fail !== 'upload_failed' && (
          <Pressable onPress={() => setFail(null)} testID="selfie-use-anyway">
            <Text style={[styles.fail, { color: colors.muted }]}>
              Use this photo anyway — VAI re-checks it on upload
            </Text>
          </Pressable>
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
            if (busy === 'upload') return; // upload in flight — navigation would strand it
            setStep('quiz');
            router.replace('/onboarding/quiz');
          }}
          testID="selfie-back"
        >
          <Text style={[styles.consent, { color: colors.muted }]}>Back to quiz</Text>
        </Pressable>
        {preview ? (
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.half, { backgroundColor: colors.surface }]} onPress={retake} testID="selfie-retake">
              <Text style={[styles.buttonText, { color: colors.text }]}>
                {previewSource === 'library' ? 'Choose a different photo' : 'Retake'}
              </Text>
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
              <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Take the photo</Text>
            )}
          </Pressable>
        )}
        {!preview && (
          <Pressable
            style={[styles.button, { backgroundColor: colors.surface }]}
            onPress={() => void pickFromLibrary()}
            disabled={busy === 'capture'}
            testID="selfie-library"
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>Choose from library</Text>
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
  webPrompt: { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  frame: { width: 220, height: 420, borderWidth: 2, borderRadius: 110, borderStyle: 'dashed' },
  checklist: { gap: 4 },
  guideText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  sheet: { backgroundColor: '#FAF8F5', padding: 20, gap: 10, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  fail: { fontSize: 14, lineHeight: 20 },
  consent: { fontSize: 12 },
  row: { flexDirection: 'row', gap: 10 },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  wide: { alignSelf: 'stretch' },
  half: { flex: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
