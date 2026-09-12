import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Surface misconfig early in dev; production builds must set .env (see .env.example).
  // eslint-disable-next-line no-console
  console.warn('[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / ANON_KEY.');
}

/**
 * True when the build carries Supabase credentials. Check this BEFORE
 * touching `supabase` / `getSupabase()` — the client factory throws on an
 * empty URL, so every startup path must gate on this first (app/_layout.tsx).
 * Reads live env so a dev refresh / OTA that restores vars is honored.
 */
export function isBackendConfigured(): boolean {
  return Boolean(
    process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Supabase auth persistence.
 * - Web: SecureStore has no native module (throws `getValueWithKeyAsync is not
 *   a function`), so use localStorage directly.
 * - Native: SecureStore, with an in-memory fallback if the device has no
 *   secure hardware or the module is otherwise unavailable. Auth tokens must
 *   never touch MMKV (MMKV storage is unencrypted); memory fallback only
 *   lasts for the session, which beats a crash.
 * Every accessor is guarded: storage failure degrades, never throws.
 */
const memoryStore = new Map<string, string>();

const webStorage: SupportedStorage = {
  getItem: (key: string) => {
    try {
      return Promise.resolve(localStorage.getItem(key));
    } catch {
      return Promise.resolve(memoryStore.get(key) ?? null);
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      memoryStore.set(key, value);
    }
    return Promise.resolve();
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      memoryStore.delete(key);
    }
    return Promise.resolve();
  },
};

const nativeStorage: SupportedStorage = {
  getItem: async (key: string) => {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return memoryStore.get(key) ?? null;
    }
  },
  setItem: async (key: string, value: string) => {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      memoryStore.set(key, value);
    }
  },
  removeItem: async (key: string) => {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      memoryStore.delete(key);
    }
  },
};

const secureStorage: SupportedStorage = Platform.OS === 'web' ? webStorage : nativeStorage;

let _client: SupabaseClient | null = null;

/**
 * Lazy singleton — the client is created on first USE, never at import.
 * Throws only when misconfigured (callers must gate on
 * `isBackendConfigured()` first); importing this module never throws.
 */
export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    throw new Error(
      '[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / ANON_KEY — gate on isBackendConfigured() before use.',
    );
  }
  _client = createClient(url, anonKey, {
    auth: {
      storage: secureStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Web OAuth is a full-page redirect (no app to deep-link back to), so
      // the client must exchange the `code` from the return URL itself.
      // Native uses explicit `exchangeCodeForSession` on vai:// instead.
      detectSessionInUrl: Platform.OS === 'web',
    },
  });
  return _client;
}

/**
 * Back-compat handle: every existing `import { supabase }` site keeps
 * compiling and behaving identically (`supabase.auth.*`, `.storage.*`,
 * `.from()`, `.rpc()`, `.functions`), but creation is deferred to first
 * property access — so the release crash (`createClient('', '')` throwing
 * during boot module evaluation) can no longer fire at import time.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    // Never initialize for promise-shape probes (`await supabase`).
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    const client = getSupabase();
    const value = (client as unknown as Record<string, unknown>)[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
});

/**
 * Storage buckets (owned by backend — migrations/0001_schema.sql:518-531).
 * `base` + `raw` are PRIVATE — never `getPublicUrl` them; mint a short-lived
 * signed URL via `createSignedBasePhotoUrl` instead. `garments` + `renders`
 * are public-read, so `getPublicUrl` is correct there.
 */
export const BUCKETS = {
  basePhotos: 'base',
  raw: 'raw',
  garments: 'garments',
  renders: 'renders',
} as const;

/** Signed-URL TTL for private base photos (matches buckets.md 1h rule). */
export const BASE_PHOTO_SIGNED_URL_TTL_S = 3600;

/**
 * Mint a short-lived signed URL for a private `base` object.
 * `path` is the storage object path (`<uid>/base-<ts>.jpg`) — the same value
 * stored in `base_photos.url`. Throws on failure; callers map to upload copy.
 */
export async function createSignedBasePhotoUrl(path: string): Promise<string> {
  const { data, error } = await getSupabase().storage
    .from(BUCKETS.basePhotos)
    .createSignedUrl(path, BASE_PHOTO_SIGNED_URL_TTL_S);
  if (error || !data?.signedUrl) throw error ?? new Error('signed-url-failed');
  return data.signedUrl;
}
