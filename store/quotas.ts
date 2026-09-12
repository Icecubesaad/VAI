import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from './mmkv';

/**
 * Local quota mirror. Source of truth is the server (`paywall-status` edge fn,
 * render_quotas table — only `done` renders decrement). This store is a fast
 * local cache for badges/counters; always re-sync after render completion.
 *
 * Iron law: free = 5 LIFETIME renders (never daily refills).
 * Premium = 30 renders/mo. Restyle always costs 1 credit.
 */
export const FREE_LIFETIME_CAP = 5;
export const PREMIUM_MONTHLY_CAP = 30;
export const MAX_RESTYLES_PER_SESSION = 3;

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

interface QuotasState {
  lifetimeUsed: number;
  month: string;
  monthlyUsed: number;
  /** yyyy-mm-dd of last planned hero outfit (free: 1 outfit/day). */
  lastOutfitDate: string | null;
  /** Restyle session budget (max 3/session). */
  restyleDate: string | null;
  restylesUsed: number;

  syncFromServer: (p: { lifetimeUsed: number; monthlyUsed: number }) => void;
  recordRenderDone: () => void;
  canRenderFree: () => boolean;
  rendersLeftFree: () => number;
  recordOutfitPlanned: () => void;
  canPlanToday: () => boolean;
  recordRestyle: () => void;
  restylesLeft: () => number;
  reset: () => void;
}

export const useQuotas = create<QuotasState>()(
  persist(
    (set, get) => ({
      lifetimeUsed: 0,
      month: monthKey(),
      monthlyUsed: 0,
      lastOutfitDate: null,
      restyleDate: null,
      restylesUsed: 0,

      syncFromServer: ({ lifetimeUsed, monthlyUsed }) =>
        set({ lifetimeUsed, monthlyUsed, month: monthKey() }),

      recordRenderDone: () =>
        set((s) => {
          const m = monthKey();
          return {
            lifetimeUsed: s.lifetimeUsed + 1,
            month: m,
            monthlyUsed: s.month === m ? s.monthlyUsed + 1 : 1,
          };
        }),

      canRenderFree: () => get().lifetimeUsed < FREE_LIFETIME_CAP,
      rendersLeftFree: () => Math.max(0, FREE_LIFETIME_CAP - get().lifetimeUsed),

      recordOutfitPlanned: () => set({ lastOutfitDate: todayKey() }),
      canPlanToday: () => get().lastOutfitDate !== todayKey(),

      recordRestyle: () =>
        set((s) => {
          const t = todayKey();
          return s.restyleDate === t
            ? { restylesUsed: s.restylesUsed + 1 }
            : { restyleDate: t, restylesUsed: 1 };
        }),
      restylesLeft: () => {
        const s = get();
        if (s.restyleDate !== todayKey()) return MAX_RESTYLES_PER_SESSION;
        return Math.max(0, MAX_RESTYLES_PER_SESSION - s.restylesUsed);
      },

      reset: () =>
        set({
          lifetimeUsed: 0,
          month: monthKey(),
          monthlyUsed: 0,
          lastOutfitDate: null,
          restyleDate: null,
          restylesUsed: 0,
        }),
    }),
    {
      name: 'vai-quotas',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
    },
  ),
);
