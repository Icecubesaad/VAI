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
      className={`flex-row items-center gap-x-sm self-start rounded-pill border px-md py-[6px] ${
        exhausted ? 'border-terracotta bg-terracottaWash' : 'border-line bg-card'
      }`}
    >
      {/* pip meter — fixed width so FlashList rows never shift (no layout thrash) */}
      <View className="flex-row gap-x-[3px]" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <View
            key={i}
            className={`h-[6px] w-[6px] rounded-full ${i < remaining ? 'bg-terracotta' : 'bg-line'}`}
          />
        ))}
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
        className="rounded-pill bg-ink px-sm py-[3px] active:opacity-80"
      >
        <Text className="text-[12px] leading-[16px] font-bold text-white">
          {exhausted ? 'Upgrade' : 'Get more'}
        </Text>
      </PressScale>
    </View>
  );
});
