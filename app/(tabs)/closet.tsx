import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { GarmentCard, PressScale } from '@/components';
import type { Garment } from '@/lib/api';
import { hapticFor } from '@/lib/haptics';
import { useCloset, selectClosetList, selectClosetCount, FREE_CLOSET_CAP } from '@/store/closet';
import { usePaywall } from '@/store/paywall';

/**
 * Closet: grid + add bar (camera single-item only) + insights banner + Fill-my-gaps.
 * Free cap: 50 items. Card shows photo/cat/colors/fabric/formality/season/wear-count/CPW.
 */
export default function ClosetScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const garments = useCloset(selectClosetList);
  const tier = usePaywall((s) => s.tier);
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
    const catName = `${topCat[0]}${topCat[1] > 1 ? 's' : ''}`;
    const hasRed = Object.keys(colorHits).some((c) => c.includes('red'));
    if (!topColor) return `Mostly ${catName} so far.`;
    const gap = hasRed ? '' : ' A red piece would stretch this closet.';
    return `Mostly ${catName} in ${topColor[0]}.${gap}`;
  }, [garments]);

  const handleAdd = useCallback(() => {
    // In-app add: ?mode=app keeps this screen from mutating onboardingStep —
    // the plain funnel route used to regress persisted step to 'selfie' and
    // re-trap onboarded users in onboarding on every cold start.
    setAddError(null);
    void hapticFor.select();
    if (tier === 'free' && count >= FREE_CLOSET_CAP) {
      setAddError(`Your closet is full (${FREE_CLOSET_CAP} items on free) — upgrade to add more.`);
      return;
    }
    setAdding(true);
    try {
      router.push('/onboarding/closet-min3?mode=app');
    } finally {
      setAdding(false);
    }
  }, [count, router, tier]);

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
    <View style={[styles.root, { backgroundColor: 'transparent' }]} testID="closet-screen">
      <MeshGradient variant="closet" />
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Closet</Text>
        <Text style={[styles.count, { color: colors.muted }]} testID="closet-count">
          {count} of {FREE_CLOSET_CAP}
        </Text>
      </View>
      {/* Atelier rule — one hairline under the header, same as the home cover. */}
      <View style={styles.rule} />


      {!!insights && (
        <View style={[styles.banner, { backgroundColor: colors.surface }]} testID="insights-banner">
          <Text style={[styles.bannerText, { color: colors.text }]}>{insights}</Text>
        </View>
      )}

      <View style={styles.addBar}>
        <PressScale
          style={[styles.addButton, { backgroundColor: colors.primary }]}
          onPress={handleAdd}
          disabled={adding}
          testID="closet-add"
        >
          {adding ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={[styles.addText, { color: colors.onPrimary }]}>Add an item</Text>
          )}
        </PressScale>
        <PressScale
          style={[styles.gapButton, { borderColor: colors.border, borderWidth: 1 }]}
          onPress={() => {
            void hapticFor.select();
            router.push('/(tabs)/shop');
          }}
          testID="fill-gaps"
        >
          <Text style={[styles.gapText, { color: colors.text }]}>Fill my gaps</Text>
        </PressScale>
      </View>
      {!!addError && (
        <View style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="closet-error">
          <Text style={[styles.error, { color: colors.danger }]}>{addError}</Text>
        </View>
      )}

      {garments.length === 0 ? (
        <View style={styles.state} testID="closet-empty">
          <Text style={[styles.stateTitle, { color: colors.text }]}>Start with one piece</Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Photograph one garment at a time. We tag the category, colors and fabric for you.
          </Text>
          <Pressable
            style={[styles.emptyCta, { backgroundColor: colors.primary }]}
            onPress={handleAdd}
            testID="closet-empty-cta"
          >
            <Text style={[styles.addText, { color: colors.onPrimary }]}>Add your first item</Text>
          </Pressable>
        </View>
      ) : (
        // Core FlatList: FlashList v2's ViewHolderCollection re-measures in a
        // loop on this grid (Maximum update depth crash). Closets are <=50
        // items on free — virtualization buys nothing here.
        <FlatList
          data={garments}
          renderItem={renderItem}
          keyExtractor={(g) => g.id}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
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
  // Serif display — the closet is the user's wardrobe atelier, not a database.
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2 },
  count: { fontSize: 13 },
  rule: { height: 1, backgroundColor: '#E6E0F5', marginTop: 10, marginBottom: 4 },
  banner: {
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#E6E0F5',
    shadowColor: '#44307E',
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  // Insights read as a stylist's note — italic serif, not a system banner.
  bannerText: { fontSize: 15, lineHeight: 21, fontFamily: 'PlayfairDisplay_700Bold_Italic' },
  addBar: { flexDirection: 'row', gap: 10, marginTop: 12 },
  addButton: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#6645D9',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  emptyCta: { borderRadius: 999, paddingVertical: 14, paddingHorizontal: 26, alignItems: 'center', marginTop: 8 },
  addText: { fontSize: 15, fontWeight: '600' },
  gapButton: { flex: 1, borderRadius: 999, paddingVertical: 14, alignItems: 'center', backgroundColor: '#FFFFFF' },
  gapText: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13, lineHeight: 18 },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8 },
  grid: { paddingVertical: 12 },
  gridRow: { gap: 12, marginBottom: 12 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  stateText: { fontSize: 14, lineHeight: 21, textAlign: 'center', paddingHorizontal: 24 },
});
