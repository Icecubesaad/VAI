import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Badge } from './Badge';
import { PressScale } from './PressScale';

export type Garment = {
  id: string;
  imageUrl?: string | null;
  /** Background-removed cutout, preferred over imageUrl when present. */
  cutoutUrl?: string | null;
  category: string;
  colors?: string[];
  fabric?: string | null;
  formality?: number | null;
  seasons?: string[];
  wearCount?: number;
  pricePaid?: number | null;
  costPerWear?: number | null;
};

export type GarmentCardProps = {
  garment: Garment;
  onPress?: (id: string) => void;
  selected?: boolean;
  disabled?: boolean;
  /** CONTRACT-frontend closet shape: renders a ✕ affordance calling back. */
  onDelete?: () => void;
  testID?: string;
};

function money(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

/**
 * Closet grid cell — fixed 3:4 ratio so FlashList rows are stable.
 * Card = photo / category / colors / fabric / formality / season /
 * wear-count + cost-per-wear (pack §6).
 */
export const GarmentCard = memo(function GarmentCard({
  garment,
  onPress,
  selected = false,
  disabled = false,
  onDelete,
  testID,
}: GarmentCardProps): React.JSX.Element {
  const cpw = money(garment.costPerWear);
  const photo = garment.cutoutUrl ?? garment.imageUrl;
  const label = `${garment.category}${garment.colors?.length ? `, ${garment.colors.join(', ')}` : ''}${
    garment.wearCount ? `, worn ${garment.wearCount} times` : ''
  }`;

  // Delete is a SIBLING of the card pressable (was nested inside → invalid
  // <button>-in-<button> DOM on web + React warnings).
  return (
    <View className="relative">
    <PressScale
      testID={testID ?? 'garment-card'}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress ? () => onPress(garment.id) : undefined}
      className={`overflow-hidden rounded-lg border bg-card active:opacity-90 ${
        selected ? 'border-terracotta' : 'border-lineOnCard'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <View className="aspect-[3/4] w-full bg-paperDeep">
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={150}
            accessibilityLabel={`${garment.category} photo`}
          />
        ) : (
          <View className="h-full w-full items-center justify-center" accessible accessibilityLabel="No photo yet">
            <Text className="font-display text-[20px] capitalize text-muted">{garment.category}</Text>
          </View>
        )}
      </View>
      <View className="gap-y-[2px] p-sm">
        <Text className="text-[14px] leading-[20px] font-semibold text-ink capitalize" numberOfLines={1}>
          {garment.category}
        </Text>
        <Text className="text-[12px] leading-[16px] text-inkSoft" numberOfLines={1}>
          {[garment.colors?.slice(0, 2).join(', '), garment.fabric].filter(Boolean).join(', ') || 'Still tagging'}
        </Text>
        <View className="mt-[2px] flex-row items-center gap-x-[4px]">
          {typeof garment.wearCount === 'number' && garment.wearCount > 0 ? (
            <Badge label={`×${garment.wearCount}`} tone="neutral" />
          ) : null}
          {cpw ? <Badge label={`${cpw}/wear`} tone="sage" /> : null}
        </View>
      </View>
    </PressScale>
    {onDelete ? (
      <PressScale
        testID={testID ? `${testID}-delete` : 'garment-delete'}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${garment.category}`}
        accessibilityHint="Removes this item from your closet"
        hitSlop={12}
        onPress={onDelete}
        className="absolute right-sm top-sm items-center justify-center rounded-pill bg-black/55 px-sm py-[4px] active:opacity-70"
      >
        <Text className="text-[12px] leading-[16px] font-bold text-white" aria-hidden>
          ✕
        </Text>
      </PressScale>
    ) : null}
    </View>
  );
});
