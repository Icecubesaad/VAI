import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';
import { PressScale } from './PressScale';
import { Icon, type IconName } from './icons';
import { tokenColors } from '@/theme';

/**
 * Floating pill tab bar (founder reference §nav): one rounded-full
 * plum-black bar, the active tab expands into a violet pill with icon +
 * label, inactive tabs stay icon-only. Per-screen `tabBarStyle.display
 * === 'none'` (the changing room) hides it entirely for immersion.
 */

const TAB_ICONS: Record<string, IconName> = {
  index: 'today',
  closet: 'closet',
  tryon: 'tryon',
  shop: 'shop',
  reel: 'reel',
  profile: 'profile',
};

const ITEM_H = 46;

function TabItem({
  focused,
  iconName,
  label,
  labelW,
  onPress,
  testID,
}: {
  focused: boolean;
  iconName: IconName;
  label: string;
  /** Natural label width, measured once in the bar's offscreen strip. */
  labelW: number;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  const grow = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(grow, {
      toValue: focused ? 1 : 0,
      duration: 240,
      useNativeDriver: false,
    }).start();
  }, [focused, grow]);

  const labelWidth = grow.interpolate({
    inputRange: [0, 1],
    // +6 slack: the strip may measure before webfonts finish loading (fallback
    // metrics run narrow) — a hair of extra pill padding beats ellipsizing.
    outputRange: [0, Math.max(0, labelW) + 6],
  });
  const pillOpacity = grow.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <PressScale
      scaleTo={0.94}
      onPress={onPress}
      testID={testID}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <View style={styles.item}>
        <Animated.View
          pointerEvents="none"
          style={[styles.pill, { opacity: pillOpacity }]}
          aria-hidden
        />
        <View style={styles.itemContent}>
          <Icon name={iconName} color={focused ? '#FFFFFF' : 'rgba(255,255,255,0.62)'} size={22} />
          <Animated.View style={[styles.labelClip, { width: labelWidth }]}>
            <Text style={[styles.labelReveal, { width: Math.max(0, labelW) + 4 }]} numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
        </View>
      </View>
    </PressScale>
  );
}

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  const activeRoute = state.routes[state.index];
  const activeOptions = activeRoute ? descriptors[activeRoute.key]?.options : undefined;
  // Immersive screens (changing room) opt out via `tabBarStyle: {display:'none'}`.
  const flatStyle = StyleSheet.flatten(activeOptions?.tabBarStyle) as ViewStyle | undefined;
  if (flatStyle?.display === 'none') return null;

  // Natural label widths measured OFFSCREEN (an absolutely-positioned text
  // inside the animated zero-width clip measures 0 — this strip never clips).
  const [labelWidths, setLabelWidths] = useState<Record<string, number>>({});

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + 10 }]}
      testID="vai-tab-bar"
    >
      <View
        pointerEvents="none"
        style={styles.measureStrip}
        aria-hidden
        accessibilityElementsHidden
      >
        {state.routes.map((route) => (
          <Text
            key={route.key}
            style={styles.label}
            onLayout={(e) => {
              const w = Math.ceil(e.nativeEvent.layout.width);
              setLabelWidths((prev) => (prev[route.key] === w ? prev : { ...prev, [route.key]: w }));
            }}
          >
            {descriptors[route.key]?.options.title ?? route.name}
          </Text>
        ))}
      </View>
      <View style={styles.bar}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const options = descriptors[route.key]?.options;
          const label = options?.title ?? route.name;
          const iconName = TAB_ICONS[route.name] ?? 'today';
          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name as never);
            }
          };
          return (
            <TabItem
              key={route.key}
              focused={focused}
              iconName={iconName}
              label={label}
              labelW={labelWidths[route.key] ?? 0}
              onPress={onPress}
              testID={`tab-${route.name}`}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokenColors.stage,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 7,
    paddingVertical: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  item: {
    height: ITEM_H,
    borderRadius: 999,
    paddingHorizontal: 11,
    justifyContent: 'center',
  },
  pill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
  },
  itemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ITEM_H,
  },
  labelClip: {
    overflow: 'hidden',
    marginLeft: 7,
    justifyContent: 'center',
    height: ITEM_H,
  },
  // Visible copy inside the animated clip — pinned to its natural width so
  // the pill reveals it like a drawer instead of reflowing letter by letter.
  labelReveal: {
    position: 'absolute',
    left: 0,
    top: 0,
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: ITEM_H,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
  },
  // Offscreen measuring strip — never clips, never visible.
  measureStrip: {
    position: 'absolute',
    top: -200,
    left: 0,
    flexDirection: 'row',
    opacity: 0,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
  },
});
