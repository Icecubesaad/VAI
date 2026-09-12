import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * Tab glyphs, drawn locally (no icon-font dep in v1): Heroicons paths on a
 * 24px grid, tinted by the tab bar. Reel = solid flame; the rest are
 * outline strokes — the router's default placeholder glyph showed otherwise.
 */
const STROKE_PATHS: Record<string, string> = {
  today:
    'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75',
  closet:
    'M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25m8.25-8.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25H9.75A2.25 2.25 0 0 1 7.5 18v-7.5a2.25 2.25 0 0 1 2.25-2.25h6.75z',
  tryon:
    'M6.827 6.175A2.31 2.31 0 0 0 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 0-1.64-1.055l-.822-1.644a.75.75 0 0 0-.676-.431H8.824a.75.75 0 0 0-.676.43L7.329 6.175zM15 12.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  shop:
    'M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007z',
  profile:
    'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0zM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632z',
};

function StrokeIcon({ name, color, size }: { name: string; color: ColorValue; size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d={STROKE_PATHS[name] ?? ''}
        stroke={color as string}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function FlameIcon({ color, size }: { color: ColorValue; size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color as string} aria-label="Reel">
      <Path d="M12.963 2.286a.75.75 0 0 0-1.071-.136 9.742 9.742 0 0 0-3.539 6.177A7.547 7.547 0 0 1 6.648 6.61a.75.75 0 0 0-1.152-.082A9 9 0 1 0 15.68 4.534a7.46 7.46 0 0 1-2.717-2.248zM15.75 14.25a3.75 3.75 0 1 1-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 0 1 1.925-3.545 3.75 3.75 0 0 1 3.255 3.717z" />
    </Svg>
  );
}

/**
 * 6-tab root: Home planner · Closet · Try-on studio (center) · Shop · Reel · Profile.
 * Icons come from the UI/UX theme package; labels are fixed product copy.
 * v1 cut scope: NO social/battles/fragrance tabs.
 */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="index"
        options={{ title: 'Today', tabBarIcon: ({ color, size }) => <StrokeIcon name="today" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="closet"
        options={{ title: 'Closet', tabBarIcon: ({ color, size }) => <StrokeIcon name="closet" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="tryon"
        options={{ title: 'Try On', tabBarIcon: ({ color, size }) => <StrokeIcon name="tryon" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="shop"
        options={{ title: 'Shop', tabBarIcon: ({ color, size }) => <StrokeIcon name="shop" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="reel"
        options={{
          title: 'Reel',
          tabBarIcon: ({ color, size }) => <FlameIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <StrokeIcon name="profile" color={color} size={size} /> }}
      />
    </Tabs>
  );
}
