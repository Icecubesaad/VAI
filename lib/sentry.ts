/**
 * VAI · Sentry error reporting (integrations turf).
 *
 * DEP: @sentry/react-native (lazy-imported; missing DSN ⇒ graceful no-op so
 * error reporting can never crash the app — with a __DEV__ warning so a
 * missing DSN is caught before release).
 *
 * DSN handling: EXPO_PUBLIC_SENTRY_DSN is a PUBLIC value (safe client-side;
 * Sentry DSNs are designed to be embedded). Do NOT add to .env.example here —
 * root configs are founder-owned; the required key is listed in
 * CONTRACT-integrations.md + DEPS-integrations.txt for the founder to wire.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SentryModule = any;

let sentry: SentryModule | null = null;
let ready = false;

export interface SentryInitOptions {
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
}

async function load(): Promise<SentryModule | null> {
  if (sentry) return sentry;
  const dsn = process.env['EXPO_PUBLIC_SENTRY_DSN'];
  if (!dsn) {
    if (__DEV__) console.warn('[sentry] EXPO_PUBLIC_SENTRY_DSN missing — errors log to console only.');
    return null;
  }
  try {
    const mod = await import('@sentry/react-native');
    sentry = mod;
    return sentry;
  } catch {
    if (__DEV__) console.warn('[sentry] @sentry/react-native unavailable — errors log to console only.');
    return null;
  }
}

export async function initSentry(opts: SentryInitOptions = {}): Promise<void> {
  const S = await load();
  if (!S || ready) return;
  S.init({
    dsn: process.env['EXPO_PUBLIC_SENTRY_DSN'],
    environment: opts.environment ?? (__DEV__ ? 'development' : 'production'),
    tracesSampleRate: opts.tracesSampleRate ?? (__DEV__ ? 0 : 0.1),
    enableAutoSessionTracking: true,
  });
  ready = true;
}

export function setSentryUser(userId: string | null, extras?: Record<string, unknown>): void {
  if (!sentry || !ready) return;
  try {
    sentry.setUser(userId ? { id: userId, ...extras } : null);
  } catch {
    /* non-blocking */
  }
}

export function sentryBreadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!sentry || !ready) return;
  try {
    sentry.addBreadcrumb({ message, data, level: 'info' });
  } catch {
    /* non-blocking */
  }
}

/**
 * Capture an exception with render-pipeline tags. Always safe to call —
 * falls back to console.error when Sentry is not configured.
 */
export function captureError(
  err: unknown,
  ctx?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    renderId?: string;
    model?: string;
    costUsd?: number;
  },
): void {
  const tags = { ...(ctx?.tags ?? {}) };
  if (ctx?.renderId) tags['render_id'] = ctx.renderId;
  if (ctx?.model) tags['render_model'] = ctx.model;
  const extra = { ...(ctx?.extra ?? {}) };
  if (ctx?.costUsd !== undefined) extra['cost_usd'] = ctx.costUsd;
  if (!sentry || !ready) {
    if (__DEV__) console.error('[sentry:fallback]', err, { tags, extra });
    return;
  }
  try {
    sentry.withScope?.((scope: { setTags: (t: unknown) => void; setExtras: (e: unknown) => void }) => {
      scope.setTags(tags);
      scope.setExtras(extra);
      sentry.captureException(err);
    });
  } catch {
    if (__DEV__) console.error('[sentry:fallback]', err);
  }
}
