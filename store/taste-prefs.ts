import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from './mmkv';
import { api, type PoseModeDefault, type SyncCadence } from '@/lib/api';

export type { PoseModeDefault, SyncCadence } from '@/lib/api';

/** Server defaults (migration 0006): weekly cadence, auto pose, 60 influence. */
export const TASTE_PREFS_DEFAULTS = {
  syncCadence: 'weekly',
  poseModeDefault: 'auto',
  styleInfluence: 60,
} as const;

/** Settings cycle order for the single "Style refresh" row. */
export const SYNC_CADENCE_ORDER: SyncCadence[] = ['daily', 'weekly', 'off'];

export function syncCadenceLabel(c: SyncCadence): string {
  return c === 'daily' ? 'Daily' : c === 'off' ? 'Off' : 'Weekly';
}

/** UI exposes two pose prefs: Auto (default) / My poses only. */
export function posePrefLabel(p: PoseModeDefault): string {
  return p === 'keep' ? 'My poses only' : 'Auto';
}

interface TastePrefsState {
  syncCadence: SyncCadence;
  /** UI writes 'auto' | 'keep' only; 'adapt' is accepted on READ (server truth). */
  poseModeDefault: PoseModeDefault;
  styleInfluence: number;
  /** True when the last server flush failed — local values remain the truth. */
  pendingSync: boolean;
  lastSyncedAt: string | null;

  setSyncCadence: (c: SyncCadence) => void;
  setPoseModeDefault: (p: Extract<PoseModeDefault, 'auto' | 'keep'>) => void;
  setStyleInfluence: (n: number) => void;
  /** Best-effort flush of the current local prefs. Never throws. */
  flushPrefs: () => Promise<void>;
  /** Best-effort pull of server prefs into local state. Never throws. */
  fetchPrefs: () => Promise<void>;
  reset: () => void;
}

type TastePrefsPersisted = Pick<
  TastePrefsState,
  'syncCadence' | 'poseModeDefault' | 'styleInfluence' | 'pendingSync' | 'lastSyncedAt'
>;

/**
 * Invisible-autopilot prefs (MMKV, default weekly). Every setter persists
 * locally FIRST (queue), then flushes via the single `api.updateTastePrefs`
 * inside try/catch — a missing taste-build fn, airplane mode, or a 5xx
 * leaves local truth intact with `pendingSync=true` and never crashes.
 */
export const useTastePrefs = create<TastePrefsState>()(
  persist<TastePrefsState, [], [], TastePrefsPersisted>(
    (set, get) => {
      const flush = async () => {
        const s = get();
        try {
          const prefs = await api.updateTastePrefs({
            syncCadence: s.syncCadence,
            poseModeDefault: s.poseModeDefault,
            styleInfluence: s.styleInfluence,
          });
          // Converge on server echoes (clamped values) without dropping
          // newer local edits made mid-flight.
          const cur = get();
          set({
            syncCadence: cur.syncCadence === s.syncCadence ? prefs.syncCadence : cur.syncCadence,
            poseModeDefault:
              cur.poseModeDefault === s.poseModeDefault ? prefs.poseModeDefault : cur.poseModeDefault,
            styleInfluence:
              cur.styleInfluence === s.styleInfluence ? prefs.styleInfluence : cur.styleInfluence,
            pendingSync: false,
            lastSyncedAt: new Date().toISOString(),
          });
        } catch {
          set({ pendingSync: true });
        }
      };
      return {
        syncCadence: TASTE_PREFS_DEFAULTS.syncCadence,
        poseModeDefault: TASTE_PREFS_DEFAULTS.poseModeDefault,
        styleInfluence: TASTE_PREFS_DEFAULTS.styleInfluence,
        pendingSync: false,
        lastSyncedAt: null,
        setSyncCadence: (syncCadence) => {
          set({ syncCadence, pendingSync: true });
          void flush();
        },
        setPoseModeDefault: (poseModeDefault) => {
          set({ poseModeDefault, pendingSync: true });
          void flush();
        },
        setStyleInfluence: (styleInfluence) => {
          set({ styleInfluence, pendingSync: true });
          void flush();
        },
        flushPrefs: flush,
        fetchPrefs: async () => {
          try {
            const prefs = await api.fetchTastePrefs();
            set({
              syncCadence: prefs.syncCadence,
              poseModeDefault: prefs.poseModeDefault,
              styleInfluence: prefs.styleInfluence,
              pendingSync: false,
              lastSyncedAt: new Date().toISOString(),
            });
          } catch {
            // Offline / fn missing: local MMKV values stay the truth.
          }
        },
        reset: () =>
          set({
            syncCadence: TASTE_PREFS_DEFAULTS.syncCadence,
            poseModeDefault: TASTE_PREFS_DEFAULTS.poseModeDefault,
            styleInfluence: TASTE_PREFS_DEFAULTS.styleInfluence,
            pendingSync: false,
            lastSyncedAt: null,
          }),
      };
    },
    {
      name: 'vai-taste-prefs',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
      partialize: (s) => ({
        syncCadence: s.syncCadence,
        poseModeDefault: s.poseModeDefault,
        styleInfluence: s.styleInfluence,
        pendingSync: s.pendingSync,
        lastSyncedAt: s.lastSyncedAt,
      }),
    },
  ),
);
