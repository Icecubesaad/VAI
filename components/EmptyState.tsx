import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Button } from './Button';

export type EmptyStateProps = {
  /** Editorial headline, e.g. "Your closet is a blank canvas" */
  title: string;
  body: string;
  actionTitle?: string;
  onAction?: () => void;
  /** Single-letter / emoji-free glyph drawn large — keeps zero asset cost */
  glyph?: string;
  /**
   * `offline-cached` adds the "Offline · saved on this device" eyebrow for
   * surfaces rendering cached content with no connection (reel saved drop,
   * offline board cache). Default renders no eyebrow — unchanged.
   */
  variant?: 'default' | 'offline-cached';
  testID?: string;
};

/** Warm empty states — never a grey void; always one clear next step. */
export const EmptyState = memo(function EmptyState({
  title,
  body,
  actionTitle,
  onAction,
  glyph = '✦',
  variant = 'default',
  testID,
}: EmptyStateProps): React.JSX.Element {
  const eyebrow = variant === 'offline-cached' ? 'Offline, saved on this device' : null;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${eyebrow ? `${eyebrow}. ` : ''}${title}. ${body}`}
      className="items-center gap-y-sm rounded-xl border border-dashed border-line bg-card px-xl py-2xl"
    >
      {eyebrow ? (
        <Text className="text-[12px] font-semibold text-muted">
          {eyebrow}
        </Text>
      ) : null}
      <Text className="text-[40px] leading-[48px] text-terracotta" aria-hidden>
        {glyph}
      </Text>
      <Text className="text-center font-display text-[22px] leading-[28px] font-semibold text-ink">{title}</Text>
      <Text className="text-center text-[15px] leading-[22px] text-inkSoft">{body}</Text>
      {actionTitle && onAction ? (
        <View className="mt-sm w-full">
          <Button title={actionTitle} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
});
