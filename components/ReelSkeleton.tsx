import React, { memo, useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

function usePulse(): Animated.AnimatedInterpolation<number> {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] });
}

/**
 * Pager loading shimmer — full-screen geometry matching `ReelCard` so the
 * first render swaps in without layout shift: photo field + top chip
 * placeholders + bottom sheetlet (thumb chips, why-lines, CTA bar).
 *
 * Opacity-only animation on the native driver; safe as a pager placeholder
 * behind a FlashList / paging ScrollView.
 */
export const ReelSkeleton = memo(function ReelSkeleton({ testID }: { testID?: string }): React.JSX.Element {
  const opacity = usePulse();
  return (
    <View
      testID={testID ?? 'reel-skeleton'}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading looks"
      className="flex-1 bg-ink"
    >
      {/* photo field */}
      <Animated.View style={{ opacity }} className="absolute inset-0 bg-white/10" aria-hidden />

      {/* top chips */}
      <View className="absolute left-0 right-0 top-0 flex-row px-md pt-lg" style={{ columnGap: 6 }} aria-hidden>
        <Animated.View style={{ opacity }} className="h-[28px] w-[92px] rounded-pill bg-white/20" />
        <Animated.View style={{ opacity }} className="h-[28px] w-[110px] rounded-pill bg-white/20" />
      </View>

      {/* bottom sheetlet */}
      <View className="absolute bottom-0 left-0 right-0 rounded-t-xl bg-paper px-lg pb-xl pt-sm" aria-hidden>
        <View className="mb-sm items-center">
          <View className="h-[4px] w-[40px] rounded-full bg-line" />
        </View>
        <View className="mb-sm flex-row" style={{ columnGap: 6 }}>
          {[0, 1, 2].map((i) => (
            <Animated.View key={i} style={{ opacity }} className="h-[34px] w-[104px] rounded-pill bg-line" />
          ))}
        </View>
        <Animated.View style={{ opacity }} className="mb-[6px] h-[16px] w-full rounded-md bg-line" />
        <Animated.View style={{ opacity }} className="mb-sm h-[16px] w-2/3 rounded-md bg-line" />
        <Animated.View style={{ opacity }} className="h-[48px] w-full rounded-lg bg-line" />
      </View>
    </View>
  );
});
