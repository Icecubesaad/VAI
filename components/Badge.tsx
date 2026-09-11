import React, { memo } from 'react';
import { Text, View } from 'react-native';

export type BadgeTone = 'neutral' | 'terracotta' | 'sage' | 'gold' | 'ink' | 'danger';

export type BadgeProps = {
  label: string;
  tone?: BadgeTone;
  testID?: string;
};

const TONE_CLS: Record<BadgeTone, string> = {
  neutral: 'bg-paperDeep text-inkSoft',
  terracotta: 'bg-terracottaWash text-terracottaDeep',
  sage: 'bg-sageWash text-sageDeep',
  gold: 'bg-goldWash text-gold',
  ink: 'bg-ink text-white',
  danger: 'bg-dangerWash text-danger',
};

/** Small pill label — gap flags, disclosure chips, AI labels. */
export const Badge = memo(function Badge({ label, tone = 'neutral', testID }: BadgeProps): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      className={`self-start rounded-pill px-sm py-[3px] ${TONE_CLS[tone].split(' ')[0]}`}
    >
      <Text className={`text-[12px] leading-[16px] font-semibold ${TONE_CLS[tone].split(' ')[1]}`}>{label}</Text>
    </View>
  );
});
