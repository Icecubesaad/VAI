import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useTheme } from '@/theme';
import { GarmentCard } from '@/components';
import type { Garment } from '@/lib/api';
import { useCloset, selectClosetList, selectClosetCount, FREE_CLOSET_CAP } from '@/store/closet';

/**
 * Closet: grid + add bar (camera single-item only) + insights banner + Fill-my-gaps.
 * Free cap: 50 items. Card shows photo/cat/colors/fabric/formality/season/wear-count/CPW.
 */
export default function ClosetScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const garments = useCloset(selectClosetList);
  const count = useCloset(selectClosetCount);
  const remove = useCloset((s) => s.remove);

  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const insights = useMemo(() => {
    if (garments.length === 0) return null;
    const byCat: Record<string, number> = {};
    const colorHits: Record<string, number> = {};
    for (const g of garments) {
      byCat[g.category] = (byCat[g.category] ?? 0) + 1;
      for (const c of g.colors) colorHits[c.toLowerCase()] = (colorHits[c.toLowerCase()] ?? 0) + 1;
    }
    const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    const topColor = Object.entries(colorHits).sort((a, b) => b[1] - a[1])[0];
    if (!topCat) return null;
    const hasRed = Object.keys(colorHits).some((c) => c.includes('red'));
    const gap = hasRed ? '' : ', no red';
    return `${topCat[1]} ${topCat[0]}${topCat[1] > 1 ? 's' : ''}${topColor ? `, lots of ${topColor[0]}` : ''}${gap}`;
  }, [garments]);

  const handleAdd = useCallback(() => {
    // Camera capture + upload flow lives behind the garment picker (owned by UI/UX
    // for the sheet UI); this route hands off with cap enforcement.
    setAddError(null);
    if (count >= FREE_CLOSET_CAP) {
      setAddError('Your closet is full (50 items). Upgrade to add more.');
      return;
    }
    setAdding(true);
    try {
      router.push('/onboarding/closet-min3');
    } finally {
      setAdding(false);
    }
  }, [count, router]);

  const handleDelete = useCallback(
    (id: string) => {
      try {
        remove(id);
      } catch {
        setAddError('Could not remove that item. Please try again.');
      }
    },
    [remove],
  );

  const renderItem = useCallback(
    ({ item }: { item: Garment }) => (
      <GarmentCard garment={item} onDelete={() => handleDelete(item.id)} />
    ),
    [handleDelete],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="closet-screen">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Closet</Text>
        <Text style={[styles.count, { color: colors.muted }]} testID="closet-count">
          {count}/{FREE_CLOSET_CAP}
        </Text>
      </View>

      {!!insights && (
        <View style={[styles.banner, { backgroundColor: colors.surface }]} testID="insights-banner">
          <Text style={[styles.bannerText, { color: colors.text }]}>{insights}</Text>
        </View>
      )}

      <View style={styles.addBar}>
        <Pressable
          style={[styles.addButton, { backgroundColor: colors.primary }]}
          onPress={handleAdd}
          disabled={adding}
          testID="closet-add"
        >
          {adding ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={[styles.addText, { color: colors.onPrimary }]}>+ Add item (camera)</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.gapButton, { borderColor: colors.border, borderWidth: 1 }]}
          onPress={() => router.push('/(tabs)/shop')}
          testID="fill-gaps"
        >
          <Text style={[styles.gapText, { color: colors.text }]}>Fill my gaps</Text>
        </Pressable>
      </View>
      {!!addError && (
        <Text style={[styles.error, { color: colors.danger }]} testID="closet-error">
          {addError}
        </Text>
      )}

      {garments.length === 0 ? (
        <View style={styles.state} testID="closet-empty">
          <Text style={[styles.stateTitle, { color: colors.text }]}>Your closet is empty</Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Photograph one garment at a time — we&apos;ll tag the category, colors and fabric for
            you.
          </Text>
        </View>
      ) : (
        <FlashList
          data={garments}
          renderItem={renderItem}
          keyExtractor={(g) => g.id}
          numColumns={2}
          contentContainerStyle={styles.grid}
          testID="closet-grid"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 24, fontWeight: '700' },
  count: { fontSize: 13 },
  banner: { borderRadius: 12, padding: 12, marginTop: 12 },
  bannerText: { fontSize: 14 },
  addBar: { flexDirection: 'row', gap: 10, marginTop: 12 },
  addButton: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  addText: { fontSize: 15, fontWeight: '600' },
  gapButton: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  gapText: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13, marginTop: 8 },
  grid: { paddingVertical: 12 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 18, fontWeight: '600' },
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
});
