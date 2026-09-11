// Outfit planning core (Deno, strict TS) — shared by `plan-day` + `plan-week`
// (+ `reel-drop` card outfits). Deterministic, offline-safe scoring (no LLM
// cost on the daily loop): season fit × formality distance × palette harmony
// × recency penalty + taste bias (0006: auto-read taste_context, scaled by
// style_influence — owned-only still wins). plan-week reuses buildDayOutfit()
// with a rolling 3-day laundry exclusion.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { readTasteContext, readTastePrefs, selectTasteTags, tasteBonus } from "./taste.ts";

export interface GarmentRow {
  id: string;
  category: string | null;
  subcat: string | null;
  colors: string[];
  fabric: string | null;
  formality: number | null;
  seasons: string[] | null;
  wear_count: number;
}

export interface ProfileRow {
  everyday_style: string | null;
  palette: string | null;
  dress_code: string | null;
  boldness: number | null;
  style_labels: unknown;
}

export interface DayInput {
  date: string; // YYYY-MM-DD
  lat?: number;
  lon?: number;
  occasion?: string;
  dressCode?: string;
  allowWishlist?: boolean;
  /** Garment ids that must not repeat (plan-week laundry dedup). */
  excludeGarmentIds?: string[];
  /**
   * Taste override (tests / manual callers). When undefined the planner
   * auto-reads the user's taste_context row + style_influence (0006
   * invisible-autopilot — no client params needed). Explicit null disables
   * the taste bias for this call.
   */
  taste?: { tags: string[]; influence: number } | null;
}

export interface DayPlan {
  garment_ids: string[];
  wishlist_ids: string[];
  why_line: string;
  score: number;
  context: Record<string, unknown>;
}

const FORMALITY_BY_DRESS: Record<string, number> = {
  active: 1, gym: 1, casual: 2, creative: 2, office: 3, smart: 3, evening: 4, formal: 5,
};

function targetFormality(occasion: string | undefined, dressCode: string | undefined): number {
  const key = `${occasion ?? ""} ${dressCode ?? ""}`.toLowerCase();
  for (const [k, f] of Object.entries(FORMALITY_BY_DRESS)) {
    if (key.includes(k)) return f;
  }
  return 2;
}

export interface Weather {
  tempC: number;
  code: number;
}

export async function getWeather(
  lat: number | undefined,
  lon: number | undefined,
  date: string,
): Promise<Weather> {
  const fallback: Weather = { tempC: 20, code: 0 };
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return fallback;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,weathercode&timezone=auto&start_date=${date}&end_date=${date}`;
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const body = (await res.json()) as {
      daily?: { temperature_2m_max?: number[]; weathercode?: number[] };
    };
    return {
      tempC: body.daily?.temperature_2m_max?.[0] ?? fallback.tempC,
      code: body.daily?.weathercode?.[0] ?? 0,
    };
  } catch {
    return fallback;
  }
}

export async function fetchCloset(sb: SupabaseClient, userId: string): Promise<GarmentRow[]> {
  const { data, error } = await sb.from("garments")
    .select("id,category,subcat,colors,fabric,formality,seasons,wear_count")
    .eq("user_id", userId).is("deleted_at", null).limit(500);
  if (error) throw error;
  return (data ?? []) as GarmentRow[];
}

/** Garment ids worn in the last N days (laundry/recency signal). */
export async function recentWornIds(
  sb: SupabaseClient,
  userId: string,
  days: number,
): Promise<Map<string, number>> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await sb.from("outfits").select("garment_ids,date")
    .eq("user_id", userId).gte("date", since.toISOString().slice(0, 10)).limit(60);
  if (error || !data) return new Map();
  const map = new Map<string, number>();
  const today = Date.now();
  for (const row of data as Array<{ garment_ids: string[]; date: string }>) {
    const ageDays = Math.max(0, (today - Date.parse(row.date)) / 86400000);
    for (const id of row.garment_ids ?? []) {
      map.set(id, Math.min(map.get(id) ?? Infinity, ageDays));
    }
  }
  return map;
}

function seasonScore(g: GarmentRow, tempC: number): number {
  const s = (g.seasons ?? ["all"]).map((x) => x.toLowerCase());
  if (s.includes("all")) return 1;
  if (tempC < 12) return s.includes("fw") ? 1 : 0;
  if (tempC >= 24) return s.includes("ss") ? 1 : 0;
  return 0.6;
}

function paletteTokens(palette: string | null): string[] {
  return (palette ?? "").toLowerCase().split(/[,/\s]+/).filter((t) => t.length > 2);
}

function scoreGarment(
  g: GarmentRow,
  opts: { tempC: number; targetForm: number; palette: string[]; boldness: number; lastWornAge: number | undefined },
): number {
  let score = seasonScore(g, opts.tempC) * 2;
  const form = g.formality ?? 3;
  score += Math.max(0, 2 - Math.abs(form - opts.targetForm)); // 0..2
  const colors = (g.colors ?? []).map((c) => c.toLowerCase());
  if (colors.some((c) => opts.palette.some((p) => c.includes(p) || p.includes(c)))) score += 1.2;
  if (opts.lastWornAge !== undefined) {
    score += opts.lastWornAge >= 7 ? 0.5 : -2.5; // unworn-a-week discovery bonus
  } else {
    score += 0.4; // never worn
  }
  if ((g.wear_count ?? 0) === 0) score += 0.2;
  void opts.boldness;
  return score;
}

function pickBest(
  pool: GarmentRow[],
  score: (g: GarmentRow) => number,
  exclude: Set<string>,
): GarmentRow | null {
  let best: GarmentRow | null = null;
  let bestScore = -Infinity;
  for (const g of pool) {
    if (exclude.has(g.id)) continue;
    const s = score(g);
    if (s > bestScore) {
      bestScore = s;
      best = g;
    }
  }
  return best;
}

const byCat = (closet: GarmentRow[], cats: string[]) =>
  closet.filter((g) => g.category && cats.includes(g.category));

export async function buildDayOutfit(
  sb: SupabaseClient,
  userId: string,
  input: DayInput,
): Promise<DayPlan> {
  const [{ data: profile }, closet, recent] = await Promise.all([
    sb.from("style_profiles")
      .select("everyday_style,palette,dress_code,boldness,style_labels").eq("user_id", userId)
      .maybeSingle<ProfileRow>(),
    fetchCloset(sb, userId),
    recentWornIds(sb, userId, 14),
  ]);
  if (closet.length === 0) {
    throw Object.assign(new Error("Closet is empty — add at least 3 items first"), {
      status: 409, code: "closet_empty",
    });
  }

  // Taste autopilot (0006): ONE-row read, scaled by style_influence. Taste
  // biases picks WITHIN the owned closet — the owned-only constraint wins,
  // taste seeds never conjure garments. influence 0 (or no context) = no-op.
  let tasteTags: string[] = [];
  let tasteInfluence = 0;
  if (input.taste === undefined) {
    const [prefs, ctx] = await Promise.all([
      readTastePrefs(sb, userId),
      readTasteContext(sb, userId),
    ]);
    tasteInfluence = prefs.styleInfluence;
    tasteTags = ctx ? selectTasteTags(ctx.seedTags, prefs.styleInfluence) : [];
  } else if (input.taste) {
    tasteTags = input.taste.tags.slice(0, 8);
    tasteInfluence = input.taste.influence;
  }

  const weather = await getWeather(input.lat, input.lon, input.date);
  const targetForm = targetFormality(input.occasion, input.dressCode ?? profile?.dress_code ?? undefined);
  const palette = paletteTokens(profile?.palette);
  const boldness = profile?.boldness ?? 3;
  const exclude = new Set(input.excludeGarmentIds ?? []);
  const sc = (g: GarmentRow) =>
    scoreGarment(g, { tempC: weather.tempC, targetForm, palette, boldness, lastWornAge: recent.get(g.id) }) +
    tasteBonus(g, tasteTags, tasteInfluence);

  // Candidate A: separates (top + bottom). Candidate B: dress/onepiece.
  const top = pickBest(byCat(closet, ["top", "active"]), sc, exclude);
  const bottom = pickBest(byCat(closet, ["bottom"]), sc, exclude);
  const dress = pickBest(byCat(closet, ["dress", "onepiece"]), sc, exclude);
  const shoes = pickBest(byCat(closet, ["shoes"]), sc, new Set()); // shoes repeat freely
  const outer = weather.tempC < 15
    ? pickBest(byCat(closet, ["outerwear"]), sc, new Set())
    : null;

  const scoreOf = (gs: Array<GarmentRow | null>) =>
    gs.reduce((s, g) => s + (g ? sc(g) : -3), 0);

  const separates = [top, bottom];
  const useDress = dress && (!top || !bottom || scoreOf([dress]) + 0.4 > scoreOf(separates));
  const core: GarmentRow[] = useDress && dress ? [dress] : separates.filter((g): g is GarmentRow => !!g);
  if (shoes) core.push(shoes);
  if (outer) core.push(outer);

  const garmentIds = core.map((g) => g.id);
  const total = scoreOf(core);

  // ---- why_line from the actual deciding factors (never generic)
  const anchor = core.find((g) => (g.colors ?? []).length > 0);
  const anchorColor = anchor?.colors?.[0] ?? "neutrals";
  const fabricBit = core.find((g) => g.fabric)?.fabric;
  const fresh = core.find((g) => {
    const age = recent.get(g.id);
    return age === undefined || age >= 7;
  });
  const bits = [
    `${cap(anchorColor)} anchors this ${input.occasion ?? profile?.dress_code ?? "everyday"} look`,
    weather.tempC >= 24 ? `breathable pick for ${Math.round(weather.tempC)}°C` : null,
    weather.tempC < 12 ? `layered for ${Math.round(weather.tempC)}°C` : null,
    fabricBit ? `${fabricBit} keeps it comfortable` : null,
    outer ? `plus a layer for the chill` : null,
    fresh && recent.has(fresh.id) ? `back in rotation after a break` : null,
    fresh && !recent.has(fresh.id) ? `first outing for a closet sleeper` : null,
  ].filter(Boolean);
  const whyLine = bits.slice(0, 3).join(" — ") + ".";

  return {
    garment_ids: garmentIds,
    wishlist_ids: [],
    why_line: whyLine,
    score: Math.round(total * 10) / 10,
    context: {
      weather: { temp_c: Math.round(weather.tempC), code: weather.code },
      occasion: input.occasion ?? null,
      dress_code: input.dressCode ?? profile?.dress_code ?? null,
      target_formality: targetForm,
      ...(tasteTags.length > 0
        ? { taste: { tags: tasteTags, influence: tasteInfluence } }
        : {}),
    },
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
