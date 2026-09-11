// paywall-status — tier + quota truth in one call.
//
// CANONICAL RESPONSE (the single shape — flat camelCase; the `data` payload
// inside the standard { ok, data } envelope):
//   { tier: 'free' | 'premium', trialing: boolean,
//     trialEndsAt: string | null, renewsAt: string | null,
//     rendersLeft: number, rendersCap: number, rendersUsedPeriod: number,
//     quotaResetsAt: string, restylesLeftToday: number,
//     closetUsed: number, closetLimit: number | null,
//     stdCredits: number, hdCredits: number,
//     canUseMax: boolean, hardBlocked: boolean }
// Field notes:
//   - rendersCap/rendersUsedPeriod: free → 5-lifetime pool; premium → 30/mo.
//   - quotaResetsAt: next monthly-window boundary (ISO). The free lifetime
//     pool NEVER refills — the field marks the premium window edge.
//   - closetLimit: 50 on free, null on premium (uncapped).
//   - hardBlocked: free && rendersLeft==0 && stdCredits==0 → upgrade sheet.
// TRANSITION (both accepted, canonical response either way):
//   - GET  (JWT)                    — original server shape (nested `quotas`)
//   - POST (JWT) { user_id? }       — CONTRACT-integrations §2. A body user_id
//     that differs from the JWT subject is rejected (403) — tier truth must
//     never be readable cross-user.
// Pure read path: no consumption, no side effects.

import { admin, requireUser } from "../_shared/auth.ts";
import { forbidden, handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";
import {
  FREE_CLOSET_ITEMS,
  FREE_LIFETIME_RENDERS,
  FREE_RESTYLES_PER_DAY,
  getEntitlementState,
  PREMIUM_MONTHLY_RENDERS,
  todayISO,
} from "../_shared/quota.ts";

/** First instant of next calendar month (UTC) — the premium window edge. */
function nextMonthlyBoundaryISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, ["GET", "POST"]);
    const user = await requireUser(req);

    if (req.method === "POST") {
      let claimed: unknown = null;
      try {
        const parsed = (await req.json()) as { user_id?: unknown; userId?: unknown };
        claimed = parsed.user_id ?? parsed.userId ?? null;
      } catch {
        claimed = null; // empty/missing body is fine — JWT is the identity
      }
      if (typeof claimed === "string" && claimed.length > 0 && claimed !== user.id) {
        throw forbidden("user_mismatch", "user_id does not match the signed-in session");
      }
    }

    const sb = admin();
    const [ent, quotaRow, closet, sub] = await Promise.all([
      getEntitlementState(sb, user.id),
      sb.from("render_quotas").select("restyles").eq("user_id", user.id).eq("day", todayISO())
        .maybeSingle<{ restyles: number }>(),
      sb.from("garments").select("id", { count: "exact", head: true })
        .eq("user_id", user.id).is("deleted_at", null),
      sb.from("subscriptions").select("status,trial_ends_at,renews_at").eq("user_id", user.id)
        .maybeSingle<{ status: string | null; trial_ends_at: string | null; renews_at: string | null }>(),
    ]);

    const closetUsed = closet.count ?? 0;
    const restylesToday = quotaRow?.restyles ?? 0;
    const nowMs = Date.now();
    const trialEndsAt = sub?.trial_ends_at ?? ent.trialEndsAt;
    const trialing = sub?.status === "trialing" &&
      trialEndsAt !== null && Date.parse(trialEndsAt) > nowMs;

    return json({
      tier: ent.tier,
      trialing,
      trialEndsAt,
      renewsAt: sub?.renews_at ?? ent.renewsAt,
      rendersLeft: ent.rendersLeft,
      rendersCap: ent.tier === "free" ? FREE_LIFETIME_RENDERS : PREMIUM_MONTHLY_RENDERS,
      rendersUsedPeriod: ent.tier === "free" ? ent.freeLifetimeUsed : ent.periodRendersUsed,
      quotaResetsAt: nextMonthlyBoundaryISO(),
      restylesLeftToday: ent.tier === "free"
        ? Math.max(0, FREE_RESTYLES_PER_DAY - restylesToday)
        : ent.rendersLeft,
      closetUsed,
      closetLimit: ent.tier === "free" ? FREE_CLOSET_ITEMS : null,
      stdCredits: ent.stdCredits,
      hdCredits: ent.hdCredits,
      canUseMax: ent.canUseMax,
      hardBlocked: ent.tier === "free" && ent.rendersLeft === 0 && ent.stdCredits === 0,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
