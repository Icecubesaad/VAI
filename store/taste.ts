import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from './mmkv';
import { api, type PinterestBoard, type PoseMode, type PosePin, type SyncCadence } from '@/lib/api';

export type { PinterestBoard, PoseMode, PosePin, SyncCadence } from '@/lib/api';

/** Segmented-control labels: [My pose | Pin pose]. */
export const POSE_MODE_OPTIONS: Array<{ value: PoseMode; label: string }> = [
  { value: 'keep', label: 'My pose' },
  { value: 'adapt', label: 'Pin pose' },
];

export function poseModeLabel(mode: PoseMode): string {
  return mode === 'adapt' ? 'Pin pose' : 'My pose';
}

interface TasteState {
  /** Pinterest OAuth linked (server holds the token; client holds taste). */
  connected: boolean;
  /** Pinterest username shown in the settings row. */
  username: string | null;
  /** Last-known board list (synced via pinterest-sync list). */
  boards: PinterestBoard[];
  /** Default pose_mode for try-ons + reel remixes (per-render override wins). */
  defaultPoseMode: PoseMode;
  /** Pose-marked pin cache feeding the pin picker grid. */
  poseRefs: PosePin[];
  /** ISO timestamp of the last pose-ref cache fill. */
  poseRefsAt: string | null;
  /** Post-first-tryon "Style with your Pinterest taste" upsell dismissed. */
  tasteUpsellDismissed: boolean;
  /**
   * Style-refresh cadence (taste-build prefs; MMKV default weekly).
   * Local-first: setters persist immediately, then best-effort flush via
   * the single `api.updateTastePrefs` — a missing fn / airplane mode / 5xx
   * leaves local truth intact with `cadencePending=true` and never throws.
   */
  cadence: SyncCadence;
  /** True when the last cadence flush failed — local value stays the truth. */
  cadencePending: boolean;
  /** ISO timestamp of the last successful cadence flush (settings caption). */
  lastSyncedAt: string | null;

  setConnection: (p: { username: string | null; boards: PinterestBoard[] }) => void;
  setBoards: (boards: PinterestBoard[]) => void;
  setPoseRefs: (pins: PosePin[]) => void;
  setDefaultPoseMode: (mode: PoseMode) => void;
  setCadence: (cadence: SyncCadence) => void;
  /** Best-effort flush of the current local cadence. Never throws. */
  flushCadence: () => Promise<void>;
  dismissTasteUpsell: () => void;
  /** Disconnect purge: drops connection + boards + pose refs, keeps the
   *  pose default + upsell flag (preferences, not taste data). */
  disconnect: () => void;
  reset: () => void;
}

const initial: Pick<
  TasteState,
  | 'connected'
  | 'username'
  | 'boards'
  | 'defaultPoseMode'
  | 'poseRefs'
  | 'poseRefsAt'
  | 'tasteUpsellDismissed'
  | 'cadence'
  | 'cadencePending'
  | 'lastSyncedAt'
> = {
  connected: false,
  username: null,
  boards: [],
  defaultPoseMode: 'keep',
  poseRefs: [],
  poseRefsAt: null,
  tasteUpsellDismissed: false,
  cadence: 'weekly',
  cadencePending: false,
  lastSyncedAt: null,
};

type TastePersisted = Pick<
  TasteState,
  | 'connected'
  | 'username'
  | 'boards'
  | 'defaultPoseMode'
  | 'poseRefs'
  | 'poseRefsAt'
  | 'tasteUpsellDismissed'
  | 'cadence'
  | 'cadencePending'
  | 'lastSyncedAt'
>;

export const useTaste = create<TasteState>()(
  persist<TasteState, [], [], TastePersisted>(
    (set, get) => {
      // Best-effort cadence flush (queue+flush): persists locally FIRST via
      // setCadence, then POSTs taste-build prefs. Any failure (missing fn,
      // shape drift, offline, 5xx) marks pending and never throws — Settings
      // stays interactive on stale-local truth.
      const flushCadence = async () => {
        const s = get();
        try {
          await api.updateTastePrefs({ syncCadence: s.cadence });
          // Converge without dropping a newer local edit made mid-flight.
          const cur = get();
          if (cur.cadence === s.cadence) {
            set({ cadencePending: false, lastSyncedAt: new Date().toISOString() });
          }
        } catch {
          set({ cadencePending: true });
        }
      };
      return {
        ...initial,
        setConnection: ({ username, boards }) =>
          set({ connected: true, username, boards }),
        setBoards: (boards) => set({ boards }),
        setPoseRefs: (poseRefs) => set({ poseRefs, poseRefsAt: new Date().toISOString() }),
        setDefaultPoseMode: (defaultPoseMode) => set({ defaultPoseMode }),
        setCadence: (cadence) => {
          set({ cadence, cadencePending: true });
          void flushCadence();
        },
        flushCadence,
        dismissTasteUpsell: () => set({ tasteUpsellDismissed: true }),
        disconnect: () =>
          set({ connected: false, username: null, boards: [], poseRefs: [], poseRefsAt: null }),
        reset: () => set({ ...initial }),
      };
    },
    {
      name: 'vai-taste',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
      partialize: (s) => ({
        connected: s.connected,
        username: s.username,
        boards: s.boards,
        defaultPoseMode: s.defaultPoseMode,
        poseRefs: s.poseRefs,
        poseRefsAt: s.poseRefsAt,
        tasteUpsellDismissed: s.tasteUpsellDismissed,
        cadence: s.cadence,
        cadencePending: s.cadencePending,
        lastSyncedAt: s.lastSyncedAt,
      }),
    },
  ),
);

/** Board count for the settings row ("3 boards synced"). */
export const selectBoardCount = (s: TasteState): number => s.boards.length;

/** Pose pin by id (pin-picker thumb after selection). */
export function selectPosePin(s: TasteState, id: string | null): PosePin | null {
  if (!id) return null;
  return s.poseRefs.find((p) => p.id === id) ?? null;
}
