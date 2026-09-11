// referral-credit — code → 1mo Premium both sides.
// POST { code: "VAI-XXXXXX" }
// Reward ONLY after the referee completes onboarding proof: 3+ closet items AND
// 1+ finished try-on. Otherwise the referral stays `pending` and the client
// shows progress. Inviter cap: 12 rewarded months per user (invitee is still
// rewarded when the inviter is capped).

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, forbidden, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { logReferralGrant } from "../_shared/ledger.ts";

const REQUIRED_ITEMS = 3;
const REQUIRED_TRYONS = 1;
const INVITER_MONTH_CAP = 12;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const invitee = await requireUser(req);
    const body = await readJson<{ code?: string }>(req);
    const code = (body.code ?? "").trim().toUpperCase();
    if (!/^VAI-[A-Z0-9]{6}$/.test(code)) throw badRequest("code_invalid", "That code doesn't look right");

    const sb = admin();
    const { data: inviter } = await sb.from("users").select("id").eq("referral_code", code)
      .maybeSingle<{ id: string }>();
    if (!inviter) throw badRequest("code_unknown", "No account matches that code");
    if (inviter.id === invitee.id) throw badRequest("self_referral", "You can't refer yourself");

    // Idempotent: already linked → report current state, never double-link.
    const { data: link } = await sb.from("referrals").select("status").eq("invitee_id", invitee.id)
      .maybeSingle<{ status: string }>();
    if (link) return json({ status: link.status, already_linked: true });

    const { error: linkErr } = await sb.from("referrals").insert({
      code,
      inviter_id: inviter.id,
      invitee_id: invitee.id,
      status: "pending",
    });
    // Concurrent double-tap → unique violation on invitee_id; treat as linked.
    if (linkErr && linkErr.code !== "23505") throw linkErr;

    // Qualification proof.
    const [{ count: items }, { count: tryons }] = await Promise.all([
      sb.from("garments").select("id", { count: "exact", head: true })
        .eq("user_id", invitee.id).is("deleted_at", null),
      sb.from("renders").select("id", { count: "exact", head: true })
        .eq("user_id", invitee.id).eq("status", "done"),
    ]);
    const itemCount = items ?? 0;
    const tryonCount = tryons ?? 0;
    const qualified = itemCount >= REQUIRED_ITEMS && tryonCount >= REQUIRED_TRYONS;
    if (!qualified) {
      return json({
        status: "pending",
        progress: {
          items: itemCount,
          items_required: REQUIRED_ITEMS,
          tryons: tryonCount,
          tryons_required: REQUIRED_TRYONS,
        },
        message: `Add ${Math.max(0, REQUIRED_ITEMS - itemCount)} more items and finish ` +
          `${Math.max(0, REQUIRED_TRYONS - tryonCount)} try-on to unlock 1 free month for you both.`,
      });
    }

    // Reward both sides. Inviter cap: 12 rewarded months, then invitee-only.
    const { count: inviterRewards } = await sb.from("referrals").select("invitee_id", { count: "exact", head: true })
      .eq("inviter_id", inviter.id).eq("status", "credited");
    const inviterCapped = (inviterRewards ?? 0) >= INVITER_MONTH_CAP;

    const inviteeRenews = (await sb.rpc("extend_subscription", {
      p_user: invitee.id,
      p_months: 1,
    })) as unknown as string;
    await logReferralGrant(sb, invitee.id, {
      direction: "invitee",
      code,
      renews_at: inviteeRenews,
    });

    let inviterRenews: string | null = null;
    if (!inviterCapped) {
      inviterRenews = (await sb.rpc("extend_subscription", {
        p_user: inviter.id,
        p_months: 1,
      })) as unknown as string;
      await logReferralGrant(sb, inviter.id, {
        direction: "inviter",
        code,
        invitee_id: invitee.id,
        renews_at: inviterRenews,
      });
    }

    const { error: credErr } = await sb.from("referrals").update({ status: "credited" })
      .eq("invitee_id", invitee.id);
    if (credErr) throw credErr;

    return json({
      status: "credited",
      invitee_renews_at: inviteeRenews,
      inviter_rewarded: !inviterCapped,
      inviter_renews_at: inviterRenews,
      inviter_capped: inviterCapped
        ? "Your friend hit the 12-month referral cap — your month still applied."
        : null,
    });
  } catch (e) {
    if (e instanceof Error && (e as Error & { status?: number }).status === 403) {
      return toErrorResponse(forbidden("referral_denied", e.message));
    }
    return toErrorResponse(e);
  }
});
