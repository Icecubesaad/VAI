// style-score — Profile-tab style stats, computed from the caller's REAL
// data (client called this fn while it did not exist — stats always showed
// "unavailable offline").
//
// FORMULA (deterministic, documented — no invented numbers, no LLM):
//   Four 25-point axes over the caller's non-deleted garments + finished
//   try-on renders, summed to total (0–100):
//     fit      = season coverage of the closet, weighted by wear
//     color    = distinct color-family count, peaked at 4–8 families
//                (one-color and rainbow-chaos closets score lower)
//     vers     = category breadth (top/bottom/shoes/outerwear/dress/…)
//                + outfit-forming combos (tops×bottoms, dresses)
//     occasion = formality spread across the 1–5 scale
//   percentile is ALWAYS null until a population-stats job exists — the
//   client type tolerates null and we never fake a percentile.
//
// Read-only: JWT via requireUser, ownership-scoped by construction (all
// queries filter user_id), no quota touch.

import { admin, requireUser } from "../_shared/auth.ts";
import { handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";

const CATEGORIES = new Set([
  "top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "onepiece", "active",
]);
const SEASONS = new Set(["spring", "summer", "fall", "winter"]);

/** Peak 4–8 distinct color families; linear ramp up, gentle decay after 8. */
function colorAxis(distinct: number): number {
  if (distinct <= 0) return 0;
  if (distinct <= 8) return Math.round((distinct / 8) * 25);
  return Math.max(15, Math.round(25 - (distinct - 8)));
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, ["GET", "POST"]);
    const user = await requireUser(req);
    const sb = admin();

    const [{ data: garments }, { count: tryons }] = await Promise.all([
      sb.from("garments")
        .select("category,colors,seasons,formality,wear_count")
        .eq("user_id", user.id).is("deleted_at", null),
      sb.from("renders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id).eq("status", "done"),
    ]);

    const rows = (garments ?? []) as Array<{
      category: string | null;
      colors: string[] | null;
      seasons: string[] | null;
      formality: number | null;
      wear_count: number | null;
    }>;

    const seasonSet = new Set<string>();
    const colorSet = new Set<string>();
    const catSet = new Set<string>();
    const formalities = new Set<number>();
    let wornPieces = 0;

    for (const g of rows) {
      if (g.category && CATEGORIES.has(g.category)) catSet.add(g.category);
      for (const s of g.seasons ?? []) {
        const k = String(s).toLowerCase();
        if (SEASONS.has(k)) seasonSet.add(k);
      }
      for (const c of g.colors ?? []) {
        const k = String(c).trim().toLowerCase();
        if (k.length > 0) colorSet.add(k);
      }
      const f = g.formality ?? null;
      if (typeof f === "number" && f >= 1 && f <= 5) formalities.add(Math.round(f));
      if ((g.wear_count ?? 0) > 0) wornPieces += 1;
    }

    // fit (25): season coverage x wear engagement. A closet that covers all
    // four seasons AND actually gets worn scores full marks.
    const seasonCoverage = seasonSet.size / 4;
    const wearEngagement = rows.length === 0 ? 0 : wornPieces / rows.length;
    const fit = Math.round(25 * (0.6 * seasonCoverage + 0.4 * wearEngagement));

    // color (25): peaked diversity (see colorAxis).
    const color = colorAxis(colorSet.size);

    // vers (25): category breadth (max 15) + outfit combos (max 10).
    const hasTop = catSet.has("top");
    const hasBottom = catSet.has("bottom");
    const hasShoes = catSet.has("shoes");
    const comboUnits =
      (hasTop && hasBottom ? 6 : 0) +
      (catSet.has("dress") || catSet.has("onepiece") ? 4 : 0) +
      (hasShoes ? 4 : 0) +
      (catSet.has("outerwear") ? 2 : 0) +
      (catSet.has("bag") || catSet.has("accessory") ? 2 : 0);
    const vers = Math.min(15, catSet.size * 2) + Math.min(10, comboUnits);

    // occasion (25): formality 1–5 spread — 5 distinct levels = full marks.
    const occasion = Math.round((formalities.size / 5) * 25);

    const total = Math.min(100, fit + color + vers + occasion);

    return json({
      total,
      fit,
      color,
      vers,
      occasion,
      percentile: null,
      garment_count: rows.length,
      tryon_count: tryons ?? 0,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
