import React, { memo, useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

function useShimmer(): Animated.AnimatedInterpolation<number> {
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

/** Base shimmer block — opacity-only animation, native driver, zero layout cost. */
export const Skeleton = memo(function Skeleton({
  className = '',
  testID,
}: {
  className?: string;
  testID?: string;
}): React.JSX.Element {
  const opacity = useShimmer();
  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={{ opacity }}
      className={`rounded-md bg-line ${className}`}
    />
  );
});

/** Closet-grid-shaped placeholder — matches GarmentCard 3:4 geometry. */
export const SkeletonCard = memo(function SkeletonCard(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel="Loading garment" className="overflow-hidden rounded-lg border border-lineOnCard bg-card">
      <Skeleton className="aspect-[3/4] w-full rounded-none" />
      <View className="gap-y-[6px] p-sm">
        <Skeleton className="h-[14px] w-3/4" />
        <Skeleton className="h-[12px] w-1/2" />
      </View>
    </View>
  );
});

/** Full-screen closet loading grid (6 cells, static — no list virtualization needed). */
export const SkeletonGrid = memo(function SkeletonGrid({ count = 6 }: { count?: number }): React.JSX.Element {
  return (
    <View accessible accessibilityLabel="Loading closet" className="flex-row flex-wrap gap-sm">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className="w-[31%]">
          <SkeletonCard />
        </View>
      ))}
    </View>
  );
});

/** Planner-hero-shaped placeholder — matches OutfitCard 4:5 geometry. */
export const SkeletonHero = memo(function SkeletonHero(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel="Loading outfit" className="overflow-hidden rounded-lg bg-card">
      <Skeleton className="aspect-[4/5] w-full rounded-none" />
      <View className="gap-y-[8px] p-lg">
        <Skeleton className="h-[22px] w-2/3" />
        <Skeleton className="h-[14px] w-full" />
        <Skeleton className="h-[44px] w-full rounded-lg" />
      </View>
    </View>
  );
});

/**
 * Settings-row-shaped placeholder — matches `InspirationRow` geometry
 * (avatar dot + two text lines + chevron) for the syncing-taste state.
 * Opacity-only shimmer, no layout shift on swap.
 */
export const SkeletonTasteRow = memo(function SkeletonTasteRow({
  testID,
}: {
  testID?: string;
}): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Syncing style inspiration"
      className="flex-row items-center rounded-xl border border-line bg-card px-md py-md"
      style={{ columnGap: 12 }}
    >
      <Skeleton className="h-[44px] w-[44px] rounded-full" />
      <View className="flex-1 gap-y-[6px]">
        <Skeleton className="h-[14px] w-2/5" />
        <Skeleton className="h-[12px] w-3/5" />
      </View>
      <Skeleton className="h-[20px] w-[12px]" />
    </View>
  );
});
