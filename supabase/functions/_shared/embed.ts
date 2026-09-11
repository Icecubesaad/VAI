// Deterministic style vectors (Deno, strict TS).
// v1 uses feature-hashed semantic vectors (documented limitation, upgrade path:
// CLIP image service for garments). Deterministic = stable across retries,
// L2-normalized for cosine search against the pgvector HNSW indexes.

export function l2norm(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (n === 0) return v.map(() => 0);
  return v.map((x) => x / n);
}

/** FNV-1a 32-bit — stable across runtimes (unlike Math.random / JSON order). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG for spreading a token across k dims. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface QuizAnswers {
  everyday_style?: string;
  palette?: string[] | string;
  dress_code?: string;
  boldness?: number;
  budget_band?: string;
  body_shape?: string;
  fit_prefs?: Record<string, unknown>;
  undertone?: string;
}

const STYLE_ARCHETYPES = [
  "minimal", "street", "classic", "boho", "sporty", "preppy", "edgy", "romantic",
];
const COLOR_FAMILIES = [
  "black", "white", "grey", "navy", "blue", "red", "pink", "green",
  "olive", "brown", "beige", "yellow",
];
const DRESS_CODES = ["casual", "office", "evening", "active", "formal", "creative"];
const BUDGETS = ["thrift", "mid", "premium", "luxury"];
const BODIES = ["straight", "pear", "apple", "hourglass", "athletic"];

function nearestIndex(value: string | undefined, list: string[]): number {
  if (!value) return -1;
  const v = value.toLowerCase();
  const exact = list.indexOf(v);
  if (exact >= 0) return exact;
  // substring fallback ("smart casual" → casual)
  for (let i = 0; i < list.length; i++) {
    if (v.includes(list[i] as string) || (list[i] as string).includes(v)) return i;
  }
  return fnv1a(v) % list.length;
}

/**
 * 64-dim style DNA. Layout: 0–7 archetype · 8–19 color families · 20–25 dress
 * code · 26–30 boldness · 31–34 budget · 35–39 body · 40–47 fit prefs ·
 * 48–50 undertone · 51–55 reserve · 56–63 stability bias.
 */
export function dna64(answers: QuizAnswers): number[] {
  const v = new Array<number>(64).fill(0);

  const arch = nearestIndex(answers.everyday_style, STYLE_ARCHETYPES);
  if (arch >= 0) {
    v[arch] = 1.0;
    v[(arch + 1) % 8]! += 0.3;
    v[(arch + 7) % 8]! += 0.3;
  }
  const palette = Array.isArray(answers.palette)
    ? answers.palette
    : typeof answers.palette === "string"
    ? answers.palette.split(/[,/]/)
    : [];
  for (const c of palette) {
    const idx = nearestIndex(c.trim(), COLOR_FAMILIES);
    if (idx >= 0) v[8 + idx]! += 0.8;
  }
  const dc = nearestIndex(answers.dress_code, DRESS_CODES);
  if (dc >= 0) v[20 + dc]! += 0.9;

  const bold = Math.min(5, Math.max(1, Math.round(answers.boldness ?? 3)));
  v[26 + (bold - 1)]! += 0.4 + bold * 0.12;

  const bud = nearestIndex(answers.budget_band, BUDGETS);
  if (bud >= 0) v[31 + bud]! += 0.7;

  const body = nearestIndex(answers.body_shape, BODIES);
  if (body >= 0) v[35 + body]! += 0.7;

  const fit = answers.fit_prefs ?? {};
  for (const [k, val] of Object.entries(fit)) {
    v[40 + (fnv1a(`${k}:${String(val)}`) % 8)]! += 0.4;
  }
  const under = (answers.undertone ?? "").toLowerCase();
  if (under.includes("warm")) v[48]! += 1.0;
  else if (under.includes("cool")) v[49]! += 1.0;
  else if (under) v[50]! += 1.0;

  for (let i = 56; i < 64; i++) v[i]! = 0.05;
  return l2norm(v);
}

/**
 * 512-dim garment embedding from auto-tag attributes. Each token fans out to
 * 8 dims via a seeded PRNG — a real semantic hash: same attributes ⇒ same
 * vector, similar wardrobes ⇒ high cosine. Stored in garments.embedding.
 */
export function hash512(tokens: string[]): number[] {
  const v = new Array<number>(512).fill(0);
  for (const token of tokens) {
    const rand = mulberry32(fnv1a(token.toLowerCase()));
    for (let k = 0; k < 8; k++) {
      const idx = Math.floor(rand() * 512);
      v[idx]! += 0.5 + rand() * 0.5;
    }
  }
  return l2norm(v);
}

export function embeddingTokens(tags: {
  category: string;
  subcat?: string | null;
  colors: string[];
  fabric?: string | null;
  formality: number;
  seasons: string[];
}): string[] {
  const tokens = [`cat:${tags.category}`];
  if (tags.subcat) tokens.push(`sub:${tags.subcat}`);
  for (const c of tags.colors) tokens.push(`color:${c}`);
  if (tags.fabric) tokens.push(`fabric:${tags.fabric}`);
  tokens.push(`form:${tags.formality}`);
  for (const s of tags.seasons) tokens.push(`season:${s}`);
  return tokens;
}
