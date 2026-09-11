/**
 * VAI perf — measurement layer.
 *
 * Every budget in PERF-BUDGETS.md maps to an event/metric here. This module
 * owns NAMES + TIMERS only; the actual PostHog/Sentry clients live in
 * integrations (lib/analytics.ts) and are injected as sinks. That keeps
 * lib/perf importable in tests without native modules.
 *
 * PostHog convention (BUILD-PACK §10): every event carries
 * { user_id, tier, render_model?, cost_usd? } — integrations add them.
 */
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Sinks (implemented by integrations)
// ---------------------------------------------------------------------------

export interface AnalyticsSink {
  capture(event: string, props?: Record<string, unknown>): void;
}

export interface ErrorSink {
  captureException(err: unknown, context?: Record<string, unknown>): void;
  /** Cold-start TTI, render latency, upload latency -> Sentry measurements. */
  setMeasurement?(name: string, valueMs: number, unit?: string): void;
  breadcrumb?(message: string, data?: Record<string, unknown>): void;
}

const noopAnalytics: AnalyticsSink = { capture: () => undefined };
const noopErrors: ErrorSink = { captureException: () => undefined };

let analytics: AnalyticsSink = noopAnalytics;
let errors: ErrorSink = noopErrors;

export function initPerfTelemetry(opts: {
  analytics: AnalyticsSink;
  errors: ErrorSink;
}): void {
  analytics = opts.analytics;
  errors = opts.errors;
}

// ---------------------------------------------------------------------------
// Event names (subset of BUILD-PACK §10 that perf owns measuring)
// ---------------------------------------------------------------------------

export const PerfEvents = {
  coldStart: 'perf_cold_start', // { tti_ms, prewarm_ms, from_push }
  imageCompressed: 'perf_image_compressed', // { kind, in_bytes, out_bytes, quality }
  baseGateFailed: 'perf_base_gate_failed', // { reasons[] } -> tune thresholds
  uploadCompleted: 'perf_upload_completed', // { kind, bytes, attempts, resumed, latency_ms }
  uploadFailed: 'perf_upload_failed', // { kind, attempts, error }
  renderRequested: 'render_requested', // { mode, tier, deduped, cooldown_hit }
  renderSettled: 'render_settled', // { mode, tier, latency_ms, restyle_n, outcome, render_model, cost_usd }
  quotaBlocked: 'quota_blocked', // { reason, placement }
  cacheOutcome: 'perf_cache', // { namespace, hit|stale|miss }
  listJank: 'perf_list_jank', // { list, blank_cells, avg_js_fps }
  outboxFlushed: 'perf_outbox_flushed', // { flushed, dead_lettered }
  reelPrefetch: 'perf_reel_prefetch', // { requested, prefetched, dropped, failed_count, offline, visible_index }
  reelTti: 'perf_reel_tti', // { tti_ms, from_cache } — reel tab time-to-interactive
  pinPrefetch: 'perf_pin_prefetch', // { requested, prefetched, dropped, failed_count, offline, visible_index, surface }
  pinTti: 'perf_pin_tti', // { tti_ms, from_cache } — board-picker time-to-interactive
} as const;

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/** Monotonic-ish ms clock (Date.now is fine for durations on device). */
export const nowMs = (): number => Date.now();

export class PerfTimer {
  private readonly start = nowMs();
  constructor(readonly label: string) {}
  elapsedMs(): number {
    return nowMs() - this.start;
  }
  /** Report to Sentry measurement + return ms for PostHog props. */
  stop(measurementName?: string): number {
    const ms = this.elapsedMs();
    try {
      errors.setMeasurement?.(measurementName ?? this.label, ms, 'millisecond');
    } catch {
      /* telemetry must never crash the app */
    }
    return ms;
  }
}

// ---------------------------------------------------------------------------
// Convenience reporters (all no-op safe before initPerfTelemetry)
// ---------------------------------------------------------------------------

export function reportColdStart(ttiMs: number, opts?: { fromPush?: boolean }): void {
  try {
    analytics.capture(PerfEvents.coldStart, {
      tti_ms: Math.round(ttiMs),
      platform: Platform.OS,
      from_push: opts?.fromPush ?? false,
    });
    errors.setMeasurement?.('app.tti', ttiMs, 'millisecond');
  } catch {
    /* never crash */
  }
}

/**
 * Gemini model names for telemetry defaults. Must match PRIMARY_IMAGE_MODEL /
 * FALLBACK_IMAGE_MODEL in lib/ai/gemini.ts (kept as literals so lib/perf
 * stays importable without the integrations layer). The `render_model`
 * reported on render events is ALWAYS the server-authoritative value
 * (TryOnResult.model ← edge fn `model`/`cost_usd`); these are fallbacks for
 * legacy call sites that have no server result yet.
 */
export const GEMINI_FLASH_TELEMETRY_MODEL = 'gemini-3.1-flash-image' as const;
export const GEMINI_PRO_TELEMETRY_MODEL = 'gemini-3-pro-image' as const;

export function reportRenderSettled(opts: {
  mode: string;
  tier: string;
  latencyMs: number;
  outcome: 'done' | 'failed';
  restyleN?: number;
  /** Server-authoritative model (TryOnResult.model). Defaults to Gemini Flash primary. */
  renderModel?: string;
  /** Server-authoritative cost USD (TryOnResult.costUsd). 0 for cached/failed-free. */
  costUsd?: number;
}): void {
  try {
    analytics.capture(PerfEvents.renderSettled, {
      // Never infer the model from tier: Max tier is usually still Flash (2K);
      // pro-image and fashn-legacy surface only when the server routes there.
      render_model: opts.renderModel ?? GEMINI_FLASH_TELEMETRY_MODEL,
      cost_usd: opts.costUsd ?? 0,
      latency_ms: Math.round(opts.latencyMs),
      outcome: opts.outcome,
      restyle_n: opts.restyleN ?? 0,
      mode: opts.mode,
      tier: opts.tier,
    });
    errors.setMeasurement?.('render.latency', opts.latencyMs, 'millisecond');
  } catch {
    /* never crash */
  }
}

export function reportQuotaBlocked(reason: string, placement: string): void {
  try {
    analytics.capture(PerfEvents.quotaBlocked, { reason, placement });
    errors.breadcrumb?.('quota blocked', { reason, placement });
  } catch {
    /* never crash */
  }
}

/**
 * Reel tab TTI (open → first card interactive). `fromCache` distinguishes the
 * <1.5 s cached budget from cold fetch. Sentry mirror: `reel.tti`.
 */
export function reportReelTti(ttiMs: number, opts?: { fromCache?: boolean }): void {
  try {
    analytics.capture(PerfEvents.reelTti, {
      tti_ms: Math.round(ttiMs),
      from_cache: opts?.fromCache ?? false,
      platform: Platform.OS,
    });
    errors.setMeasurement?.('reel.tti', ttiMs, 'millisecond');
  } catch {
    /* never crash */
  }
}

/**
 * Board-picker TTI (open → grid interactive). `fromCache` distinguishes the
 * <1.5 s cached budget from cold fetch. Sentry mirror: `pin.tti`.
 */
export function reportPinBoardTti(ttiMs: number, opts?: { fromCache?: boolean }): void {
  try {
    analytics.capture(PerfEvents.pinTti, {
      tti_ms: Math.round(ttiMs),
      from_cache: opts?.fromCache ?? false,
      platform: Platform.OS,
    });
    errors.setMeasurement?.('pin.tti', ttiMs, 'millisecond');
  } catch {
    /* never crash */
  }
}

export function reportError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    errors.captureException(err, context);
  } catch {
    /* never crash */
  }
}
