import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Badge } from './Badge';
import { Card } from './Card';

export type OutfitCardProps = {
  imageUrl?: string | null;
  /** Canonical title. Optional when the frontend barrel shape is used —
   * falls back to a planner default (outfitId is shown, never blank). */
  title?: string;
  whyLine?: string | null;
  weatherChip?: string | null;
  eventChip?: string | null;
  onTryOn?: () => void;
  onRestyle?: () => void;
  onSave?: () => void;
  saved?: boolean;
  /** CONTRACT-frontend barrel shape: planner/first-outfit hero. */
  outfitId?: string;
  /** Owned-garment photo URLs; first becomes the hero media. */
  garmentImages?: string[];
  /** Hero showcase — extra garment images render as a thumb strip. */
  hero?: boolean;
  testID?: string;
};

/**
 * Planner hero card — 1 outfit/day. Weather + event chips, "Why this
 * works" line, Try-on / Restyle / Save actions (pack §6).
 * Fixed 4:5 media ratio keeps home + week-strip rows jank-free.
 *
 * Accepts BOTH the canonical shape (`imageUrl/title/chips/handlers`) and the
 * CONTRACT-frontend barrel shape (`outfitId/garmentImages/whyLine/hero`);
 * action buttons render only when their handler is passed.
 */
export const OutfitCard = memo(function OutfitCard({
  imageUrl,
  title,
  whyLine,
  weatherChip,
  eventChip,
  onTryOn,
  onRestyle,
  onSave,
  saved = false,
  outfitId,
  garmentImages,
  hero = false,
  testID,
}: OutfitCardProps): React.JSX.Element {
  const resolvedImage = imageUrl ?? garmentImages?.[0] ?? null;
  const resolvedTitle = title ?? "Today's outfit";
  const extraImages = hero ? (garmentImages ?? []).slice(1, 4) : [];
  return (
    <Card testID={testID} padded={false} accessible accessibilityLabel={`Outfit: ${resolvedTitle}`}>
      <View className="aspect-[4/5] w-full bg-paperDeep">
        {resolvedImage ? (
          <Image
            source={{ uri: resolvedImage }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            accessibilityLabel={`${resolvedTitle} outfit photo`}
          />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <Text className="font-display text-[24px] text-muted">{resolvedTitle}</Text>
          </View>
        )}
      </View>
      <View className="gap-y-sm p-lg">
        <View className="flex-row items-center gap-x-[6px]">
          {weatherChip ? <Badge label={weatherChip} tone="neutral" /> : null}
          {eventChip ? <Badge label={eventChip} tone="terracotta" /> : null}
        </View>
        <Text className="font-display text-[22px] leading-[28px] font-semibold text-ink" numberOfLines={2}>
          {resolvedTitle}
        </Text>
        {outfitId ? (
          <Text className="text-[12px] leading-[16px] text-muted" testID="outfit-id">
            {outfitId}
          </Text>
        ) : null}
        {whyLine ? (
          <Text className="text-[14px] leading-[20px] text-inkSoft" numberOfLines={3}>
            {whyLine}
          </Text>
        ) : null}
        <View className="mt-xs flex-row gap-x-sm">
          {onTryOn ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Try on ${resolvedTitle}`}
              onPress={onTryOn}
              className="flex-1 items-center rounded-lg bg-ink py-md active:opacity-80"
            >
              <Text className="text-[15px] font-bold text-white">Try on</Text>
            </Pressable>
          ) : null}
          {onRestyle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Restyle ${resolvedTitle}`}
              onPress={onRestyle}
              className="flex-1 items-center rounded-lg border border-line bg-card py-md active:bg-paperDeep"
            >
              <Text className="text-[15px] font-semibold text-ink">Restyle</Text>
            </Pressable>
          ) : null}
          {onSave ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={saved ? `Saved ${resolvedTitle}` : `Save ${resolvedTitle}`}
              accessibilityState={{ selected: saved }}
              onPress={onSave}
              className={`items-center justify-center rounded-lg border px-lg active:bg-paperDeep ${
                saved ? 'border-sage bg-sageWash' : 'border-line bg-card'
              }`}
            >
              <Text className={`text-[15px] font-semibold ${saved ? 'text-sageDeep' : 'text-ink'}`}>
                {saved ? '✓ Saved' : 'Save'}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {extraImages.length > 0 ? (
          <View className="mt-sm flex-row gap-x-sm" testID="outfit-thumbs">
            {extraImages.map((uri) => (
              <View key={uri} className="h-[56px] w-[56px] overflow-hidden rounded-md bg-paperDeep">
                <Image
                  source={{ uri }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={150}
                  accessibilityLabel="Outfit garment thumbnail"
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Card>
  );
});
