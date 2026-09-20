import { Redirect, Tabs } from 'expo-router';
import { useSession } from '@/store/session';
import { TabBar } from '@/components/TabBar';
import { Icon } from '@/components/icons';

/**
 * 5-tab root: Home · Closet · Try-on studio (center) · Shop · Reel.
 * Custom floating pill tab bar (components/TabBar.tsx); the try-on studio
 * hides it (`tabBarStyle.display = 'none'`) — the changing room is a
 * full-bleed immersive surface with its own back chrome. Profile lives
 * outside the tab bar (v2: reachable from home header).
 *
 * Session gate: a removed/expired token must land on sign-in, never on the
 * signed-in UI (deep links to /(tabs) included). Render-level Redirect — an
 * effect-based replace is swallowed during the navigator's initial mount.
 */
export default function TabsLayout() {
  const userId = useSession((s) => s.userId);

  if (!userId) {
    return <Redirect href="/onboarding/auth" />;
  }

  return (
    <Tabs
      // The custom pill bar is a navigator-level config (expo-router v6),
      // not a screen option — and the changing room hides it per-screen via
      // `tabBarStyle.display = 'none'` (read inside TabBar).
      // freezeOnBlur suspends inactive tab trees (perf; keeps state).
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, freezeOnBlur: true }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Today', tabBarIcon: ({ color, size }) => <Icon name="today" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="closet"
        options={{ title: 'Closet', tabBarIcon: ({ color, size }) => <Icon name="closet" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="tryon"
        options={{
          title: 'Try On',
          tabBarStyle: { display: 'none' },
          tabBarIcon: ({ color, size }) => <Icon name="tryon" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="shop"
        options={{ title: 'Shop', tabBarIcon: ({ color, size }) => <Icon name="shop" color={color as string} size={size} /> }}
      />
    </Tabs>
  );
}
