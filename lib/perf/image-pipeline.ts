/**
 * VAI perf — image pipeline.
 *
 * Capture -> compress -> gate -> upload (+retry/resume) -> prefetch.
 *
 * Budgets enforced here (see PERF-BUDGETS.md):
 *  - garment photos: WebP, max edge 1024px, MUST be < 200 KB before upload.
 *  - base (mirror-selfie) photos: 1080x1920 JPEG, local gates for
 *    size/aspect/blur/luminance; face+keypoints are DEFERRED to the server
 *    (quiz-score verdict cached in MMKV) because shipping a fake on-device
 *    face check would be worse than none. Never green-light a base photo
 *    the client cannot actually verify — return `needsServerCheck`.
 *
 * Dependencies (see DEPS-perf.txt, install via `npx expo install --fix`):
 *  expo-image, expo-image-manipulator, expo-file-system/legacy,
 *  expo-crypto, jpeg-js (thumbnail decode for REAL blur/luminance numbers).
 */
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';

// ---------------------------------------------------------------------------
// Budgets / constants
// ---------------------------------------------------------------------------

/** Garment uploads must stay under this or the upload is refused. */
export const GARMENT_MAX_WIDTH_PX = 1024;
export const GARMENT_MAX_BYTES = 200 * 1024; // 200 KB
const GARMENT_QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;
const GARMENT_FALLBACK_WIDTH_PX = 768;

/** Base photo target geometry (portrait mirror selfie). */
export const BASE_TARGET_W = 1080;
export const BASE_TARGET_H = 1920;
export const BASE_MIN_W = 720;
export const BASE_MIN_H = 1280;
/** |w/h - 9/16| tolerance. Outside this the FASHN crop drifts. */
export const BASE_ASPECT_TOLERANCE = 0.12;
export const BASE_MAX_BYTES = 15 * 1024 * 1024;

/** Chunk size for resumable uploads. Multiple of 3 keeps base64 slicing clean. */
export const RESUMABLE_CHUNK_BYTES = 255 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhotoKind = 'garment' | 'base';
export type CompressedFormat = 'webp' | 'jpeg';

export interface CompressResult {
  uri: string;
  width: number;
  height: number;
  bytes: number;
  format: CompressedFormat;
  quality: number;
  /** SHA-256 of the COMPRESSED bytes. Doubles as dedup key + idempotent remote path. */
  sha256: string;
}

export type BasePhotoFailReason =
  | 'unreadable'
  | 'file_too_big'
  | 'too_small'
  | 'bad_aspect'
  | 'too_dark'
  | 'too_bright'
  | 'too_blurry'
  | 'no_face_or_body'
  | 'face_check_unavailable';

export interface FaceVerdict {
  faceCount: number;
  bodyVisible: boolean;
  confidence: number; // 0..1
  source: 'device' | 'server';
}

/**
 * Injected by integrations. Client ships NO face model (expo-face-detector is
 * gone in SDK 57 and bundling an ML kit blows the JS/native budget).
 * Preferred implementation: read the cached `quiz-score` verdict from MMKV
 * (see lib/perf/cache.ts `dnaCache` / CONTRACT-perf.md). Must work offline
 * from cache or throw OFFLINE so the caller can defer.
 */
export interface FaceDetector {
  detectFaces(localUri: string): Promise<FaceVerdict>;
}

export interface QualityThresholds {
  /** Mean luma 0..255. Below = "find daylight", above = "blown out". */
  minLuminance: number;
  maxLuminance: number;
  /** Laplacian variance on 96px luma. Below = blurry. Tune in QA (blocker P1). */
  minBlurVariance: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minLuminance: 40,
  maxLuminance: 220,
  minBlurVariance: 16,
};

export interface BasePhotoGate {
  ok: boolean;
  reasons: BasePhotoFailReason[];
  /** True when the only blocker is face/keypoints with no detector result yet. */
  needsServerCheck: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  luminance?: number;
  blurVariance?: number;
  face?: FaceVerdict;
}

export class ImagePipelineError extends Error {
  readonly code:
    | 'unreadable'
    | 'garment_too_heavy'
    | 'base_gate_failed'
    | 'upload_failed'
    | 'offline';
  constructor(code: ImagePipelineError['code'], message: string) {
    super(message);
    this.name = 'ImagePipelineError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export async function sha256OfStringAsync(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

/** Minimal base64 -> bytes decoder (no Buffer on Hermes, atob not guaranteed). */
function base64ToBytes(b64: string): Uint8Array {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) lookup.set(chars[i]!, i);
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(((clean.length * 3) >> 2) - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup.get(clean[i]!) ?? 0;
    const b = lookup.get(clean[i + 1]!) ?? 0;
    const c = lookup.get(clean[i + 2]!) ?? 0;
    const d = lookup.get(clean[i + 3]!) ?? 0;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (o < out.length) out[o++] = triple & 0xff;
  }
  return out;
}

function getSizeAsync(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    // expo-image has no getSize — dimensions come from the RN static.
    RNImage.getSize(
      uri,
      (width: number, height: number) => resolve({ width, height }),
      (err: unknown) =>
        reject(
          new ImagePipelineError('unreadable', `Cannot read image: ${String(err)}`),
        ),
    );
  });
}

async function fileBytes(uri: string): Promise<number> {
  // Installed expo-file-system InfoOptions has no `size` flag — size is
  // always returned when the file exists.
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    throw new ImagePipelineError('unreadable', `File missing: ${uri}`);
  }
  return info.size;
}

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

async function manipulateTo(
  uri: string,
  width: number,
  format: CompressedFormat,
  quality: number,
  wantBase64: boolean,
): Promise<{ uri: string; width: number; height: number; base64?: string }> {
  const ctx = ImageManipulator.manipulate(uri);
  ctx.resize({ width });
  const ref = await ctx.renderAsync();
  const saved = await ref.saveAsync({
    compress: quality,
    format: format === 'webp' ? SaveFormat.WEBP : SaveFormat.JPEG,
    base64: wantBase64,
  });
  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    base64: saved.base64 ?? undefined,
  };
}

/**
 * Garment photo: WebP, <=1024px edge, MUST land < 200 KB.
 * Iterates quality 0.85 -> 0.4, then one 768px fallback pass.
 * Throws `garment_too_heavy` if the budget cannot be met (UI: "Retake closer / plain bg").
 */
export async function compressGarmentPhoto(
  localUri: string,
): Promise<CompressResult> {
  const { width: srcW } = await getSizeAsync(localUri).catch(() => {
    throw new ImagePipelineError('unreadable', 'Cannot read garment photo.');
  });
  const startWidth = Math.min(srcW, GARMENT_MAX_WIDTH_PX);
  const widths = [startWidth, GARMENT_FALLBACK_WIDTH_PX];

  for (const width of widths) {
    for (const quality of GARMENT_QUALITIES) {
      const saved = await manipulateTo(localUri, width, 'webp', quality, false);
      const bytes = await fileBytes(saved.uri);
      if (bytes <= GARMENT_MAX_BYTES) {
        const b64 = await FileSystem.readAsStringAsync(saved.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return {
          uri: saved.uri,
          width: saved.width,
          height: saved.height,
          bytes,
          format: 'webp',
          quality,
          sha256: await sha256OfStringAsync(b64),
        };
      }
    }
  }
  throw new ImagePipelineError(
    'garment_too_heavy',
    `Garment photo exceeds ${GARMENT_MAX_BYTES / 1024} KB even at 768px/q0.4. Retake on a plain background.`,
  );
}

/** Base photo: 1080px-wide JPEG q0.9. No byte cap (full-body detail matters for FASHN). */
export async function compressBasePhoto(
  localUri: string,
): Promise<CompressResult> {
  const saved = await manipulateTo(localUri, BASE_TARGET_W, 'jpeg', 0.9, false);
  const bytes = await fileBytes(saved.uri);
  const b64 = await FileSystem.readAsStringAsync(saved.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    bytes,
    format: 'jpeg',
    quality: 0.9,
    sha256: await sha256OfStringAsync(b64),
  };
}

/** Idempotent remote path: same bytes -> same path, so retries never duplicate. */
export function remotePathFor(kind: PhotoKind, sha256: string): string {
  return kind === 'garment'
    ? `garments/${sha256}.webp`
    : `base-photos/${sha256}.jpg`;
}

// ---------------------------------------------------------------------------
// Base-photo gates (blur / luminance measured for real, face deferred)
// ---------------------------------------------------------------------------

interface LumaStats {
  mean: number;
  blurVariance: number;
}

function lumaStatsFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): LumaStats {
  const px = width * height;
  const luma = new Float32Array(px);
  let sum = 0;
  for (let i = 0; i < px; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[i] = y;
    sum += y;
  }
  const mean = sum / Math.max(1, px);
  // Laplacian variance, subsampled 1:4 for speed (96px thumb -> ~2.3k samples).
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const c = luma[y * width + x] ?? 0;
      const lap =
        Math.abs(
          4 * c -
            (luma[(y - 1) * width + x] ?? 0) -
            (luma[(y + 1) * width + x] ?? 0) -
            (luma[y * width + (x - 1)] ?? 0) -
            (luma[y * width + (x + 1)] ?? 0),
        );
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const lapMean = lapSum / Math.max(1, n);
  return { mean, blurVariance: Math.max(0, lapSq / Math.max(1, n) - lapMean * lapMean) };
}

async function measureThumbnailStats(localUri: string): Promise<LumaStats> {
  // 96px JPEG thumb: <15 KB in memory, decodes in ~ms on Hermes via jpeg-js.
  const saved = await manipulateTo(localUri, 96, 'jpeg', 0.5, true);
  if (!saved.base64) {
    throw new ImagePipelineError('unreadable', 'Thumbnail encode failed.');
  }
  const decoded = decodeJpeg(base64ToBytes(saved.base64), {
    maxMemoryUsageInMB: 32,
    maxResolutionInMP: 1,
  });
  const rgba = decoded.data instanceof Uint8Array
    ? decoded.data
    : new Uint8Array(decoded.data);
  return lumaStatsFromRgba(rgba, decoded.width, decoded.height);
}

/**
 * On-device preflight for the mirror selfie. Fails fast with inline reasons
 * (UI shows reason + Retake). Face/keypoints need `detector`; without a
 * result the gate reports `face_check_unavailable` + needsServerCheck so the
 * caller routes to the server verdict instead of faking a pass.
 */
export async function preflightBasePhoto(
  localUri: string,
  opts?: { detector?: FaceDetector; thresholds?: QualityThresholds },
): Promise<BasePhotoGate> {
  const thresholds = opts?.thresholds ?? DEFAULT_THRESHOLDS;
  const reasons: BasePhotoFailReason[] = [];

  let bytes: number;
  try {
    bytes = await fileBytes(localUri);
  } catch {
    return { ok: false, reasons: ['unreadable'], needsServerCheck: false };
  }
  if (bytes > BASE_MAX_BYTES) {
    return { ok: false, reasons: ['file_too_big'], needsServerCheck: false, bytes };
  }

  let dims: { width: number; height: number };
  try {
    dims = await getSizeAsync(localUri);
  } catch {
    return { ok: false, reasons: ['unreadable'], needsServerCheck: false, bytes };
  }
  if (dims.width < BASE_MIN_W || dims.height < BASE_MIN_H) reasons.push('too_small');
  const aspect = dims.width / Math.max(1, dims.height);
  if (Math.abs(aspect - 9 / 16) > BASE_ASPECT_TOLERANCE) reasons.push('bad_aspect');

  let luminance: number | undefined;
  let blurVariance: number | undefined;
  try {
    const stats = await measureThumbnailStats(localUri);
    luminance = stats.mean;
    blurVariance = stats.blurVariance;
    if (stats.mean < thresholds.minLuminance) reasons.push('too_dark');
    else if (stats.mean > thresholds.maxLuminance) reasons.push('too_bright');
    if (stats.blurVariance < thresholds.minBlurVariance) reasons.push('too_blurry');
  } catch {
    reasons.push('unreadable');
  }

  let face: FaceVerdict | undefined;
  let needsServerCheck = false;
  if (opts?.detector) {
    try {
      face = await opts.detector.detectFaces(localUri);
      if (face.faceCount < 1 || !face.bodyVisible) reasons.push('no_face_or_body');
    } catch {
      reasons.push('face_check_unavailable');
      needsServerCheck = true;
    }
  } else {
    reasons.push('face_check_unavailable');
    needsServerCheck = true;
  }

  const hardFails = reasons.filter((r) => r !== 'face_check_unavailable');
  return {
    ok: hardFails.length === 0 && !needsServerCheck,
    reasons,
    needsServerCheck,
    width: dims.width,
    height: dims.height,
    bytes,
    luminance,
    blurVariance,
    face,
  };
}

// ---------------------------------------------------------------------------
// Upload: small-file retry + resumable (transport injected by integrations)
// ---------------------------------------------------------------------------

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

export interface UploadRetryOpts {
  maxAttempts?: number; // default 4
  baseDelayMs?: number; // default 800, exponential + jitter, capped 8s
  onProgress?: (p: UploadProgress) => void;
  isOnline?: () => boolean;
}

export interface SmallFileTransport {
  putBytes(
    remotePath: string,
    base64: string,
    contentType: string,
  ): Promise<{ publicUrl: string }>;
}

export interface ResumableTransport extends SmallFileTransport {
  startResumable(
    remotePath: string,
    totalBytes: number,
    contentType: string,
  ): Promise<{ uploadId: string }>;
  uploadChunk(
    uploadId: string,
    chunkBase64: string,
    offset: number,
  ): Promise<{ offset: number }>;
  completeResumable(uploadId: string): Promise<{ publicUrl: string }>;
}

/** Minimal KV for upload-session persistence (cache.ts exports an adapter). */
export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
}

export function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const capped = Math.min(8000, baseDelayMs * 2 ** attempt);
  return Math.round(capped * (0.7 + Math.random() * 0.6)); // full-ish jitter
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Single-shot upload with retry. For garments (<200 KB) this IS the resume
 * strategy — a retry costs one cheap PUT to an idempotent path.
 */
export async function uploadWithRetry(
  transport: SmallFileTransport,
  localUri: string,
  remotePath: string,
  contentType: string,
  opts?: UploadRetryOpts,
): Promise<{ publicUrl: string; attempts: number }> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 800;
  if (opts?.isOnline && !opts.isOnline()) {
    throw new ImagePipelineError(
      'offline',
      "You're offline — photo is kept on-device and will upload on reconnect.",
    );
  }
  const totalBytes = await fileBytes(localUri);
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      opts?.onProgress?.({ sentBytes: 0, totalBytes });
      const res = await transport.putBytes(remotePath, base64, contentType);
      opts?.onProgress?.({ sentBytes: totalBytes, totalBytes });
      return { publicUrl: res.publicUrl, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(backoffDelayMs(attempt, baseDelayMs));
      }
    }
  }
  throw new ImagePipelineError(
    'upload_failed',
    `Upload failed after ${maxAttempts} attempts: ${String(lastErr)}`,
  );
}

interface ResumableSession {
  uploadId: string;
  offset: number;
  totalBytes: number;
  sha256: string;
}

/**
 * Chunked resumable upload for base photos. Session {uploadId, offset} is
 * persisted in MMKV after every chunk, so a kill/restart resumes instead of
 * restarting. Remote path embeds the content sha -> completion is idempotent.
 */
export class ResumableUpload {
  constructor(
    private readonly transport: ResumableTransport,
    private readonly kv: KVStore,
    private readonly sessionKey: string,
  ) {}

  async startOrResume(
    localUri: string,
    remotePath: string,
    contentType: string,
    opts?: UploadRetryOpts,
  ): Promise<{ publicUrl: string; resumed: boolean; attempts: number }> {
    if (opts?.isOnline && !opts.isOnline()) {
      throw new ImagePipelineError(
        'offline',
        "You're offline — photo is kept on-device and will upload on reconnect.",
      );
    }
    const totalBytes = await fileBytes(localUri);
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const sha256 = await sha256OfStringAsync(base64.slice(0, 1_000_000));
    let attempts = 0;

    let session: ResumableSession | null = null;
    const raw = this.kv.get(this.sessionKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ResumableSession;
        if (parsed.sha256 === sha256 && parsed.totalBytes === totalBytes) {
          session = parsed;
        }
      } catch {
        session = null;
      }
    }
    if (!session) {
      const started = await this.transport.startResumable(
        remotePath,
        totalBytes,
        contentType,
      );
      session = { uploadId: started.uploadId, offset: 0, totalBytes, sha256 };
      this.kv.set(this.sessionKey, JSON.stringify(session));
    }
    const resumed = session.offset > 0;

    // Slice base64 on 4-char boundaries (= 3 raw bytes) so every chunk
    // decodes standalone. Offsets always advance by whole chunks (multiples
    // of 3 bytes), so byteOffset -> b64 mapping stays exact across resumes.
    const offsetToB64 = (byteOffset: number): number =>
      Math.floor(byteOffset / 3) * 4;
    const chunkB64Len = Math.floor(RESUMABLE_CHUNK_BYTES / 3) * 4;

    let offset = session.offset;
    while (offset < totalBytes) {
      const start = offsetToB64(offset);
      const chunk = base64.slice(start, start + chunkB64Len);
      let done = false;
      for (let attempt = 0; attempt < (opts?.maxAttempts ?? 4); attempt++) {
        attempts++;
        try {
          const res = await this.transport.uploadChunk(
            session.uploadId,
            chunk,
            offset,
          );
          offset = res.offset;
          done = true;
          break;
        } catch {
          await sleep(backoffDelayMs(attempt, opts?.baseDelayMs ?? 800));
        }
      }
      if (!done) {
        this.kv.set(this.sessionKey, JSON.stringify({ ...session, offset }));
        throw new ImagePipelineError(
          'upload_failed',
          `Chunk upload failed at byte ${offset}; session saved, resume later.`,
        );
      }
      this.kv.set(this.sessionKey, JSON.stringify({ ...session, offset }));
      opts?.onProgress?.({
        sentBytes: Math.min(offset, totalBytes),
        totalBytes,
      });
    }

    const completed = await this.transport.completeResumable(session.uploadId);
    this.kv.del(this.sessionKey);
    return { publicUrl: completed.publicUrl, resumed, attempts };
  }

  /** Drop a stale session (e.g. user retook the photo). */
  abandon(): void {
    this.kv.del(this.sessionKey);
  }
}

// ---------------------------------------------------------------------------
// Pre-warm + prefetch (expo-image disk cache)
// ---------------------------------------------------------------------------

export interface PrefetchResult {
  prefetched: number;
  failed: string[];
}

/**
 * Prefetch next-outfit images into expo-image's disk cache with a bounded
 * concurrency pool (default 4) so prefetch never starves the visible list.
 * Call AFTER first paint (see loading.ts), never during cold start.
 */
export async function prefetchOutfitImages(
  urls: string[],
  opts?: { concurrency?: number },
): Promise<PrefetchResult> {
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const queue = urls.filter((u) => u.length > 0);
  const failed: string[] = [];
  let prefetched = 0;

  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const ok = await Image.prefetch(url, {
            cachePolicy: 'memory-disk',
          });
          return { url, ok };
        } catch {
          return { url, ok: false };
        }
      }),
    );
    for (const r of results) {
      if (r.ok) prefetched++;
      else failed.push(r.url);
    }
  }
  return { prefetched, failed };
}

/**
 * Fire-and-forget warm for above-the-fold URLs (hero outfit, base thumb).
 * Never awaited on the critical path — loading.ts gates on its own timeout.
 */
export function prewarmCritical(urls: string[]): void {
  void prefetchOutfitImages(urls, { concurrency: 2 }).catch(() => {
    /* prewarm is best-effort by design */
  });
}
