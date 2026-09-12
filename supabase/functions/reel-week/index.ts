// reel-week — read the saved weekly drop (GET ?week_of= / POST { week_of }).
// The client (api.reelWeek) called this fn while it did NOT exist server-side
// — every refresh failed over to the cached drop. Now: the same read path as
// reel-drop's GET (readWeeklyDrop in _shared/reel.ts), which mints fresh 1h
// signed URLs per card (0008).
//
// Response: { ok: true, data: WeeklyDrop | null } — null when no drop exists
// for (user, week_of) yet. Pure read: no quota, no writes.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, getQuery, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { readWeeklyDrop, type WeeklyDrop } from "../_shared/reel.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, ["GET", "POST"]);
    const user = await requireUser(req);

    let weekOf: string | null;
    if (req.method === "GET") {
      weekOf = getQuery(req, "week_of") ?? getQuery(req, "weekOf");
    } else {
      try {
        const body = (await req.json()) as { week_of?: unknown; weekOf?: unknown };
        const raw = body.week_of ?? body.weekOf;
        weekOf = typeof raw === "string" && raw.length > 0 ? raw : null;
      } catch {
        weekOf = null; // empty body on POST is fine — query string may carry it
      }
      if (!weekOf) weekOf = getQuery(req, "week_of") ?? getQuery(req, "weekOf");
    }
    if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
      throw badRequest("week_required", "week_of (YYYY-MM-DD, a Monday) is required");
    }

    const drop: WeeklyDrop | null = await readWeeklyDrop(admin(), user.id, weekOf);
    return json(drop);
  } catch (e) {
    return toErrorResponse(e);
  }
});
