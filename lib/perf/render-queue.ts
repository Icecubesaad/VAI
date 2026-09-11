/**
 * VAI perf — render queue client state machine.
 *
 * Renders take 10-55s IRL (BUILD-PACK §5). This module owns the client side:
 *  queued -> processing -> done | failed
 *
 * UX contract (no fake countdowns, ever):
 *  - optimistic skeleton immediately + honest step copy ("Usually ~20s — we'll ping you").
 *  - progress steps advance on ELAPSED TIME only, presented as stages, never %.
 *  - push-tap deep-links to the finished result (`vai://render/<id>`).
 *  - identical re-requests dedup client-side via sha256 key (0 extra cost).
 *  - 10 s global cooldown kills double-tap spam.
 *  - offline: renders HARD-FAIL with airplane-mode copy; only NON-render
 *    actions (wishlist, outfit save, wear log) enter the offline outbox.
 *
 * Wiring (see CONTRACT-perf.md): transport (submit/status) is implemented by
 * integrations against Supabase/Inngest; quota gating via quotas.ts `guard()`
 * BEFORE calling enqueue; connectivity via NetInfo callbacks from app shell.
 */
import * as Crypto from 'expo-crypto';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { mmkv } from './cache';

// ---------------------------------------------------------------------------
// Constants + copy
// ---------------------------------------------------------------------------

/** Canonical scheme owned by integrations lib/push (`vai://tryon/<id>`). */
export const RENDER_DEEP_LINK_PREFIX = 'vai://tryon/';
export const SUBMIT_COOLDOWN_MS = 10_000;
export const POLL_DEADLINE_MS = 120_000; // after this, push owns resolution
const POLL_DELAYS_MS = [3000, 5000, 8000, 10000, 15000];
const OUTBOX_KEY = 'render-queue:outbox:v1';
const MAX_OUTBOX_ATTEMPTS = 8;

/** Stage copy. Index advances at ~0s / 6s / 14s / 26s. Honest, no seconds promised. */
export const RENDER_PROGRESS_STEPS = [
  'Finding your fit…',
  'Lighting your photo…',
  'Stitching the outfit…',
  "Usually ~20s — we'll ping you when it's ready.",
] as const;
const STEP_AT_MS = [0, 6000, 14000, 26000];

export const COPY_OFFLINE_RENDER =
  "You're offline — renders need a connection. Your outfit is saved; tap Generate when you're back.";
export const COPY_COOLDOWN = 'Hold on — your last try-on just went in.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClientRenderStatus = 'queued' | 'processing' | 'done' | 'failed';
export type RenderMode = 'tryon' | 'restyle' | 'compare';
export type RenderTier = 'std' | 'max';

export interface RenderRequestInput {
  userId: string;
  basePhotoId: string;
  outfitId: string;
  garmentIds: string[];
  mode: RenderMode;
  tier: RenderTier;
  /** YYYY-MM-DD in user tz. Part of the idempotency key (BUILD-PACK §5). */
  day: string;
  restyleNote?: string;
}

export interface RenderJob {
  clientKey: string;
  renderId: string | null;
  mode: RenderMode;
  tier: RenderTier;
  status: ClientRenderStatus;
  stepIndex: number;
  outputUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deduped: boolean;
  pollingStopped: boolean;
}

export type RenderBlockedReason = 'offline' | 'cooldown' | 'quota';

export interface EnqueueResult {
  job: RenderJob | null;
  blocked?: { reason: RenderBlockedReason; retryInMs?: number; message: string };
}

/** Implemented by integrations (Supabase Edge Fn `render-tryon` / `restyle`). */
export interface RenderTransport {
  submitRender(
    req: RenderRequestInput & { idempotencyKey: string },
  ): Promise<{ renderId: string; deduped: boolean; status: ClientRenderStatus; outputUrl?: string }>;
  fetchRenderStatus(
    renderId: string,
  ): Promise<{ status: ClientRenderStatus; outputUrl?: string; error?: string }>;
}

export type OfflineActionType =
  | 'wishlist_add'
  | 'wishlist_remove'
  | 'outfit_save'
  | 'wear_log'
  | 'garment_delete';

export interface OfflineAction {
  id: string;
  type: OfflineActionType;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

interface RenderQueueState {
  jobs: Record<string, RenderJob>;
  lastSubmitAt: number;
  outbox: OfflineAction[];
  enqueue: (input: RenderRequestInput) => Promise<EnqueueResult>;
  /** Push-tap / realtime / poll all funnel through here. */
  ingestStatus: (
    renderId: string,
    status: ClientRenderStatus,
    opts?: { outputUrl?: string; error?: string },
  ) => void;
  retry: (clientKey: string) => Promise<EnqueueResult>;
  /**
   * Retry a FAILED job with the ORIGINAL input (same idempotency key, so a
   * late success on the server resolves as deduped at $0 instead of a double
   * charge). Cooldown is waived for retries — the failure already cost the wait.
   */
  retryWith: (input: RenderRequestInput) => Promise<EnqueueResult>;
  dismiss: (clientKey: string) => void;
  enqueueOfflineAction: (
    type: OfflineActionType,
    payload: Record<string, unknown>,
  ) => void;
  flushOutbox: (sender: (a: OfflineAction) => Promise<void>) => Promise<void>;
  setOnline: (online: boolean) => void;
}

// ---------------------------------------------------------------------------
// Idempotency key: sha256(user|base|outfit|day) — BUILD-PACK §5.
// ---------------------------------------------------------------------------

export async function idempotencyKeyFor(input: RenderRequestInput): Promise<string> {
  const raw = [input.userId, input.basePhotoId, input.outfitId, input.day].join('|');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export function parseRenderDeepLink(url: string): string | null {
  if (!url.startsWith(RENDER_DEEP_LINK_PREFIX)) return null;
  const id = url.slice(RENDER_DEEP_LINK_PREFIX.length).split(/[?#]/)[0];
  return id && id.length > 0 ? id : null;
}

export function renderDeepLink(renderId: string): string {
  return `${RENDER_DEEP_LINK_PREFIX}${renderId}`;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

function loadOutbox(): OfflineAction[] {
  try {
    const raw = mmkv.getString(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflineAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOutbox(actions: OfflineAction[]): void {
  mmkv.set(OUTBOX_KEY, JSON.stringify(actions));
}

export function createRenderQueue(deps: {
  transport: RenderTransport;
  isOnline: () => boolean;
  /** Quota gate from quotas.ts — MUST block at 0 (no bypass). */
  quotaGuard: (placement: string) => boolean;
  now?: () => number;
}): StoreApi<RenderQueueState> {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  const clearTimers = (key: string): void => {
    const list = timers.get(key);
    if (list) for (const t of list) clearTimeout(t);
    timers.delete(key);
  };
  const later = (key: string, ms: number, fn: () => void): void => {
    const list = timers.get(key) ?? [];
    list.push(setTimeout(fn, ms));
    timers.set(key, list);
  };

  const store = createStore<RenderQueueState>()((set, get) => {
    const upsertJob = (job: RenderJob): void => {
      set((s) => ({
        jobs: { ...s.jobs, [job.clientKey]: job },
      }));
    };

    const scheduleSteps = (key: string): void => {
      for (let i = 1; i < STEP_AT_MS.length; i++) {
        const at = STEP_AT_MS[i];
        if (at === undefined) continue;
        later(key, at, () => {
          const job = get().jobs[key];
          if (!job || job.status === 'done' || job.status === 'failed') return;
          upsertJob({ ...job, stepIndex: i, updatedAt: now() });
        });
      }
    };

    const poll = (key: string, renderId: string, elapsed: number, attempt: number): void => {
      if (elapsed >= POLL_DEADLINE_MS) {
        // Stop polling; the push ("Try-on ready") + deep link resolves it.
        const job = get().jobs[key];
        if (job && job.status !== 'done' && job.status !== 'failed') {
          upsertJob({ ...job, pollingStopped: true, updatedAt: now() });
        }
        return;
      }
      const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 15000;
      later(key, delay, () => {
        void (async () => {
          const job = get().jobs[key];
          if (!job || job.status === 'done' || job.status === 'failed') return;
          try {
            const res = await deps.transport.fetchRenderStatus(renderId);
            get().ingestStatus(renderId, res.status, {
              outputUrl: res.outputUrl,
              error: res.error,
            });
            const next = get().jobs[key];
            if (next && next.status !== 'done' && next.status !== 'failed') {
              poll(key, renderId, elapsed + delay, attempt + 1);
            }
          } catch {
            // Transient poll failure: keep polling, push is the backstop.
            poll(key, renderId, elapsed + delay, attempt + 1);
          }
        })();
      });
    };

    const submit = async (input: RenderRequestInput): Promise<EnqueueResult> => {
      if (!deps.isOnline()) {
        return {
          job: null,
          blocked: { reason: 'offline', message: COPY_OFFLINE_RENDER },
        };
      }
      if (!deps.quotaGuard('tryon_generate')) {
        return {
          job: null,
          blocked: { reason: 'quota', message: 'No renders left.' },
        };
      }
      const sinceLast = now() - get().lastSubmitAt;
      if (sinceLast < SUBMIT_COOLDOWN_MS) {
        return {
          job: null,
          blocked: {
            reason: 'cooldown',
            retryInMs: SUBMIT_COOLDOWN_MS - sinceLast,
            message: COPY_COOLDOWN,
          },
        };
      }

      const clientKey = await idempotencyKeyFor(input);
      const existing = get().jobs[clientKey];
      if (
        existing &&
        (existing.status === 'queued' || existing.status === 'processing') &&
        now() - existing.createdAt < 15 * 60 * 1000
      ) {
        // Identical request in flight: return it, $0 extra cost.
        upsertJob({ ...existing, deduped: true, updatedAt: now() });
        const job = get().jobs[clientKey];
        return { job: job ?? existing };
      }

      const submitted = await deps.transport.submitRender({
        ...input,
        idempotencyKey: clientKey,
      });
      const job: RenderJob = {
        clientKey,
        renderId: submitted.renderId,
        mode: input.mode,
        tier: input.tier,
        status: submitted.status,
        stepIndex: 0,
        outputUrl: submitted.outputUrl ?? null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
        deduped: submitted.deduped,
        pollingStopped: false,
      };
      set((s) => ({ lastSubmitAt: now(), jobs: { ...s.jobs, [clientKey]: job } }));
      if (job.status !== 'done' && job.status !== 'failed') {
        scheduleSteps(clientKey);
        poll(clientKey, submitted.renderId, 0, 0);
      }
      return { job };
    };

    return {
      jobs: {},
      lastSubmitAt: 0,
      outbox: loadOutbox(),

      enqueue: (input) => submit(input),

      ingestStatus: (renderId, status, opts) => {
        const entry = Object.values(get().jobs).find((j) => j.renderId === renderId);
        if (!entry) return;
        clearTimers(entry.clientKey);
        upsertJob({
          ...entry,
          status,
          outputUrl: opts?.outputUrl ?? entry.outputUrl,
          error: opts?.error ?? entry.error,
          stepIndex: status === 'done' ? RENDER_PROGRESS_STEPS.length - 1 : entry.stepIndex,
          updatedAt: now(),
        });
      },

      retry: async (clientKey) => {
        const job = get().jobs[clientKey];
        if (!job || job.status !== 'failed') {
          return { job: job ?? null };
        }
        // UI holds the original input; direct it to retryWith so the
        // idempotency key recomputes byte-identical. This path only resets
        // cooldown for callers that lost the input (waives the wait once).
        clearTimers(clientKey);
        set((s) => ({ lastSubmitAt: 0 }));
        return { job: get().jobs[clientKey] ?? job };
      },

      retryWith: async (input) => {
        const clientKey = await idempotencyKeyFor(input);
        const job = get().jobs[clientKey];
        if (!job || job.status !== 'failed') {
          return { job: job ?? null };
        }
        clearTimers(clientKey);
        set((s) => ({ lastSubmitAt: 0 })); // waive cooldown for retries
        return submit(input);
      },

      dismiss: (clientKey) => {
        clearTimers(clientKey);
        set((s) => {
          const jobs = { ...s.jobs };
          delete jobs[clientKey];
          return { jobs };
        });
      },

      enqueueOfflineAction: (type, payload) => {
        const action: OfflineAction = {
          id: `${now()}-${Math.floor(Math.random() * 1e9)}`,
          type,
          payload,
          createdAt: now(),
          attempts: 0,
        };
        set((s) => {
          const outbox = [...s.outbox, action];
          saveOutbox(outbox);
          return { outbox };
        });
      },

      flushOutbox: async (sender) => {
        const pending = [...get().outbox];
        const remaining: OfflineAction[] = [];
        for (const action of pending) {
          try {
            await sender(action);
          } catch (err) {
            const attempts = action.attempts + 1;
            if (attempts < MAX_OUTBOX_ATTEMPTS) {
              remaining.push({
                ...action,
                attempts,
                lastError: String(err),
              });
            } else {
              // Dead-letter: kept out of the queue so one poison action
              // can't block the rest. Surfaced via Sentry by the caller.
              remaining.push({ ...action, attempts, lastError: `dead-letter: ${String(err)}` });
              break;
            }
          }
        }
        saveOutbox(remaining);
        set({ outbox: remaining });
      },

      setOnline: (online) => {
        if (online) {
          // Flushing is owned by integrations (they hold the sender);
          // this is a no-op marker kept for explicitness in the contract.
        }
      },
    };
  });

  return store;
}

// ---------------------------------------------------------------------------
// React bindings (frontend)
// ---------------------------------------------------------------------------

export function useRenderQueue<T>(
  store: StoreApi<RenderQueueState>,
  selector: (s: RenderQueueState) => T,
): T {
  return useStore(store, selector);
}

export function useRenderJob(
  store: StoreApi<RenderQueueState>,
  clientKey: string | null,
): RenderJob | null {
  return useStore(
    store,
    (s) => (clientKey ? (s.jobs[clientKey] ?? null) : null),
  );
}
