import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';

export type CounterBadgeProps = {
  /** Renders remaining, e.g. 3 of total 5 → "3 of 5 left". */
  remaining: number;
  total: number;
  /** One-tap upgrade — opens PaywallSheet. Required: badge always offers a way out. */
  onUpgrade: () => void;
  testID?: string;
};

/**
 * Quota counter shown on Try-on + Planner hero.
 * Copy contract (pack §6): "X of 5 left" for free lifetime renders.
 * Exhausted state turns terracotta + tappable upgrade pill.
 */
export const CounterBadge = memo(function CounterBadge({
  remaining,
  total,
  onUpgrade,
  testID,
}: CounterBadgeProps): React.JSX.Element {
  const exhausted = remaining <= 0;
  const label = exhausted ? `0 of ${total} left` : `${remaining} of ${total} left`;

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Renders remaining: ${label}. Activate upgrade for more.`}
      className={`flex-row items-center gap-x-sm self-start rounded-pill border px-md py-[7px] ${
        exhausted ? 'border-terracotta bg-terracottaWash' : 'border-line bg-card'
      }`}
    >
      {/* meter: one slim track, violet fill — reads as remaining-at-a-glance
          without the chunky dot row */}
      <View className="h-[4px] w-[34px] overflow-hidden rounded-full bg-line" aria-hidden>
        <View
          className="h-full rounded-full bg-terracottaDeep"
          style={{ width: `${total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0}%` }}
        />
      </View>
      <Text className={`text-[13px] leading-[18px] font-semibold ${exhausted ? 'text-terracottaDeep' : 'text-inkSoft'}`}>
        {label}
      </Text>
      <PressScale
        testID={testID ? `${testID}-cta` : 'counter-cta'}
        accessibilityRole="button"
        accessibilityLabel={exhausted ? 'Upgrade to get more renders' : 'See upgrade options'}
        accessibilityHint="Opens the Premium paywall"
        hitSlop={12}
        onPress={() => {
          void hapticFor.select();
          onUpgrade();
        }}
        className="rounded-pill bg-terracottaDeep px-sm py-[4px] active:opacity-80"
      >
        <Text className="text-[12px] leading-[16px] font-bold text-white">
          {exhausted ? 'Upgrade' : 'Get more'}
        </Text>
      </PressScale>
    </View>
  );
});
