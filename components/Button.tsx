import React, { memo } from 'react';
import { StyleSheet, Text, ActivityIndicator, View, type PressableProps } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { hapticFor } from '../lib/haptics';
import { MOTION } from '../lib/motion';
import { PressScale } from './PressScale';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'premium' | 'danger' | 'dev';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  /** Haptic on press. Defaults: confirm for primary/premium, select otherwise. */
  haptic?: 'confirm' | 'select' | 'none';
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
} & Pick<PressableProps, 'accessibilityRole'>;

const SIZES: Record<ButtonSize, { container: string; text: string }> = {
  sm: { container: 'px-md py-[8px] rounded-pill', text: 'text-[14px] leading-[20px] font-semibold' },
  md: { container: 'px-xl py-[14px] rounded-pill', text: 'text-[16px] leading-[24px] font-semibold' },
  lg: { container: 'px-xl py-[16px] rounded-pill', text: 'text-[17px] leading-[24px] font-bold' },
};

/**
 * VAI Button. Glossed violet primary (gradient + top-edge sheen, so the CTA
 * has weight instead of reading as a flat pastel slab), ink-on-paper
 * secondary, quiet ghost.
 * `premium` = Apple-pay-style black pill (see PremiumCTA for the full
 *  logo lockup used on paywall / quota-upsell surfaces).
 * `dev` = dashed dev-login style for onboarding debug entry points only —
 * never ship it on production paths; it is deliberately unconfusable with
 * primary/premium.
 */
export const Button = memo(function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  haptic = variant === 'primary' || variant === 'premium' ? 'confirm' : 'select',
  testID,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
}: ButtonProps): React.JSX.Element {
  const s = SIZES[size];
  const isDisabled = disabled || loading;

  const variantCls: Record<ButtonVariant, string> = {
    primary: '',
    secondary: 'bg-card border border-line active:bg-paperDeep',
    ghost: 'bg-transparent active:bg-paperDeep',
    premium: 'bg-appleBlack active:opacity-80',
    danger: 'bg-danger active:opacity-80',
    dev: 'bg-paperDeep border border-dashed border-line active:bg-line',
  };
  const textCls: Record<ButtonVariant, string> = {
    primary: 'text-white',
    secondary: 'text-ink',
    ghost: 'text-terracotta',
    premium: 'text-white',
    danger: 'text-white',
    dev: 'text-inkSoft',
  };

  const label = (
    <View className="items-center justify-center">
      <Text className={`${s.text} ${textCls[variant]} ${loading ? 'opacity-0' : ''}`}>{title}</Text>
      {loading ? (
        <View className="absolute inset-0 items-center justify-center">
          <ActivityIndicator size="small" color={variant === 'secondary' || variant === 'ghost' || variant === 'dev' ? '#1D141C' : '#FFFFFF'} />
        </View>
      ) : null}
    </View>
  );

  return (
    <PressScale
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      hitSlop={12}
      onPress={() => {
        if (haptic === 'confirm') void hapticFor.confirm();
        else if (haptic === 'select') void hapticFor.select();
        onPress();
      }}
      className={`${s.container} ${variantCls[variant]} items-center justify-center overflow-hidden ${
        isDisabled ? 'opacity-50' : ''
      }`}
      style={variant === 'primary' ? styles.primaryDepth : undefined}
    >
      {variant === 'primary' ? (
        <>
          {/* Gloss: deep-base violet gradient + a hairline sheen at the top
              edge — the button reads lacquered, not flat. */}
          <LinearGradient
            colors={['#3A2331', '#000000']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.primarySheen} pointerEvents="none" />
          {label}
        </>
      ) : (
        label
      )}
    </PressScale>
  );
});

const styles = StyleSheet.create({
  primaryDepth: {
    shadowColor: '#000000',
    shadowOpacity: 0.38,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  primarySheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
});

export type PremiumCTAProps = {
  title: string;
  subtitle?: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};

/**
 * PremiumCTA — Apple-pay-style premium checkout button: full-width black
 * pill,  logo mark, title + optional price subtitle. Reserved for
 * paywall purchase, quota-upsell, and trial-start surfaces so the gesture
 * always feels identical at the moment money is involved.
 */
export const PremiumCTA = memo(function PremiumCTA({
  title,
  subtitle,
  onPress,
  loading = false,
  disabled = false,
  testID,
  accessibilityLabel,
}: PremiumCTAProps): React.JSX.Element {
  const isDisabled = disabled || loading;
  return (
    <PressScale
      scaleTo={MOTION.pressScaleSubtle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${title}${subtitle ? `, ${subtitle}` : ''}`}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      hitSlop={12}
      onPress={() => {
        void hapticFor.confirm();
        onPress();
      }}
      className={`w-full flex-row items-center justify-center gap-x-sm rounded-pill bg-appleBlack px-xl py-[16px] active:opacity-80 ${
        isDisabled ? 'opacity-50' : ''
      }`}
      style={{ elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } }}
    >
      {/* VAI monogram — text-drawn so no font asset is required */}
      <Text className="text-[11px] font-bold uppercase text-white/70" style={{ letterSpacing: 1.5 }} aria-hidden>
        VAI
      </Text>
      {/* Loading keeps the title measured (invisible) with the spinner
          overlaid absolute — no width/height shift at the money moment. */}
      <View className="items-center justify-center">
        <Text className={`text-[17px] leading-[24px] font-bold text-white ${loading ? 'opacity-0' : ''}`}>
          {title}
          {subtitle ? <Text className="font-medium text-white/80"> · {subtitle}</Text> : null}
        </Text>
        {loading ? (
          <View className="absolute inset-0 items-center justify-center">
            <ActivityIndicator size="small" color="#FFFFFF" />
          </View>
        ) : null}
      </View>
    </PressScale>
  );
});
