import React, { memo } from 'react';
import { Pressable, Text, ActivityIndicator, type PressableProps } from 'react-native';
import { hapticFor } from '../lib/haptics';

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
  sm: { container: 'px-md py-[6px] rounded-md', text: 'text-[14px] leading-[20px] font-semibold' },
  md: { container: 'px-lg py-md rounded-lg', text: 'text-[16px] leading-[24px] font-semibold' },
  lg: { container: 'px-xl py-[14px] rounded-xl', text: 'text-[17px] leading-[24px] font-bold' },
};

/**
 * VAI Button. Terracotta primary, ink-on-paper secondary, quiet ghost.
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
    primary: 'bg-terracotta active:bg-terracottaDeep',
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

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={() => {
        if (haptic === 'confirm') void hapticFor.confirm();
        else if (haptic === 'select') void hapticFor.select();
        onPress();
      }}
      className={`${s.container} ${variantCls[variant]} items-center justify-center ${
        isDisabled ? 'opacity-50' : ''
      }`}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variant === 'secondary' || variant === 'ghost' || variant === 'dev' ? '#1A1A1A' : '#FFFFFF'} />
      ) : (
        <Text className={`${s.text} ${textCls[variant]}`}>{title}</Text>
      )}
    </Pressable>
  );
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
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${title}${subtitle ? `, ${subtitle}` : ''}`}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
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
      {loading ? (
        <ActivityIndicator size="small" color="#FFFFFF" />
      ) : (
        <Text className="text-[17px] leading-[24px] font-bold text-white">
          {title}
          {subtitle ? <Text className="font-medium text-white/80"> · {subtitle}</Text> : null}
        </Text>
      )}
    </Pressable>
  );
});
