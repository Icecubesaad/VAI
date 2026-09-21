import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image as RNImage, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { decode } from 'base64-arraybuffer';
import { useTheme, tokenColors } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { PressScale } from '@/components/PressScale';
import { Icon } from '@/components/icons';
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
  const insets = useSafeAreaInsets();
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
      <View style={[styles.center, { backgroundColor: 'transparent' }]} testID="selfie-upload">
        <MeshGradient variant="quiet" />
        {/* cute cluster: guide cards echoing the carousel reference */}
        <View style={styles.heroCluster} aria-hidden pointerEvents="none">
          <View style={[styles.heroCard, styles.heroLeft]}>
            <Text style={styles.heroEmoji}>☀</Text>
            <Text style={styles.heroLabel}>Daylight</Text>
          </View>
          <View style={[styles.heroCard, styles.heroCenter]}>
            <View style={styles.heroFrame} />
            <Text style={styles.heroLabel}>Head to shoes</Text>
          </View>
          <View style={[styles.heroCard, styles.heroRight]}>
            <Text style={styles.heroEmoji}>🪞</Text>
            <Text style={styles.heroLabel}>Plain wall</Text>
          </View>
        </View>
        <Text style={[styles.title, { color: colors.text }]}>
          Add <Text style={styles.titleSoft}>your{'\n'}photo </Text>first
        </Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          Full-body, daylight, plain background — used only for your try-ons, never public
          without opt-in.
        </Text>
        <PressScale
          scaleTo={0.97}
          style={[styles.button, styles.wide, { backgroundColor: tokenColors.ink }]}
          onPress={() => void pickFromLibrary()}
          disabled={busy === 'capture'}
          testID="selfie-library"
        >
          {busy === 'capture' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>Choose from library</Text>
          )}
        </PressScale>
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
      {/* full-bleed review: the photo IS the screen (multi-million-dollar
          ad, not a school-project thumbnail). Scrims top/bottom keep chrome
          legible; the decision bar floats over the photo. */}
      {preview ? (
        <Image source={{ uri: preview }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : Platform.OS === 'web' ? (
        <View style={[StyleSheet.absoluteFill, styles.webPrompt]} testID="selfie-web-prompt">
          <Text style={styles.guideText}>Your photo appears here for review</Text>
        </View>
      ) : (
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="front">
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
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0.55)', 'rgba(15,10,28,0.28)', 'rgba(15,10,28,0)']}
        locations={[0, 0.55, 1]}
        style={styles.scrimTop}
        aria-hidden
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0)', 'rgba(15,10,28,0.5)', 'rgba(15,10,28,0.78)']}
        locations={[0, 0.4, 1]}
        style={styles.scrimBottom}
        aria-hidden
      />
      {/* top chrome: back · title · quality verdict */}
      <View style={[styles.topChrome, { top: insets.top + 8 }]}>
        <PressScale
          style={styles.glassBtn}
          onPress={() => {
            if (busy === 'upload') return; // upload in flight — navigation would strand it
            setStep('quiz');
            router.replace('/onboarding/quiz');
          }}
          testID="selfie-back"
          accessibilityRole="button"
          accessibilityLabel="Back to the style quiz"
        >
          <Icon name="chevronLeft" color="#FFFFFF" size={20} strokeWidth={2.1} />
        </PressScale>
        <Text style={styles.topTitle} pointerEvents="none">Mirror check</Text>
        {preview ? (
          <View style={styles.verdictChip} testID="selfie-verdict">
            <View
              style={[
                styles.verdictDot,
                {
                  backgroundColor:
                    fail && fail !== 'upload_failed' ? '#E35B72' : busy === 'upload' ? '#D9CFFF' : '#7BC496',
                },
              ]}
              aria-hidden
            />
            <Text style={styles.verdictText}>
              {fail && fail !== 'upload_failed' ? 'Needs a retake' : busy === 'upload' ? 'Uploading…' : 'Looks good'}
            </Text>
          </View>
        ) : (
          <View style={styles.topSpacer} aria-hidden />
        )}
      </View>

      {!!fail && (
        <View style={styles.failGlass} testID={fail === 'upload_failed' ? 'selfie-fail-upload' : 'selfie-fail'}>
          <Text style={styles.failGlassText} numberOfLines={3}>
            {FAIL_COPY[fail]}
          </Text>
        </View>
      )}
      {!!error && !fail && (
        <View style={styles.failGlass} testID="selfie-error">
          <Text style={styles.failGlassText} numberOfLines={3}>
            {error}
          </Text>
        </View>
      )}

      {/* bottom decision bar: retake ghost · primary use-photo · consent */}
      <View style={[styles.decisionBar, { paddingBottom: insets.bottom + 16 }]}>
        {fail && fail !== 'upload_failed' ? (
          <Pressable onPress={() => setFail(null)} testID="selfie-use-anyway">
            <Text style={styles.anywayText}>
              Use this photo anyway — VAI re-checks it on upload
            </Text>
          </Pressable>
        ) : null}
        {preview ? (
          <View style={styles.decisionRow}>
            <PressScale style={styles.ghostPill} onPress={retake} testID="selfie-retake">
              <Text style={styles.ghostPillText}>
                {previewSource === 'library' ? 'Different photo' : 'Retake'}
              </Text>
            </PressScale>
            <PressScale
              style={[styles.usePill, fail !== null && fail !== 'upload_failed' && styles.usePillBlocked]}
              onPress={() => void confirm()}
              disabled={busy === 'upload'}
              testID="selfie-confirm"
            >
              {busy === 'upload' ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.usePillText}>
                  {fail === 'upload_failed' ? 'Retry upload' : 'Use this photo'}
                </Text>
              )}
            </PressScale>
          </View>
        ) : (
          <View style={styles.decisionRow}>
            <PressScale
              style={styles.ghostPill}
              onPress={() => void pickFromLibrary()}
              disabled={busy === 'capture'}
              testID="selfie-library"
            >
              <Text style={styles.ghostPillText}>Library</Text>
            </PressScale>
            <PressScale
              style={styles.usePill}
              onPress={() => void capture()}
              disabled={busy === 'capture'}
              testID="selfie-capture"
            >
              {busy === 'capture' ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.usePillText}>Take the photo</Text>
              )}
            </PressScale>
          </View>
        )}
        <Text style={styles.consentDark} testID="selfie-consent">
          Used only for your try-ons. Never public without opt-in.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  heroCluster: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 0,
    marginBottom: 6,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 10,
    alignItems: 'center',
    gap: 6,
    shadowColor: '#B9A5F2',
    shadowOpacity: 0.45,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  heroLeft: {
    width: 108,
    height: 152,
    transform: [{ rotate: '-8deg' }],
    marginRight: -18,
    shadowColor: '#9FD8BC',
  },
  heroCenter: {
    width: 138,
    height: 190,
    borderRadius: 26,
    padding: 10,
    zIndex: 2,
    shadowOpacity: 0.55,
    shadowRadius: 28,
  },
  heroRight: {
    width: 108,
    height: 156,
    transform: [{ rotate: '8deg' }],
    marginLeft: -18,
    shadowColor: '#F0AED2',
  },
  heroEmoji: { fontSize: 34, textAlign: 'center' },
  heroFrame: {
    width: 84,
    height: 128,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(42,35,64,0.35)',
    borderRadius: 42,
  },
  heroLabel: { color: tokenColors.inkSoft, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  title: {
    color: tokenColors.ink,
    fontSize: 32,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    lineHeight: 38,
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  titleSoft: { fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold_Italic', fontSize: 30 },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  guide: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  webPrompt: { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  frame: { width: 220, height: 420, borderWidth: 2, borderRadius: 110, borderStyle: 'dashed' },
  checklist: { gap: 4 },
  guideText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 150 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 340 },
  topChrome: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
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
  topTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    textShadowColor: 'rgba(15,10,28,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  topSpacer: { width: 42 },
  // Verdict reads as frosted glass with a status dot — a whisper, not a
  // notification badge shouting over the photo.
  verdictChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  verdictDot: { width: 6, height: 6, borderRadius: 3 },
  verdictText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  failGlass: {
    position: 'absolute',
    top: 118,
    left: 24,
    right: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(23,14,40,0.85)',
    padding: 14,
  },
  failGlassText: { color: '#FFFFFF', fontSize: 13, lineHeight: 18 },
  anywayText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  decisionBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 20, gap: 10 },
  decisionRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  ghostPill: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  ghostPillText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  usePill: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
    paddingVertical: 15,
    alignItems: 'center',
  },
  usePillBlocked: { opacity: 0.55 },
  usePillText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  consentDark: { color: 'rgba(255,255,255,0.65)', fontSize: 12, textAlign: 'center' },
  sheet: { backgroundColor: '#141114', padding: 20, gap: 10, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  fail: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  consent: { fontSize: 12 },
  row: { flexDirection: 'row', gap: 10 },
  button: {
    borderRadius: 999,
    paddingVertical: 16,
    paddingHorizontal: 32,
    alignItems: 'center',
    shadowColor: '#5B4A8E',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  wide: { alignSelf: 'stretch' },
  half: { flex: 1 },
  buttonText: { fontSize: 16, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
});
