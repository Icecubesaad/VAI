import React, { memo, useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';

export type PoseToggleMode = 'mine' | 'pin';

export type PoseToggleProps = {
  mode: PoseToggleMode;
  onChange: (mode: PoseToggleMode) => void;
  /** Pin thumb shown as the Pin-pose dot preview; glyph fallback when absent. */
  pinThumb?: string | null;
  disabled?: boolean;
  testID?: string;
};

const MODES: PoseToggleMode[] = ['mine', 'pin'];

const LABEL: Record<PoseToggleMode, string> = {
  mine: 'My pose',
  pin: 'Pin pose',
};

/**
 * Segmented [My pose | Pin pose] toggle for the taste-graph flow.
 * Each segment carries a pose-dot preview (pin thumb when provided) so the
 * choice reads at a glance. Sliding thumb runs on the native driver;
 * selection fires a `select` haptic and is exposed as a radiogroup.
 */
export const PoseToggle = memo(function PoseToggle({
  mode,
  onChange,
  pinThumb,
  disabled = false,
  testID,
}: PoseToggleProps): React.JSX.Element {
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(mode === 'pin' ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: mode === 'pin' ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [mode, slide]);

  const inner = Math.max(0, width - 8);
  const thumbWidth = inner / 2;
  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, thumbWidth)] });

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="radiogroup"
      accessibilityLabel="Pose source"
      accessibilityValue={{ text: LABEL[mode] }}
      accessibilityState={{ disabled }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      className={`relative flex-row rounded-pill border border-line bg-paperDeep p-[4px] ${disabled ? 'opacity-50' : ''}`}
    >
      {thumbWidth > 0 ? (
        <Animated.View
          aria-hidden
          style={{ width: thumbWidth, transform: [{ translateX }] }}
          className="absolute bottom-[4px] left-[4px] top-[4px] rounded-pill bg-card"
        />
      ) : null}
      {MODES.map((m) => {
        const selected = m === mode;
        return (
          <PressScale
            key={m}
            testID={testID ? `${testID}-${m}` : `pose-toggle-${m}`}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`${LABEL[m]}${selected ? ', selected' : ''}`}
            accessibilityHint={m === 'mine' ? 'Style with your own pose' : 'Style with the Pinterest pin pose'}
            disabled={disabled}
            hitSlop={8}
            onPress={() => {
              if (!selected) {
                void hapticFor.select();
                onChange(m);
              }
            }}
            className="z-10 flex-1 flex-row items-center justify-center rounded-pill py-sm active:opacity-80"
            style={{ columnGap: 6 }}
          >
            {m === 'pin' && pinThumb ? (
              <Image
                source={{ uri: pinThumb }}
                style={{ width: 22, height: 22, borderRadius: 999 }}
                contentFit="cover"
                transition={150}
                accessibilityLabel="Pin pose preview"
              />
            ) : (
              <View
                aria-hidden
                style={{ width: 22, height: 22, borderRadius: 999 }}
                className={`items-center justify-center ${selected ? 'bg-terracotta' : 'border border-line bg-card'}`}
              >
                <Text className={`text-[12px] leading-[16px] font-bold ${selected ? 'text-white' : 'text-muted'}`}>
                  {m === 'mine' ? '◐' : '◈'}
                </Text>
              </View>
            )}
            <Text className={`text-[14px] leading-[20px] font-semibold ${selected ? 'text-ink' : 'text-muted'}`}>
              {LABEL[m]}
            </Text>
          </PressScale>
        );
      })}
    </View>
  );
});
