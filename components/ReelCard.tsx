import React, { memo, useCallback, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { ReelSkeleton } from './ReelSkeleton';

export type ReelPose = 'front' | 'step' | 'detail';

/**
 * One pager cell in the looks reel. The pager parent owns sizing /
 * virtualization; this component is `flex-1` full-bleed inside its slot.
 */
export type ReelCard = {
  id: string;
  outfitId: string;
  renderId: string;
  imageUrl: string;
  pose: ReelPose;
  garmentIds: string[];
  whyLine: string;
  trendTag?: string;
  costUsd: number;
  createdAt: string;
};

export type ReelCardProps = {
  card: ReelCard;
  onWear?: () => void;
  onTry?: () => void;
  onShop?: () => void;
  onSave?: () => void;
  onRegenerate?: () => void;
  saved: boolean;
  /** Owned-garment thumbs keyed by garment id (matches `card.garmentIds`). */
  garmentThumbs?: Record<string, string>;
  /** Renders-left pill in the top scrim; falls back to the cost context pill. */
  quotaLeft?: number | null;
  quotaCap?: number | null;
  onUpgrade?: () => void;
  /** Failed-render retry (free, same language as RenderView). Falls back to onRegenerate. */
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** Shows the pager shimmer in place. */
  loading?: boolean;
  testID?: string;
};

export const REEL_POSE_LABEL: Record<ReelPose, string> = {
  front: 'Front fit',
  step: 'Street step',
  detail: 'Detail',
};

/** Mandatory microcopy on every reel cell (store compliance, pack §6/§9). */
export const REEL_DISCLOSURE = 'AI styled · may differ from fit';

function money(n: number): string {
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

const GarmentChip = memo(function GarmentChip({
  index,
  thumb,
}: {
  index: number;
  thumb?: string;
}): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Outfit piece ${index + 1}`}
      className="flex-row items-center rounded-pill border border-line bg-card py-[3px] pl-[3px] pr-sm"
      style={{ columnGap: 6 }}
    >
      <View className="h-[28px] w-[28px] overflow-hidden rounded-full bg-paperDeep">
        {thumb ? (
          <Image
            source={{ uri: thumb }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={150}
            accessibilityLabel={`Piece ${index + 1} thumbnail`}
          />
        ) : (
          <View className="h-full w-full items-center justify-center" aria-hidden>
            <Text className="text-[13px] text-muted">✦</Text>
          </View>
        )}
      </View>
      <Text className="text-[12px] leading-[16px] font-semibold text-inkSoft">Piece {index + 1}</Text>
    </View>
  );
});

const ReelAction = memo(function ReelAction({
  label,
  glyph,
  onPress,
  active = false,
  testID,
  hint,
}: {
  label: string;
  glyph: string;
  onPress?: () => void;
  active?: boolean;
  testID?: string;
  hint?: string;
}): React.JSX.Element | null {
  const press = useCallback(() => {
    if (active) void hapticFor.done();
    else void hapticFor.select();
    onPress?.();
  }, [active, onPress]);
  if (!onPress) return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected: active }}
      onPress={press}
      className={`flex-1 items-center rounded-lg border py-sm active:bg-paperDeep ${
        active ? 'border-sage bg-sageWash' : 'border-line bg-card'
      }`}
      style={{ rowGap: 2 }}
    >
      <Text className={`text-[18px] leading-[22px] font-bold ${active ? 'text-terracotta' : 'text-ink'}`} aria-hidden>
        {glyph}
      </Text>
      <Text className={`text-[11px] leading-[14px] font-semibold ${active ? 'text-sageDeep' : 'text-inkSoft'}`}>
        {label}
      </Text>
    </Pressable>
  );
});

/**
 * Full-screen reel card — expo-image cover, top scrim (pose chip + trend
 * chip + quota/cost context), bottom paper sheetlet (garment chips with
 * tiny thumbs, 1–2 line why-line, Wear-it-today primary + Try / Shop /
 * Save / Remix icon-buttons).
 *
 * Double-tap the photo = save + heart burst (single taps are no-ops so the
 * pager owns horizontal gestures). No `expo-linear-gradient` dependency —
 * the "gradient" is two layered scrims, so this ships with zero new native
 * deps. Action buttons render only when their handler is passed (same idiom
 * as OutfitCard: free tier hides Remix by not passing it).
 */
export const ReelCard = memo(function ReelCard({
  card,
  onWear,
  onTry,
  onShop,
  onSave,
  onRegenerate,
  saved,
  garmentThumbs,
  quotaLeft = null,
  quotaCap = null,
  onUpgrade,
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

  const fireBurst = useCallback(() => {
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
  }, [burstOpacity, burstScale]);

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
        className="flex-1 items-center justify-center bg-paper px-xl"
        style={{ rowGap: 8 }}
      >
        <View className="h-[56px] w-[56px] items-center justify-center rounded-full bg-dangerWash" aria-hidden>
          <Text className="text-[24px] text-danger">!</Text>
        </View>
        <Text className="text-center font-display text-[22px] leading-[28px] font-semibold text-ink">
          Couldn&apos;t create this look
        </Text>
        <Text className="text-center text-[15px] leading-[22px] text-inkSoft">{error}</Text>
        {retry ? (
          <View className="mt-sm w-full">
            <Pressable
              testID="reel-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry this look, free of charge"
              accessibilityState={{ busy: retrying }}
              disabled={retrying}
              onPress={() => {
                void hapticFor.select();
                retry();
              }}
              className={`items-center rounded-lg bg-terracotta py-md active:bg-terracottaDeep ${
                retrying ? 'opacity-50' : ''
              }`}
            >
              <Text className="text-[15px] font-bold text-white">{retrying ? 'Retrying…' : 'Retry (free)'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  const poseLabel = REEL_POSE_LABEL[card.pose];
  const hasSecondary = Boolean(onTry ?? onShop ?? onSave ?? onRegenerate);
  const visibleIds = card.garmentIds.slice(0, 4);
  const overflow = card.garmentIds.length - visibleIds.length;
  const qLeft = quotaLeft;
  const qCap = quotaCap;

  return (
    <View
      testID={testID ?? 'reel-card'}
      accessible
      accessibilityLabel={`AI styled look, ${poseLabel}. ${card.whyLine}`}
      className="flex-1 bg-ink"
    >
      {/* cover — double-tap saves */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Look photo"
        accessibilityHint="Double-tap to save this look"
        onPress={handleImagePress}
        className="absolute inset-0"
      >
        <Image
          source={{ uri: card.imageUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          accessibilityLabel={`AI styled ${poseLabel} photo`}
        />
      </Pressable>

      {/* top scrim — two layered fades stand in for a gradient (no new dep) */}
      <View pointerEvents="none" className="absolute left-0 right-0 top-0 h-[148px]" style={{ backgroundColor: 'rgba(14, 11, 8, 0.42)' }} aria-hidden />
      <View pointerEvents="none" className="absolute left-0 right-0 top-[148px] h-[44px]" style={{ backgroundColor: 'rgba(14, 11, 8, 0.12)' }} aria-hidden />

      {/* top chips */}
      <View className="absolute left-0 right-0 top-0 flex-row items-center px-md pb-sm pt-lg" style={{ columnGap: 6 }}>
        <View accessible accessibilityRole="text" accessibilityLabel={`Pose: ${poseLabel}`} className="rounded-pill bg-white/95 px-sm py-[4px]">
          <Text className="text-[12px] leading-[16px] font-bold text-ink">{poseLabel}</Text>
        </View>
        {card.trendTag ? (
          <View accessible accessibilityRole="text" accessibilityLabel={`Trend: ${card.trendTag}`} className="rounded-pill bg-white/95 px-sm py-[4px]">
            <Text className="text-[12px] leading-[16px] font-bold text-gold">✦ {card.trendTag}</Text>
          </View>
        ) : null}
        <View className="flex-1" />
        {qLeft != null && qCap != null ? (
          onUpgrade ? (
            <Pressable
              testID="reel-quota"
              accessibilityRole="button"
              accessibilityLabel={`${qLeft} of ${qCap} renders left. See upgrade options.`}
              accessibilityHint="Opens the Premium paywall"
              onPress={() => {
                void hapticFor.select();
                onUpgrade();
              }}
              className="rounded-pill bg-white/95 px-sm py-[4px] active:opacity-80"
            >
              <Text className="text-[12px] leading-[16px] font-bold text-ink">{`${qLeft} of ${qCap} left`}</Text>
            </Pressable>
          ) : (
            <View accessible accessibilityRole="text" accessibilityLabel={`${qLeft} of ${qCap} renders left`} className="rounded-pill bg-white/95 px-sm py-[4px]">
              <Text className="text-[12px] leading-[16px] font-bold text-ink">{`${qLeft} of ${qCap} left`}</Text>
            </View>
          )
        ) : (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${card.garmentIds.length} pieces, ${money(card.costUsd)}`}
            className="rounded-pill bg-black/55 px-sm py-[4px]"
          >
            <Text className="text-[12px] leading-[16px] font-semibold text-white">
              {money(card.costUsd)} · {card.garmentIds.length} pcs
            </Text>
          </View>
        )}
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
            <Text className="text-[48px] leading-[52px] text-terracotta">♥</Text>
          </View>
        </Animated.View>
      ) : null}

      {/* bottom sheetlet */}
      <View className="absolute bottom-0 left-0 right-0">
        <View className="rounded-t-xl bg-paper px-lg pb-xl pt-sm">
          <View className="mb-sm items-center" aria-hidden>
            <View className="h-[4px] w-[40px] rounded-full bg-line" />
          </View>
          <View className="mb-sm flex-row flex-wrap" style={{ columnGap: 6, rowGap: 6 }}>
            {visibleIds.map((id, i) => (
              <GarmentChip key={id} index={i} thumb={garmentThumbs?.[id]} />
            ))}
            {overflow > 0 ? (
              <View accessible accessibilityLabel={`${overflow} more pieces`} className="rounded-pill bg-paperDeep px-sm py-[6px]">
                <Text className="text-[12px] leading-[16px] font-bold text-inkSoft">+{overflow}</Text>
              </View>
            ) : null}
          </View>
          <Text className="mb-[2px] text-[15px] leading-[22px] text-ink" numberOfLines={2}>
            {card.whyLine}
          </Text>
          <Text testID="reel-disclosure" className="mb-sm text-[12px] leading-[16px] text-muted">
            {REEL_DISCLOSURE}
          </Text>
          {onWear ? (
            <Pressable
              testID="reel-wear"
              accessibilityRole="button"
              accessibilityLabel="Wear this outfit today"
              accessibilityHint="Logs this look as today's outfit"
              onPress={() => {
                void hapticFor.confirm();
                onWear();
              }}
              className="mb-sm items-center rounded-lg bg-terracotta py-md active:bg-terracottaDeep"
            >
              <Text className="text-[16px] leading-[24px] font-bold text-white">Wear it today</Text>
            </Pressable>
          ) : null}
          {hasSecondary ? (
            <View className="flex-row" style={{ columnGap: 8 }}>
              <ReelAction label="Try" glyph="✦" onPress={onTry} testID="reel-try" hint="Preview this look on your photo" />
              <ReelAction label="Shop" glyph="◈" onPress={onShop} testID="reel-shop" hint="Shop similar pieces" />
              <ReelAction
                label={saved ? 'Saved' : 'Save'}
                glyph="♥"
                onPress={onSave ? handleSave : undefined}
                active={saved}
                testID="reel-save"
                hint="Double-tap the photo also saves"
              />
              <ReelAction label="Remix" glyph="↻" onPress={onRegenerate} testID="reel-regenerate" hint="Generate a new variation" />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
});
