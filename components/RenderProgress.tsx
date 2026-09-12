import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { RENDER_STAGES, RENDER_TIMING_LINE, useStagedCopy } from '../lib/motion';
import { SkeletonHero } from './Skeleton';

export type RenderProgressProps = {
  stages?: readonly string[];
  timingLine?: string;
  testID?: string;
};

/**
 * Render-pipeline wait state: never a dead spinner. A 4:5 shimmer skeleton
 * (same geometry as the try-on result, so progress → result crossfades
 * in place), a cycling editorial stage line, a 4-pip stage meter, and the
 * locked "usually ~20s" timing line. Pip fills are discrete commits —
 * no loops, no layout shift.
 */
export const RenderProgress = memo(function RenderProgress({
  stages = RENDER_STAGES,
  timingLine = RENDER_TIMING_LINE,
  testID = 'render-progress',
}: RenderProgressProps): React.JSX.Element {
  const { stage, index } = useStagedCopy(stages, true);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Render in progress. ${stage}`}
      className="gap-y-sm"
    >
      <SkeletonHero />
      <Text
        accessibilityLiveRegion="polite"
        numberOfLines={1}
        className="text-center text-[14px] font-semibold text-ink"
      >
        {stage}
      </Text>
      <View className="flex-row gap-x-[6px]" aria-hidden>
        {stages.map((s, i) => (
          <View
            key={s}
            className={`h-[6px] flex-1 rounded-full ${i <= index ? 'bg-terracotta' : 'bg-line'}`}
          />
        ))}
      </View>
      <Text className="text-center text-[13px] leading-[18px] text-inkSoft">{timingLine}</Text>
    </View>
  );
});
