/**
 * DNA gallery — the style-DNA reveal's photo set. Bundled lookbook shots
 * (assets/dna/), one fresh frame per persona per side.
 *
 * Why this file exists: the quiz deck and the DNA reveal previously shared
 * the same remote Pinterest URLs, so the "verdict" moment re-showed the exact
 * photos the user had just swiped on. The reveal must feel like a payoff —
 * new shots of the same vibes, never a replay.
 *
 * Two layers: `lib/dna-cast.ts` holds the pure cast logic (UI-free,
 * unit-tested on bare Node). This file is ONLY the bundler-side photo table
 * plus the one-line `dnaGalleryFor` wrapper the quiz screen calls.
 *
 * Swap point: replace any `import` below with a new bundled shot or a
 * user/AI render — keep the per-persona key contract.
 */
import dnaStreet1 from '@/assets/dna/street-1.jpg';
import dnaStreet2 from '@/assets/dna/street-2.jpg';
import dnaOldmoney1 from '@/assets/dna/oldmoney-1.jpg';
import dnaOldmoney2 from '@/assets/dna/oldmoney-2.jpg';
import dnaMinimal1 from '@/assets/dna/minimal-1.jpg';
import dnaMinimal2 from '@/assets/dna/minimal-2.jpg';
import dnaTech1 from '@/assets/dna/tech-1.jpg';
import dnaTailored1 from '@/assets/dna/tailored-1.jpg';
import dnaSmart1 from '@/assets/dna/smart-1.jpg';
import dnaAthleisure1 from '@/assets/dna/athleisure-1.jpg';
import dnaAthleisure2 from '@/assets/dna/athleisure-2.jpg';
import dnaVintage1 from '@/assets/dna/vintage-1.jpg';
import dnaDenim1 from '@/assets/dna/denim-1.jpg';
import dnaGorpcore1 from '@/assets/dna/gorpcore-1.jpg';
import dnaCleangirl1 from '@/assets/dna/cleangirl-1.jpg';
import dnaCoquette1 from '@/assets/dna/coquette-1.jpg';
import dnaBoho1 from '@/assets/dna/boho-1.jpg';
import dnaY2k1 from '@/assets/dna/y2k-1.jpg';
import dnaCottage1 from '@/assets/dna/cottage-1.jpg';
import dnaOffice1 from '@/assets/dna/office-1.jpg';
import { buildDnaCast, type DnaCastLook, type DnaCastShot } from './dna-cast';

export type { DnaCastLook as DnaGalleryLook, DnaCastShot as DnaGalleryShot };

const SHOTS: readonly DnaCastShot[] = [
  { persona: 'Streetwear', womenswear: false, art: dnaStreet1, line: 'Your rotation, off duty' },
  { persona: 'Streetwear', womenswear: true, art: dnaStreet2, line: 'Your rotation, off duty' },
  { persona: 'Old Money', womenswear: false, art: dnaOldmoney1, line: 'The quiet-luxury keep' },
  { persona: 'Old Money', womenswear: true, art: dnaOldmoney2, line: 'The quiet-luxury keep' },
  { persona: 'Minimal', womenswear: false, art: dnaMinimal1, line: 'Clean lines, your cut' },
  { persona: 'Minimalist', womenswear: true, art: dnaMinimal2, line: 'Clean lines, your cut' },
  { persona: 'Techwear', womenswear: false, art: dnaTech1, line: 'Utility, weatherproofed' },
  { persona: 'Tailored', womenswear: false, art: dnaTailored1, line: 'Sharp shoulders, kept' },
  { persona: 'Smart casual', womenswear: false, art: dnaSmart1, line: 'Polished without trying' },
  { persona: 'Athleisure', womenswear: false, art: dnaAthleisure1, line: 'Off-duty, still sharp' },
  { persona: 'Athleisure', womenswear: true, art: dnaAthleisure2, line: 'Off-duty, still sharp' },
  { persona: 'Vintage', womenswear: false, art: dnaVintage1, line: 'Thrifted, one of one' },
  { persona: 'Denim & Boots', womenswear: false, art: dnaDenim1, line: 'Rugged, worn in right' },
  { persona: 'Gorpcore', womenswear: false, art: dnaGorpcore1, line: 'Trail-ready layers' },
  { persona: 'Clean girl', womenswear: true, art: dnaCleangirl1, line: 'Slicked, gold, neutral' },
  { persona: 'Coquette', womenswear: true, art: dnaCoquette1, line: 'Soft, bow-tied' },
  { persona: 'Boho', womenswear: true, art: dnaBoho1, line: 'Flowy and earthy' },
  { persona: 'Y2K', womenswear: true, art: dnaY2k1, line: 'Throwback, metallic' },
  { persona: 'Cottagecore', womenswear: true, art: dnaCottage1, line: 'Prairie-soft florals' },
  { persona: 'Office chic', womenswear: true, art: dnaOffice1, line: 'Blazer-sharp days' },
];

/**
 * Build the filmstrip cast from the user's kept personas against one side's
 * pool — kept shots first in kept order, side-matched fillers to `fillTo`.
 */
export function dnaGalleryFor(
  kept: readonly string[],
  womenswear: boolean,
  fillTo = 6,
): DnaCastLook[] {
  return buildDnaCast(
    kept,
    SHOTS.filter((s) => s.womenswear === womenswear),
    fillTo,
  );
}
