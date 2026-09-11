import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Button } from './Button';

export type PinPoseCompareProps = {
  /** Your photo; dashed placeholder when not captured yet. */
  mineUrl?: string | null;
  pinUrl: string;
  pinTitle?: string | null;
  /** Stance caption, e.g. "Mid-step street · weight on back foot". */
  stanceLabel: string;
  stanceHint?: string | null;
  onUsePose: () => void;
  using?: boolean;
  testID?: string;
};

/**
 * Side-by-side "Mine vs Pin" pose compare — two fixed 3:4 frames so the
 * pair swaps without layout shift, a stance caption grounding the pose
 * language, and one explicit `Use this pose` CTA (haptic-fired by Button).
 */
export const PinPoseCompare = memo(function PinPoseCompare({
  mineUrl,
  pinUrl,
  pinTitle,
  stanceLabel,
  stanceHint,
  onUsePose,
  using = false,
  testID,
}: PinPoseCompareProps): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`Pose compare. Stance: ${stanceLabel}`}
      className="gap-y-sm"
    >
      <View className="flex-row" style={{ columnGap: 8 }}>
        <View className="flex-1 gap-y-[4px]">
          <Text className="text-[12px] font-bold uppercase text-muted" style={{ letterSpacing: 1.2 }}>
            Mine
          </Text>
          <View className="aspect-[3/4] w-full overflow-hidden rounded-lg border border-lineOnCard bg-paperDeep">
            {mineUrl ? (
              <Image
                source={{ uri: mineUrl }}
                style={{ width: '100%', height: '100%' }}
                contentFit="cover"
                transition={150}
                accessibilityLabel="Your pose photo"
              />
            ) : (
              <View
                accessible
                accessibilityLabel="Your photo, not captured yet"
                className="h-full w-full items-center justify-center border border-dashed border-line px-sm"
              >
                <Text className="text-center text-[13px] leading-[18px] text-muted">Your photo goes here</Text>
              </View>
            )}
          </View>
        </View>
        <View className="flex-1 gap-y-[4px]">
          <Text className="text-[12px] font-bold uppercase text-muted" style={{ letterSpacing: 1.2 }}>
            Pin
          </Text>
          <View className="aspect-[3/4] w-full overflow-hidden rounded-lg border border-lineOnCard bg-paperDeep">
            <Image
              source={{ uri: pinUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              transition={150}
              accessibilityLabel={pinTitle ?? 'Pinterest pin pose'}
            />
          </View>
        </View>
      </View>

      <View className="items-center gap-y-[2px] px-md">
        <Text className="text-center text-[14px] leading-[20px] font-semibold text-ink">◐ {stanceLabel}</Text>
        {stanceHint ? (
          <Text className="text-center text-[13px] leading-[18px] text-inkSoft">{stanceHint}</Text>
        ) : null}
        {pinTitle ? (
          <Text className="text-center text-[12px] leading-[16px] text-muted" numberOfLines={1}>
            from “{pinTitle}”
          </Text>
        ) : null}
      </View>

      <Button
        title={using ? 'Setting pose…' : 'Use this pose'}
        onPress={onUsePose}
        loading={using}
        testID={testID ? `${testID}-cta` : 'pin-pose-cta'}
        accessibilityHint="Applies the pin stance to your next try-on"
      />
    </View>
  );
});
