/**
 * Persona-deck verdict rules (quiz style step) — pure, UI-free, unit-tested.
 *
 * The deck is a judged queue: every card advances deckIndex exactly once
 * (keep or skip), kept names accumulate in everydayStyle up to MULTI_MAX,
 * and kept-pill removal un-keeps WITHOUT rewinding the deck (the card stays
 * judged — undo is the only way back). These rules lived inline in
 * app/onboarding/quiz.tsx and broke silently twice (the rAF-gated fling
 * stranded the deck; the kept-row ScrollView stretched a pill into a
 * circle). Extracted here so the state machine is testable without React.
 */

export const DECK_MAX_KEPT = 3;

export interface DeckState {
  /** Index of the current top card in `deckNames`. */
  deckIndex: number;
  /** Kept persona names (everydayStyle, split). */
  kept: string[];
  /** Full swipe receipts (undo walks this back). */
  history: Array<{ name: string; liked: boolean }>;
}

export const initialDeckState: DeckState = { deckIndex: 0, kept: [], history: [] };

export type DeckVerdict =
  | { ok: true; state: DeckState }
  | { ok: false; reason: 'capped'; state: DeckState };

/**
 * Judge the top card. Like at cap is refused (deck does NOT advance —
 * the user must un-keep something first). Skip always advances.
 */
export function judgeDeckCard(
  state: DeckState,
  deckNames: readonly string[],
  liked: boolean,
): DeckVerdict {
  const name = deckNames[state.deckIndex];
  if (!name) return { ok: true, state };
  if (liked && !state.kept.includes(name) && state.kept.length >= DECK_MAX_KEPT) {
    return { ok: false, reason: 'capped', state };
  }
  return {
    ok: true,
    state: {
      deckIndex: state.deckIndex + 1,
      kept: liked && !state.kept.includes(name) ? [...state.kept, name] : state.kept,
      history: [...state.history, { name, liked }],
    },
  };
}

/** Undo the last swipe. Liked restores kept-removal; deck rewinds one. */
export function undoDeckSwipe(state: DeckState): DeckState {
  if (state.history.length === 0) return state;
  const last = state.history[state.history.length - 1]!;
  return {
    deckIndex: Math.max(0, state.deckIndex - 1),
    kept: last.liked ? state.kept.filter((p) => p !== last.name) : state.kept,
    history: state.history.slice(0, -1),
  };
}

/**
 * Un-keep a kept pill WITHOUT touching deckIndex/history (swipe receipt
 * semantics — the card stays judged and counted in "N of 10").
 */
export function unkeepDeckPick(state: DeckState, name: string): DeckState {
  if (!state.kept.includes(name)) return state;
  return { ...state, kept: state.kept.filter((p) => p !== name) };
}
