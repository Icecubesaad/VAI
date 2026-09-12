import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { useSession } from '@/store/session';

const SLIDES = [
  {
    key: 'plan',
    title: 'Wake up to the right outfit',
    body: 'VAI plans one hero outfit a day from your own closet, weather and plans included.',
  },
  {
    key: 'tryon',
    title: 'See it on you first',
    body: 'Mirror-selfie try-ons in usually ~20s. Restyle until it feels right.',
  },
  {
    key: 'gaps',
    title: 'Stop buying duplicates',
    body: 'We spot the gaps ("6 black tops, no red") and find pieces that earn their place.',
  },
];

/** Value carousel (entry). Advances funnel to auth. */
export default function OnboardingCarousel() {
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const listRef = useRef<FlatList | null>(null);
  const setStep = useSession((s) => s.setOnboardingStep);

  const goAuth = useCallback(() => {
    setStep('auth');
    router.replace('/onboarding/auth');
  }, [router, setStep]);

  const next = useCallback(() => {
    if (page < SLIDES.length - 1) {
      listRef.current?.scrollToIndex({ index: page + 1, animated: true });
    } else {
      goAuth();
    }
  }, [page, goAuth]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="onboarding-carousel">
      <FlatList
        ref={(r) => {
          listRef.current = r;
        }}
        data={SLIDES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(s) => s.key}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <View style={[styles.slide, { width }]}>
            {/* Art slot: UI/UX owner drops the final illustration here (expo-image). */}
            <View style={[styles.art, { backgroundColor: colors.surface }]} testID={`slide-art-${item.key}`}>
              <Text style={[styles.artEmoji, { color: colors.muted }]}>
                {item.key === 'plan' ? '✨' : item.key === 'tryon' ? '🪞' : '👗'}
              </Text>
            </View>
            <Text style={[styles.title, { color: colors.text }]}>{item.title}</Text>
            <Text style={[styles.body, { color: colors.muted }]}>{item.body}</Text>
          </View>
        )}
      />
      <View style={styles.dots}>
        {SLIDES.map((s, i) => (
          <View
            key={s.key}
            style={[
              styles.dot,
              { backgroundColor: i === page ? colors.primary : colors.border },
            ]}
          />
        ))}
      </View>
      <View style={styles.footer}>
        <Pressable style={[styles.button, { backgroundColor: colors.primary }]} onPress={next} testID="carousel-next">
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
            {page === SLIDES.length - 1 ? 'Get started' : 'Next'}
          </Text>
        </Pressable>
        <Pressable onPress={goAuth} testID="carousel-skip">
          <Text style={[styles.skip, { color: colors.muted }]}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 64 },
  slide: { paddingHorizontal: 24, gap: 12 },
  art: { height: 320, borderRadius: 20, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  artEmoji: { fontSize: 96 },
  title: { fontSize: 30, fontWeight: '800', fontFamily: 'Georgia', marginTop: 12 },
  body: { fontSize: 15, lineHeight: 22 },
  dots: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginVertical: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  footer: { padding: 24, gap: 12 },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700' },
  skip: { fontSize: 14, textAlign: 'center' },
});
