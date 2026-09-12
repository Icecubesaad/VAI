// plan-week — 7× plan-day + laundry dedup.
// POST { start_date (YYYY-MM-DD Monday), lat?, lon?, calendar?: [{date, occasion, dress_code}] }
// v1 CUT (build pack §8: full-week plan deferred to v2): implemented behind the
// `week_plan_enabled` flag AND Premium. Until v2 launch this returns 403
// v2_locked with a paywall payload — real logic, flagged off, not a stub.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, forbidden, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { buildDayOutfit } from "../_shared/plan.ts";
import { getEntitlementState } from "../_shared/quota.ts";

interface CalendarEntry {
  date?: string;
  occasion?: string;
  dress_code?: string;
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<{
      start_date?: string; lat?: number; lon?: number; calendar?: CalendarEntry[];
    }>(req);

    const start = body.start_date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      throw badRequest("date_invalid", "start_date must be YYYY-MM-DD");
    }

    const sb = admin();
    // Unlocked for ALL tiers: plan-week is text-only (no renders), which costs
    // ~$0 on the free Gemini text tier. The app_config kill switch remains as
    // an operator opt-out; money gates stay on image renders only.
    const { data: flag } = await sb.from("app_config").select("value").eq("key", "flags")
      .maybeSingle<{ value: { week_plan_enabled?: boolean } }>();
    if (flag?.value?.week_plan_enabled === false) {
      throw forbidden("week_plan_disabled",
        "Week planning is temporarily paused — try again soon.");
    }

    const cal = new Map<string, CalendarEntry>();
    for (const c of body.calendar ?? []) {
      if (c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date)) cal.set(c.date, c);
    }

    // Laundry dedup: tops/bottoms/dresses cannot repeat within any 3-day window.
    const usedRecent: string[] = [];
    const week: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const entry = cal.get(date);
      const plan = await buildDayOutfit(sb, user.id, {
        date,
        lat: body.lat,
        lon: body.lon,
        occasion: entry?.occasion,
        dressCode: entry?.dress_code,
        excludeGarmentIds: usedRecent.slice(-12),
      });
      const { data: outfit } = await sb.from("outfits").insert({
        user_id: user.id,
        date,
        garment_ids: plan.garment_ids,
        wishlist_ids: plan.wishlist_ids,
        context: { ...plan.context, week_start: start },
        why_line: plan.why_line,
        source: "plan-week",
        score: plan.score,
      }).select("id").single<{ id: string }>();
      usedRecent.push(...plan.garment_ids);
      week.push({ date, outfit_id: outfit?.id ?? null, ...plan });
    }

    return json({ start_date: start, week });
  } catch (e) {
    return toErrorResponse(e);
  }
});
