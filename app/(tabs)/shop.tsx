import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
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
  const router = useRouter();
  const { colors } = useTheme();
  const userId = useSession((s) => s.userId);
  const tier = usePaywall((s) => s.tier);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  const [wishError, setWishError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Heart ids touched this session — hydration must never clobber them. */
  const touchedRef = useRef<Set<string>>(new Set());
  // Reel card entry scopes gap picks to that outfit (reel handleShop forwards
  // `outfitId`; direct tab entry has no param → unscoped picks).
  const params = useLocalSearchParams<{ outfitId?: string | string[] }>();
  const rawOutfit: string | string[] | undefined = params.outfitId;
  const outfitParam =
    typeof rawOutfit === 'string'
      ? (rawOutfit.length > 0 ? rawOutfit : null)
      : Array.isArray(rawOutfit)
        ? ((rawOutfit as string[]).find((x: string) => x.length > 0) ?? null)
        : null;

  const picksQuery = useQuery({
    queryKey: ['shop-picks', outfitParam ?? null],
    queryFn: () => api.shopPicks(outfitParam ? { outfitId: outfitParam } : {}),
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
          const server = new Set(rows.map((r) => r.product_id).filter((x): x is string => !!x));
          // Merge, not overwrite: hearts toggled while this fetch was in flight
          // used to be silently reverted by the hydration.
          setWishlist((local) => {
            const merged = new Set(server);
            for (const id of touchedRef.current) {
              if (local.has(id)) merged.add(id);
            }
            return merged;
          });
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
  // Optimistic mirror with revert + boxed error on server failure.
  const toggleWish = useCallback(
    (item: ProductPick) => {
      const id = item.productId;
      if (!userId) {
        // The optimistic heart flipped and then silently never persisted —
        // a save that lied. Ask for sign-in first instead.
        setWishError('Sign in to save items to your wishlist.');
        return;
      }
      const adding = !wishlist.has(id);
      setWishError(null);
      touchedRef.current.add(id);
      setWishlist((s) => {
        const next = new Set(s);
        if (adding) next.add(id);
        else next.delete(id);
        return next;
      });
      const revert = () => {
        setWishlist((s) => {
          const next = new Set(s);
          if (adding) next.delete(id);
          else next.add(id);
          return next;
        });
        setWishError('Could not save your wishlist. Check your connection and try again.');
      };
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
            price: item.price ?? null,
            affiliate_url: item.affiliateUrl,
          })
          .then(({ error }) => {
            if (error) revert();
          });
      } else {
        void supabase
          .from('wishlist')
          .delete()
          .eq('user_id', userId)
          .eq('product_id', id)
          .then(({ error }) => {
            if (error) revert();
          });
      }
    },
    [wishlist, userId, tier],
  );

  // THE shop CTA: open the affiliate product (server-signed URL). The old
  // card was display-only — no onPress anywhere, affiliateUrl never opened,
  // lib/affiliate.ts had zero callers while the footer promised commission.
  const openProduct = useCallback((item: ProductPick) => {
    void (async () => {
      setOpenError(null);
      if (!item.affiliateUrl) {
        setOpenError('No shopping link available for this item yet.');
        return;
      }
      try {
        await WebBrowser.openBrowserAsync(item.affiliateUrl);
      } catch {
        try {
          await Linking.openURL(item.affiliateUrl);
        } catch {
          setOpenError('Could not open the shop page. Please try again.');
        }
      }
    })();
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ProductPick }) => (
      <Pressable
        style={[styles.card, { backgroundColor: colors.surface }]}
        onPress={() => openProduct(item)}
        testID={`product-${item.productId}`}
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.title} at ${item.retailer}`}
      >
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
          <Text style={[styles.sub, { color: colors.muted }]}>{item.retailer}</Text>
          {item.rating != null ? (
            <Text style={[styles.sub, { color: colors.muted }]}>
              Rated {item.rating.toFixed(1)} out of 5
            </Text>
          ) : null}
          <Text style={[styles.reason, { color: colors.muted }]} numberOfLines={2}>
            {item.valueAddReason}
          </Text>
          <View style={styles.row}>
            {item.price != null ? (
              <Text style={[styles.price, { color: colors.text }]}>${item.price.toFixed(2)}</Text>
            ) : null}
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
      </Pressable>
    ),
    [colors, toggleWish, wishlist, openProduct],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="shop-screen">
      <Text style={[styles.header, { color: colors.text }]}>Shop the look</Text>
      {!!wishError && (
        <View
          style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="shop-wishlist-error"
        >
          <Text style={[styles.error, { color: colors.danger }]}>{wishError}</Text>
        </View>
      )}
      {!!openError && (
        <View
          style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="shop-open-error"
        >
          <Text style={[styles.error, { color: colors.danger }]}>{openError}</Text>
        </View>
      )}

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
            Add to your closet and plan outfits. Gap-filling picks will show up here.
          </Text>
          <Pressable
            style={[styles.retry, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)')}
            testID="shop-empty-cta"
          >
            <Text style={[styles.retryText, { color: colors.onPrimary }]}>See today&apos;s outfit</Text>
          </Pressable>
        </View>
      ) : (
        <FlashList
          data={picksQuery.data}
          renderItem={renderItem}
          keyExtractor={(p, i) => p.productId || `${p.retailer}-${p.title}-${i}`}
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
  header: { fontSize: 28, fontWeight: '700', fontFamily: 'Georgia', marginBottom: 12 },
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
  price: { fontSize: 17, fontWeight: '700', fontFamily: 'Georgia' },
  heart: { fontSize: 24 },
  disclosure: { fontSize: 12, textAlign: 'center', marginTop: 16, paddingHorizontal: 24 },
  error: { fontSize: 13, lineHeight: 18 },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8, marginBottom: 8 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 18, fontWeight: '600' },
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retry: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  retryText: { fontSize: 15, fontWeight: '600' },
});
