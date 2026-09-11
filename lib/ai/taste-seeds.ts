/**
 * VAI · Pinterest taste-seed extractor: pin → style-seed pack (integrations turf).
 *
 * Turns a board name + pin titles/descriptions into deduped style adjectives
 * (`taste:<adj>`) and coverage/fit notes (`fit:<note>`), capped at
 * `MAX_TASTE_SEEDS`, with a `promptBlock` the planner appends to day prompts
 * exactly like `trendSeedPack` — the owned-only constraint still wins, taste
 * seeds bias picks within the owned closet and never conjure garments.
 *
 * Extraction is vocab-based (deterministic, $0, no LLM round-trip): only
 * phrases from the curated style/fit vocabularies become tags, so pin
 * marketing fluff ("viral must-have!!") can never leak into the prompt.
 * Matching is case-insensitive on word boundaries; tags come out in
 * first-seen order (board name first, then pins in order).
 *
 * Empty-in → empty-out: no board/pins, or no vocab hits, yields
 * `{ tags: [], promptBlock: '' }` and the planner prompt is untouched.
 *
 * Pure + unit-testable. No secrets, no network — BACKEND OWNS board sync
 * and passes the raw board/pin text through.
 */

export interface TasteSeedPin {
  title?: string;
  description?: string;
}

export interface TasteSeedInput {
  boardName?: string;
  pins?: readonly TasteSeedPin[];
}

export interface TasteSeedPack {
  tags: string[];
  promptBlock: string;
}

/** Total tags (taste + fit) per pack. Same downstream prompt budget as trend seeds. */
export const MAX_TASTE_SEEDS = 8;

/** Curated style adjectives — the ONLY single/multi-word phrases that become `taste:` tags. */
const STYLE_ADJECTIVES: readonly string[] = [
  'minimalist', 'minimal', 'oversized', 'tailored', 'relaxed', 'cropped',
  'vintage', 'retro', 'streetwear', 'bohemian', 'boho', 'preppy', 'classic',
  'edgy', 'feminine', 'elegant', 'casual', 'chic', 'cozy', 'sporty',
  'androgynous', 'monochrome', 'neutral', 'pastel', 'bold', 'layered',
  'flowy', 'structured', 'fitted', 'slouchy', 'denim', 'leather', 'satin',
  'silk', 'knit', 'linen', 'pleated', 'cargo', 'evening', 'office',
  'quiet luxury', 'old money', 'y2k', 'normcore', 'cottagecore', 'gorpcore',
];

/** Coverage/fit phrases — the ONLY phrases that become `fit:` tags. */
const FIT_NOTES: readonly string[] = [
  'high waist', 'wide leg', 'full length', 'long sleeve', 'off shoulder',
  'high neck', 'low rise', 'midi', 'maxi', 'mini', 'sleeveless',
  'turtleneck', 'modest', 'sheer', 'bodycon', 'boxy',
];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * Collect vocab hits in first-seen order within one text. Word-boundary
 * padded matching keeps `minimal` from firing on `minimalist`.
 */
function collectPhrases(
  text: string,
  phrases: readonly string[],
  prefix: 'taste' | 'fit',
  seen: Set<string>,
  out: string[],
): void {
  const haystack = normalize(text);
  const hits: Array<{ at: number; tag: string }> = [];
  for (const phrase of phrases) {
    const at = haystack.indexOf(` ${phrase} `);
    if (at === -1) continue;
    const tag = `${prefix}:${phrase.replace(/\s+/g, '-')}`;
    if (!seen.has(tag)) hits.push({ at, tag });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const hit of hits) {
    seen.add(hit.tag);
    out.push(hit.tag);
  }
}

/**
 * Extract a taste-seed pack from board + pin text. Pure; empty-in →
 * empty-out (`{ tags: [], promptBlock: '' }`).
 */
export function tasteSeedPack(input: TasteSeedInput = {}): TasteSeedPack {
  const tags: string[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  if (input.boardName?.trim()) sources.push(input.boardName);
  for (const pin of input.pins ?? []) {
    const text = `${pin.title ?? ''} ${pin.description ?? ''}`.trim();
    if (text) sources.push(text);
  }
  for (const text of sources) {
    collectPhrases(text, STYLE_ADJECTIVES, 'taste', seen, tags);
    collectPhrases(text, FIT_NOTES, 'fit', seen, tags);
    if (tags.length >= MAX_TASTE_SEEDS) break;
  }
  const capped = tags.slice(0, MAX_TASTE_SEEDS);
  if (capped.length === 0) return { tags: [], promptBlock: '' };
  return {
    tags: capped,
    promptBlock:
      'TASTE SEED (pinterest) — bias picks toward these tags where the owned ' +
      `closet allows; the owned-only constraint still wins, never invent garments: ${capped.join(', ')}.`,
  };
}
