import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Garment } from '@/lib/api';
import { mmkvStorage } from './mmkv';

export const CLOSET_MIN_COUNT = 3;
export const FREE_CLOSET_CAP = 50;

interface ClosetState {
  items: Record<string, Garment>;
  order: string[];
  lastSyncAt: string | null;

  upsert: (g: Garment) => void;
  addMany: (gs: Garment[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  setLastSync: (iso: string) => void;
}

export const useCloset = create<ClosetState>()(
  persist(
    (set) => ({
      items: {},
      order: [],
      lastSyncAt: null,
      upsert: (g) =>
        set((s) => ({
          items: { ...s.items, [g.id]: g },
          order: s.order.includes(g.id) ? s.order : [g.id, ...s.order],
        })),
      addMany: (gs) =>
        set((s) => {
          const items = { ...s.items };
          const order = [...s.order];
          for (const g of gs) {
            items[g.id] = g;
            if (!order.includes(g.id)) order.unshift(g.id);
          }
          return { items, order };
        }),
      remove: (id) =>
        set((s) => {
          const items = { ...s.items };
          delete items[id];
          return { items, order: s.order.filter((x) => x !== id) };
        }),
      clear: () => set({ items: {}, order: [], lastSyncAt: null }),
      setLastSync: (lastSyncAt) => set({ lastSyncAt }),
    }),
    {
      name: 'vai-closet',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
    },
  ),
);

/** Selectors (avoid re-render churn on large closets). */
export const selectClosetCount = (s: ClosetState) => s.order.length;
export const selectClosetList = (s: ClosetState): Garment[] =>
  s.order.map((id) => s.items[id]).filter((g): g is Garment => g !== undefined);
