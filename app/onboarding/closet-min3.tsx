import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useTheme } from '@/theme';
import { BUCKETS, supabase } from '@/lib/supabase';
import { compressGarmentPhoto, ImagePipelineError } from '@/lib/perf/image-pipeline';
import { api, apiErrorCopy, type Garment } from '@/lib/api';
import { useCloset, selectClosetCount, CLOSET_MIN_COUNT, FREE_CLOSET_CAP } from '@/store/closet';
import { useSession } from '@/store/session';

/**
 * Closet-min-3: camera single-item only, progress 1/3–3/3.
 * Each photo uploads to the garments bucket → auto-tag edge fn → closet cache.
 * Continue unlocks at ≥3 items. Downgrade UX: past the 50-item free cap the
 * closet is read-only overflow — adds are blocked behind an Upgrade-to-edit
 * banner (data is never deleted; the paywall carries the downgrade copy).
 */
export default function ClosetMin3() {
  const router = useRouter();
  const { colors } = useTheme();
  const count = useCloset(selectClosetCount);
  const upsert = useCloset((s) => s.upsert);
  const setLastSync = useCloset((s) => s.setLastSync);
  const setStep = useSession((s) => s.setOnboardingStep);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read-only overflow: downgraded closets over the free cap keep everything
  // but cannot add/edit until upgrade.
  const overflow = count > FREE_CLOSET_CAP;

  // Shared camera/library pipeline: compress → upload → auto-tag → cache.
  const processUri = useCallback(
    async (uri: string, source: Garment['source']) => {
      setBusy(true);
      try {
        const userId = useSession.getState().userId;
        if (!userId) throw new Error('auth');
        // 200KB budget enforced BEFORE upload (P1-1): WebP ≤1024px via the
        // shared pipeline. `garment_too_heavy` carries retake copy and is
        // surfaced as-is by the catch below — never silently uploaded raw.
        const compressed = await compressGarmentPhoto(uri);
        const b64 = await FileSystem.readAsStringAsync(compressed.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
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
        upsert(garment);
        setLastSync(new Date().toISOString());
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
    if (useCloset.getState().order.length > FREE_CLOSET_CAP) {
      setError(
        `Your closet is over the ${FREE_CLOSET_CAP}-item free limit — extras are read-only. Upgrade to edit.`,
      );
      return;
    }
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
  }, [processUri]);

  // Photo-library path: same compress → upload → auto-tag pipeline as camera.
  const addFromLibrary = useCallback(async () => {
    setError(null);
    if (useCloset.getState().order.length > FREE_CLOSET_CAP) {
      setError(
        `Your closet is over the ${FREE_CLOSET_CAP}-item free limit — extras are read-only. Upgrade to edit.`,
      );
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo-library access is needed to pick garment photos.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      quality: 0.9,
      allowsEditing: false,
      allowsMultipleSelection: false,
      mediaTypes: ['images'],
    });
    if (picked.canceled || !picked.assets[0]?.uri) return;
    await processUri(picked.assets[0].uri, 'camera');
  }, [processUri]);

  const goFirstOutfit = useCallback(() => {
    setStep('firstOutfit');
    router.replace('/onboarding/first-outfit');
  }, [router, setStep]);

  const done = count >= CLOSET_MIN_COUNT;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="closet-min3">
      <Text style={[styles.progress, { color: colors.muted }]} testID="closet-progress">
        {Math.min(count, 3)}/3
      </Text>
      <Text style={[styles.title, { color: colors.text }]}>Photograph 3 garments</Text>
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
            Tagging your garment — category, colors, fabric…
          </Text>
        </View>
      ) : (
        <>
          <Pressable
            style={[styles.add, { borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addItem()}
            testID="closet-add-item"
          >
            <Text style={styles.addArt}>📷</Text>
            <Text style={[styles.addText, { color: colors.text }]}>+ Add item (camera)</Text>
          </Pressable>
          <Pressable
            style={[styles.add, styles.library, { borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => void addFromLibrary()}
            testID="closet-add-library"
          >
            <Text style={[styles.addText, { color: colors.text }]}>+ Choose from library</Text>
          </Pressable>
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

      <Pressable
        style={[styles.button, { backgroundColor: done ? colors.primary : colors.border }]}
        onPress={goFirstOutfit}
        disabled={!done}
        testID="closet-continue"
      >
        <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
          {done ? 'See my first outfit' : `Add ${CLOSET_MIN_COUNT - count} more to continue`}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => {
          setStep('selfie');
          router.replace('/onboarding/selfie-capture');
        }}
        testID="closet-back"
      >
        <Text style={[styles.back, { color: colors.muted }]}>← Back (items are kept)</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64 },
  progress: { fontSize: 13, fontWeight: '700' },
  title: { fontSize: 26, fontWeight: '800', marginTop: 8 },
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
