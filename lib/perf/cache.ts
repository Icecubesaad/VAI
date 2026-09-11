/**
 * VAI perf — MMKV caches with TTLs + invalidation rules.
 *
 * Namespaces (single MMKV instance `vai-perf`, JSON envelopes):
 *  - closet list      TTL 5 min   invalidate on any garment mutation
 *  - style DNA        TTL 24 h    invalidate on quiz retake
 *  - quotas mirror    TTL 60 s    invalidate on render settle / purchase
 *  - paywall status   TTL 5 min   invalidate on purchase / restore / trial change
 *
 * Server is ALWAYS source of truth for money-adjacent state (quotas,
 * paywall). These caches are latency-hiding mirrors: reads may serve stale
 * while a background refresh runs, but NOTHING here can grant a render.
 * The grant decision lives in quotas.ts against a fresh-or-reconciled snapshot.
 */
import { createMMKV } from 'react-native-mmkv';
import type { KVStore } from './image-pipeline';

export const mmkv = createMMKV({ id: 'vai-perf' });

/** KV adapter so image-pipeline resumable uploads persist sessions here. */
export const mmkvKV: KVStore = {
  get: (key) => mmkv.getString(key) ?? null,
  set: (key, value) => mmkv.set(key, value),
  del: (key) => mmkv.remove(key),
};

// ---------------------------------------------------------------------------
// Envelope + generic TTL cache
// ---------------------------------------------------------------------------

interface Envelope<T> {
  /** Schema version — bump to force-migrate a namespace. */
  v: number;
  /** Epoch ms when written. */
  t: number;
  ttlMs: number;
  data: T;
}

export interface CacheRead<T> {
  /** Fresh data (within TTL), or null. */
  fresh: T | null;
  /** Last-known data regardless of age (for stale-while-revalidate UI). */
  stale: T | null;
  ageMs: number | null;
}

export class TTLCache<T> {
  constructor(
    readonly key: string,
    readonly defaultTtlMs: number,
    readonly version = 1,
  ) {}

  private readEnvelope(): Envelope<T> | null {
    const raw = mmkv.getString(this.key);
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as Envelope<T>;
      if (env.v !== this.version || typeof env.t !== 'number') return null;
      return env;
    } catch {
      return null;
    }
  }

  read(): CacheRead<T> {
    const env = this.readEnvelope();
    if (!env) return { fresh: null, stale: null, ageMs: null };
    const ageMs = Date.now() - env.t;
    const isFresh = ageMs <= env.ttlMs;
    return { fresh: isFresh ? env.data : null, stale: env.data, ageMs };
  }

  /** Fresh data or null (use `read()` when you want SWR fallback). */
  get(): T | null {
    return this.read().fresh;
  }

  set(data: T, ttlMs?: number): void {
    const env: Envelope<T> = {
      v: this.version,
      t: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
      data,
    };
    mmkv.set(this.key, JSON.stringify(env));
  }

  invalidate(): void {
    mmkv.remove(this.key);
  }
}

// ---------------------------------------------------------------------------
// Stored shapes (wire-compatible with backend/integrations; see CONTRACT)
// ---------------------------------------------------------------------------

export interface StoredGarmentSummary {
  id: string;
  imageUrl: string;
  category: string;
  colors: string[];
  wearCount: number;
  updatedAt: string;
}

export interface ClosetSnapshot {
  userId: string;
  items: StoredGarmentSummary[];
  /** Server cursor/etag for cheap "did anything change" checks. */
  cursor: string | null;
  fetchedAt: number;
}

export interface DnaSnapshot {
  userId: string;
  labels: Record<string, unknown>;
  colorSeason: string | null;
  palette: string[];
  /** Server verdict reused as the base-photo FaceDetector (see CONTRACT). */
  faceVerdict?: { faceCount: number; bodyVisible: boolean; confidence: number };
  quizVersion: number;
  fetchedAt: number;
}

export interface StoredQuota {
  rendersLeft: number;
  monthlyUsed: number;
  monthlyCap: number;
  lifetimeUsed: number;
  lifetimeCap: number | null; // 5 for free, null for premium/trial
  packCredits: number;
  resetsAt: string | null;
  syncedAt: number;
}

export interface StoredPaywall {
  tier: 'free' | 'trial' | 'premium';
  trialEndsAt: string | null;
  productId: string | null;
  status: string | null;
  syncedAt: number;
}

// ---------------------------------------------------------------------------
// Concrete caches
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const closetCache = new TTLCache<ClosetSnapshot>('closet:list:v1', 5 * MIN, 1);
export const dnaCache = new TTLCache<DnaSnapshot>('style:dna:v1', 24 * HOUR, 1);
/** Quota mirror: short TTL on purpose. UI may render `stale` + "syncing" state, never grant on it. */
export const quotaCache = new TTLCache<StoredQuota>('quota:mirror:v1', 60 * 1000, 1);
export const paywallCache = new TTLCache<StoredPaywall>('paywall:status:v1', 5 * MIN, 1);

// ---------------------------------------------------------------------------
// Invalidation rules — call these, don't delete keys ad-hoc.
// ---------------------------------------------------------------------------

/** Any garment add / edit / delete / wear-log that changes counts. */
export function invalidateOnGarmentMutation(): void {
  closetCache.invalidate();
}

/** Render settled (done/failed): quota numbers moved server-side. */
export function invalidateOnRenderSettled(): void {
  quotaCache.invalidate();
}

/** Purchase / restore / trial start / cancel: everything money-adjacent is suspect. */
export function invalidateOnPurchase(): void {
  quotaCache.invalidate();
  paywallCache.invalidate();
}

/** Quiz retake or style-profile edit. */
export function invalidateOnDnaChange(): void {
  dnaCache.invalidate();
}

/** Base-photo retake: FASHN cache key changes (sha256(user:active_photo)). */
export function invalidateOnBasePhotoRetake(): void {
  mmkv.remove('upload:base-photo:session');
}

/** Logout / account delete: wipe the whole perf namespace, no leaks across users. */
export function clearAllOnLogout(): void {
  const keys = mmkv.getAllKeys();
  for (const k of keys) mmkv.remove(k);
}
