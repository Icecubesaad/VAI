import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { SoftGradient } from '@/components/SoftGradient';
import { useSession } from '@/store/session';

const SLIDES = [
  {
    key: 'plan',
    headlineA: 'Start',
    headlineB: ' finding your',
    headlineC: 'Style',
    body: 'VAI plans one hero outfit a day from your own closet — weather and plans included.',
  },
  {
    key: 'tryon',
    headlineA: 'See it',
    headlineB: ' on you',
    headlineC: 'first',
    body: 'One mirror selfie — every closet combo rendered on you before you wear it.',
  },
  {
    key: 'gaps',
    headlineA: 'Stop',
    headlineB: ' buying',
    headlineC: 'duplicates',
    body: 'We spot the gaps ("6 black tops, no red") and find pieces that earn their place.',
  },
];

/** Value carousel (entry). Advances funnel to auth. */
export default function OnboardingCarousel() {
  const router = useRouter();
  const { colors } = useTheme();
  const { width, height: winH } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const listRef = useRef<FlatList | null>(null);
  const setStep = useSession((s) => s.setOnboardingStep);

  const goAuth = useCallback(() => {
    setStep('auth');
    router.replace('/onboarding/auth');
  }, [router, setStep]);

  const next = useCallback(() => {
    if (page < SLIDES.length - 1) {
      // scrollToIndex no-ops on RN-web without getItemLayout — offset is exact
      // because slides are pagingEnabled full-width.
      listRef.current?.scrollToOffset({ offset: (page + 1) * width, animated: true });
    } else {
      goAuth();
    }
  }, [page, goAuth, width]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="onboarding-carousel">
      <SoftGradient height={520} />
      {/* floating glass cards — art-direction slot (no fake imagery) */}
      <View style={styles.floatStack} aria-hidden pointerEvents="none">
        <View style={styles.floatCardA} />
        <View style={styles.floatCardB} />
        <View style={styles.floatCardC} />
      </View>
      <FlatList
        ref={(r) => {
          listRef.current = r;
        }}
        data={SLIDES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(s) => s.key}
        style={styles.list}
        // onMomentumScrollEnd alone misses programmatic scrolls and web
        // flings (dots stuck, Next stuck on slide 2) — track offset directly.
        onScroll={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <View style={[styles.slide, { width, height: winH - 130 }]}>
            <View style={styles.spacer} />
            <Text style={[styles.title, { color: colors.text }]}>
              {item.headlineA}
              <Text style={styles.titleSoft}>{item.headlineB}</Text>
              {'\n'}
              <Text style={styles.titleStrong}>{item.headlineC}</Text>
            </Text>
            <Text style={[styles.body, { color: colors.muted }]}>{item.body}</Text>
          </View>
        )}
      />
      <View style={styles.footerRow}>
        <View style={styles.dots}>
          {SLIDES.map((s, i) => (
            <View key={s.key} style={[styles.dot, i === page ? styles.dotActive : styles.dotIdle]} />
          ))}
        </View>
        <Pressable style={styles.cta} onPress={next} testID="carousel-next">
          <Text style={styles.ctaText}>{page === SLIDES.length - 1 ? 'Get started' : 'Next'}</Text>
        </Pressable>
      </View>
      <Pressable onPress={goAuth} testID="carousel-skip">
        <Text style={[styles.skip, { color: colors.muted }]}>Skip</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  floatStack: { position: 'absolute', top: 70, left: 0, right: 0, height: 260 },
  floatCardA: {
    position: 'absolute', top: 30, left: 46, width: 118, height: 168,
    borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.6)',
    transform: [{ rotate: '-7deg' }],
    shadowColor: '#B9A5F2', shadowOpacity: 0.55, shadowRadius: 26, shadowOffset: { width: 0, height: 10 },
  },
  floatCardB: {
    position: 'absolute', top: 8, left: '50%', marginLeft: -74, width: 148, height: 208,
    borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.82)',
    shadowColor: '#C4B0F5', shadowOpacity: 0.7, shadowRadius: 34, shadowOffset: { width: 0, height: 14 },
  },
  floatCardC: {
    position: 'absolute', top: 36, right: 46, width: 118, height: 162,
    borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.55)',
    transform: [{ rotate: '8deg' }],
    shadowColor: '#E9A8D0', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 },
  },
  slide: { paddingHorizontal: 28, gap: 12, justifyContent: 'flex-end', paddingBottom: 8, height: '100%' },
  spacer: { flex: 1 },
  title: { fontSize: 34, fontWeight: '800', fontFamily: 'Georgia', lineHeight: 42 },
  titleSoft: { fontWeight: '400', fontSize: 30 },
  titleStrong: { fontWeight: '800' },
  body: { fontSize: 15, lineHeight: 22 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 28, paddingBottom: 10 },
  dots: { flexDirection: 'row', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { width: 26, backgroundColor: '#D9A9E8', borderWidth: 3, borderColor: '#F0B9DF' },
  dotIdle: { backgroundColor: '#D8D2C8' },
  cta: { borderRadius: 999, backgroundColor: '#141414', paddingVertical: 15, paddingHorizontal: 34 },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  skip: { fontSize: 14, textAlign: 'center', paddingBottom: 18 },
});
