import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';

export type InspirationRowProps = {
  /** Pinterest taste linked. False renders the one-tap connect state. */
  connected: boolean;
  /** Pinterest handle shown as @username when connected. */
  username?: string | null;
  /** Status line when connected, e.g. "Last synced Tue 9:41 AM". */
  lastSyncCaption?: string | null;
  /** When true the status flips to "Syncing taste…" and the row locks. */
  syncing?: boolean;
  /** Fallback status when no caption is provided, e.g. "3 boards synced". */
  boardCount?: number | null;
  /** Connected → manage boards; disconnected → start one-tap connect. */
  onPress: () => void;
  /** Rendered as a separate danger hit-area when connected. Omit to hide. */
  onDisconnect?: () => void;
  disconnecting?: boolean;
  testID?: string;
};

const DISCONNECTED_SUB = 'One-tap connect — fresh ideas for your reel';

/**
 * "Style inspiration" settings row — row 1 of the two-row invisible-Pinterest
 * settings surface (row 2 is `TasteCadence`). Connected state shows the
 * avatar dot, @username, and last-synced caption plus a separate disconnect
 * hit-area (sibling pressable, never nested); disconnected state is a single
 * one-tap connect row. Pinterest is otherwise invisible in v1.
 */
export const InspirationRow = memo(function InspirationRow({
  connected,
  username,
  lastSyncCaption,
  syncing = false,
  boardCount,
  onPress,
  onDisconnect,
  disconnecting = false,
  testID,
}: InspirationRowProps): React.JSX.Element {
  const locked = syncing || disconnecting;
  const initial = (username?.trim().charAt(0) || '✦').toUpperCase();
  const status = !connected
    ? DISCONNECTED_SUB
    : syncing
      ? 'Syncing taste…'
      : (lastSyncCaption ??
        (boardCount != null
          ? `${boardCount} board${boardCount === 1 ? '' : 's'} synced`
          : 'Connected'));
  const rowLabel = connected
    ? `Style inspiration, connected as ${username ?? 'connected'}, ${status}`
    : `Style inspiration, not connected. ${DISCONNECTED_SUB}`;

  return (
    <View testID={testID} className="rounded-xl border border-line bg-card px-md py-md">
      <PressScale
        testID={testID ? `${testID}-row` : 'inspiration-row'}
        accessibilityRole="button"
        accessibilityLabel={rowLabel}
        accessibilityHint={connected ? 'Manage style inspiration boards' : 'Connect Pinterest'}
        accessibilityState={{ disabled: locked, busy: syncing }}
        disabled={locked}
        hitSlop={8}
        onPress={() => {
          void hapticFor.select();
          onPress();
        }}
        className={`flex-row items-center active:opacity-80 ${locked ? 'opacity-50' : ''}`}
        style={{ columnGap: 12 }}
      >
        <View
          aria-hidden
          className={`h-[44px] w-[44px] items-center justify-center rounded-full ${
            connected ? 'bg-terracottaWash' : 'bg-paperDeep'
          }`}
        >
          <Text
            className={`text-[18px] leading-[24px] font-bold ${
              connected ? 'text-terracottaDeep' : 'text-muted'
            }`}
          >
            {initial}
          </Text>
          <View
            className={`absolute bottom-0 right-0 h-[14px] w-[14px] rounded-full border-2 border-card ${
              connected ? 'bg-sage' : 'bg-muted'
            }`}
          />
        </View>
        <View className="flex-1 gap-y-[2px]">
          <Text className="text-[12px] font-bold uppercase text-muted" style={{ letterSpacing: 1.2 }}>
            Style inspiration
          </Text>
          <Text className="text-[15px] leading-[22px] font-semibold text-ink" numberOfLines={1}>
            {connected ? `@${username ?? 'connected'}` : 'Connect Pinterest'}
          </Text>
          <Text className="text-[13px] leading-[18px] text-inkSoft" numberOfLines={2}>
            {status}
          </Text>
        </View>
        <Text className="text-[20px] leading-[24px] text-muted" aria-hidden>
          ›
        </Text>
      </PressScale>
      {connected && onDisconnect ? (
        <PressScale
          testID={testID ? `${testID}-disconnect` : 'inspiration-disconnect'}
          accessibilityRole="button"
          accessibilityLabel={disconnecting ? 'Disconnecting style inspiration' : 'Disconnect style inspiration'}
          accessibilityHint="Removes synced taste data. Your closet and renders stay."
          accessibilityState={{ disabled: disconnecting, busy: disconnecting }}
          disabled={disconnecting}
          hitSlop={12}
          onPress={() => {
            void hapticFor.select();
            onDisconnect();
          }}
          className={`mt-sm border-t border-lineOnCard pt-sm active:opacity-70 ${disconnecting ? 'opacity-50' : ''}`}
        >
          <Text className="text-[14px] leading-[20px] font-semibold text-danger">
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Text>
        </PressScale>
      ) : null}
    </View>
  );
});
