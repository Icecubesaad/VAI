import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { tokenColors } from '@/theme';
import { MeshGradient } from '@/components/MeshGradient';
import { PressScale } from '@/components/PressScale';
import { useReducedMotion } from '@/lib/motion';
import { useSession } from '@/store/session';
import teeFlat from '@/assets/onboarding/tee-flat.jpg';
import teeFold from '@/assets/onboarding/tee-fold.jpg';
import teeHanger from '@/assets/onboarding/tee-hanger.jpg';

/**
 * Each slide owns its photo trio — the CENTER photo rotates per slide so
 * pressing Next visibly changes the imagery.
 *
 * State-driven (no FlatList): the active slide renders from `page` state, so
 * Next/dots/swipe advance content on every platform with zero reliance on
 * native scroll offsets — web FlatList `scrollToOffset` silently no-ops when
 * the target isn't laid out, which stranded users on slide 1. Swipe is a
 * PanResponder on the slide (progressive enhancement, never the only path).
 */
const SLIDES = [
  {
    key: 'plan',
    headlineA: 'Start',
    headlineB: ' finding your',
    headlineC: 'Style',
    body: 'VAI plans one hero outfit a day from your own closet — weather and plans included.',
    center: teeFlat,
    left: teeHanger,
    right: teeFold,
  },
  {
    key: 'tryon',
    headlineA: 'See it',
    headlineB: ' on you',
    headlineC: 'first',
    body: 'One mirror selfie — every closet combo rendered on you before you wear it.',
    center: teeHanger,
    left: teeFold,
    right: teeFlat,
  },
  {
    key: 'gaps',
    headlineA: 'Stop',
    headlineB: ' buying',
    headlineC: 'duplicates',
    body: 'We spot the gaps ("6 black tops, no red") and find pieces that earn their place.',
    center: teeFold,
    left: teeFlat,
    right: teeHanger,
  },
] as const;

/** The inspo's hollow pink ring — active page. Inactive dots are tappable. */
function PageDot({ active, onPress, testID }: { active: boolean; onPress: () => void; testID?: string }): React.JSX.Element {
  if (active) {
    return <View style={styles.dotActive} />;
  }
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Go to slide"
    >
      <View style={styles.dotIdle} />
    </Pressable>
  );
}

/** Value carousel (entry). Advances funnel to auth. */
export default function OnboardingCarousel() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  const setStep = useSession((s) => s.setOnboardingStep);

  // Slide transition: content eases in from the right on every page change.
  const slideAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) {
      slideAnim.setValue(1);
      return;
    }
    slideAnim.setValue(0);
    Animated.spring(slideAnim, {
      toValue: 1,
      friction: 8,
      tension: 70,
      useNativeDriver: true,
    }).start();
  }, [page, slideAnim, reduceMotion]);
  const slideOpacity = slideAnim;
  const slideShift = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [32, 0] });

  const goAuth = useCallback(() => {
    setStep('auth');
    router.replace('/onboarding/auth');
  }, [router, setStep]);

  const goTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, index));
    pageRef.current = clamped;
    setPage(clamped);
  }, []);

  const next = useCallback(() => {
    if (pageRef.current < SLIDES.length - 1) {
      goTo(pageRef.current + 1);
    } else {
      goAuth();
    }
  }, [goTo, goAuth]);

  const prev = useCallback(() => {
    goTo(pageRef.current - 1);
  }, [goTo]);

  // Swipe between slides — buttons + dots stay the primary path (web-safe).
  const nextRef = useRef(next);
  nextRef.current = next;
  const prevRef = useRef(prev);
  prevRef.current = prev;
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      onPanResponderRelease: (_e, g) => {
        if (g.dx < -70) nextRef.current();
        else if (g.dx > 70) prevRef.current();
      },
    }),
  ).current;

  const item = SLIDES[page] ?? SLIDES[0]!;

  return (
    <View style={styles.root} testID="onboarding-carousel">
      <MeshGradient variant="onboardingHero" />
      <View style={styles.slide} {...swipe.panHandlers}>
        {/* photo trio — in-flow with the copy, center photo rotates per slide */}
        <View aria-hidden pointerEvents="none" style={styles.cluster}>
          <View style={styles.floatCardA}>
            <Image source={item.left} style={styles.floatPhoto} contentFit="cover" transition={200} />
          </View>
          <View style={styles.floatCardB}>
            <Image
              key={item.key}
              source={item.center}
              style={styles.floatPhotoLarge}
              contentFit="cover"
              transition={200}
            />
          </View>
          <View style={styles.floatCardC}>
            <Image source={item.right} style={styles.floatPhoto} contentFit="cover" transition={200} />
          </View>
        </View>
        <Animated.View
          key={`copy-${item.key}`}
          style={{ opacity: slideOpacity, transform: [{ translateX: slideShift }] }}
        >
          <Text style={styles.title} testID={`carousel-title-${item.key}`}>
            {item.headlineA}
            <Text style={styles.titleSoft}>{item.headlineB}</Text>
            {'\n'}
            <Text style={styles.titleStrong}>{item.headlineC}</Text>
          </Text>
          <Text style={styles.body}>{item.body}</Text>
        </Animated.View>
      </View>
      {/* footer flows below the slide — never absolute, so copy can never
          slide underneath it and the footer can never cover copy */}
      <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.footerRow}>
          <View style={styles.dots}>
            {SLIDES.map((s, i) => (
              <PageDot
                key={s.key}
                active={i === page}
                testID={`carousel-dot-${i}`}
                onPress={() => goTo(i)}
              />
            ))}
          </View>
          <PressScale scaleTo={0.95} style={styles.cta} onPress={next} testID="carousel-next">
            <Text style={styles.ctaText}>{page === SLIDES.length - 1 ? 'Get started' : 'Next'}</Text>
          </PressScale>
        </View>
        <Pressable onPress={goAuth} testID="carousel-skip">
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow hidden: the float cards intentionally bleed past the screen edge —
  // on web the bleed must never become page-level horizontal overflow.
  root: { flex: 1, overflow: 'hidden' },
  slide: { flex: 1, paddingTop: 8 },
  // In-flow cluster: fixed height, cards absolutely positioned inside it.
  cluster: { height: 300, overflow: 'hidden', marginTop: 8 },
  floatCardA: {
    position: 'absolute',
    top: 48,
    left: -30,
    width: 124,
    height: 174,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-10deg' }],
    shadowColor: '#9FD8BC',
    shadowOpacity: 0.6,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 10 },
  },
  floatCardB: {
    position: 'absolute',
    top: 8,
    left: '50%',
    marginLeft: -78,
    width: 156,
    height: 214,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    padding: 7,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-2deg' }],
    shadowColor: '#B9A5F2',
    shadowOpacity: 0.65,
    shadowRadius: 34,
    shadowOffset: { width: 0, height: 14 },
  },
  floatCardC: {
    position: 'absolute',
    top: 42,
    right: -30,
    width: 128,
    height: 180,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '9deg' }],
    shadowColor: '#F0AED2',
    shadowOpacity: 0.6,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 10 },
  },
  floatPhoto: { width: '100%', height: '100%', borderRadius: 14 },
  floatPhotoLarge: { width: '100%', height: '100%', borderRadius: 19 },
  title: {
    color: tokenColors.ink,
    fontSize: 37,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    lineHeight: 44,
    letterSpacing: -0.2,
    paddingHorizontal: 28,
    marginTop: 24,
  },
  // The soft middle phrase drops into the italic serif — the atelier voice
  // speaking inside its own headline.
  titleSoft: { fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold_Italic', fontSize: 35 },
  titleStrong: { fontWeight: '700' },
  body: { color: tokenColors.inkSoft, fontSize: 15, lineHeight: 22, paddingHorizontal: 28, marginTop: 10 },
  footerWrap: { paddingTop: 6 },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingBottom: 10,
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  // Active page = a violet pill dash (the app's signature shape); idle =
  // small solid dots.
  dotActive: {
    width: 22,
    height: 7,
    borderRadius: 4,
    backgroundColor: tokenColors.terracottaDeep,
  },
  dotIdle: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#CFC6E4',
  },
  cta: {
    borderRadius: 999,
    backgroundColor: tokenColors.ink,
    paddingVertical: 16,
    paddingHorizontal: 36,
    shadowColor: '#211C33',
    shadowOpacity: 0.32,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 9 },
    elevation: 6,
  },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', fontFamily: 'Poppins_600SemiBold' },
  skip: {
    color: tokenColors.inkSoft,
    fontSize: 14,
    textAlign: 'center',
    paddingBottom: 8,
  },
});
