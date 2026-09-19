import type { Garment, GarmentCategory } from '@/lib/api';

/**
 * Outfit combos — the feed behind the home grid and the changing-room card
 * rail. Built purely from OWNED closet garments (dress / top+bottom base,
 * formality-nearest layer + shoes attached), so every card is renderable
 * today. No randomness: same closet → same combo list, stable keys.
 */

export type Occasion = 'casual' | 'office' | 'party' | 'sport';

export interface OutfitCombo {
  /** Stable key — sorted garment ids pipe-joined. Doubles as the render key. */
  id: string;
  garmentIds: string[];
  /** Piece names, max 3, "Trench · Tee · Jeans" — real content, never filler. */
  label: string;
  /** Avg formality 1–5 of the base pieces. */
  formality: number;
  occasion: Occasion;
}

/** Order-insensitive combo key — matches reel cards / renders by garment set. */
export function comboKey(ids: string[]): string {
  return [...ids].sort().join('|');
}

export function comboLabel(ids: string[], garments: Garment[]): string {
  const names = ids
    .map((id) => garments.find((g) => g.id === id)?.category)
    .filter((c): c is GarmentCategory => typeof c === 'string')
    .map((c) => c.charAt(0).toUpperCase() + c.slice(1));
  return [...new Set(names)].slice(0, 3).join(' · ');
}

function occasionOf(ids: string[], garments: Garment[]): Occasion {
  const picked = ids
    .map((id) => garments.find((g) => g.id === id))
    .filter((g): g is Garment => g !== undefined);
  if (picked.some((g) => g.category === 'active')) return 'sport';
  const f = picked.reduce((s, g) => s + g.formality, 0) / Math.max(1, picked.length);
  if (f >= 4) return 'party';
  if (f >= 3) return 'office';
  return 'casual';
}

/** Nearest-formality garment from a pool (deterministic — stable card order). */
function nearest(pool: Garment[], f: number): Garment | null {
  if (pool.length === 0) return null;
  return (
    [...pool].sort(
      (a, b) => Math.abs(a.formality - f) - Math.abs(b.formality - f) || a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

const COMBO_CAP = 16;

/**
 * Build the combo feed: every dress, plus each top paired with its two
 * formality-nearest bottoms; every base gets the nearest layer + shoes.
 */
export function buildCombos(garments: Garment[]): OutfitCombo[] {
  const by = (c: GarmentCategory) => garments.filter((g) => g.category === c);
  const tops = by('top');
  const bottoms = by('bottom');
  const dresses = [...by('dress'), ...by('onepiece')];
  const layers = by('outerwear');
  const shoes = by('shoes');

  let bases: Garment[][] = dresses.map((d) => [d]);
  for (const t of tops) {
    const partners = [...bottoms]
      .sort(
        (a, b) =>
          Math.abs(a.formality - t.formality) - Math.abs(b.formality - t.formality) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 2);
    for (const b of partners) bases.push([t, b]);
  }
  // Nothing pairs (e.g. three tees, no bottoms): single hero pieces still
  // make a card the user can render.
  if (bases.length === 0) {
    bases = [...dresses, ...tops, ...bottoms].slice(0, 4).map((g) => [g]);
  }

  const combos: OutfitCombo[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const ids: string[] = base.map((g) => g.id);
    const f = base.reduce((s, g) => s + g.formality, 0) / base.length;
    for (const extra of [nearest(layers, f), nearest(shoes, f)]) {
      if (extra && !ids.some((id) => id === extra.id)) ids.push(extra.id);
    }
    const key = comboKey(ids);
    if (seen.has(key)) continue;
    seen.add(key);
    const picked = ids
      .map((id) => garments.find((g) => g.id === id))
      .filter((g): g is Garment => g !== undefined);
    combos.push({
      id: key,
      garmentIds: ids,
      label: comboLabel(ids, garments),
      formality: Math.round((picked.reduce((s, g) => s + g.formality, 0) / Math.max(1, picked.length)) * 10) / 10,
      occasion: occasionOf(ids, garments),
    });
  }
  return combos.slice(0, COMBO_CAP);
}
