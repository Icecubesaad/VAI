import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api, type PoseMode, type ReelCard, type ReelPose, type WeeklyDrop } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { mmkvStorage } from './mmkv';
import { useSession } from './session';

export { REEL_POSES } from '@/lib/api';

/** Client mirror of the server weekly regenerate budget (server is truth). */
export const MAX_REGENERATES_PER_WEEK = 3;

/** Monday (YYYY-MM-DD, UTC) of the week containing `d` — the drop key. */
export function mondayOf(d = new Date()): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - daysSinceMonday);
  return utc.toISOString().slice(0, 10);
}

interface ReelState {
  /** Monday key of the cached drop. */
  weekOf: string;
  /** Current drop cache; null = no drop styled for the week yet. */
  drop: WeeklyDrop | null;
  /** Locally saved card ids (survive reinstalls via MMKV). */
  savedIds: Record<string, true>;
  /** Post-onboarding pose-pack nudge dismissed (persisted). */
  poseNudgeDismissed: boolean;
  /** Week key the regenerate budget below was consumed in. */
  regenerateWeek: string | null;
  regeneratesUsed: number;
  fetching: boolean;
  fetchError: string | null;
  regeneratingId: string | null;

  /** Cache-first: cached drop for `weekOf`, else GET reel-week. */
  ensureWeek: (weekOf?: string) => Promise<WeeklyDrop | null>;
  /** Force GET reel-week (pull-to-refresh / retry). */
  refreshWeek: (weekOf?: string) => Promise<WeeklyDrop | null>;
  /** POST reel-drop — styles the week (empty-state "Style my week"). */
  styleMyWeek: (weekOf?: string) => Promise<WeeklyDrop | null>;
  /** POST reel-regenerate with client budget guard; swaps the card in. */
  regenerate: (cardId: string, note?: string, opts?: { poseMode?: PoseMode; poseRefId?: string }) => Promise<ReelCard | null>;
  regeneratesLeft: () => number;
  toggleSave: (cardId: string) => void;
  dismissPoseNudge: () => void;
  reset: () => void;
}

export const useReel = create<ReelState>()(
  persist(
    (set, get) => ({
      weekOf: mondayOf(),
      drop: null,
      savedIds: {},
      poseNudgeDismissed: false,
      regenerateWeek: null,
      regeneratesUsed: 0,
      fetching: false,
      fetchError: null,
      regeneratingId: null,

      ensureWeek: async (weekOf) => {
        const wk = weekOf ?? mondayOf();
        const s = get();
        if (s.weekOf === wk && s.drop) return s.drop;
        return get().refreshWeek(wk);
      },

      refreshWeek: async (weekOf) => {
        const wk = weekOf ?? mondayOf();
        set({ fetching: true, fetchError: null });
        try {
          const drop = await api.reelWeek({ weekOf: wk });
          set({ weekOf: wk, drop, fetching: false });
          return drop;
        } catch (e) {
          set({
            fetching: false,
            fetchError: e instanceof Error ? e.message : 'Could not load your reel.',
          });
          return get().weekOf === wk ? get().drop : null;
        }
      },

      styleMyWeek: async (weekOf) => {
        const wk = weekOf ?? mondayOf();
        set({ fetching: true, fetchError: null });
        try {
          const drop = await api.reelDrop({ weekOf: wk });
          set({ weekOf: wk, drop, fetching: false });
          return drop;
        } catch (e) {
          set({
            fetching: false,
            fetchError: e instanceof Error ? e.message : 'Could not style your week.',
          });
          return null;
        }
      },

      regenerate: async (cardId, note, opts) => {
        if (get().regeneratesLeft() <= 0) return null;
        set({ regeneratingId: cardId, fetchError: null });
        try {
          const card = await api.reelRegenerate({
            cardId,
            note,
            ...(opts?.poseMode ? { poseMode: opts.poseMode } : {}),
            ...(opts?.poseRefId ? { poseRefId: opts.poseRefId } : {}),
          });
          const wk = mondayOf();
          set((s) => ({
            // Match on the REQUESTED id: the server may return a rotated card
            // id for the remix, in which case the old cell is replaced in place
            // (never appended — the pager is exactly one cell per drop card).
            drop: s.drop
              ? {
                  ...s.drop,
                  cards: s.drop.cards.some((c) => c.id === cardId)
                    ? s.drop.cards.map((c) => (c.id === cardId ? card : c))
                    : s.drop.cards,
                }
              : s.drop,
            regenerateWeek: wk,
            regeneratesUsed: s.regenerateWeek === wk ? s.regeneratesUsed + 1 : 1,
            regeneratingId: null,
          }));
          return card;
        } catch (e) {
          set({
            regeneratingId: null,
            fetchError: e instanceof Error ? e.message : 'Could not regenerate this look.',
          });
          return null;
        }
      },

      regeneratesLeft: () => {
        const s = get();
        if (s.regenerateWeek !== mondayOf()) return MAX_REGENERATES_PER_WEEK;
        return Math.max(0, MAX_REGENERATES_PER_WEEK - s.regeneratesUsed);
      },

      toggleSave: (cardId) =>
        set((s) => {
          const savedIds = { ...s.savedIds };
          if (savedIds[cardId]) delete savedIds[cardId];
          else savedIds[cardId] = true;
          return { savedIds };
        }),

      dismissPoseNudge: () => set({ poseNudgeDismissed: true }),

      reset: () =>
        set({
          weekOf: mondayOf(),
          drop: null,
          savedIds: {},
          poseNudgeDismissed: false,
          regenerateWeek: null,
          regeneratesUsed: 0,
          fetching: false,
          fetchError: null,
          regeneratingId: null,
        }),
    }),
    {
      name: 'vai-reel',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (s) => ({
        weekOf: s.weekOf,
        drop: s.drop,
        savedIds: s.savedIds,
        poseNudgeDismissed: s.poseNudgeDismissed,
        regenerateWeek: s.regenerateWeek,
        regeneratesUsed: s.regeneratesUsed,
      }),
    },
  ),
);

/** Which poses have an active base photo (`pose_meta.pose`, one active per pose). */
export async function fetchPoseStatus(): Promise<Record<ReelPose, boolean>> {
  const status: Record<ReelPose, boolean> = { front: false, step: false, detail: false };
  const userId = useSession.getState().userId;
  if (!userId) return status;
  try {
    const { data } = await supabase
      .from('base_photos')
      .select('pose_meta')
      .eq('user_id', userId)
      .eq('is_active', true);
    const rows = (data ?? []) as Array<{ pose_meta?: { pose?: unknown } | null }>;
    for (const row of rows) {
      const pose = row.pose_meta?.pose;
      if (pose === 'front' || pose === 'step' || pose === 'detail') status[pose] = true;
    }
  } catch {
    // Best-effort: callers treat all-false as "pose pack needed".
  }
  return status;
}

export function missingPoses(status: Record<ReelPose, boolean>): ReelPose[] {
  return (Object.keys(status) as ReelPose[]).filter((p) => !status[p]);
}
