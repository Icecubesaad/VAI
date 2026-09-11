import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/theme';
import { api, apiErrorCopy, type ProductPick } from '@/lib/api';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';

/**
 * Shop the look: product cards (img/price/rating/retailer, badge
 * "Fills gap"/"Own similar"), wishlist hearts, affiliate disclosure footer.
 * Affiliate = physical goods only (IAP-exempt). Price-drop alerts = v2.
 */
export default function ShopScreen() {
  const { colors } = useTheme();
  const userId = useSession((s) => s.userId);
  const tier = usePaywall((s) => s.tier);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());

  const picksQuery = useQuery({
    queryKey: ['shop-picks'],
    queryFn: () => api.shopPicks({}),
    staleTime: 1000 * 60 * 30,
  });

  // Hydrate hearts from the server wishlist (owner-RLS `wishlist` table) so
  // saves survive reinstalls; local state stays the optimistic mirror.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase
          .from('wishlist')
          .select('product_id')
          .eq('user_id', userId);
        if (!cancelled && data) {
          const rows = data as Array<{ product_id: string | null }>;
          setWishlist(
            new Set(rows.map((r) => r.product_id).filter((x): x is string => !!x)),
          );
        }
      } catch {
        // Best-effort: hearts start empty, saves still write through below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Wishlist persists server-side (insert/delete on the owner `wishlist`
  // table) and fires `wishlist_added` — never local-only (P1-3).
  const toggleWish = useCallback(
    (item: ProductPick) => {
      const id = item.productId;
      const adding = !wishlist.has(id);
      setWishlist((s) => {
        const next = new Set(s);
        if (adding) next.add(id);
        else next.delete(id);
        return next;
      });
      if (!userId) return;
      if (adding) {
        track('wishlist_added', {
          user_id: userId,
          tier: tier === 'free' ? 'free' : 'premium',
          product_id: id,
        });
        void supabase
          .from('wishlist')
          .insert({
            user_id: userId,
            retailer: item.retailer,
            product_id: id,
            title: item.title,
            image_url: item.imageUrl,
            price: item.price,
            affiliate_url: item.affiliateUrl,
          })
          .then(
            () => undefined,
            () => undefined,
          );
      } else {
        void supabase
          .from('wishlist')
          .delete()
          .eq('user_id', userId)
          .eq('product_id', id)
          .then(
            () => undefined,
            () => undefined,
          );
      }
    },
    [wishlist, userId, tier],
  );

  const renderItem = useCallback(
    ({ item }: { item: ProductPick }) => (
      <View style={[styles.card, { backgroundColor: colors.surface }]} testID={`product-${item.productId}`}>
        <Image source={{ uri: item.imageUrl }} style={styles.image} contentFit="cover" />
        {!!item.badge && (
          <View style={[styles.badge, { backgroundColor: colors.primary }]} testID="gap-badge">
            <Text style={[styles.badgeText, { color: colors.onPrimary }]}>{item.badge}</Text>
          </View>
        )}
        <View style={styles.meta}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={[styles.sub, { color: colors.muted }]}>
            {item.retailer}
            {item.rating != null ? ` · ★ ${item.rating.toFixed(1)}` : ''}
          </Text>
          <Text style={[styles.reason, { color: colors.muted }]} numberOfLines={2}>
            {item.valueAddReason}
          </Text>
          <View style={styles.row}>
            <Text style={[styles.price, { color: colors.text }]}>${item.price.toFixed(2)}</Text>
            <Pressable
              onPress={() => toggleWish(item)}
              hitSlop={12}
              testID={`wish-${item.productId}`}
              accessibilityLabel={wishlist.has(item.productId) ? 'Remove from wishlist' : 'Save to wishlist'}
            >
              <Text style={[styles.heart, { color: colors.primary }]}>
                {wishlist.has(item.productId) ? '♥' : '♡'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    ),
    [colors, toggleWish, wishlist],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="shop-screen">
      <Text style={[styles.header, { color: colors.text }]}>Shop the look</Text>

      {picksQuery.isPending ? (
        <View style={styles.state} testID="shop-loading">
          <ActivityIndicator size="large" />
          <Text style={[styles.stateText, { color: colors.muted }]}>Finding pieces for you…</Text>
        </View>
      ) : picksQuery.isError ? (
        <View style={styles.state} testID="shop-error">
          <Text style={[styles.stateTitle, { color: colors.text }]}>
            {apiErrorCopy(picksQuery.error).title}
          </Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            {apiErrorCopy(picksQuery.error).message}
          </Text>
          <Pressable
            style={[styles.retry, { backgroundColor: colors.primary }]}
            onPress={() => void picksQuery.refetch()}
            testID="shop-retry"
          >
            <Text style={[styles.retryText, { color: colors.onPrimary }]}>Try again</Text>
          </Pressable>
        </View>
      ) : (picksQuery.data ?? []).length === 0 ? (
        <View style={styles.state} testID="shop-empty">
          <Text style={[styles.stateTitle, { color: colors.text }]}>No picks yet</Text>
          <Text style={[styles.stateText, { color: colors.muted }]}>
            Build your closet and plan outfits — gap-filling picks will show up here.
          </Text>
        </View>
      ) : (
        <FlashList
          data={picksQuery.data}
          renderItem={renderItem}
          keyExtractor={(p) => p.productId}
          numColumns={2}
          contentContainerStyle={styles.grid}
          ListFooterComponent={
            <Text style={[styles.disclosure, { color: colors.muted }]} testID="affiliate-disclosure">
              We may earn commission — no extra cost to you.
            </Text>
          }
          testID="shop-grid"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  header: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  grid: { paddingBottom: 24 },
  card: { flex: 1, borderRadius: 14, overflow: 'hidden', margin: 6 },
  image: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#EDE8E0' },
  badge: { position: 'absolute', top: 8, left: 8, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  meta: { padding: 10, gap: 4 },
  title: { fontSize: 14, fontWeight: '600' },
  sub: { fontSize: 12 },
  reason: { fontSize: 12, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  price: { fontSize: 16, fontWeight: '700' },
  heart: { fontSize: 24 },
  disclosure: { fontSize: 12, textAlign: 'center', marginTop: 16, paddingHorizontal: 24 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 18, fontWeight: '600' },
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retry: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  retryText: { fontSize: 15, fontWeight: '600' },
});
