import React, { Children, memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { hapticFor } from '../lib/haptics';
import { MOTION, useReducedMotion } from '../lib/motion';

const easeOut = Easing.out(Easing.ease);

export type ResultRevealProps = {
  /**
   * Done-render id, or null while waiting. The reveal + `done` haptic fire
   * exactly once per fresh id — mount-with-result (push-tap resume, tab
   * revisit) stays silent, and re-renders never replay.
   */
  revealKey: string | null;
  children: ReactNode;
};

/**
 * The try-on aha moment: when a fresh result lands, the image settles in
 * (fade + 0.96→1 spring) with a success tick. The wrapper is permanent and
 * style-free, so wrapping never remounts or re-lays-out the result.
 */
export const ResultReveal = memo(function ResultReveal({
  revealKey,
  children,
}: ResultRevealProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const prevKey = useRef(revealKey);
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const prev = prevKey.current;
    prevKey.current = revealKey;
    if (revealKey === null || revealKey === prev) return;
    // Confirmation tick even under reduced motion — haptics are not motion.
    void hapticFor.done();
    if (reduceMotion) return;
    opacity.setValue(0);
    scale.setValue(MOTION.revealScaleFrom);
    const reveal = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: MOTION.revealDurationMs,
        easing: easeOut,
        useNativeDriver: true,
      }),
      Animated.spring(scale, { toValue: 1, ...MOTION.revealSpring, useNativeDriver: true }),
    ]);
    reveal.start();
    return () => reveal.stop();
  }, [revealKey, reduceMotion, opacity, scale]);

  return (
    <Animated.View style={{ opacity, transform: [{ scale }] }}>{children}</Animated.View>
  );
});

export type EditorialRevealProps = {
  /** Plays once per key (mount included) — the onboarding cover reveal. */
  playKey: string;
  children: ReactNode;
};

/**
 * The first-outfit aha moment: one orchestrated page-load sequence. Child 0
 * is the cover (fades + settles from 0.97); later children rise 14px with a
 * stagger — magazine cover, then the deck, then nothing else moves.
 * Under reduced motion every child renders in its final state.
 */
export const EditorialReveal = memo(function EditorialReveal({
  playKey,
  children,
}: EditorialRevealProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const playedRef = useRef<string | null>(null);
  const kids = useMemo(() => Children.toArray(children), [children]);
  const anims = useMemo(
    () =>
      kids.map(() => ({
        opacity: new Animated.Value(1),
        rise: new Animated.Value(0),
        zoom: new Animated.Value(1),
      })),
    // Length is stable per branch (outfit: 2, fallback: 2) — values are
    // only recreated if the child count itself changes, which replays anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kids.length],
  );

  useEffect(() => {
    if (reduceMotion || playedRef.current === playKey) return;
    playedRef.current = playKey;
    anims.forEach((a, i) => {
      a.opacity.setValue(0);
      a.rise.setValue(i === 0 ? 0 : 14);
      a.zoom.setValue(i === 0 ? MOTION.revealScaleFrom : 1);
    });
    const sequence = Animated.parallel(
      anims.map((a, i) =>
        Animated.sequence([
          Animated.delay(i * MOTION.staggerMs),
          Animated.parallel([
            Animated.timing(a.opacity, {
              toValue: 1,
              duration: 300,
              easing: easeOut,
              useNativeDriver: true,
            }),
            Animated.timing(a.rise, {
              toValue: 0,
              duration: 300,
              easing: easeOut,
              useNativeDriver: true,
            }),
            Animated.timing(a.zoom, {
              toValue: 1,
              duration: 380,
              easing: easeOut,
              useNativeDriver: true,
            }),
          ]),
        ]),
      ),
    );
    sequence.start();
    return () => sequence.stop();
  }, [playKey, reduceMotion, anims]);

  return (
    <View>
      {kids.map((child, i) => {
        const a = anims[i];
        if (!a) return <View key={`reveal-${i}`}>{child}</View>;
        return (
          <Animated.View
            key={`reveal-${i}`}
            style={{ opacity: a.opacity, transform: [{ translateY: a.rise }, { scale: a.zoom }] }}
          >
            {child}
          </Animated.View>
        );
      })}
    </View>
  );
});
