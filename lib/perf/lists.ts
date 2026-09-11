/**
 * VAI perf — FlashList configs for 60 fps lists.
 *
 * Rules (measured on Pixel 6a, target JS FPS >= 55 sustained, blank cells < 1%):
 *  - FIXED item heights everywhere (cells are designed to an exact
 *    main-axis size recorded in `FixedLayoutSpec`). FlashList v2
 *    auto-estimates sizes — there is no `estimatedItemSize` prop anymore;
 *    variable heights remain the #1 FlashList jank source.
 *  - `removeClippedSubviews`: TRUE on Android only. On iOS it fights
 *    expo-image's recycling and produces blank-cell flashes.
 *  - `drawDistance`: 1.5-2 viewports of overscan. More = smoother fling,
 *    more memory; values below are the measured sweet spot per list.
 *  - expo-image thumbs: `recyclingKey` = stable item id so recycled views
 *    never flash the previous photo; `cachePolicy: 'memory-disk'`.
 *  - No anonymous closures in renderItem (define row components memoized in
 *    components/, pass ids + a stable handler map from here).
 */
import { Dimensions, Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const CLOSET_GRID_COLUMNS = 3;
export const CLOSET_GRID_GAP = 8;
export const CLOSET_CARD_META_H = 46; // category + colors line under the thumb

export const SHOP_GRID_COLUMNS = 2;
export const SHOP_GRID_GAP = 12;
export const SHOP_CARD_META_H = 92; // title 2-line + price/retailer row + badge

export const PLANNER_ROW_H = 148;
export const TRYON_HISTORY_CELL = 112;

export function screenWidth(): number {
  return Dimensions.get('window').width;
}

/** Square-cell edge for an N-column grid with gaps + screen padding. */
export function gridCellEdge(
  columns: number,
  gap: number,
  screenPadding = 32,
  width = screenWidth(),
): number {
  return Math.floor(
    (width - screenPadding - gap * (columns - 1)) / columns,
  );
}

// ---------------------------------------------------------------------------
// FlashList prop presets (spread into <FlashList>, then add data/renderItem)
// ---------------------------------------------------------------------------

interface BaseListTuning {
  drawDistance: number;
  removeClippedSubviews: boolean;
  onEndReachedThreshold: number;
}

/** Android needs clipping for memory; iOS must NOT clip (expo-image recycling). */
const CLIP_RULE = Platform.OS === 'android';

const BASE_TUNING: BaseListTuning = {
  drawDistance: 600,
  removeClippedSubviews: CLIP_RULE,
  onEndReachedThreshold: 0.5,
};

export interface FixedLayoutSpec {
  /**
   * EXACT item main-axis size — must match the rendered cell.
   * Geometry record only (FlashList v2 takes no `estimatedItemSize` prop);
   * pass it to `overrideGridItemLayout` for span handling.
   */
  estimatedItemSize: number;
  numColumns?: number;
}

/**
 * Closet grid: 3-col photo-first cards. estimatedItemSize is exact
 * (square thumb + fixed meta strip), so overrideItemLayout is safe.
 */
export function closetGridSpec(width = screenWidth()): FixedLayoutSpec {
  const edge = gridCellEdge(CLOSET_GRID_COLUMNS, CLOSET_GRID_GAP, 32, width);
  return {
    estimatedItemSize: edge + CLOSET_CARD_META_H,
    numColumns: CLOSET_GRID_COLUMNS,
  };
}

/** Shop grid: 2-col product cards with fixed meta block. */
export function shopGridSpec(width = screenWidth()): FixedLayoutSpec {
  const edge = gridCellEdge(SHOP_GRID_COLUMNS, SHOP_GRID_GAP, 32, width);
  return {
    estimatedItemSize: Math.round(edge * 1.25) + SHOP_CARD_META_H,
    numColumns: SHOP_GRID_COLUMNS,
  };
}

/** Planner/outfit rows: full-width fixed-height rows. */
export const plannerRowSpec: FixedLayoutSpec = {
  estimatedItemSize: PLANNER_ROW_H,
};

/** Extra tuning per list (spread AFTER the spec). */
export const listTuning: Record<'closet' | 'shop' | 'planner', BaseListTuning> = {
  // Closet is the hottest list: deeper overscan, earlier pagination.
  closet: { ...BASE_TUNING, drawDistance: 800, onEndReachedThreshold: 0.6 },
  shop: { ...BASE_TUNING, drawDistance: 600, onEndReachedThreshold: 0.5 },
  planner: { ...BASE_TUNING, drawDistance: 400, onEndReachedThreshold: 0.4 },
};

// ---------------------------------------------------------------------------
// overrideItemLayout helpers (span overrides only — FlashList v2+)
// ---------------------------------------------------------------------------

export function overrideGridItemLayout(
  _mainAxisSize: number,
  columns: number,
): (
  layout: { span?: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  index: number,
  maxColumns: number,
) => void {
  return (layout, _item, _index, maxColumns) => {
    // FlashList v2 auto-estimates item size (no `size` override, no
    // `estimatedItemSize` prop) — only full-row `span` overrides are honored.
    // `_mainAxisSize` is kept so callers can still pass
    // `FixedLayoutSpec.estimatedItemSize` as the geometry source of truth.
    void _mainAxisSize;
    if (maxColumns !== columns) layout.span = maxColumns;
  };
}

// ---------------------------------------------------------------------------
// Item typing (heterogeneous rows without re-mount storms)
// ---------------------------------------------------------------------------

export type ClosetItemType = 'garment' | 'insights_banner' | 'gap_cta';

export function closetItemType(item: { kind: ClosetItemType }): string {
  return item.kind;
}

// ---------------------------------------------------------------------------
// expo-image thumb props (import type only — components/ spreads these)
// ---------------------------------------------------------------------------

export interface ThumbImageProps {
  cachePolicy: 'memory-disk';
  recyclingKey: string;
  priority: 'low' | 'normal' | 'high';
  contentFit: 'cover';
}

/** Grid thumbs: low priority so the hero/visible image always wins decode. */
export function closetThumbProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: id,
    priority: 'low',
    contentFit: 'cover',
  };
}

/** Above-the-fold images (hero outfit, try-on result): high priority. */
export function heroImageProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: id,
    priority: 'high',
    contentFit: 'cover',
  };
}

// ---------------------------------------------------------------------------
// Keys (stable, never index-based — index keys destroy recycling)
// ---------------------------------------------------------------------------

export function keyById(item: { id: string }): string {
  return item.id;
}

// ---------------------------------------------------------------------------
// Reel pager (vertical snap paging — weekly-drop reel)
// ---------------------------------------------------------------------------

/**
 * Vertical snap-paging config for the reel. Spread into `<FlashList>` with
 * `data` + `renderItem`; `snapToInterval` MUST equal the measured pager
 * height (pass `Dimensions.get('window').height` at call time, not import).
 *
 * Deliberately OMITTED (verified against installed typings):
 *  - `maxToRenderPerBatch` / `windowSize` are FlatList/VirtualizedList-only.
 *    Neither exists in `FlashListProps.d.ts` nor in `ScrollView.d.ts`
 *    (FlashList v2 inherits scroll props from ScrollView) — spreading them
 *    would fail strict TS and do nothing at runtime. The v2 equivalent of
 *    `windowSize=3` (±1 viewport overscan) is `drawDistance` = 1 screen
 *    height below; `maxToRenderPerBatch=1` has no v2 counterpart (the pager
 *    shows exactly 1 full-screen card, so one viewport of overscan already
 *    bounds decode work to current ± 1 — matching reel-prefetch.ts).
 *  - `estimatedItemSize`: FlashList v2 auto-estimates (see header comment).
 *    Item height is exactly `snapToInterval` by construction.
 */
export interface ReelPagerConfig {
  pagingEnabled: boolean;
  snapToInterval: number;
  disableIntervalMomentum: boolean;
  removeClippedSubviews: boolean;
  drawDistance: number;
  onEndReachedThreshold: number;
}

export function reelPagerSpec(screenHeight: number): ReelPagerConfig {
  return {
    pagingEnabled: true,
    snapToInterval: Math.round(screenHeight),
    disableIntervalMomentum: true,
    removeClippedSubviews: CLIP_RULE,
    // ±1 viewport of overscan ≈ windowSize 3, without the removed prop.
    drawDistance: Math.round(screenHeight),
    onEndReachedThreshold: 0.5,
  };
}
