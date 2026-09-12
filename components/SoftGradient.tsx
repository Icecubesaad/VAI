import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Layered-fade gradient stand-in (no expo-linear-gradient dependency, same
 * trick the reel scrims use). Lavender glow → warm cream, matching the
 * onboarding art direction. direction: 'down' (default) or 'up'.
 */
export const SoftGradient = memo(function SoftGradient({
  height = 420,
  direction = 'down',
  tint = 'rgba(196, 176, 245,',
}: {
  height?: number;
  direction?: 'down' | 'up';
  tint?: string;
}): React.JSX.Element {
  const bands = 8;
  const alphas = direction === 'down' ? [0.55, 0.46, 0.37, 0.28, 0.2, 0.13, 0.07, 0.02] : [...[0.55, 0.46, 0.37, 0.28, 0.2, 0.13, 0.07, 0.02]].reverse();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} aria-hidden>
      {alphas.map((a, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: direction === 'down' ? (height / bands) * i : undefined,
            bottom: direction === 'up' ? (height / bands) * i : undefined,
            height: height / bands + 1,
            backgroundColor: `${tint} ${a})`,
          }}
        />
      ))}
    </View>
  );
});
