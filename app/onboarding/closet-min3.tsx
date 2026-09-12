import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useTheme } from '@/theme';
import { PressScale } from '@/components';
import { hapticFor } from '@/lib/haptics';
import { BUCKETS, supabase } from '@/lib/supabase';
import { compressGarmentPhoto, ImagePipelineError } from '@/lib/perf/image-pipeline';
import { api, apiErrorCopy, type Garment } from '@/lib/api';
import { useCloset, selectClosetCount, CLOSET_MIN_COUNT, FREE_CLOSET_CAP } from '@/store/closet';
import { useSession } from '@/store/session';
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read-only overflow: free closets AT the 50-item cap (>= — the funnel used
  // '>' and let item 51 through while the Closet tab blocked it) cannot add;
  // premium is uncapped, mirroring the server's free-only closet cap.
  const isFree = usePaywall.getState().tier === 'free';
  const overflow = isFree && count >= FREE_CLOSET_CAP;
  const atFreeCap = () => usePaywall.getState().tier === 'free' &&
    useCloset.getState().order.length >= FREE_CLOSET_CAP;

  // Shared camera/library pipeline: compress → upload → auto-tag → cache.
  const processUri = useCallback(
    async (uri: string, source: Garment['source']) => {
      setBusy(true);
      try {
        const userId = useSession.getState().userId;
        if (!userId) {
          setError('Sign in to continue your setup — your progress is saved.');
          return;
        }
        // 200KB budget enforced BEFORE upload (P1-1): WebP ≤1024px via the
        // shared pipeline. `garment_too_heavy` carries retake copy and is
        // surfaced as-is by the catch below — never silently uploaded raw.
        const compressed = await compressGarmentPhoto(uri);
        // Base64 the bytes: FileSystem on native, fetch fallback for web blob URIs.
        let b64: string;
        try {
          b64 = await FileSystem.readAsStringAsync(compressed.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } catch {
          const fetched = await fetch(compressed.uri);
          const buf = new Uint8Array(await fetched.arrayBuffer());
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
          }
          b64 = btoa(bin);
        }
        const path = `${userId}/${Date.now()}.webp`;
        const { error: upErr } = await supabase.storage
          .from(BUCKETS.garments)
          .upload(path, decode(b64), { contentType: 'image/webp', upsert: false });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from(BUCKETS.garments).getPublicUrl(path);
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
        // Success confirmation: crossing the 3-item threshold earns the done
        // tick (Continue unlocks); other adds get a quiet select tick.
        if (before < CLOSET_MIN_COUNT && useCloset.getState().order.length >= CLOSET_MIN_COUNT) {
          void hapticFor.done();
        } else {
          void hapticFor.select();
        }
      } catch (e) {
        setError(e instanceof ImagePipelineError ? e.message : apiErrorCopy(e).message);
      } finally {
        setBusy(false);
      }
    },
    [setLastSync, upsert],
  );

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
  const addFromLibrary = useCallback(async () => {
    setError(null);
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
      setError('Could not open your photo library. Please try again.');
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
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="closet-min3">
      {!appMode && (
        <Text style={[styles.progress, { color: colors.muted }]} testID="closet-progress">
          {Math.min(count, 3)}/3
        </Text>
      )}
      <Text style={[styles.title, { color: colors.text }]}>
        {appMode ? 'Add an item' : 'Photograph 3 garments'}
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
              { backgroundColor: count > i ? colors.primary : colors.border },
            ]}
            testID={`progress-dot-${i}`}
          />
        ))}
      </View>

      {busy ? (
        <View style={styles.state} testID="closet-adding">
          <ActivityIndicator size="large" />
          <Text style={[styles.sub, { color: colors.muted }]}>
            Tagging your garment: category, colors, fabric…
          </Text>
        </View>
      ) : (
        <>
          <PressScale
            style={[styles.add, { borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addItem()}
            testID="closet-add-item"
          >
            <Text style={styles.addArt}>📷</Text>
            <Text style={[styles.addText, { color: colors.text }]}>Photograph an item</Text>
          </PressScale>
          <PressScale
            style={[styles.add, styles.library, { borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addFromLibrary()}
            testID="closet-add-library"
          >
            <Text style={[styles.addText, { color: colors.text }]}>Choose from library</Text>
          </PressScale>
        </>
      )}

      {!!error && (
        <Text style={[styles.error, { color: colors.danger }]} testID="closet-min3-error">
          {error}
        </Text>
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
        style={[styles.button, { backgroundColor: appMode || done ? colors.primary : colors.border }]}
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
      >
        <Text style={[styles.back, { color: colors.muted }]}>
          {appMode ? 'Back to closet' : 'Go back, items are kept'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64 },
  progress: { fontSize: 13, fontWeight: '700' },
  title: { fontSize: 30, fontWeight: '800', fontFamily: 'Georgia', marginTop: 8 },
  sub: { fontSize: 14, marginTop: 4, lineHeight: 20 },
  dots: { flexDirection: 'row', gap: 8, marginVertical: 20 },
  dot: { flex: 1, height: 8, borderRadius: 4 },
  add: { borderRadius: 16, padding: 16, alignItems: 'center', gap: 10 },
  library: { marginTop: 10 },
  back: { fontSize: 14, textAlign: 'center', marginTop: 12 },
  addArt: { fontSize: 64, textAlign: 'center' },
  addText: { fontSize: 16, fontWeight: '600' },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  error: { fontSize: 13, marginTop: 12 },
  overflow: { borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 12 },
  overflowText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  state: { alignItems: 'center', paddingVertical: 32, gap: 8 },
});
