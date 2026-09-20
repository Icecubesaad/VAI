import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { useTheme, tokenColors } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { PressScale } from '@/components';
import { Icon } from '@/components/icons';
import { hapticFor } from '@/lib/haptics';
import { BUCKETS, supabase } from '@/lib/supabase';
import { compressGarmentPhoto, ImagePipelineError } from '@/lib/perf/image-pipeline';
import { api, ApiError, apiErrorCopy, type Garment } from '@/lib/api';
import { useCloset, selectClosetCount, CLOSET_MIN_COUNT, FREE_CLOSET_CAP } from '@/store/closet';
import { useSession } from '@/store/session';
import { track } from '@/lib/analytics';
import { usePaywall } from '@/store/paywall';

/**
 * Closet-min-3: camera single-item only, progress 1/3–3/3.
 * Each photo uploads to the garments bucket → auto-tag edge fn → closet cache.
 * Continue unlocks at ≥3 items. Downgrade UX: past the 50-item free cap the
 * closet is read-only overflow — adds are blocked behind an Upgrade-to-edit
 * banner (data is never deleted; the paywall carries the downgrade copy).
 */
/**
 * Funnel step (`/onboarding/closet-min3`) AND in-app add flow
 * (`/onboarding/closet-min3?mode=app`). App mode NEVER touches the persisted
 * onboarding step — the old behavior (a Closet-tab "Add an item" mutating
 * onboardingStep to 'selfie') re-trapped onboarded users in the funnel on
 * every cold start.
 */
export default function ClosetMin3() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const appMode = mode === 'app';
  const { colors } = useTheme();
  const count = useCloset(selectClosetCount);
  const upsert = useCloset((s) => s.upsert);
  const setLastSync = useCloset((s) => s.setLastSync);
  const setStep = useSession((s) => s.setOnboardingStep);

  const [busy, setBusy] = useState<null | 'compress' | 'upload' | 'tag'>(null);
  const [error, setError] = useState<string | null>(null);
  // Last failed attempt — powers the Retry button so a dead network never
  // eats the user's pick (the screenshot-3 dead end: generic red line, no retry).
  const [lastAttempt, setLastAttempt] = useState<{ uri: string; source: Garment['source'] } | null>(null);

  // Read-only overflow: free closets AT the 50-item cap (>= — the funnel used
  // '>' and let item 51 through while the Closet tab blocked it) cannot add;
  // premium is uncapped, mirroring the server's free-only closet cap.
  const isFree = usePaywall.getState().tier === 'free';
  const overflow = isFree && count >= FREE_CLOSET_CAP;
  const atFreeCap = () => usePaywall.getState().tier === 'free' &&
    useCloset.getState().order.length >= FREE_CLOSET_CAP;

  // Shared camera/library pipeline: compress → upload → auto-tag → cache.
  // Staged busy state names the phase ("Compressing…" / "Uploading…" /
  // "Tagging…") so a stall always says WHERE — never a bare spinner.
  const processUri = useCallback(
    async (uri: string, source: Garment['source']) => {
      setBusy('compress');
      setError(null);
      // Local phase mirror: `busy` state is stale inside this closure (captured
      // at call time), so the catch reads this — never the state value.
      let phase: 'compress' | 'upload' | 'tag' = 'compress';
      try {
        const userId = useSession.getState().userId;
        if (!userId) {
          setError('Sign in to continue your setup — your progress is saved.');
          return;
        }
        // 200KB budget enforced BEFORE upload (P1-1): WebP ≤1024px via the
        // shared pipeline. `garment_too_heavy` carries retake copy and is
        // surfaced as-is by the catch below — never silently uploaded raw.
        // COMPRESSION IS BEST-EFFORT, NEVER A BLOCKER: on web the
        // manipulator has no implementation, and on device it can throw a
        // raw Error on formats it can't decode (HEIC bursts, screenshots,
        // some gallery imports). Any of those fall through with the ORIGINAL
        // uri — Storage + the auto-tag vision model accept JPEG/PNG as-is;
        // the size budget is best-effort via Content-Length. Only a true
        // `garment_too_heavy` (user-facing retake copy) still stops the pick.
        let uploadUri = uri;
        let uploadBytes: number | null = null;
        try {
          const compressed = await compressGarmentPhoto(uri);
          uploadUri = compressed.uri;
          uploadBytes = compressed.bytes;
        } catch (compressErr) {
          if (compressErr instanceof ImagePipelineError && compressErr.code === 'garment_too_heavy') {
            throw compressErr;
          }
          // Fall through with the original bytes — a photo we can't compress
          // is still a photo we can upload. Never trap the user's pick here.
        }
        // Base64 the bytes: FileSystem on native, fetch fallback for web blob
        // URIs (and for manipulator file:// outputs on web, which the legacy
        // FS cannot read).
        phase = 'upload';
        setBusy('upload');
        let b64: string;
        try {
          b64 = await FileSystem.readAsStringAsync(uploadUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } catch {
          const fetched = await fetch(uploadUri);
          if (!fetched.ok) throw new Error(`fetch-${fetched.status}`);
          const buf = new Uint8Array(await fetched.arrayBuffer());
          if (uploadBytes === null) uploadBytes = buf.length;
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
          }
          b64 = btoa(bin);
        }
        const ext = (uploadUri.split('.').pop() ?? '').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const path = `${userId}/${Date.now()}.${ext === 'png' || ext === 'webp' ? ext : 'jpg'}`;
        const { error: upErr } = await supabase.storage
          .from(BUCKETS.garments)
          .upload(path, decode(b64), { contentType: mime, upsert: false });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from(BUCKETS.garments).getPublicUrl(path);
        phase = 'tag';
        setBusy('tag');
        const tag = await api.autoTag({ imageUrl: data.publicUrl });
        const garment: Garment = {
          // REAL garment id from the nested auto-tag unwrapping (P0-2) —
          // Date.now() fallback only if the server ever omits it.
          id: tag.id || `${Date.now()}`,
          imageUrl: tag.imageUrl || data.publicUrl,
          cutoutUrl: tag.cutoutUrl ?? null,
          category: tag.category,
          subcat: tag.subcat ?? null,
          colors: tag.colors ?? [],
          fabric: tag.fabric ?? null,
          formality: tag.formality ?? 3,
          seasons: tag.seasons ?? [],
          brand: tag.brand ?? null,
          pricePaid: tag.pricePaid ?? null,
          wearCount: 0,
          costPerWear: null,
          source,
        };
        const before = useCloset.getState().order.length;
        upsert(garment);
        setLastSync(new Date().toISOString());
        // Funnel step event: per-add provenance feeds closet-building drop-off.
        track('closet_item_added', {
          user_id: userId,
          tier: 'free',
          count: useCloset.getState().order.length,
          source,
        });
        // Success confirmation: crossing the 3-item threshold earns the done
        // tick (Continue unlocks); other adds get a quiet select tick.
        if (before < CLOSET_MIN_COUNT && useCloset.getState().order.length >= CLOSET_MIN_COUNT) {
          void hapticFor.done();
        } else {
          void hapticFor.select();
        }
        setLastAttempt(null);
      } catch (e) {
        // Keep the failed pick for Retry — a dead network must never eat it.
        // Generic ApiError copy ("Something went wrong") is replaced with
        // staged copy naming the failed phase + the fix.
        const phaseLabel = phase === 'tag' ? 'tagging' : phase === 'upload' ? 'uploading' : 'reading';
        setLastAttempt({ uri, source });
        if (e instanceof ImagePipelineError) setError(e.message);
        else if (e instanceof ApiError && e.code === 'NETWORK') {
          setError(`Could not ${phaseLabel} your photo — you look offline. Check your connection, then tap Retry. Your pick is kept.`);
        } else {
          const copy = apiErrorCopy(e);
          setError(copy.title === 'Something went wrong'
            ? `Could not finish ${phaseLabel} your photo. Tap Retry — your pick is kept.`
            : copy.message);
        }
      } finally {
        setBusy(null);
      }
    },
    [setLastSync, upsert],
  );

  const retryLast = useCallback(() => {
    if (!lastAttempt || busy !== null) return;
    void processUri(lastAttempt.uri, lastAttempt.source);
  }, [lastAttempt, busy, processUri]);

  const addItem = useCallback(async () => {
    setError(null);
    void hapticFor.select();
    if (atFreeCap()) {
      setError(
        `Your closet is full (${FREE_CLOSET_CAP} items on free) — upgrade to add more.`,
      );
      return;
    }
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError('Camera access is needed to photograph garments.');
        return;
      }
      const shot = await ImagePicker.launchCameraAsync({
        quality: 0.9,
        allowsEditing: false,
      });
      if (shot.canceled || !shot.assets[0]?.uri) return;
      await processUri(shot.assets[0].uri, 'camera');
    } catch {
      setError('Could not open the camera. Please try again.');
    }
  }, [processUri]);

  // Photo-library path: same compress → upload → auto-tag pipeline as camera.
  // WEB: expo-image-picker on web never rejects (cancel = canceled:true), but
  // a missing file input / blocked popup surfaces as an empty throw — mapped
  // to actionable copy instead of the bare "could not open" line.
  const addFromLibrary = useCallback(async () => {
    setError(null);
    setLastAttempt(null);
    void hapticFor.select();
    if (atFreeCap()) {
      setError(
        `Your closet is full (${FREE_CLOSET_CAP} items on free) — upgrade to add more.`,
      );
      return;
    }
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError('Photo-library access is needed to pick garment photos.');
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        quality: 0.9,
        allowsEditing: false,
        allowsMultipleSelection: false,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (picked.canceled || !picked.assets[0]?.uri) return;
      // Library picks are provenance 'bulk', not 'camera' (wrong source was
      // persisted for every garment added via this path).
      await processUri(picked.assets[0].uri, 'bulk');
    } catch {
      setError(
        Platform.OS === 'web'
          ? 'Your browser blocked the file picker. Allow popups for this site, then tap "Choose from library" again.'
          : 'Could not open your photo library. Please try again.',
      );
    }
  }, [processUri]);

  const goFirstOutfit = useCallback(() => {
    void hapticFor.confirm();
    if (appMode) {
      // In-app add: return to the closet tab WITHOUT touching onboardingStep.
      router.replace('/(tabs)/closet');
      return;
    }
    setStep('firstOutfit');
    router.replace('/onboarding/first-outfit');
  }, [appMode, router, setStep]);

  const done = count >= CLOSET_MIN_COUNT;

  return (
    <View style={[styles.root, { backgroundColor: 'transparent' }]} testID="closet-min3">
      <MeshGradient variant="quiet" />
      {!appMode && (
        <Text style={[styles.progress, { color: colors.muted }]} testID="closet-progress">
          {Math.min(count, 3)}/3
        </Text>
      )}
      <Text style={[styles.title, { color: colors.text }]}>
        {appMode ? (
          <>
            Add <Text style={styles.titleSoft}>an{'\n'}item</Text>
          </>
        ) : (
          <>
            Photograph <Text style={styles.titleSoft}>your{'\n'}first 3</Text>
          </>
        )}
      </Text>
      <Text style={[styles.sub, { color: colors.muted }]}>
        One item at a time, flat or hanging. We tag category, colors and fabric automatically.
      </Text>

      <View style={styles.dots}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.dot,
              // Filled violet for each item captured, a violet ring on the
              // slot you're on, quiet porcelain for what's left.
              count > i ? styles.dotDone : i === Math.min(count, 2) && !done ? styles.dotActive : null,
            ]}
            testID={`progress-dot-${i}`}
          />
        ))}
      </View>

      {busy !== null ? (
        <View style={styles.state} testID="closet-adding">
          <ActivityIndicator size="large" />
          <Text style={[styles.sub, { color: colors.muted }]}>
            {busy === 'compress'
              ? 'Reading your photo…'
              : busy === 'upload'
                ? 'Uploading your garment…'
                : 'Tagging your garment: category, colors, fabric…'}
          </Text>
        </View>
      ) : (
        <>
          <PressScale
            style={[styles.add, { backgroundColor: '#FFFFFF', borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addItem()}
            testID="closet-add-item"
            accessibilityRole="button"
            accessibilityLabel="Photograph an item with the camera"
          >
            <View style={styles.addIconTile} aria-hidden>
              <Icon name="tryon" color={tokenColors.terracottaDeep} size={22} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.addText, { color: colors.text }]}>Photograph an item</Text>
              <Text style={[styles.addSub, { color: colors.muted }]}>Flat or hanging works best</Text>
            </View>
            <Icon name="plus" color={tokenColors.muted} size={18} aria-hidden />
          </PressScale>
          <PressScale
            style={[styles.add, styles.library, { backgroundColor: '#FFFFFF', borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addFromLibrary()}
            testID="closet-add-library"
            accessibilityRole="button"
            accessibilityLabel="Choose a photo from your library"
          >
            <View style={styles.addIconTile} aria-hidden>
              <Icon name="share" color={tokenColors.terracottaDeep} size={20} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.addText, { color: colors.text }]}>Choose from library</Text>
              <Text style={[styles.addSub, { color: colors.muted }]}>Screenshots and saved photos work</Text>
            </View>
            <Icon name="plus" color={tokenColors.muted} size={18} aria-hidden />
          </PressScale>
        </>
      )}

      {!!error && (
        <View style={styles.errorBox} testID="closet-min3-error-box">
          <Text style={[styles.error, { color: colors.danger }]} testID="closet-min3-error">
            {error}
          </Text>
          {lastAttempt !== null && busy === null ? (
            <PressScale style={styles.retryBtn} onPress={retryLast} testID="closet-retry">
              <Text style={styles.retryText}>Retry — your pick is kept</Text>
            </PressScale>
          ) : null}
        </View>
      )}

      {overflow && (
        <View
          style={[styles.overflow, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="closet-overflow"
        >
          <Text style={[styles.overflowText, { color: colors.text }]}>
            Your closet is over the {FREE_CLOSET_CAP}-item free limit — extra items are read-only.
            Upgrade to edit.
          </Text>
        </View>
      )}

      <PressScale
        style={[
          styles.button,
          {
            backgroundColor: appMode || done ? colors.text : colors.border,
            shadowColor: '#5B4A8E',
            shadowOpacity: appMode || done ? 0.28 : 0,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 8 },
            elevation: appMode || done ? 6 : 0,
          },
        ]}
        onPress={goFirstOutfit}
        disabled={!appMode && !done}
        testID="closet-continue"
      >
        <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
          {appMode
            ? 'Done'
            : done
              ? 'See my first outfit'
              : `Add ${CLOSET_MIN_COUNT - count} more to continue`}
        </Text>
      </PressScale>
      <Pressable
        onPress={() => {
          if (appMode) {
            // No step regression in app mode — "Go back" used to reset the
            // persisted funnel step to 'selfie' and re-trap onboarded users.
            router.back();
            return;
          }
          setStep('selfie');
          router.replace('/onboarding/selfie-capture');
        }}
        testID="closet-back"
        accessibilityRole="button"
        style={styles.backBtn}
        hitSlop={8}
      >
        <Icon name="chevronLeft" color={tokenColors.muted} size={15} aria-hidden />
        <Text style={[styles.backBtnText, { color: colors.muted }]}>
          {appMode ? 'Back to closet' : 'Go back — items are kept'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64, overflow: 'hidden' },
  progress: { fontSize: 13, fontWeight: '700' },
  title: {
    fontSize: 32,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    lineHeight: 38,
    letterSpacing: -0.2,
    marginTop: 8,
    textAlign: 'center',
  },
  titleSoft: { fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold_Italic', fontSize: 30 },
  sub: { fontSize: 14, marginTop: 8, lineHeight: 21, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 8, marginVertical: 20, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokenColors.line },
  dotDone: { backgroundColor: tokenColors.terracotta },
  // Next-up dot: violet ring on porcelain — the step you're on, not a pink
  // candy circle (the old pink fought the whole palette).
  dotActive: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: tokenColors.terracottaDeep,
    backgroundColor: '#FFFFFF',
  },
  // Add cards: one porcelain surface each, a violet icon tile + label. No
  // emoji art — the glyph set carries it.
  add: {
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#44307E',
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  addIconTile: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: tokenColors.terracottaWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addSub: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  library: { marginTop: 10 },
  // Ghost back button — a real target with a border, not bare text.
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    alignSelf: 'center',
    marginTop: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokenColors.line,
    backgroundColor: '#FFFFFF',
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  backBtnText: { fontSize: 13.5, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  addText: { fontSize: 16, fontWeight: '600', fontFamily: 'Poppins_600SemiBold' },
  button: { borderRadius: 999, paddingVertical: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { fontSize: 16, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  error: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  errorBox: { marginTop: 12, alignItems: 'center', gap: 10 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    backgroundColor: tokenColors.ink,
    paddingHorizontal: 22,
    paddingVertical: 12,
    shadowColor: '#211C33',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  retryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  overflow: { borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 12 },
  overflowText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  state: { alignItems: 'center', paddingVertical: 32, gap: 8 },
});
