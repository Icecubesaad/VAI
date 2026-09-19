/**
 * Deck state-machine tests — run with `npx tsx lib/__tests__/persona-deck.test.ts`
 * (or any TS runner). No React, no native modules: pure logic.
 *
 * Each case constructs a DeckState, applies one transition, and asserts the
 * result. A failure prints the case name + expected/actual and exits nonzero.
 */
import {
  DECK_MAX_KEPT,
  initialDeckState,
  judgeDeckCard,
  unkeepDeckPick,
  undoDeckSwipe,
  type DeckState,
} from '../persona-deck';

const DECK = ['Streetwear', 'Old Money', 'Minimal', 'Techwear'] as const;

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

// keep advances + accumulates
const s1 = judgeDeckCard(initialDeckState, DECK, true);
check('keep advances deck', (s1.ok && s1.state.deckIndex) || null, 1);
check('keep accumulates', (s1.ok && s1.state.kept) || null, ['Streetwear']);

// skip advances without accumulating
const s2 = judgeDeckCard(initialDeckState, DECK, false);
check('skip advances deck', (s2.ok && s2.state.deckIndex) || null, 1);
check('skip keeps nothing', (s2.ok && s2.state.kept) || null, []);

// like at cap refuses WITHOUT advancing (user must un-keep first)
const full: DeckState = { deckIndex: 3, kept: ['A', 'B', 'C'], history: [] };
const s3 = judgeDeckCard(full, ['A', 'B', 'C', 'Techwear'], true);
check('cap refuses', s3.ok, false);
check('cap holds deck', s3.state.deckIndex, 3);
check('cap holds kept', s3.state.kept, ['A', 'B', 'C']);

// skip at cap still advances
const s4 = judgeDeckCard(full, ['A', 'B', 'C', 'Techwear'], false);
check('skip-at-cap advances', (s4.ok && s4.state.deckIndex) || null, 4);

// undo rewinds + removes kept
const after: DeckState = { deckIndex: 2, kept: ['Streetwear'], history: [{ name: 'Streetwear', liked: true }, { name: 'Old Money', liked: false }] };
const s5 = undoDeckSwipe(after);
check('undo rewinds', s5.deckIndex, 1);
check('undo keeps liked-removal-safe', s5.kept, ['Streetwear']);
const s6 = undoDeckSwipe({ deckIndex: 1, kept: ['Streetwear'], history: [{ name: 'Streetwear', liked: true }] });
check('undo removes kept', s6.kept, []);
check('undo empties history', s6.history, []);

// undo on empty history is identity
check('undo-empty identity', undoDeckSwipe(initialDeckState), initialDeckState);

// un-keep never rewinds the deck
const s7 = unkeepDeckPick({ deckIndex: 3, kept: ['Streetwear', 'Minimal'], history: [{ name: 'Streetwear', liked: true }] }, 'Streetwear');
check('unkeep removes name', s7.kept, ['Minimal']);
check('unkeep holds deck', s7.deckIndex, 3);

// cap constant matches the quiz UI
check('cap is 3', DECK_MAX_KEPT, 3);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nAll deck tests passed.');
}
