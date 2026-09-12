import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Badge } from './Badge';

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
  onDelete,
  testID,
}: GarmentCardProps): React.JSX.Element {
  const cpw = money(garment.costPerWear);
  const photo = garment.cutoutUrl ?? garment.imageUrl;
  const label = `${garment.category}${garment.colors?.length ? `, ${garment.colors.join(', ')}` : ''}${
    garment.wearCount ? `, worn ${garment.wearCount} times` : ''
  }`;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress ? () => onPress(garment.id) : undefined}
      className={`overflow-hidden rounded-lg border bg-card active:opacity-90 ${
        selected ? 'border-terracotta' : 'border-lineOnCard'
      }`}
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
      {onDelete ? (
        <Pressable
          testID={testID ? `${testID}-delete` : 'garment-delete'}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${garment.category}`}
          onPress={onDelete}
          className="absolute right-sm top-sm items-center justify-center rounded-pill bg-black/55 px-sm py-[4px] active:opacity-70"
        >
          <Text className="text-[12px] leading-[16px] font-bold text-white" aria-hidden>
            ✕
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
});
