import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { api, apiErrorCopy, type ProductPick } from '@/lib/api';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';

/**
 * Shop the look: product cards (img/price/rating/retailer, badge
 * "Fills gap"/"Own similar"), wishlist hearts, affiliate disclosure footer.
 * Affiliate = physical goods only (IAP-exempt). Price-drop alerts = v2.
 * Picks | Saved segment on top — hearts persist server-side and the Saved
 * tab reads the same `wishlist` table back (previously write-only).
 */
export default function ShopScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const userId = useSession((s) => s.userId);
  const tier = usePaywall((s) => s.tier);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  const [wishError, setWishError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // Picks | Saved segment. Saved reads the server wishlist table back —
  // hearts were write-only before (saves went nowhere visible).
  const [tab, setTab] = useState<'picks' | 'saved'>('picks');
  /** Full saved rows for the Saved tab (hydrated with the heart ids). */
  const [savedRows, setSavedRows] = useState<ProductPick[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
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
  // Saved-tab rows hydrate here too (same read — ids + display columns).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    if (tab === 'saved') setSavedLoading(true);
    void (async () => {
      try {
        const { data } = await supabase
          .from('wishlist')
          .select('product_id,retailer,title,image_url,price,affiliate_url')
          .eq('user_id', userId);
        if (!cancelled && data) {
          const rows = data as Array<{
            product_id: string | null;
            retailer: string | null;
            title: string | null;
            image_url: string | null;
            price: number | null;
            affiliate_url: string | null;
          }>;
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
          setSavedRows(
            rows
              .filter((r): r is typeof r & { product_id: string } => !!r.product_id)
              .map((r) => ({
                productId: r.product_id,
                title: r.title ?? 'Saved pick',
                imageUrl: r.image_url ?? '',
                price: typeof r.price === 'number' ? r.price : null,
                retailer: r.retailer ?? '',
                affiliateUrl: r.affiliate_url ?? '',
                valueAddReason: '',
              })),
          );
        }
      } catch {
        // Best-effort: hearts start empty, saves still write through below.
      } finally {
        if (!cancelled) setSavedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, tab]);

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
      // Card pressable and the wishlist heart are SIBLINGS (a Pressable was
      // nested inside the card Pressable → invalid <button>-in-<button> DOM).
      <View style={styles.cardWrap}>
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
            {!!item.retailer && (
              <Text style={[styles.sub, { color: colors.muted }]}>{item.retailer}</Text>
            )}
            {item.rating != null ? (
              <Text style={[styles.sub, { color: colors.muted }]}>
                Rated {item.rating.toFixed(1)} out of 5
              </Text>
            ) : null}
            {!!item.valueAddReason && (
              <Text style={[styles.reason, { color: colors.muted }]} numberOfLines={2}>
                {item.valueAddReason}
              </Text>
            )}
            <View style={styles.row}>
              {item.price != null ? (
                <Text style={[styles.price, { color: colors.text }]}>${item.price.toFixed(2)}</Text>
              ) : null}
            </View>
          </View>
        </Pressable>
        <Pressable
          onPress={() => toggleWish(item)}
          hitSlop={12}
          style={styles.heartBtn}
          testID={`wish-${item.productId}`}
          accessibilityRole="button"
          accessibilityLabel={wishlist.has(item.productId) ? 'Remove from wishlist' : 'Save to wishlist'}
        >
          <Text style={[styles.heart, { color: colors.primary }]}>
            {wishlist.has(item.productId) ? '♥' : '♡'}
          </Text>
        </Pressable>
      </View>
    ),
    [colors, toggleWish, wishlist, openProduct],
  );

  return (
    <View style={[styles.root, { backgroundColor: 'transparent' }]} testID="shop-screen">
      <MeshGradient variant="shop" />
      <Text style={[styles.header, { color: colors.text }]}>Shop the look</Text>
      <View style={styles.headerRule} />
      {/* Picks | Saved segment */}
      <View style={styles.segRow} testID="shop-tabs">
        {(['picks', 'saved'] as const).map((t) => {
          const active = tab === t;
          return (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              testID={`shop-tab-${t}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t === 'picks' ? 'Gap picks for you' : 'Your saved items'}
              style={[styles.segHit, active ? styles.segHitOn : null]}
            >
              <Text style={[styles.segText, active ? styles.segTextOn : { color: colors.muted }]}>
                {t === 'picks' ? 'Picks' : `Saved${wishlist.size > 0 ? ` · ${wishlist.size}` : ''}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
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

      {tab === 'saved' ? (
        savedLoading ? (
          <View style={styles.state} testID="shop-saved-loading">
            <ActivityIndicator size="large" />
            <Text style={[styles.stateText, { color: colors.muted }]}>Loading your saves…</Text>
          </View>
        ) : savedRows.length === 0 ? (
          <View style={styles.state} testID="shop-saved-empty">
            <Text style={[styles.stateTitle, { color: colors.text }]}>Nothing saved yet</Text>
            <Text style={[styles.stateText, { color: colors.muted }]}>
              Tap the heart on any pick and it lands here.
            </Text>
            <Pressable
              style={[styles.retry, { backgroundColor: colors.primary }]}
              onPress={() => setTab('picks')}
              testID="shop-saved-browse"
            >
              <Text style={[styles.retryText, { color: colors.onPrimary }]}>Browse picks</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={savedRows}
            renderItem={renderItem}
            keyExtractor={(p, i) => p.productId || `${p.retailer}-${p.title}-${i}`}
            numColumns={2}
            contentContainerStyle={styles.grid}
            ListFooterComponent={
              <Text style={[styles.disclosure, { color: colors.muted }]} testID="affiliate-disclosure">
                We may earn commission — no extra cost to you.
              </Text>
            }
            testID="shop-saved-grid"
          />
        )
      ) : picksQuery.isPending ? (
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
        <FlatList
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
  // Serif display — the shop is a curated boutique rail, not a product dump.
  header: { fontSize: 30, lineHeight: 36, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2, marginBottom: 4 },
  // Hairline under the header — the atelier rule, same as home + closet.
  headerRule: { height: 1, backgroundColor: '#2C252C', marginBottom: 10 },
  segRow: { flexDirection: 'row', gap: 4, marginBottom: 10 },
  segHit: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  segHitOn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(33,28,51,0.08)',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  segText: { fontSize: 13, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  segTextOn: { color: '#1D141C' },
  grid: { paddingBottom: 24 },
  cardWrap: { flex: 1, margin: 6 },
  heartBtn: { position: 'absolute', right: 14, bottom: 44 },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(33,28,51,0.05)',
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  image: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#241E24' },
  badge: { position: 'absolute', top: 8, left: 8, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  meta: { padding: 10, gap: 4 },
  title: { fontSize: 14, fontWeight: '600' },
  sub: { fontSize: 12 },
  // The stylist's reason speaks in the editorial italic serif.
  reason: { fontSize: 13, lineHeight: 18, fontFamily: 'PlayfairDisplay_700Bold_Italic' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  price: { fontSize: 17, fontWeight: '700', fontFamily: 'Poppins_700Bold' },
  heart: { fontSize: 24 },
  disclosure: { fontSize: 12, textAlign: 'center', marginTop: 16, paddingHorizontal: 24 },
  error: { fontSize: 13, lineHeight: 18 },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8, marginBottom: 8 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  stateTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold' },
  stateText: { fontSize: 14, lineHeight: 21, textAlign: 'center', paddingHorizontal: 24 },
  retry: { borderRadius: 999, paddingHorizontal: 26, paddingVertical: 13, marginTop: 8 },
  retryText: { fontSize: 15, fontWeight: '600' },
});
