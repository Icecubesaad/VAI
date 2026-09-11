import React, { memo } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Card } from './Card';

export type PinterestConsentProps = {
  /** When true, adds the secret-boards opt-in line. */
  secretOptIn?: boolean;
  testID?: string;
};

const ROWS: { head: string; body: string }[] = [
  {
    head: 'What we read',
    body: 'Your boards and Pins — secret boards only if you opt in — so VAI can style from your taste.',
  },
  {
    head: 'What we store',
    body: 'Pin IDs, image URLs, and titles for styling. Nothing else, never sold.',
  },
  {
    head: 'Purge on disconnect',
    body: 'Disconnect anytime in Settings and we delete your Pinterest data for good.',
  },
];

/**
 * Consent copy block for the Pinterest connect screen. States the read /
 * store / purge contract up front and closes with the never-auto-post
 * promise (Pinterest authenticity rules: every share is a deliberate tap).
 * Pure copy — OAuth itself is owned by the frontend crew.
 */
export const PinterestConsent = memo(function PinterestConsent({
  secretOptIn = false,
  testID,
}: PinterestConsentProps): React.JSX.Element {
  return (
    <Card
      testID={testID}
      accessibilityLabel="Pinterest data consent. What we read, what we store, purge on disconnect. VAI never auto-posts."
    >
      <Text className="text-[12px] font-bold uppercase text-terracotta" style={{ letterSpacing: 1.2 }}>
        Pinterest · your call
      </Text>
      <Text className="mt-[4px] font-display text-[22px] leading-[28px] font-semibold text-ink">
        You decide what VAI sees
      </Text>
      <View className="mt-md gap-y-md" style={{ rowGap: 12 }}>
        {ROWS.map((r) => (
          <View key={r.head} className="flex-row items-start" style={{ columnGap: 8 }}>
            <Text className="text-[15px] font-bold text-sage" aria-hidden>
              ✓
            </Text>
            <View className="flex-1 gap-y-[2px]">
              <Text className="text-[15px] leading-[22px] font-semibold text-ink">{r.head}</Text>
              <Text className="text-[14px] leading-[20px] text-inkSoft">{r.body}</Text>
            </View>
          </View>
        ))}
        {secretOptIn ? (
          <View className="rounded-md bg-paperDeep px-md py-sm">
            <Text className="text-[13px] leading-[18px] text-inkSoft">
              Secret-board access is on — we read secret boards too. Turn it off in Settings anytime.
            </Text>
          </View>
        ) : null}
        <View className="rounded-md bg-terracottaWash/50 px-md py-sm">
          <Text className="text-[14px] leading-[20px] font-semibold text-terracottaDeep">
            VAI never auto-posts. Every share to Pinterest is a deliberate tap by you.
          </Text>
        </View>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Pinterest data and privacy details"
          onPress={() => void Linking.openURL('https://vai.style/privacy')}
          className="py-[2px] active:opacity-70"
        >
          <Text className="text-[14px] font-semibold text-ink underline">How we handle Pinterest data</Text>
        </Pressable>
      </View>
    </Card>
  );
});
