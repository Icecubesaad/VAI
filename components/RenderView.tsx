import React, { memo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { RenderStatus } from '../lib/api';
import { AI_DISCLOSURE } from '../lib/watermark';
import { CounterBadge } from './CounterBadge';
import { Watermark } from './Watermark';

export type RenderViewProps = {
  basePhotoUrl: string | null;
  outputUrl: string | null;
  status: RenderStatus;
  /** 2-up before/after when true (needs basePhotoUrl). */
  compare?: boolean;
  /** Attribution stamp overlay on the output image. */
  watermark?: boolean;
  /** Referral code for the watermark URL; generic stamp when omitted. */
  watermarkCode?: string | null;
  /** Restyle-loop entry; hidden when omitted. */
  onRestyle?: () => void;
  restyleLabel?: string;
  restyling?: boolean;
  /** Failed-render retry (free); hidden when omitted. */
  onRetry?: () => void;
  retrying?: boolean;
  error?: string | null;
  /** Optional quota strip under the result. */
  quotaLeft?: number | null;
  quotaCap?: number | null;
  onUpgrade?: () => void;
  testID?: string;
};

/**
 * Try-on result view (CONTRACT-frontend §2).
 *
 * - `done` + output → result image (or 2-up compare), the mandatory
 *   `"AI try-on · may differ from fit"` caption on EVERY output, optional
 *   watermark overlay, restyle entry, quota strip.
 * - `failed` → error block with free-retry entry (failed renders cost 0).
 * - anything else → compact loading slot (spinner only, no headline copy —
 *   parents own the "usually ~20s" messaging so nothing renders twice).
 */
export const RenderView = memo(function RenderView({
  basePhotoUrl,
  outputUrl,
  status,
  compare = false,
  watermark = false,
  watermarkCode,
  onRestyle,
  restyleLabel = 'Restyle',
  restyling = false,
  onRetry,
  retrying = false,
  error,
  quotaLeft,
  quotaCap,
  onUpgrade,
  testID,
}: RenderViewProps): React.JSX.Element {
  if (status === 'failed') {
    return (
      <View
        testID={testID ?? 'render-error'}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={`Render failed. ${error ?? 'Please try again.'}`}
        className="items-center gap-y-sm rounded-xl border border-line bg-card px-xl py-2xl"
      >
        <Text className="text-center font-display text-[22px] leading-[28px] font-semibold text-ink">
          This try-on did not work
        </Text>
        <Text className="text-center text-[15px] leading-[22px] text-inkSoft">
          {error ?? 'The render failed, so it cost nothing. Try again when you are ready.'}
        </Text>
        {onRetry ? (
          <View className="mt-sm w-full">
            <Pressable
              testID="render-retry"
              accessibilityRole="button"
              accessibilityLabel="Try again, free of charge"
              accessibilityState={{ busy: retrying }}
              disabled={retrying}
              onPress={onRetry}
              className={`items-center rounded-lg border border-line bg-card py-md active:bg-paperDeep ${
                retrying ? 'opacity-50' : ''
              }`}
            >
              {retrying ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text className="text-[15px] font-semibold text-ink">Try again (free)</Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  if (status === 'done' && outputUrl) {
    const twoUp = compare && basePhotoUrl != null;
    const stamp = watermark ? (
      <View className="absolute bottom-sm left-sm">
        {watermarkCode ? (
          <Watermark code={watermarkCode} tone="light" />
        ) : (
          <View className="self-start rounded-pill bg-black/55 px-sm py-[4px]">
            <Text className="text-[11px] leading-[14px] font-semibold text-white">
              Made with VAI
            </Text>
          </View>
        )}
      </View>
    ) : null;
    return (
      <View
        testID={testID ?? 'render-result'}
        accessible
        accessibilityLabel={`AI try-on result. ${AI_DISCLOSURE}`}
        className="gap-y-sm"
      >
        {twoUp ? (
          <View className="flex-row gap-x-sm">
            <View className="flex-1 gap-y-[4px]">
              <View className="aspect-[3/4] w-full overflow-hidden rounded-lg bg-paperDeep">
                <Image
                  source={{ uri: basePhotoUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={200}
                  accessibilityLabel="Your base photo"
                />
              </View>
              <Text className="text-center text-[12px] font-semibold text-muted">
                You
              </Text>
            </View>
            <View className="flex-1 gap-y-[4px]">
              <View className="aspect-[3/4] w-full overflow-hidden rounded-lg bg-paperDeep">
                <Image
                  source={{ uri: outputUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={200}
                  accessibilityLabel="AI try-on output"
                />
                {stamp}
              </View>
              <Text className="text-center text-[12px] font-semibold text-muted">
                Try-on
              </Text>
            </View>
          </View>
        ) : (
          <View className="aspect-[4/5] w-full overflow-hidden rounded-xl border border-lineOnCard bg-paperDeep shadow-card">
            <Image
              source={{ uri: outputUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              transition={200}
              accessibilityLabel="AI try-on output"
            />
            {stamp}
          </View>
        )}
        <Text testID="render-caption" className="text-center text-[12px] leading-[16px] text-muted">
          {AI_DISCLOSURE}
        </Text>
        {quotaLeft != null ? (
          <View className="items-center">
            <CounterBadge
              remaining={quotaLeft}
              total={quotaCap ?? 5}
              onUpgrade={onUpgrade ?? (() => undefined)}
            />
          </View>
        ) : null}
        {onRestyle ? (
          <Pressable
            testID="render-restyle"
            accessibilityRole="button"
            accessibilityLabel="Restyle this look"
            accessibilityState={{ busy: restyling }}
            disabled={restyling}
            onPress={onRestyle}
            className={`items-center rounded-lg border border-line bg-card py-md active:bg-paperDeep ${
              restyling ? 'opacity-50' : ''
            }`}
          >
            {restyling ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-[15px] font-semibold text-ink">{restyleLabel}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View
      testID="render-loading"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Render in progress"
      className="aspect-[4/5] w-full items-center justify-center rounded-xl border border-dashed border-line bg-paperDeep"
    >
      <ActivityIndicator size="large" />
    </View>
  );
});
