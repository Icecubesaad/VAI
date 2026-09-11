import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * Flame tab glyph, drawn locally (no icon-font dep in v1): Heroicons
 * `fire` solid path on a 24px grid, tinted by the tab bar.
 */
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
      <Tabs.Screen name="index" options={{ title: 'Today' }} />
      <Tabs.Screen name="closet" options={{ title: 'Closet' }} />
      <Tabs.Screen name="tryon" options={{ title: 'Try On' }} />
      <Tabs.Screen name="shop" options={{ title: 'Shop' }} />
      <Tabs.Screen
        name="reel"
        options={{
          title: 'Reel',
          tabBarIcon: ({ color, size }) => <FlameIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
