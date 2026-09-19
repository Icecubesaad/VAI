import { create } from 'zustand';

/**
 * Combo renders — session cache mapping `comboKey(garmentIds)` → a finished
 * try-on image of the user wearing that combo. Two writers:
 * - the changing room, after a render settles (freshest, always wins);
 * - a one-way seed from the weekly reel drop (server renders matched by
 *   garment set), which fills gaps only.
 * Home grid + changing-room stage read this so scrolling the rail swaps the
 * stage to the look's real render when one exists.
 */
interface ComboRendersState {
  renders: Record<string, { url: string; renderId?: string }>;
  put: (key: string, url: string, renderId?: string) => void;
  /** Gap-filling bulk seed — never clobbers an existing entry. */
  seed: (entries: Record<string, { url: string; renderId?: string }>) => void;
}

export const useComboRenders = create<ComboRendersState>()((set) => ({
  renders: {},
  put: (key, url, renderId) =>
    set((s) => ({ renders: { ...s.renders, [key]: { url, renderId } } })),
  seed: (entries) =>
    set((s) => {
      const fresh = { ...entries };
      for (const k of Object.keys(fresh)) {
        if (s.renders[k] !== undefined) delete fresh[k];
      }
      return Object.keys(fresh).length === 0 ? s : { renders: { ...s.renders, ...fresh } };
    }),
}));
