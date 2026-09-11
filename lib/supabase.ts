import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Surface misconfig early in dev; production builds must set .env (see .env.example).
  // eslint-disable-next-line no-console
  console.warn('[supabase] Missing EXPO_PUBLIC_SUPABASE_URL / ANON_KEY.');
}

/** Supabase auth persistence backed by SecureStore (tokens never touch MMKV). */
const secureStorage: SupportedStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
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
  const { data, error } = await supabase.storage
    .from(BUCKETS.basePhotos)
    .createSignedUrl(path, BASE_PHOTO_SIGNED_URL_TTL_S);
  if (error || !data?.signedUrl) throw error ?? new Error('signed-url-failed');
  return data.signedUrl;
}
