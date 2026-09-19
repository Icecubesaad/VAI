/**
 * DNA cast tests — run with the repo's script form, e.g.
 * `npx tsx lib/__tests__/dna-cast.test.ts` (or any TS runner). No React, no
 * native modules: the cast logic is UI-free, so it runs bare. Metro asset
 * imports are deliberately absent here — the contract under test is
 * names + order + pool bounds, pinned against inline mock pools.
 *
 * Each case builds a cast and asserts the result. A failure prints the case
 * name + expected/actual and exits nonzero.
 */
import { buildDnaCast, type DnaCastShot } from '../dna-cast';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

const names = (looks: Array<{ name: string }>): string[] => looks.map((l) => l.name);

// Mock pools stand in for the bundler-side photo table: distinct ints, no I/O.
const MENS: readonly DnaCastShot[] = [
  { persona: 'Streetwear', womenswear: false, art: 101, line: 'a' },
  { persona: 'Old Money', womenswear: false, art: 102, line: 'b' },
  { persona: 'Minimal', womenswear: false, art: 103, line: 'c' },
  { persona: 'Techwear', womenswear: false, art: 104, line: 'd' },
  { persona: 'Tailored', womenswear: false, art: 105, line: 'e' },
  { persona: 'Vintage', womenswear: false, art: 106, line: 'f' },
];
const WOMENS: readonly DnaCastShot[] = [
  { persona: 'Clean girl', womenswear: true, art: 201, line: 'g' },
  { persona: 'Y2K', womenswear: true, art: 202, line: 'h' },
  { persona: 'Streetwear', womenswear: true, art: 203, line: 'i' },
  { persona: 'Boho', womenswear: true, art: 204, line: 'j' },
];

// Kept personas lead, in the order the user kept them.
check(
  'kept lead in order',
  names(buildDnaCast(['Minimal', 'Streetwear'], MENS)).slice(0, 2),
  ['Minimal', 'Streetwear'],
);

// One keep still yields a full cast — the marquee never runs near-empty.
check('single keep fills to six', buildDnaCast(['Vintage'], MENS).length, 6);
check('single keep fills to six (womenswear)', buildDnaCast(['Y2K'], WOMENS).length, 4);

// Fillers never duplicate a kept persona.
const filled = buildDnaCast(['Streetwear'], MENS);
check('fillers never duplicate kept', new Set(names(filled)).size, filled.length);

// Nothing outside the pool can leak into the cast.
check(
  'cast stays pool-bounded',
  names(buildDnaCast(['Streetwear', 'Clean girl'], MENS)).includes('Clean girl'),
  false,
);

// Unknown names are ignored, not crashed on — the deck contract may grow.
check(
  'unknown persona ignored',
  names(buildDnaCast(['Not a vibe', 'Minimal'], MENS)).slice(0, 1),
  ['Minimal'],
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll DNA cast tests passed.');
}
