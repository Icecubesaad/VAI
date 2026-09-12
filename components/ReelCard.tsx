import React, { memo, useCallback, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';
import { useReducedMotion } from '../lib/motion';
import { reelFullProps } from '../lib/perf';
import { ReelSkeleton } from './ReelSkeleton';

/**
 * One pager cell in the looks reel. The pager parent owns sizing /
 * virtualization; this component is `flex-1` full-bleed inside its slot.
 */
export type ReelCard = {
  id: string;
  outfitId: string;
  renderId: string;
  imageUrl: string;
  pose: 'front' | 'step' | 'detail';
  garmentIds: string[];
  whyLine: string;
  trendTag?: string;
  costUsd: number;
  createdAt: string;
};

export type ReelCardProps = {
  card: ReelCard;
  onTry?: () => void;
  onSave?: () => void;
  onRegenerate?: () => void;
  saved: boolean;
  /** Owned-garment thumbs keyed by garment id (matches `card.garmentIds`). */
  garmentThumbs?: Record<string, string>;
  /** Real piece names keyed by garment id (closet categories), for the title. */
  garmentNames?: Record<string, string>;
  /** Pager position — drives the dots on the visible card. */
  index?: number;
  count?: number;
  /** Whether THIS card is the pager's visible page (dots render on it only). */
  active?: boolean;
  /** Failed-render retry (free). */
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** Shows the pager shimmer in place. */
  loading?: boolean;
  testID?: string;
};

/** Mandatory microcopy on every reel cell (store compliance, pack §6/§9). */
export const REEL_DISCLOSURE = 'AI styled · may differ from fit';

/**
 * Full-screen reel card — the whole cell is the look. Floating glass buttons
 * top-right (save ♥ + remix ↻), page dots + outfit title + why-line over a
 * bottom scrim, one frosted "Try it on" pill. Double-tap the photo saves.
 * Buttons render only when their handler is passed.
 */
export const ReelCard = memo(function ReelCard({
  card,
  onTry,
  onSave,
  onRegenerate,
  saved,
  garmentThumbs,
  garmentNames,
  index = 0,
  count = 0,
  active = false,
  error = null,
  onRetry,
  retrying = false,
  loading = false,
  testID,
}: ReelCardProps): React.JSX.Element {
  const lastTap = useRef(0);
  const burstScale = useRef(new Animated.Value(0)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;
  const [burstOn, setBurstOn] = useState(false);
  const reduceMotion = useReducedMotion();

  const fireBurst = useCallback(() => {
    if (reduceMotion) return;
    setBurstOn(true);
    burstScale.setValue(0.4);
    burstOpacity.setValue(1);
    Animated.parallel([
      Animated.spring(burstScale, { toValue: 1.1, friction: 6, tension: 120, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(350),
        Animated.timing(burstOpacity, { toValue: 0, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]),
    ]).start(({ finished }) => {
      if (finished) setBurstOn(false);
    });
  }, [burstOpacity, burstScale, reduceMotion]);

  const handleSave = useCallback(() => {
    void hapticFor.done();
    onSave?.();
  }, [onSave]);

  const handleImagePress = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 350) {
      lastTap.current = 0;
      handleSave();
      fireBurst();
    } else {
      lastTap.current = now;
    }
  }, [fireBurst, handleSave]);

  const title = card.garmentIds
    .map((id) => garmentNames?.[id])
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');

  if (loading) {
    return <ReelSkeleton testID={testID} />;
  }

  if (error) {
    const retry = onRetry ?? onRegenerate;
    return (
      <View
        testID={testID ?? 'reel-error'}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={`Look failed to load. ${error}`}
        className="flex-1 items-center justify-center bg-ink px-xl"
        style={{ rowGap: 8 }}
      >
        <View className="h-[56px] w-[56px] items-center justify-center rounded-full bg-white/10" aria-hidden>
          <Text className="text-[24px] text-white">!</Text>
        </View>
        <Text className="text-center font-display text-[22px] leading-[28px] font-semibold text-white">
          Couldn&apos;t create this look
        </Text>
        <Text className="text-center text-[15px] leading-[22px] text-white/70">{error}</Text>
        {retry ? (
          <View className="mt-sm w-full">
            <PressScale
              testID="reel-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry this look, free of charge"
              accessibilityState={{ disabled: retrying, busy: retrying }}
              disabled={retrying}
              hitSlop={12}
              onPress={() => {
                void hapticFor.select();
                retry();
              }}
              className={`items-center justify-center rounded-pill bg-white py-md active:opacity-80 ${
                retrying ? 'opacity-50' : ''
              }`}
            >
              <View className="items-center justify-center">
                <Text className={`text-[15px] font-bold text-ink ${retrying ? 'opacity-0' : ''}`}>Retry (free)</Text>
                {retrying ? (
                  <View className="absolute inset-0 items-center justify-center">
                    <ActivityIndicator size="small" color="#1A1A1A" />
                  </View>
                ) : null}
              </View>
            </PressScale>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      testID={testID ?? 'reel-card'}
      accessible
      accessibilityLabel={`AI styled look. ${title}. ${card.whyLine}`}
      className="flex-1 bg-ink"
    >
      {/* cover — the whole cell is the look; double-tap saves */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Look photo"
        accessibilityHint="Double-tap to save this look"
        onPress={handleImagePress}
        className="absolute inset-0"
      >
        {card.imageUrl ? (
          <Image
            source={{ uri: card.imageUrl }}
            style={{ width: '100%', height: '100%' }}
            {...reelFullProps(card.id)}
            transition={reduceMotion ? 0 : 200}
            accessibilityLabel="AI styled outfit photo"
          />
        ) : (
          // Pending render: dark stage + honest note (never a fake image).
          <View className="h-full w-full items-center justify-center bg-[#101010]">
            <ActivityIndicator color="#FFFFFF" />
            <Text className="mt-md text-[13px] font-semibold text-white/60">Styling this look…</Text>
          </View>
        )}
      </Pressable>

      {/* scrims for legibility (two layered fades — no new native dep) */}
      <View pointerEvents="none" className="absolute left-0 right-0 top-0 h-[120px]" style={{ backgroundColor: 'rgba(10, 10, 10, 0.38)' }} aria-hidden />
      <View pointerEvents="none" className="absolute bottom-0 left-0 right-0 h-[290px]" style={{ backgroundColor: 'rgba(10, 10, 10, 0.55)' }} aria-hidden />

      {/* floating glass buttons — top-right */}
      <View className="absolute right-md top-md items-center" style={{ rowGap: 10 }}>
        {onSave ? (
          <PressScale
            testID="reel-save"
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Remove from saved looks' : 'Save this look'}
            accessibilityState={{ selected: saved }}
            hitSlop={10}
            onPress={() => {
              if (!saved) void hapticFor.done();
              else void hapticFor.select();
              onSave();
            }}
            className="h-[46px] w-[46px] items-center justify-center rounded-full bg-white/20 active:opacity-70"
          >
            <Text className="text-[20px] leading-[24px] font-bold" style={{ color: saved ? '#FF5A6E' : '#FFFFFF' }}>
              {saved ? '♥' : '♡'}
            </Text>
          </PressScale>
        ) : null}
        {onRegenerate ? (
          <PressScale
            testID="reel-regenerate"
            accessibilityRole="button"
            accessibilityLabel="Generate a new variation of this look"
            hitSlop={10}
            onPress={() => {
              void hapticFor.select();
              onRegenerate();
            }}
            className="h-[46px] w-[46px] items-center justify-center rounded-full bg-white/20 active:opacity-70"
          >
            <Text className="text-[18px] leading-[22px] text-white">↻</Text>
          </PressScale>
        ) : null}
      </View>

      {/* heart burst on double-tap save */}
      {burstOn ? (
        <Animated.View
          pointerEvents="none"
          aria-hidden
          style={{ opacity: burstOpacity, transform: [{ scale: burstScale }] }}
          className="absolute inset-0 items-center justify-center"
        >
          <View className="h-[96px] w-[96px] items-center justify-center rounded-full bg-white/95">
            <Text className="text-[48px] leading-[52px] text-[#FF5A6E]">♥</Text>
          </View>
        </Animated.View>
      ) : null}

      {/* bottom: dots → title → why-line → try pill */}
      <View pointerEvents="box-none" className="absolute bottom-0 left-0 right-0 items-center px-lg pb-[86px]">
        {active && count > 1 ? (
          <View className="mb-md flex-row" style={{ columnGap: 5 }} aria-hidden>
            {Array.from({ length: count }, (_, i) => (
              <View
                key={i}
                className="h-[5px] w-[5px] rounded-full"
                style={{ backgroundColor: i === index ? '#FFFFFF' : 'rgba(255,255,255,0.38)' }}
              />
            ))}
          </View>
        ) : null}
        {!!title && (
          <Text
            testID="reel-outfit-title"
            className="text-center font-display text-[26px] leading-[32px] font-bold text-white"
            numberOfLines={1}
          >
            {title}
          </Text>
        )}
        {!!card.whyLine && (
          <Text className="mt-[6px] text-center text-[13px] leading-[18px] text-white/80" numberOfLines={2}>
            {card.whyLine}
          </Text>
        )}
        <Text testID="reel-disclosure" className="mt-[6px] text-[11px] leading-[14px] text-white/50">
          {REEL_DISCLOSURE}
        </Text>
        {onTry ? (
          <PressScale
            testID="reel-try"
            accessibilityRole="button"
            accessibilityLabel="Try this look on your photo"
            hitSlop={10}
            onPress={() => {
              void hapticFor.confirm();
              onTry();
            }}
            className="mt-md rounded-full bg-white px-xl py-[14px] active:opacity-80"
          >
            <Text className="text-[15px] font-bold text-ink">Try it on</Text>
          </PressScale>
        ) : null}
      </View>
    </View>
  );
});
