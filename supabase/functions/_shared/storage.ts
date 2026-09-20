// Storage URL helpers (Deno, strict TS) — the ONLY way edge functions turn a
// stored image reference into a fetchable URL.
//
// SSRF + privacy invariants (security audit P1-3/P1-4):
//   - Users can UPDATE their own `base_photos.url` / `garments.image_url` via
//     the Data API, so a stored value is NEVER trusted as a fetch target:
//     bare paths must live under the owner's `<userId>/` prefix, and full
//     URLs are accepted only when they point at THIS project's storage object
//     endpoint and reduce to an owner-prefixed path.
//   - Renders (derived from the private selfie) are served as 1h signed URLs
//     minted server-side — the `renders` bucket has no public-read policy.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { supabaseUrl } from "./auth.ts";

function projectHost(): string {
  try {
    return new URL(supabaseUrl()).host;
  } catch {
    return "";
  }
}

/**
 * Resolve a stored base/garment image reference to a 1h signed URL.
 * Throws (fail closed) on anything that is not an owner-prefixed object of
 * THIS project's storage for the given bucket.
 */
export async function signedAssetUrl(
  sb: SupabaseClient,
  bucket: "base" | "garments",
  stored: string,
  userId: string,
): Promise<string> {
  let objectPath = stored;
  if (/^https?:\/\//i.test(stored)) {
    let u: URL;
    try {
      u = new URL(stored);
    } catch {
      throw new Error(`Invalid ${bucket} image URL`);
    }
    const m = /^\/storage\/v1\/object\/(?:public|authenticated|sign\/[^/]+)?\/([^/]+)\/(.+)$/.exec(
      u.pathname,
    );
    const host = projectHost();
    if (!host || u.host !== host || !m || m[1] !== bucket) {
      throw new Error(`${bucket} image must be a VAI storage object`);
    }
    objectPath = decodeURIComponent(m[2]!);
  }
  // auto-tag stores cutouts nested (`garments/cutout/{uid}/<id>.png`) while
  // direct app uploads live at `{uid}/<file>` — both are owner-scoped; the
  // path must contain the caller's own prefix either way (never another user's).
  if (!objectPath.startsWith(`${userId}/`) && !objectPath.includes(`${userId}/`)) {
    throw new Error(`${bucket} image is outside the owner's storage prefix`);
  }
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(objectPath, 3600);
  if (error || !data) throw new Error(`Cannot sign ${bucket}/${objectPath}`);
  return data.signedUrl;
}

/** Mint a fresh 1h signed URL for a stored render output path (or null). */
export async function signedRenderUrl(
  sb: SupabaseClient,
  userId: string,
  outputPath: string | null | undefined,
): Promise<string | null> {
  if (!outputPath || !outputPath.startsWith(`${userId}/`)) return null;
  const { data, error } = await sb.storage.from("renders").createSignedUrl(outputPath, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
