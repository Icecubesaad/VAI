import React, { memo, useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';

/** Style-refresh cadence for the invisible-Pinterest settings surface. */
export type TasteCadenceValue = 'daily' | 'weekly' | 'off';

export type TasteCadenceProps = {
  value: TasteCadenceValue;
  onChange: (value: TasteCadenceValue) => void;
  /** Caption under the control, e.g. "Last synced Tue 9:41 AM". Hidden while syncing. */
  lastSyncCaption?: string | null;
  /** When true the caption flips to the syncing line and input locks. */
  syncing?: boolean;
  disabled?: boolean;
  testID?: string;
};

const OPTIONS: Array<{ value: TasteCadenceValue; label: string; hint: string }> = [
  { value: 'daily', label: 'Daily', hint: 'Refresh style inspiration every day' },
  { value: 'weekly', label: 'Weekly', hint: 'Refresh style inspiration every week' },
  { value: 'off', label: 'Off', hint: 'Pause automatic style refreshes' },
];

const LABEL: Record<TasteCadenceValue, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  off: 'Off',
};

/**
 * "Style refresh" cadence selector — row 2 of the two-row invisible-Pinterest
 * settings surface (row 1 is `InspirationRow`). Segmented Daily / Weekly /
 * Off with the same native-driver sliding thumb + radiogroup semantics as
 * `PoseToggle`, plus the product microcopy and an optional last-sync caption
 * driven by the frontend's taste store.
 */
export const TasteCadence = memo(function TasteCadence({
  value,
  onChange,
  lastSyncCaption,
  syncing = false,
  disabled = false,
  testID,
}: TasteCadenceProps): React.JSX.Element {
  const index = Math.max(
    0,
    OPTIONS.findIndex((o) => o.value === value),
  );
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(index)).current;

  useEffect(() => {
    Animated.timing(slide, { toValue: index, duration: 180, useNativeDriver: true }).start();
  }, [index, slide]);

  const locked = disabled || syncing;
  const inner = Math.max(0, width - 8);
  const thumbWidth = inner / 3;
  const translateX = slide.interpolate({
    inputRange: [0, 1, 2],
    outputRange: [0, Math.max(0, thumbWidth), Math.max(0, thumbWidth * 2)],
  });
  const caption = syncing ? 'Syncing taste…' : lastSyncCaption;

  return (
    <View testID={testID} className="gap-y-sm">
      <View className="gap-y-[2px]">
        <Text className="text-[15px] leading-[22px] font-semibold text-ink">Style refresh</Text>
        <Text className="text-[13px] leading-[18px] text-inkSoft">
          Fresh inspiration for your reel, automatically
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="radiogroup"
        accessibilityLabel="Style refresh cadence"
        accessibilityValue={{ text: LABEL[value] }}
        accessibilityState={{ disabled: locked, busy: syncing }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        className={`relative flex-row rounded-pill border border-line bg-paperDeep p-[4px] ${
          locked ? 'opacity-50' : ''
        }`}
      >
        {thumbWidth > 0 ? (
          <Animated.View
            aria-hidden
            style={{ width: thumbWidth, transform: [{ translateX }] }}
            className="absolute bottom-[4px] left-[4px] top-[4px] rounded-pill bg-card"
          />
        ) : null}
        {OPTIONS.map((o) => {
          const selected = o.value === value;
          return (
            <PressScale
              key={o.value}
              testID={testID ? `${testID}-${o.value}` : `taste-cadence-${o.value}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: locked }}
              accessibilityLabel={`${o.label}${selected ? ', selected' : ''}`}
              accessibilityHint={o.hint}
              disabled={locked}
              hitSlop={8}
              onPress={() => {
                if (!selected) {
                  void hapticFor.select();
                  onChange(o.value);
                }
              }}
              className={`z-10 flex-1 items-center justify-center rounded-pill py-sm active:opacity-80 ${locked ? 'opacity-50' : ''}`}
            >
              <Text
                className={`text-[14px] leading-[20px] font-semibold ${
                  selected ? 'text-ink' : 'text-muted'
                }`}
              >
                {o.label}
              </Text>
            </PressScale>
          );
        })}
      </View>
      {caption ? (
        <Text
          testID={testID ? `${testID}-caption` : 'taste-cadence-caption'}
          className="text-[12px] leading-[16px] text-muted"
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
});
