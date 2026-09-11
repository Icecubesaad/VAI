import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Button } from './Button';

export type ErrorViewProps = {
  title?: string;
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  offline?: boolean;
  /**
   * When true (typically paired with `offline`), adds the "Showing your last
   * saved version" caption for surfaces that keep cached content usable
   * through the failure. Default false — unchanged.
   */
  cached?: boolean;
  testID?: string;
};

const OFFLINE_COPY =
  "You're offline — your closet is safe on this device. Reconnect and we'll pick up where you left off.";

const CACHED_COPY = "Showing your last saved version — we'll refresh when you're back.";

/**
 * Failure surface with retry. Airplane-mode copy built in: pass
 * `offline` (or detect via NetInfo in frontend) for the offline variant.
 */
export const ErrorView = memo(function ErrorView({
  title,
  message,
  onRetry,
  retrying = false,
  offline = false,
  cached = false,
  testID,
}: ErrorViewProps): React.JSX.Element {
  const heading = offline ? 'No connection' : (title ?? 'Something went wrong');
  const body = offline ? OFFLINE_COPY : message;
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${heading}. ${body}${cached ? ` ${CACHED_COPY}` : ''}`}
      className="items-center gap-y-sm rounded-xl border border-line bg-card px-xl py-2xl"
    >
      <View className="h-[56px] w-[56px] items-center justify-center rounded-full bg-dangerWash" aria-hidden>
        <Text className="text-[24px] text-danger">{offline ? '✈' : '!'}</Text>
      </View>
      <Text className="text-center font-display text-[22px] leading-[28px] font-semibold text-ink">{heading}</Text>
      <Text className="text-center text-[15px] leading-[22px] text-inkSoft">{body}</Text>
      {cached ? (
        <Text className="text-center text-[13px] leading-[18px] text-muted">{CACHED_COPY}</Text>
      ) : null}
      <View className="mt-sm w-full">
        <Button title={retrying ? 'Retrying…' : 'Try again'} onPress={onRetry} loading={retrying} />
      </View>
    </View>
  );
});
