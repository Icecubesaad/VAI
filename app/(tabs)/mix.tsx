import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme, tokenColors } from '@/theme';
import { hapticFor } from '@/lib/haptics';
import { useCloset, selectClosetList } from '@/store/closet';
import type { Garment } from '@/lib/api';
import { mockGarment } from '@/lib/mock-visuals';

const FILTERS: Array<{ key: 'all' | Garment['category']; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'top', label: 'Tops' },
  { key: 'bottom', label: 'Bottoms' },
  { key: 'dress', label: 'Dresses' },
  { key: 'outerwear', label: 'Outerwear' },
  { key: 'shoes', label: 'Shoes' },
  { key: 'active', label: 'Active' },
];

const CATEGORY_LABEL: Record<string, string> = {
  top: 'Tops', bottom: 'Bottoms', dress: 'Dresses', outerwear: 'Outerwear',
  shoes: 'Shoes', active: 'Active', bag: 'Bags', accessory: 'Accessories',
  onepiece: 'One-pieces',
};

/**
 * Mix — pick pieces from your own closet (multi-select) → one combination →
 * one render on the Ensemble page. Bounded by the same quota + daily
 * idempotency as every render surface; this page itself never spends.
 */
export default function MixScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const garments = useCloset(selectClosetList);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [picked, setPicked] = useState<string[]>([]);

  const shown = useMemo(
    () => (filter === 'all' ? garments : garments.filter((g) => g.category === filter)),
    [garments, filter],
  );

  const toggle = useCallback(
    (id: string) => {
      void hapticFor.select();
      setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    },
    [],
  );

  const create = useCallback(() => {
    if (picked.length === 0) return;
    void hapticFor.confirm();
    router.push({
      pathname: '/look',
      params: { garmentIds: picked.join(','), label: 'My Mix' },
    });
  }, [picked, router]);

  const pickedGarments = picked
    .map((id) => garments.find((g) => g.id === id))
    .filter((g): g is Garment => !!g);

  return (
    <View style={styles.root} testID="mix-screen">
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 140 }]}>
        <View style={styles.headerTop}>
          <View style={[styles.brandChip, { backgroundColor: colors.surface }]}>
            <Text style={[styles.brandChipText, { color: colors.text }]}>V</Text>
          </View>
          <Text style={[styles.headerCount, { color: colors.muted }]}>
            {garments.length} pieces
          </Text>
        </View>

        <Text style={[styles.masthead, { color: colors.text }]} testID="mix-masthead">
          Create a style that feels like you
        </Text>

        {/* Category tabs — the 153012 chip row. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow} testID="mix-filters">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  void hapticFor.select();
                  setFilter(f.key);
                }}
                testID={`mix-filter-${f.key}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${f.label}`}
              >
                <Text style={[styles.filterText, { color: colors.muted }, active && { color: colors.text, fontWeight: '700' }]}>
                  {f.label}
                </Text>
                {active ? <View style={[styles.filterUnderline, { backgroundColor: colors.primary }]} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Closet masonry — tap to pick, claret ring + check on selection. */}
        {shown.length === 0 ? (
          <View style={styles.empty} testID="mix-empty">
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Nothing here yet</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              Add pieces in the Closet tab, then mix them here.
            </Text>
          </View>
        ) : (
          <View style={styles.grid} testID="mix-grid">
            {[0, 1].map((col) => (
              <View key={col} style={styles.column}>
                {shown.filter((_, i) => i % 2 === col).map((g) => {
                  const selected = picked.includes(g.id);
                  return (
                    <Pressable
                      key={g.id}
                      onPress={() => toggle(g.id)}
                      style={[
                        styles.cell,
                        selected && { borderColor: colors.primary, borderWidth: 2 },
                      ]}
                      testID={`mix-cell-${g.id}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${g.category} piece${selected ? ', selected' : ''}`}
                    >
                      <Image
                        source={{ uri: g.cutoutUrl ?? g.imageUrl ?? (__DEV__ ? mockGarment('#6B2E44', 'dress') : null) }}
                        style={styles.cellImg}
                        contentFit="cover"
                        transition={150}
                      />
                      <Text style={[styles.cellCat, { color: colors.muted }]}>{CATEGORY_LABEL[g.category] ?? 'Piece'}</Text>
                      {selected ? (
                        <View style={[styles.check, { backgroundColor: colors.primary }]}>
                          <Text style={styles.checkGlyph}>✓</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Floating composer pill — the inspo's floating nav, repurposed. */}
      {picked.length > 0 && (
        <View style={[styles.composer, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 12 }]} testID="mix-composer">
          <View style={styles.composerChips}>
            {pickedGarments.slice(0, 4).map((g) => (
              <Image key={g.id} source={{ uri: g.cutoutUrl ?? g.imageUrl }} style={[styles.composerChip, { backgroundColor: colors.well }]} />
            ))}
            {pickedGarments.length > 4 ? (
              <Text style={[styles.composerMore, { color: colors.muted }]}>+{pickedGarments.length - 4}</Text>
            ) : null}
          </View>
          <Pressable
            style={[styles.createCta, { backgroundColor: colors.primary }]}
            onPress={create}
            testID="mix-create"
            accessibilityRole="button"
            accessibilityLabel={`Create the look from ${picked.length} pieces`}
          >
            <Text style={[styles.createCtaText, { color: colors.onPrimary }]}>
              ✦ Create look · {picked.length}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20 },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandChip: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  brandChipText: { fontSize: 17, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  headerCount: { fontSize: 12, fontWeight: '600' },
  masthead: {
    fontSize: 30, lineHeight: 36, fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.4,
    marginTop: 10, marginBottom: 14,
  },
  filterRow: { flexDirection: 'row', gap: 18, paddingBottom: 12 },
  filterText: { fontSize: 13, fontWeight: '600' },
  filterUnderline: { height: 2, borderRadius: 1, marginTop: 4 },
  grid: { flexDirection: 'row', gap: 12, marginTop: 4 },
  column: { flex: 1, gap: 12 },
  cell: {
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E7DDE2',
    overflow: 'hidden',
  },
  cellImg: { width: '100%', height: 150 },
  cellCat: { fontSize: 11, fontWeight: '600', padding: 8 },
  check: {
    position: 'absolute', top: 8, right: 8,
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  checkGlyph: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  composer: {
    // Floats above the pill tab bar, never on top of it.
    position: 'absolute', left: 12, right: 12, bottom: 104,
    borderRadius: 24, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  composerChips: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  composerChip: { width: 34, height: 44, borderRadius: 8 },
  composerMore: { fontSize: 12, fontWeight: '700' },
  createCta: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 12 },
  createCtaText: { fontSize: 13, fontWeight: '700' },
});
