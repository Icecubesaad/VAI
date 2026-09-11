/**
 * VAI perf — Pinterest taste-graph image pipeline + sync guardrails.
 *
 * What this module owns (perf turf):
 *  - pin image variants: 236px thumbs (grids) vs 736px fulls (pose-ref/detail),
 *    derived client-side from the pin `image_url` by rewriting the Pinterest
 *    CDN width token. Unknown CDN shapes pass through untouched — never break
 *    an image to save bytes.
 *  - expo-image `memory-disk` caching everywhere + `recyclingKey` per pin id.
 *  - grid prefetch windows (current ±6 thumbs) with the same
 *    generation-guarded cooperative-cancel engine as reel-prefetch.ts
 *    (expo-image exposes no cancel handle — in-flight resolves are dropped,
 *    never applied).
 *  - pose-ref preload: full-res (736px) warm into disk cache BEFORE the render
 *    call so the pose-adapt submit never stalls on a cold CDN fetch.
 *  - MMKV mirrors for boards + per-board pin lists (stale-while-revalidate;
 *    server is source of truth) + purge on Pinterest disconnect.
 *
 * What this module does NOT own (backend/integrations turf):
 *  - listing/pagination executes server-side (edge fn, newest-first). This
 *    module owns the CLIENT pacing hints only: nightly/manual-only gate,
 *    chunk shape, newest-first cap, 429 backoff math.
 *  - quota granting (quotas.ts mirror; pose-adapt spends the standard std
 *    pool — no new quota class, see PERF-BUDGETS.md §10).
 *  - share-back execution (integrations turf; $0 render-cost, see §10).
 *
 * Budgets (must match PERF-BUDGETS.md §10 — change in both places):
 *  - thumb (236px) ≤ 60 KB · full (736px) ≤ 300 KB transfer.
 *  - board-picker TTI < 1.5 s from cache (`perf_pin_tti{from_cache:true}`).
 *  - grid prefetch ≤ ~780 KB in flight (count-enforced: ±6 thumbs).
 *  - pose-ref preload ≤ 3 fulls (~900 KB max) before the render call.
 *  - sync: nightly/manual-only, chunked, capped at 100 newest-first pins per
 *    board per sync, 429 backoff with Retry-After honor.
 *
 * Telemetry is sink-injected (`onEvent`) so this module stays importable in
 * tests without PostHog/Sentry. Wire `onEvent` to
 * `analytics.capture('perf_pin_prefetch', props)` in the app shell.
 */
import { Image } from 'expo-image';
import { mmkv, TTLCache, type CacheRead } from './cache';
import type { ThumbImageProps } from './lists';

// ---------------------------------------------------------------------------
// Budgets (must match PERF-BUDGETS.md §10 — change in both places)
// ---------------------------------------------------------------------------

/** Grid thumb width: Pinterest 236px rendition. */
export const PIN_THUMB_WIDTH_PX = 236;
/** Detail / pose-ref width: Pinterest 736px rendition. */
export const PIN_FULL_WIDTH_PX = 736;
/** Per-thumb transfer weight: 236px rendition, ≤ 60 KB. */
export const PIN_THUMB_MAX_BYTES = 60 * 1024;
/** Per-full transfer weight: 736px rendition, ≤ 300 KB. */
export const PIN_FULL_MAX_BYTES = 300 * 1024;
/** Grid prefetch radius around the visible index (current ±6 thumbs). */
export const PIN_GRID_PREFETCH_RADIUS = 6;
/** Bounded prefetch concurrency so prefetch never starves the visible cell. */
export const PIN_PREFETCH_CONCURRENCY = 3;
/** Pose-ref preload concurrency (small N, high priority on decode). */
export const PIN_POSE_PRELOAD_CONCURRENCY = 2;
/** Pose-adapt takes at most 3 pose refs per render (normally 1). */
export const MAX_POSE_REFS_PER_RENDER = 3;
/** Board-picker time-to-interactive from cache. */
export const PIN_BOARD_TTI_BUDGET_MS = 1500;

// ---------------------------------------------------------------------------
// Sync guardrails (client hints — server enforces; see PERF-BUDGETS.md §10)
// ---------------------------------------------------------------------------

/**
 * Max pins pulled per board per sync, newest-first. The Pinterest list call
 * returns newest first; the client keeps the head and drops the tail so a
 * 2000-pin inspo board can neither blow the Trial 1000 req/day budget nor
 * the MMKV mirror.
 */
export const MAX_PINS_PER_BOARD_PER_SYNC = 100;
/** Board-sync chunk size: one page-ish of pins processed/persisted at a time. */
export const PIN_SYNC_CHUNK_SIZE = 25;
/**
 * Minimum gap between AUTOMATIC syncs (nightly job). Manual pulls bypass the
 * interval but still respect offline + foreground-critical + 429 gates.
 */
export const PIN_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** 429 backoff base: exponential 1s → 30s cap + jitter (see below). */
export const PIN_SYNC_429_BASE_DELAY_MS = 1000;
/** 429 backoff cap: never sleep longer than this between retries. */
export const PIN_SYNC_429_MAX_DELAY_MS = 30_000;
/** Give up a sync run after this many 429s; surface "try again later". */
export const PIN_SYNC_MAX_429_ATTEMPTS = 5;

/** Shown when the user taps Sync (or opens boards) while offline. */
export const COPY_PIN_OFFLINE_SYNC =
  'You’re offline — showing saved boards. Reconnect to sync Pinterest.';
/** Shown when a board has no cached pins and the network is down. */
export const COPY_PIN_OFFLINE_UNCACHED =
  'You’re offline and this board isn’t saved yet. Reconnect to load it.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PinBoard {
  id: string;
  name: string;
  pinCount: number;
  coverImageUrl: string;
}

export interface PinItem {
  id: string;
  boardId: string;
  /** Canonical pin image URL as returned by the API (any CDN width). */
  imageUrl: string;
}

export interface PinBoardSnapshot {
  boards: PinBoard[];
  fetchedAt: number;
}

export interface PinListSnapshot {
  boardId: string;
  /** Newest-first (API order), already capped at MAX_PINS_PER_BOARD_PER_SYNC. */
  pins: PinItem[];
  cursor: string | null;
  fetchedAt: number;
}

export interface PinPrefetchResult {
  requested: number;
  prefetched: number;
  /** Resolved after a newer generation won (fling) — dropped, not failed. */
  dropped: number;
  failed: string[];
  /** True when prefetch was skipped: offline, disk cache serves the boards. */
  offline: boolean;
}

export type PinPrefetchSurface = 'grid' | 'pose-ref';

export interface PinPrefetchEventProps {
  requested: number;
  prefetched: number;
  dropped: number;
  failed_count: number;
  offline: boolean;
  /** List position for grids; -1 for non-list pose-ref preloads. */
  visible_index: number;
  surface: PinPrefetchSurface;
}

export interface PinPrefetcherDeps {
  /** Connectivity probe (NetInfo in the app shell). Checked per `update()`. */
  isOnline: () => boolean;
  /**
   * Prefetch primitive. Defaults to expo-image disk+memory prefetch.
   * Inject a stub in tests.
   */
  prefetchOne?: (url: string) => Promise<boolean>;
  /** Telemetry sink (PostHog `capture`). Never throws — guarded internally. */
  onEvent?: (event: 'perf_pin_prefetch', props: PinPrefetchEventProps) => void;
}

export interface PosePreloadDeps {
  /** Connectivity probe (NetInfo in the app shell). */
  isOnline: () => boolean;
  /** Prefetch primitive. Defaults to expo-image disk+memory prefetch. */
  prefetchOne?: (url: string) => Promise<boolean>;
  /** Telemetry sink (PostHog `capture`). Never throws — guarded internally. */
  onEvent?: (event: 'perf_pin_prefetch', props: PinPrefetchEventProps) => void;
  /** Bounded concurrency (default PIN_POSE_PRELOAD_CONCURRENCY). */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// URL variants (pure — unit-testable without native modules)
// ---------------------------------------------------------------------------

/**
 * Pinterest CDN width tokens seen in the wild: 236x / 474x / 564x / 736x /
 * 1200x renditions plus `originals`. Rewrites the token to the requested
 * rendition; URLs without a recognized token (unknown CDN shape, proxy URLs)
 * are returned UNTOUCHED — a full-weight image beats a broken one.
 */
const PIN_WIDTH_TOKEN_RE = /\/(236x|474x|564x|736x|1200x|originals)(\/|$)/;

export function pinImageVariant(imageUrl: string, variant: 'thumb' | 'full'): string {
  if (imageUrl.length === 0) return imageUrl;
  const token = variant === 'thumb' ? `${PIN_THUMB_WIDTH_PX}x` : `${PIN_FULL_WIDTH_PX}x`;
  if (!PIN_WIDTH_TOKEN_RE.test(imageUrl)) return imageUrl;
  return imageUrl.replace(PIN_WIDTH_TOKEN_RE, `/${token}$2`);
}

/** Grid rendition (236px, ≤ 60 KB budget). */
export function pinThumbUrl(imageUrl: string): string {
  return pinImageVariant(imageUrl, 'thumb');
}

/** Detail / pose-ref rendition (736px, ≤ 300 KB budget). */
export function pinFullUrl(imageUrl: string): string {
  return pinImageVariant(imageUrl, 'full');
}

// ---------------------------------------------------------------------------
// expo-image props (recycle keys per pin id — recycled views never flash)
// ---------------------------------------------------------------------------

/** Grid thumbs: low priority, memory-disk. */
export function pinThumbProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: `pin-thumb:${id}`,
    priority: 'low',
    contentFit: 'cover',
  };
}

/** Detail / pose-ref full: high priority so it wins decode over prefetch. */
export function pinFullProps(id: string): ThumbImageProps {
  return {
    cachePolicy: 'memory-disk',
    recyclingKey: `pin-full:${id}`,
    priority: 'high',
    contentFit: 'cover',
  };
}

/** Sync is a network write/read — disabled while offline (mirror only). */
export function canSyncPins(isOnline: boolean): boolean {
  return isOnline;
}

// ---------------------------------------------------------------------------
// Grid window selection (pure — unit-testable without native modules)
// ---------------------------------------------------------------------------

/**
 * Ordered thumb-URL queue for `visibleIndex`: current thumb first, then ±1 …
 * ±6 (dedupe, skip empties). The visible cell itself loads at normal priority
 * via the view; prefetch warms the fling path at low priority.
 */
export function pinGridPrefetchQueue(
  pins: readonly PinItem[],
  visibleIndex: number,
): string[] {
  const queue: string[] = [];
  const push = (url: string): void => {
    if (url.length > 0 && !queue.includes(url)) queue.push(url);
  };
  const at = (i: number): PinItem | undefined => pins[i];
  const current = at(visibleIndex);
  if (!current) return queue;
  push(pinThumbUrl(current.imageUrl));
  for (let d = 1; d <= PIN_GRID_PREFETCH_RADIUS; d++) {
    const prev = at(visibleIndex - d);
    const next = at(visibleIndex + d);
    push(prev ? pinThumbUrl(prev.imageUrl) : '');
    push(next ? pinThumbUrl(next.imageUrl) : '');
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Grid prefetcher (generation-guarded, cooperative cancel — see reel-prefetch)
// ---------------------------------------------------------------------------

export class PinPrefetcher {
  private generation = 0;
  private flinging = false;
  private readonly deps: PinPrefetcherDeps;

  constructor(deps: PinPrefetcherDeps) {
    this.deps = deps;
  }

  /**
   * Call on index change + on momentum-scroll-end. While `flinging` only the
   * current thumb is ensured; the window rebuilds on the next `update()`
   * after `notifyFling(false)`.
   */
  update(pins: readonly PinItem[], visibleIndex: number): void {
    const gen = ++this.generation;
    let queue = pinGridPrefetchQueue(pins, visibleIndex);
    if (queue.length === 0) return;

    let online = true;
    try {
      online = this.deps.isOnline();
    } catch {
      online = false;
    }
    if (!online) {
      this.emit({
        requested: queue.length,
        prefetched: 0,
        dropped: 0,
        failed_count: 0,
        offline: true,
        visible_index: visibleIndex,
        surface: 'grid',
      });
      return; // cached boards browse; nothing issued, nothing to cancel
    }

    if (this.flinging) {
      // Fast fling: cancel offscreen work; ensure at most the current thumb.
      const first = queue[0];
      const dropped = queue.length - (first !== undefined ? 1 : 0);
      queue = first !== undefined ? [first] : [];
      if (queue.length === 0) return;
      void this.run(queue, gen, visibleIndex, queue.length + dropped, dropped);
      return;
    }

    void this.run(queue, gen, visibleIndex, queue.length, 0);
  }

  /** Grid calls with `true` on momentum-begin, `false` on momentum-end. */
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
  ): Promise<PinPrefetchResult> {
    const failed: string[] = [];
    let prefetched = 0;
    let dropped = droppedUpfront;
    const concurrency = Math.max(1, PIN_PREFETCH_CONCURRENCY);

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

    const result: PinPrefetchResult = {
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
      surface: 'grid',
    });
    return result;
  }

  private emit(props: PinPrefetchEventProps): void {
    try {
      this.deps.onEvent?.('perf_pin_prefetch', props);
    } catch {
      /* telemetry must never crash the grid */
    }
  }
}

// ---------------------------------------------------------------------------
// Pose-ref preload (one-shot warm of 736px fulls BEFORE the render call)
// ---------------------------------------------------------------------------

function emitPinPrefetch(
  onEvent: PosePreloadDeps['onEvent'],
  props: PinPrefetchEventProps,
): void {
  try {
    onEvent?.('perf_pin_prefetch', props);
  } catch {
    /* telemetry must never block a render */
  }
}

/**
 * Warm pose-reference fulls into the disk cache immediately before the
 * pose-adapt render submit. Bounded to MAX_POSE_REFS_PER_RENDER fulls at
 * PIN_POSE_PRELOAD_CONCURRENCY — a ~900 KB worst case that never starves the
 * submit itself. NEVER throws: failures are reported in `failed` and the
 * caller proceeds (the server fetches the canonical pin URL itself; this
 * warm is latency-hiding for the client preview + instant board-detail paint
 * after the render settles). Offline resolves `{ offline: true }` and the
 * caller hard-fails the render with airplane-mode copy (renders NEVER queue).
 */
export async function preloadPoseRefs(
  fullUrls: readonly string[],
  deps: PosePreloadDeps,
): Promise<PinPrefetchResult> {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of fullUrls) {
    if (url.length > 0 && !seen.has(url)) {
      seen.add(url);
      deduped.push(url);
    }
  }
  const bounded = deduped.slice(0, MAX_POSE_REFS_PER_RENDER);
  const requested = bounded.length;

  let online = true;
  try {
    online = deps.isOnline();
  } catch {
    online = false;
  }
  if (!online) {
    emitPinPrefetch(deps.onEvent, {
      requested,
      prefetched: 0,
      dropped: 0,
      failed_count: 0,
      offline: true,
      visible_index: -1,
      surface: 'pose-ref',
    });
    return { requested, prefetched: 0, dropped: 0, failed: [], offline: true };
  }

  const prefetchOne =
    deps.prefetchOne ?? ((url: string) => Image.prefetch(url, 'memory-disk'));
  const failed: string[] = [];
  let prefetched = 0;
  const concurrency = Math.max(1, deps.concurrency ?? PIN_POSE_PRELOAD_CONCURRENCY);
  for (let i = 0; i < bounded.length; i += concurrency) {
    const batch = bounded.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          return await prefetchOne(url);
        } catch {
          return false;
        }
      }),
    );
    for (let b = 0; b < batch.length; b++) {
      const url = batch[b];
      if (url === undefined) continue;
      if (results[b] === true) prefetched++;
      else failed.push(url);
    }
  }

  emitPinPrefetch(deps.onEvent, {
    requested,
    prefetched,
    dropped: 0,
    failed_count: failed.length,
    offline: false,
    visible_index: -1,
    surface: 'pose-ref',
  });
  return { requested, prefetched, dropped: 0, failed, offline: false };
}

// ---------------------------------------------------------------------------
// Sync gate: nightly/manual-only, never the foreground critical path
// ---------------------------------------------------------------------------

export type PinSyncBlockReason =
  | 'offline'
  | 'foreground_critical'
  | 'too_soon'
  | 'rate_limited';

export interface PinSyncRequest {
  /** NetInfo probe result. Offline → blocked (cached boards browse). */
  isOnline: boolean;
  /**
   * True while cold start, Generate submit, or checkout is in flight. Sync is
   * NEVER allowed on the foreground critical path — it waits.
   */
  isForegroundCritical: boolean;
  /** Last successful sync epoch ms (null = never synced → allowed). */
  lastSyncedAtMs: number | null;
  /** Defaults to Date.now(). Injected in tests. */
  nowMs?: number;
  /** Manual pulls bypass the nightly interval — nothing else. */
  isManual?: boolean;
  /** Server 429 Retry-After epoch ms. now < retryAfter → rate_limited. */
  retryAfterMs?: number | null;
}

export interface PinSyncGate {
  allowed: boolean;
  reason: PinSyncBlockReason | null;
}

export const PIN_SYNC_BLOCK_COPY: Record<
  PinSyncBlockReason,
  { title: string; body: string }
> = {
  offline: {
    title: 'You’re offline',
    body: COPY_PIN_OFFLINE_SYNC,
  },
  foreground_critical: {
    title: 'Finishing your try-on first',
    body: 'Pinterest sync waits until your render is in — it never slows down Generate.',
  },
  too_soon: {
    title: 'Boards are up to date',
    body: 'Pinterest syncs nightly. Your saved boards are fresh enough.',
  },
  rate_limited: {
    title: 'Pinterest asked us to slow down',
    body: 'Waiting a little before retrying your boards sync — your saved boards still work.',
  },
};

/**
 * THE sync gate. Every Pinterest sync entry point (nightly job, manual pull)
 * MUST call this first. Automatic runs additionally respect the nightly
 * interval; manual pulls bypass `too_soon` only. A 429 `Retry-After` (server
 * wins) blocks both until it lapses.
 */
export function shouldRunPinSync(req: PinSyncRequest): PinSyncGate {
  const now = req.nowMs ?? Date.now();
  if (!req.isOnline) return { allowed: false, reason: 'offline' };
  if (req.isForegroundCritical) return { allowed: false, reason: 'foreground_critical' };
  if (req.retryAfterMs != null && now < req.retryAfterMs) {
    return { allowed: false, reason: 'rate_limited' };
  }
  if (
    !req.isManual &&
    req.lastSyncedAtMs != null &&
    now - req.lastSyncedAtMs < PIN_SYNC_MIN_INTERVAL_MS
  ) {
    return { allowed: false, reason: 'too_soon' };
  }
  return { allowed: true, reason: null };
}

/**
 * Split a board's pin page into persistable chunks (default 25). The server
 * paginates newest-first; the client writes one chunk at a time so a killed
 * sync resumes from the last chunk instead of restarting the board.
 */
export function chunkBoardSync<T>(items: readonly T[], chunkSize = PIN_SYNC_CHUNK_SIZE): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Enforce the per-board per-sync cap. Input MUST already be newest-first
 * (the Pinterest list call returns newest first) — the head is kept, the tail
 * is dropped. Pure + total: safe to apply per page AND to the merged list.
 */
export function capPinsNewestFirst<T>(pins: readonly T[], cap = MAX_PINS_PER_BOARD_PER_SYNC): T[] {
  return pins.slice(0, Math.max(0, Math.floor(cap)));
}

/**
 * Client-side 429 backoff: exponential from 1s, capped at 30s, ±~30% jitter
 * (same shape as image-pipeline `backoffDelayMs`). ALWAYS honor the server's
 * `Retry-After` first — this math paces retries when the header is absent.
 * Stops after PIN_SYNC_MAX_429_ATTEMPTS (caller surfaces "try again later").
 */
export function pinSyncBackoffDelayMs(
  attempt: number,
  baseDelayMs = PIN_SYNC_429_BASE_DELAY_MS,
): number {
  const capped = Math.min(PIN_SYNC_429_MAX_DELAY_MS, baseDelayMs * 2 ** attempt);
  return Math.round(capped * (0.7 + Math.random() * 0.6)); // full-ish jitter
}

// ---------------------------------------------------------------------------
// MMKV mirrors: boards + per-board pin lists (stale-while-revalidate)
// ---------------------------------------------------------------------------

/** MMKV key for the boards mirror (24h TTL, stale-while-revalidate). */
export const PIN_BOARDS_CACHE_KEY = 'pinterest:boards:v1';
/** MMKV key prefix for per-board pin lists (purged on disconnect). */
const PIN_PINS_KEY_PREFIX = 'pinterest:pins:';

export const pinBoardsCache = new TTLCache<PinBoardSnapshot>(
  PIN_BOARDS_CACHE_KEY,
  24 * 60 * 60 * 1000,
  1,
);

export function pinListCacheKey(boardId: string): string {
  return `${PIN_PINS_KEY_PREFIX}${boardId}:v1`;
}

function pinListCacheFor(boardId: string): TTLCache<PinListSnapshot> {
  return new TTLCache<PinListSnapshot>(pinListCacheKey(boardId), 24 * 60 * 60 * 1000, 1);
}

/** Cached-first read for the board picker (serves `stale` while revalidating). */
export function readPinBoards(): CacheRead<PinBoardSnapshot> {
  return pinBoardsCache.read();
}

export function writePinBoards(snapshot: PinBoardSnapshot): void {
  pinBoardsCache.set(snapshot);
}

/** Cached-first read for a board's pin grid. */
export function readPinList(boardId: string): CacheRead<PinListSnapshot> {
  return pinListCacheFor(boardId).read();
}

export function writePinList(snapshot: PinListSnapshot): void {
  pinListCacheFor(snapshot.boardId).set(snapshot);
}

export function invalidatePinList(boardId: string): void {
  pinListCacheFor(boardId).invalidate();
}

/**
 * Pinterest disconnect: purge taste-graph keys ONLY (boards + per-board pin
 * lists). Closet/quota/paywall caches are untouched — disconnecting Pinterest
 * must never log the user out of their wardrobe. Cached boards stay browsable
 * until disconnect; after purge the next connect refetches nightly-fresh.
 */
export function purgePinCachesOnDisconnect(): void {
  try {
    pinBoardsCache.invalidate();
    const keys = mmkv.getAllKeys();
    for (const k of keys) {
      if (k.startsWith(PIN_PINS_KEY_PREFIX)) mmkv.remove(k);
    }
  } catch {
    /* cache purge must never crash the settings screen */
  }
}
