import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { tokenColors } from '@/theme';
import { useReducedMotion } from '@/lib/motion';

export type DnaLook = { name: string; art: number; line: string };

const CARD_W = 140;
const CARD_H = 186;
const GAP = 12;
const STRIDE = CARD_W + GAP;
const PAD = 24;

const CENTER_SCALE = 1.08;
const SIDE_SCALE = 0.86;
const CENTER_LIFT = -12;
const SIDE_REST = 6;

/**
 * DNA filmstrip — the style-DNA reveal's hero. Fresh gallery shots of the
 * user's kept personas (never the quiz-deck photos) ride one endless marquee
 * behind edge fades — pure photography, no category labels on the cards. The
 * loop is a triplicated-list linear cycle over one cast length, so it never
 * ends and never snaps.
 * Whatever photo crosses the middle grows and lifts while it holds center —
 * the pop is interpolated per-card off the same scroll value, so it lands
 * exactly on turn. One fade-and-rise entrance per fresh cast, then the
 * marquee owns the motion. Pure showcase — no gestures, no verdicts (those
 * lived on the deck). Under reduced motion (or a tiny cast) it renders one
 * still centered row instead.
 */
export const DnaFilmstrip = memo(function DnaFilmstrip({
  looks,
}: {
  looks: DnaLook[];
}): React.JSX.Element | null {
  const reduceMotion = useReducedMotion();
  const { width: winW } = useWindowDimensions();
  const offset = useRef(new Animated.Value(0)).current;
  const entrance = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  // Stable cast key: the loop restarts only when the cast itself changes,
  // never on a parent re-render (callers build a fresh array per render).
  const castKey = looks.map((l) => l.name).join('|');

  useEffect(() => {
    if (reduceMotion || looks.length === 0) {
      offset.setValue(0);
      entrance.setValue(1);
      return;
    }
    const cycle = STRIDE * looks.length;
    offset.setValue(0);
    entrance.setValue(0);
    Animated.timing(entrance, {
      toValue: 1,
      duration: 550,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    loopRef.current = Animated.loop(
      Animated.timing(offset, {
        toValue: -cycle,
        duration: Math.max(12000, looks.length * 5000),
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loopRef.current.start();
    return () => {
      loopRef.current?.stop();
      loopRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castKey, reduceMotion]);

  if (looks.length === 0) return null;

  // Offset value at which card i sits dead-center on screen.
  const centeredAt = (i: number): number => winW / 2 - CARD_W / 2 - PAD - i * STRIDE;

  const markFailed = (name: string): void => {
    setFailed((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  };

  const renderPhoto = (l: DnaLook): React.JSX.Element =>
    failed.has(l.name) ? (
      <View style={styles.fallback} aria-hidden>
        <Text style={styles.fallbackGlyph}>{l.name.charAt(0).toUpperCase()}</Text>
      </View>
    ) : (
      <Image
        source={l.art}
        style={styles.photo}
        contentFit="cover"
        transition={200}
        draggable={false}
        onError={() => markFailed(l.name)}
        accessibilityLabel={`${l.name} look`}
      />
    );

  const renderCard = (l: DnaLook, key: string, i: number): React.JSX.Element => {
    const c = centeredAt(i);
    const scope = [c - STRIDE, c, c + STRIDE];
    const scale = offset.interpolate({
      inputRange: scope,
      outputRange: [SIDE_SCALE, CENTER_SCALE, SIDE_SCALE],
      extrapolate: 'clamp',
    });
    const lift = offset.interpolate({
      inputRange: scope,
      outputRange: [SIDE_REST, CENTER_LIFT, SIDE_REST],
      extrapolate: 'clamp',
    });
    const spotlight = offset.interpolate({
      inputRange: scope,
      outputRange: [0.72, 1, 0.72],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View
        key={key}
        style={[styles.card, { opacity: spotlight, transform: [{ translateY: lift }, { scale }] }]}
      >
        {renderPhoto(l)}
      </Animated.View>
    );
  };

  const entranceShift = entrance.interpolate({ inputRange: [0, 1], outputRange: [26, 0] });
  // A near-empty cast can't marquee — center it still instead.
  const staticCast = reduceMotion || looks.length <= 2;

  return (
    <View style={styles.wrap} testID="dna-filmstrip" aria-hidden={false}>
      {staticCast ? (
        <View style={styles.staticRow}>
          {looks.map((l) => (
            <View key={l.name} style={styles.card}>
              {renderPhoto(l)}
            </View>
          ))}
        </View>
      ) : (
        <Animated.View style={{ opacity: entrance, transform: [{ translateY: entranceShift }] }}>
          <View style={[styles.window, { width: winW }]}>
            {/* Tripled cast, one-cast loop distance: at any scroll offset the
                window stays covered on wide screens, and the -cycle wrap is
                seamless because every card repeats exactly once per cycle. */}
            <Animated.View style={[styles.track, { transform: [{ translateX: offset }] }]}>
              {[...looks, ...looks, ...looks].map((l, i) => renderCard(l, `${l.name}-${i}`, i))}
            </Animated.View>
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(250,249,254,1)', 'rgba(250,249,254,0)']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.fadeLeft}
            />
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(250,249,254,0)', 'rgba(250,249,254,1)']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.fadeRight}
            />
          </View>
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { marginTop: 18, marginBottom: 4 },
  staticRow: { flexDirection: 'row', justifyContent: 'center', gap: GAP, paddingHorizontal: 24 },
  window: { overflow: 'hidden', marginLeft: -24, paddingVertical: 16 },
  track: { flexDirection: 'row', gap: GAP, paddingHorizontal: PAD },
  card: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: tokenColors.line,
    shadowColor: '#3D2E75',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  photo: { width: '100%', height: '100%' },
  fallback: {
    width: '100%',
    height: '100%',
    backgroundColor: tokenColors.terracottaWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackGlyph: {
    color: tokenColors.terracottaDeep,
    fontSize: 44,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  fadeLeft: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 44 },
  fadeRight: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 44 },
});
