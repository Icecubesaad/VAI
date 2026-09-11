/**
 * VAI · integrations-owned shared HTTP helper for Supabase Edge Functions.
 *
 * Owner: integrations engineer. Other engineers: prefer `callEdgeFunction`
 * over hand-rolled fetch so retry / timeout / idempotency stay consistent.
 *
 * SECRETS (read carefully):
 * - PUBLIC client-side (safe): EXPO_PUBLIC_SUPABASE_URL,
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY. The anon key is designed to be embedded
 *   in the app; row-level security + explicit Data-API exposure enforce access.
 * - SERVER-ONLY (Supabase Edge Function secrets, NEVER EXPO_PUBLIC_ and NEVER
 *   imported here): GEMINI_API_KEY, FASHN_API_KEY, SHOPSTYLE_KEY,
 *   LTK_AFFILIATE_ID, SKIMLINKS_ACCOUNT, STRIPE_SECRET, RESEND_KEY,
 *   POSTHOG_SERVER_KEY. If you need one of these, add an edge function —
 *   do not thread it through this module.
 */

export type EdgeFnName =
  | 'render-tryon'
  | 'restyle'
  | 'plan-day'
  | 'plan-week'
  | 'auto-tag'
  | 'shop-picks'
  | 'paywall-status'
  | 'quiz-score';

export interface EdgeCallOptions {
  /** Supabase session JWT. Frontend passes its session token; null = anon. */
  authToken?: string | null;
  /** Lazy token supplier (preferred: always fresh). Wins over `authToken`. */
  getAccessToken?: () => Promise<string | null>;
  /** Required for safe POST retries. Reused as the server idempotency key. */
  idempotencyKey?: string;
  /** Per-attempt timeout. Default 30_000. Server render budget is 90s (§5) but
   *  the edge fn queues async and returns fast — client must not hold 90s. */
  timeoutMs?: number;
  /** Max retries after the first attempt. Default: 1 when idempotent, else 0. */
  retries?: number;
  /** Base backoff delay. Default 800ms, exponential with jitter. */
  baseDelayMs?: number;
}

export class ConfigError extends Error {
  readonly code = 'config-missing';
  constructor(variable: string) {
    super(
      `Missing ${variable}. Copy .env.example to .env and fill it (public vars only — never server secrets).`,
    );
    this.name = 'ConfigError';
  }
}

export type EdgeErrorCode =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict-duplicate'
  | 'rate-limited'
  | 'quota-exhausted'
  | 'upstream-failed'
  | 'upstream-timeout'
  | 'bad-request'
  | 'server';

export class EdgeError extends Error {
  readonly fn: EdgeFnName;
  readonly status: number;
  readonly code: EdgeErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(args: {
    fn: EdgeFnName;
    status: number;
    code: EdgeErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(args.message);
    this.name = 'EdgeError';
    this.fn = args.fn;
    this.status = args.status;
    this.code = args.code;
    this.retryable = args.retryable;
    if (args.retryAfterMs !== undefined) this.retryAfterMs = args.retryAfterMs;
  }
}

/** Read a public env var or throw an actionable ConfigError. */
export function getPublicEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(name);
  return value;
}

function supabaseFunctionsBase(): string {
  return `${getPublicEnv('EXPO_PUBLIC_SUPABASE_URL').replace(/\/$/, '')}/functions/v1`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter: min(cap, base * 2^attempt) randomized. */
export function backoffMs(attempt: number, baseMs: number, capMs = 10_000): number {
  const grown = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * grown);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function classifyStatus(
  status: number,
  bodyText: string,
): { code: EdgeErrorCode; retryable: boolean } {
  if (status === 401) return { code: 'unauthorized', retryable: false };
  if (status === 403) return { code: 'forbidden', retryable: false };
  if (status === 404) return { code: 'not-found', retryable: false };
  if (status === 409) return { code: 'conflict-duplicate', retryable: false };
  if (status === 429) {
    const quota = /quota|credit|limit/i.test(bodyText);
    return quota
      ? { code: 'quota-exhausted', retryable: false }
      : { code: 'rate-limited', retryable: true };
  }
  if (status === 408 || status === 504) return { code: 'upstream-timeout', retryable: true };
  if (status >= 500) return { code: 'upstream-failed', retryable: true };
  if (status >= 400) return { code: 'bad-request', retryable: false };
  return { code: 'server', retryable: true };
}

async function resolveToken(opts: EdgeCallOptions): Promise<string | null> {
  if (opts.getAccessToken) {
    try {
      return await opts.getAccessToken();
    } catch {
      return opts.authToken ?? null;
    }
  }
  return opts.authToken ?? null;
}

/**
 * POST JSON to a Supabase edge function with timeout + classified errors.
 * Retries ONLY when an idempotency key is present (POSTs are not otherwise
 * safe to replay — the server dedups on `idempotency_key`, pack §5).
 */
export async function callEdgeFunction<TResponse>(
  fn: EdgeFnName,
  body: Record<string, unknown>,
  opts: EdgeCallOptions = {},
): Promise<TResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const requestedRetries = opts.retries ?? (opts.idempotencyKey ? 1 : 0);
  // Hard rule: never auto-replay a non-idempotent POST.
  const maxRetries = opts.idempotencyKey ? requestedRetries : 0;
  if (requestedRetries > 0 && !opts.idempotencyKey && __DEV__) {
    console.warn(
      `[edge:${fn}] retries requested without idempotencyKey — disabled to avoid double-charge.`,
    );
  }

  const url = `${supabaseFunctionsBase()}/${fn}`;
  const anonKey = getPublicEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  const token = await resolveToken(opts);

  let lastError: EdgeError | Error = new Error('unreachable');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: anonKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          opts.idempotencyKey ? { ...body, idempotency_key: body['idempotency_key'] ?? opts.idempotencyKey } : body,
        ),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const { code, retryable } = classifyStatus(res.status, text);
        const err = new EdgeError({
          fn,
          status: res.status,
          code,
          message: `${fn} failed (${res.status}): ${text.slice(0, 300)}`,
          retryable,
          retryAfterMs: parseRetryAfterMs(res.headers.get('Retry-After')),
        });
        lastError = err;
        if (!retryable || attempt === maxRetries) throw err;
      } else {
        try {
          return JSON.parse(text) as TResponse;
        } catch {
          throw new EdgeError({
            fn,
            status: res.status,
            code: 'server',
            message: `${fn} returned non-JSON: ${text.slice(0, 200)}`,
            retryable: false,
          });
        }
      }
    } catch (e) {
      if (e instanceof EdgeError) {
        lastError = e;
        if (!e.retryable || attempt === maxRetries) throw e;
      } else if (e instanceof Error && e.name === 'AbortError') {
        lastError = new EdgeError({
          fn,
          status: 408,
          code: 'timeout',
          message: `${fn} timed out after ${timeoutMs}ms (attempt ${attempt + 1})`,
          retryable: true,
        });
        if (attempt === maxRetries) throw lastError;
      } else {
        const net = new EdgeError({
          fn,
          status: 0,
          code: 'network',
          message: `${fn} network error: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        });
        lastError = net;
        if (attempt === maxRetries) throw net;
      }
    } finally {
      clearTimeout(timer);
    }
    const wait = lastError instanceof EdgeError && lastError.retryAfterMs !== undefined
      ? lastError.retryAfterMs
      : backoffMs(attempt, baseDelayMs);
    await sleep(wait);
  }
  throw lastError;
}

/**
 * Build a deterministic idempotency key: sha256(joined parts), hex.
 * Pack §5 canonical form for renders: sha256(user|base|outfit|day).
 * Uses expo-crypto (already a dependency) — never Math.random here.
 */
export async function generateIdempotencyKey(parts: Array<string | number>): Promise<string> {
  const Crypto = await import('expo-crypto');
  const joined = parts.map((p) => String(p)).join('|');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, joined);
}
