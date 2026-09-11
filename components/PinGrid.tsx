import React, { memo, useCallback, useRef } from 'react';
import { FlatList, Pressable, Text, View, type ViewToken } from 'react-native';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { EmptyState } from './EmptyState';
import { ErrorView } from './ErrorView';
import { SkeletonGrid } from './Skeleton';

export type PinItem = {
  id: string;
  thumbUrl: string;
  /** Full-res URL prefetched when the cell nears the viewport. */
  fullUrl?: string | null;
  title?: string | null;
  /** Pose-marked pins show the stance glyph badge. */
  poseMarked?: boolean;
  stanceLabel?: string | null;
};

export type PinGridProps = {
  pins: PinItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  onEmptyAction?: () => void;
  emptyActionTitle?: string;
  scrollEnabled?: boolean;
  testID?: string;
};

type CellProps = {
  item: PinItem;
  selected: boolean;
  onSelect: ((id: string) => void) | undefined;
};

/** Memo 3-col pin cell — expo-image thumb, pose badge, selected ring + check. */
const PinCell = memo(function PinCell({ item, selected, onSelect }: CellProps): React.JSX.Element {
  const label = `${item.title ?? 'Pinterest pin'}${item.poseMarked ? ', pose marked' : ''}${selected ? ', selected' : ''}`;
  return (
    <Pressable
      testID={`pin-cell-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={
        onSelect
          ? () => {
              void hapticFor.select();
              onSelect(item.id);
            }
          : undefined
      }
      className={`flex-1 overflow-hidden rounded-lg border-2 bg-paperDeep active:opacity-90 ${
        selected ? 'border-terracotta' : 'border-transparent'
      }`}
    >
      <View className="aspect-[3/4] w-full">
        <Image
          source={{ uri: item.thumbUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          accessibilityLabel={item.title ?? 'Pinterest pin photo'}
        />
      </View>
      {item.poseMarked ? (
        <View
          accessible
          accessibilityLabel={item.stanceLabel ? `Pose marked, ${item.stanceLabel}` : 'Pose marked'}
          className="absolute bottom-sm left-sm max-w-[85%] flex-row items-center rounded-pill bg-black/55 px-sm py-[3px]"
          style={{ columnGap: 4 }}
        >
          <Text className="text-[11px] leading-[14px] font-bold text-white" aria-hidden>
            ◐
          </Text>
          <Text className="flex-shrink text-[11px] leading-[14px] font-semibold text-white" numberOfLines={1}>
            {item.stanceLabel ?? 'Pose'}
          </Text>
        </View>
      ) : null}
      {selected ? (
        <View
          aria-hidden
          className="absolute right-sm top-sm h-[24px] w-[24px] items-center justify-center rounded-full bg-terracotta"
        >
          <Text className="text-[13px] leading-[16px] font-bold text-white">✓</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

/**
 * 3-column Pinterest pin picker grid. Cells are memoized with fixed 3:4
 * ratio (stable rows, no per-item measure); full-res URLs are prefetched
 * as cells near the viewport. Loading reuses the closet shimmer geometry;
 * empty/error reuse the kit surfaces so the picker never dead-ends.
 */
export const PinGrid = memo(function PinGrid({
  pins,
  selectedId,
  onSelect,
  loading = false,
  error,
  onRetry,
  retrying = false,
  onEmptyAction,
  emptyActionTitle,
  scrollEnabled = true,
  testID,
}: PinGridProps): React.JSX.Element {
  const seen = useRef<Set<string>>(new Set());

  const handleViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    for (const v of viewableItems) {
      const item = v.item as PinItem | undefined;
      const full = item?.fullUrl;
      if (item && full && !seen.current.has(item.id)) {
        seen.current.add(item.id);
        void Image.prefetch(full).catch(() => undefined);
      }
    }
  }, []);

  if (loading) return <SkeletonGrid />;

  if (error) {
    if (onRetry) return <ErrorView message={error} onRetry={onRetry} retrying={retrying} testID={testID} />;
    return (
      <View
        testID={testID}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={error}
        className="items-center rounded-xl border border-line bg-card px-xl py-2xl"
      >
        <Text className="text-center text-[15px] leading-[22px] text-inkSoft">{error}</Text>
      </View>
    );
  }

  if (pins.length === 0) {
    return (
      <EmptyState
        testID={testID}
        title="No pins here yet"
        body="Connect a board with outfit pins and they'll show up here for styling."
        actionTitle={onEmptyAction ? (emptyActionTitle ?? 'Choose a board') : undefined}
        onAction={onEmptyAction}
      />
    );
  }

  return (
    <FlatList
      testID={testID}
      data={pins}
      keyExtractor={(p) => p.id}
      numColumns={3}
      scrollEnabled={scrollEnabled}
      columnWrapperStyle={{ gap: 8 }}
      contentContainerStyle={{ gap: 8 }}
      initialNumToRender={12}
      removeClippedSubviews
      viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
      onViewableItemsChanged={handleViewable}
      renderItem={({ item }) => (
        <PinCell item={item} selected={item.id === selectedId} onSelect={onSelect} />
      )}
    />
  );
});
