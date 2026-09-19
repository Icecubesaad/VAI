/**
 * DNA cast logic — pure, UI-free, unit-tested. No asset imports here: the
 * bundler-only photo table lives in `lib/dna-gallery.ts`, which wraps
 * `buildDnaCast` with the real per-side pools. Tests pin the contract
 * (kept-first order, fill-to-full, no duplicates, pool-bounded) against
 * inline mock pools so they run on bare Node with zero native modules.
 */

export interface DnaCastShot {
  /** Quiz persona name this shot pays off. */
  persona: string;
  /** True → womenswear deck; false → menswear deck. */
  womenswear: boolean;
  /** Bundled lookbook shot (Metro asset ID — works offline, no network). */
  art: number;
  /** Caption line for the shot (kept off the filmstrip cards by design). */
  line: string;
}

export interface DnaCastLook {
  name: string;
  art: number;
  line: string;
}

/**
 * Build the filmstrip cast from the user's kept personas against one side's
 * pool. Kept shots come first (same order the user kept them); when fewer
 * than `fillTo` personas were kept, unused pool shots fill the rest so the
 * marquee always has a full cast. Fillers never duplicate a kept shot, and
 * nothing outside `pool` can ever leak into the cast.
 */
export function buildDnaCast(
  kept: readonly string[],
  pool: readonly DnaCastShot[],
  fillTo = 6,
): DnaCastLook[] {
  const byPersona = new Map<string, DnaCastShot>();
  for (const shot of pool) {
    if (!byPersona.has(shot.persona)) byPersona.set(shot.persona, shot);
  }
  const seen = new Set<string>();
  const looks: DnaCastLook[] = [];
  for (const name of kept) {
    const shot = byPersona.get(name);
    if (shot && !seen.has(shot.persona)) {
      seen.add(shot.persona);
      looks.push({ name: shot.persona, art: shot.art, line: shot.line });
    }
  }
  if (looks.length < fillTo) {
    const keptSet = new Set(kept);
    for (const shot of pool) {
      if (looks.length >= fillTo) break;
      if (keptSet.has(shot.persona) || seen.has(shot.persona)) continue;
      seen.add(shot.persona);
      looks.push({ name: shot.persona, art: shot.art, line: shot.line });
    }
  }
  return looks;
}
