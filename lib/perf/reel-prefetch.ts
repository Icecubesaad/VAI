/**
 * VAI perf — reel (vertical snap pager) prefetch engine.
 *
 * Window policy (see PERF-BUDGETS.md §8):
 *  - full-res:  current ± 1  (3 images, ≤ 350 KB each → ~1 MB in flight)
 *  - thumbs:    current ± 2  (5 images, tiny WebP)
 *  - whole-drop prefetch cap: ≤ 3 MB (count-enforced: full-res batch is
 *    bounded by the ±1 window; never prefetch the full 7-card drop at once)
 *
 * Cancellation is COOPERATIVE: expo-image `Image.prefetch(urls, cachePolicy)`
 * exposes no AbortSignal/cancel handle (verified against installed
 * expo-image typings — `Image.d.ts` lists only `prefetch`/`clearMemoryCache`/
 * `clearDiskCache`). So "cancel offscreen prefetch on fast flings" means:
 *  1. `notifyFling(true)` bumps the generation — in-flight batches resolve
 *     but their results are dropped (never reported as prefetched, never
 *     followed by more work), and new full-res issues are suppressed;
 *  2. on momentum end the pager calls `update()` again and the window
 *     rebuilds from the settled index.
 *
 * Offline behavior: prefetch is skipped entirely (the disk cache serves what
 * it has — "cached drop scrolls"); regenerate is disabled client-side via
 * `canRegenerateReelCard()` + `COPY_REEL_OFFLINE_REGENERATE`.
 *
 * Telemetry is sink-injected (`onEvent`) so this module stays importable in
 * tests without PostHog/Sentry. Wire `onEvent` to
 * `analytics.capture('perf_reel_prefetch', props)` in the app shell.
 */
import { Image } from 'expo-image';
import type { ThumbImageProps } from './lists';

// ---------------------------------------------------------------------------
// Budgets (must match PERF-BUDGETS.md §8 — change in both places)
// ---------------------------------------------------------------------------

/** Per-card full-res weight: AVIF/WebP, ≤ 350 KB transfer. */
export const REEL_CARD_MAX_BYTES = 350 * 1024;
/** Whole-drop prefetch cap: never more than 3 MB of prefetch in flight. */
export const REEL_DROP_PREFETCH_MAX_BYTES = 3 * 1024 * 1024;
/** Full-res prefetch radius around the visible index (current ± 1). */
export const REEL_FULL_PREFETCH_RADIUS = 1;
/** Thumb prefetch radius around the visible index (current ± 2). */
export const REEL_THUMB_PREFETCH_RADIUS = 2;
/** Bounded prefetch concurrency so prefetch never starves the visible card. */
export const REEL_PREFETCH_CONCURRENCY = 3;

/** Shown when the user taps regenerate/regenerate-look while offline. */
export const COPY_REEL_OFFLINE_REGENERATE =
  "You're offline — showing your saved drop. Reconnect to generate new looks.";

/** Shown when the visible card has no cached image and the network is down. */
export const COPY_REEL_OFFLINE_UNCACHED =
  "You're offline and this look isn't saved yet. Reconnect to load it.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReelCard {
  /** Stable card id — also the expo-image `recyclingKey`. */
  id: string;
  /** Full-res pager image (AVIF/WebP, ≤ 350 KB). Empty string = not ready. */
  fullResUrl: string;
  /** Low-weight thumb (grid/strip + fling placeholder). */
  thumbUrl: string;
}

export interface ReelPrefetchResult {
  requested: number;
  prefetched: number;
  /** Resolved after a newer generation won (fling) — dropped, not failed. */
  dropped: number;
  failed: string[];
  /** True when prefetch was skipped: offline, disk cache serves the drop. */
  offline: boolean;
}

export interface ReelPrefetchEventProps {
  requested: number;
  prefetched: number;
  dropped: number;
  failed_count: number;
  offline: boolean;
  visible_index: number;
}

export interface ReelPrefetcherDeps {
  /** Connectivity probe (NetInfo in the app shell). Checked per `update()`. */
  isOnline: () => boolean;
  /**
   * Prefetch primitive. Defaults to expo-image disk+memory prefetch.
   * Inject a stub in tests.
   */
  prefetchOne?: (url: string) => Promise<boolean>;
  /** Telemetry sink (PostHog `capture`). Never throws — guarded internally. */
  onEvent?: (event: 'perf_reel_prefetch', props: ReelPrefetchEventProps) => void;
}

// ---------------------------------------------------------------------------
// expo-image props (recycle keys per card id — recycled views never flash)
// ---------------------------------------------------------------------------

/** Pager thumbs / fling placeholders: low priority, memory-disk. */
export function reelThumbProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: `reel-thumb:${id}`,
    priority: 'low',
    contentFit: 'cover',
  };
}

/** Visible full-res card: high priority so it wins decode over prefetch. */
export function reelFullProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: `reel-full:${id}`,
    priority: 'high',
    contentFit: 'cover',
  };
}

/** Regenerate is a server render — disabled while offline (mirror only). */
export function canRegenerateReelCard(isOnline: boolean): boolean {
  return isOnline;
}

// ---------------------------------------------------------------------------
// Window selection (pure — unit-testable without native modules)
// ---------------------------------------------------------------------------

/**
 * Ordered prefetch queue for `visibleIndex`: current full-res first, then
 * ±1 full-res, then ±2 thumbs (dedupe, skip empties, skip the visible
 * full-res already on screen — the view itself loads it at high priority).
 */
export function reelPrefetchQueue(
  cards: readonly ReelCard[],
  visibleIndex: number,
): string[] {
  const queue: string[] = [];
  const push = (url: string): void => {
    if (url.length > 0 && !queue.includes(url)) queue.push(url);
  };
  const at = (i: number): ReelCard | undefined => cards[i];
  const current = at(visibleIndex);
  if (!current) return queue;
  push(current.fullResUrl);
  for (let d = 1; d <= REEL_FULL_PREFETCH_RADIUS; d++) {
    push(at(visibleIndex - d)?.fullResUrl ?? '');
    push(at(visibleIndex + d)?.fullResUrl ?? '');
  }
  for (let d = 0; d <= REEL_THUMB_PREFETCH_RADIUS; d++) {
    push(at(visibleIndex - d)?.thumbUrl ?? '');
    push(at(visibleIndex + d)?.thumbUrl ?? '');
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Prefetcher (generation-guarded, cooperative cancel)
// ---------------------------------------------------------------------------

export class ReelPrefetcher {
  private generation = 0;
  private flinging = false;
  private readonly deps: ReelPrefetcherDeps;

  constructor(deps: ReelPrefetcherDeps) {
    this.deps = deps;
  }

  /**
   * Call on index change + on momentum-scroll-end. While `flinging` only the
   * current full-res is ensured; the window rebuilds on the next `update()`
   * after `notifyFling(false)`.
   */
  update(cards: readonly ReelCard[], visibleIndex: number): void {
    const gen = ++this.generation;
    let queue = reelPrefetchQueue(cards, visibleIndex);
    if (queue.length === 0) return;

    let online = true;
    try {
      online = this.deps.isOnline();
    } catch {
      online = false;
    }
    if (!online) {
      this.emit({ requested: queue.length, prefetched: 0, dropped: 0, failed_count: 0, offline: true, visible_index: visibleIndex });
      return; // cached drop scrolls; nothing issued, nothing to cancel
    }

    if (this.flinging) {
      // Fast fling: cancel offscreen work (bump already invalidated older
      // batches); ensure at most the current card, drop the rest.
      const first = queue[0];
      const dropped = queue.length - (first !== undefined ? 1 : 0);
      queue = first !== undefined ? [first] : [];
      if (queue.length === 0) return;
      void this.run(queue, gen, visibleIndex, queue.length + dropped, dropped);
      return;
    }

    void this.run(queue, gen, visibleIndex, queue.length, 0);
  }

  /** Pager calls with `true` on momentum-begin, `false` on momentum-end. */
  notifyFling(flinging: boolean): void {
    this.flinging = flinging;
    if (flinging) this.cancelOffscreen();
  }

  /** Invalidate all in-flight batches; late resolves are dropped, not applied. */
  cancelOffscreen(): void {
    this.generation++;
  }

  /** For tests: current generation (bump = prior batches are stale). */
  get currentGeneration(): number {
    return this.generation;
  }

  private prefetchOne(url: string): Promise<boolean> {
    if (this.deps.prefetchOne) return this.deps.prefetchOne(url);
    return Image.prefetch(url, 'memory-disk');
  }

  private async run(
    queue: string[],
    gen: number,
    visibleIndex: number,
    requested: number,
    droppedUpfront: number,
  ): Promise<ReelPrefetchResult> {
    const failed: string[] = [];
    let prefetched = 0;
    let dropped = droppedUpfront;
    const concurrency = Math.max(1, REEL_PREFETCH_CONCURRENCY);

    for (let i = 0; i < queue.length; i += concurrency) {
      if (gen !== this.generation) {
        // Superseded (fling / newer index): drop the remainder silently.
        dropped += queue.length - i;
        break;
      }
      const batch = queue.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (url) => {
          try {
            return await this.prefetchOne(url);
          } catch {
            return false;
          }
        }),
      );
      if (gen !== this.generation) {
        dropped += batch.length; // resolved late — do not count as prefetched
        dropped += queue.length - (i + batch.length);
        break;
      }
      for (let b = 0; b < batch.length; b++) {
        const url = batch[b];
        if (url === undefined) continue;
        if (results[b] === true) prefetched++;
        else failed.push(url);
      }
    }

    const result: ReelPrefetchResult = {
      requested,
      prefetched,
      dropped,
      failed,
      offline: false,
    };
    this.emit({
      requested: result.requested,
      prefetched: result.prefetched,
      dropped: result.dropped,
      failed_count: result.failed.length,
      offline: false,
      visible_index: visibleIndex,
    });
    return result;
  }
  private emit(props: ReelPrefetchEventProps): void {
    try {
      this.deps.onEvent?.('perf_reel_prefetch', props);
    } catch {
      /* telemetry must never crash the pager */
    }
  }
}
