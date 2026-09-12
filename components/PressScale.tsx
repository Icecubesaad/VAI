import React, { memo, useCallback, useRef } from 'react';
import {
  Animated,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MOTION, useReducedMotion } from '../lib/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressScaleProps = Omit<PressableProps, 'style'> & {
  /** Pressed scale. 0.97 for buttons, 0.98 for pills/dense chips. */
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
  className?: string;
};

/**
 * Drop-in Pressable with a tactile spring-down on touch (transform-only,
 * native driver — no layout cost, FlashList-safe). Same node, same props:
 * testIDs, accessibility, className, and style all land on the pressable
 * itself, so layout is byte-identical to the Pressable it replaces.
 * Renders instantly with no scaling under reduced motion.
 */
export const PressScale = memo(function PressScale({
  scaleTo = MOTION.pressScale,
  onPressIn,
  onPressOut,
  disabled = false,
  style,
  className,
  children,
  ...rest
}: PressScaleProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = useCallback(
    (e: GestureResponderEvent) => {
      onPressIn?.(e);
      if (reduceMotion || disabled) return;
      Animated.spring(scale, {
        toValue: scaleTo,
        ...MOTION.pressSpring,
        useNativeDriver: true,
      }).start();
    },
    [onPressIn, reduceMotion, disabled, scale, scaleTo],
  );

  const pressOut = useCallback(
    (e: GestureResponderEvent) => {
      onPressOut?.(e);
      if (reduceMotion || disabled) return;
      Animated.spring(scale, { toValue: 1, ...MOTION.pressSpring, useNativeDriver: true }).start();
    },
    [onPressOut, reduceMotion, disabled, scale],
  );

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={pressIn}
      onPressOut={pressOut}
      className={className}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
});
