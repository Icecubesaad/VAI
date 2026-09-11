// plan-day — { date, weather, calendar } → { outfit garment_ids, why_line }.
// POST { date (YYYY-MM-DD), lat?, lon?, occasion?, dress_code?, allow_wishlist? }
// Owned-only unless allow_wishlist=true. Free: 1 outfit/day (one hero look);
// the row is persisted to `outfits` (source=plan-day) for recency tracking.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { buildDayOutfit } from "../_shared/plan.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<{
      date?: string; lat?: number; lon?: number;
      occasion?: string; dress_code?: string; allow_wishlist?: boolean;
    }>(req);

    const date = body.date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date_invalid", "date must be YYYY-MM-DD");

    const sb = admin();
    const plan = await buildDayOutfit(sb, user.id, {
      date,
      lat: body.lat,
      lon: body.lon,
      occasion: body.occasion,
      dressCode: body.dress_code,
      allowWishlist: body.allow_wishlist ?? false,
    });

    const { data: outfit, error } = await sb.from("outfits").insert({
      user_id: user.id,
      date,
      garment_ids: plan.garment_ids,
      wishlist_ids: plan.wishlist_ids,
      context: plan.context,
      why_line: plan.why_line,
      source: "plan-day",
      score: plan.score,
    }).select("id,date,garment_ids,why_line,score").single();
    if (error) throw error;

    return json({ outfit_id: (outfit as { id: string }).id, ...plan });
  } catch (e) {
    // buildDayOutfit signals empty closet with a coded error.
    if (e instanceof Error && (e as Error & { code?: string }).code === "closet_empty") {
      return toErrorResponse(
        Object.assign(badRequest("closet_empty", e.message), {}),
      );
    }
    return toErrorResponse(e);
  }
});
