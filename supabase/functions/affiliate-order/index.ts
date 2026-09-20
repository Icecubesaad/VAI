// affiliate-order — affiliate network order postback (GTM turf).
// POST /functions/v1/affiliate-order  (no JWT — network-signed instead)
// Verify: `Authorization: Bearer <AFFILIATE_POSTBACK_SECRET>` (constant-time).
// Body: { user_id?, click_id, product_id?, retailer?, commission_cents? }
// Writes a ledger memo + PostHog `affiliate_order` — closes the try-on→buy
// attribution chain (lib/affiliate.ts click → network → order postback).

import { admin } from "../_shared/auth.ts";
import { isUuid, requireUserExists, timingSafeEqual } from "../_shared/billing.ts";
import {
  handleOptions,
  json,
  readJson,
  requireMethod,
  toErrorResponse,
} from "../_shared/http.ts";
import { writeLedger } from "../_shared/ledger.ts";
import { captureServerEvent } from "../_shared/posthog.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const secret = Deno.env.get("AFFILIATE_POSTBACK_SECRET");
    if (!secret) return json({ ok: false, reason: "not_configured" }, 503);
    const auth = req.headers.get("authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${secret}`)) {
      return json({ ok: false, reason: "bad_signature" }, 401);
    }

    const body = await readJson<{
      user_id?: unknown;
      click_id?: unknown;
      product_id?: unknown;
      retailer?: unknown;
      commission_cents?: unknown;
    }>(req);
    const clickId = typeof body.click_id === "string" ? body.click_id.trim() : "";
    if (!clickId) return json({ ok: false, reason: "click_id_required" }, 400);
    const commission = Number.isFinite(Number(body.commission_cents))
      ? Math.max(0, Math.round(Number(body.commission_cents)))
      : 0;
    const retailer = typeof body.retailer === "string" ? body.retailer : null;
    const productId = typeof body.product_id === "string" ? body.product_id : null;
    const userId = typeof body.user_id === "string" ? body.user_id : "";

    if (isUuid(userId)) {
      await requireUserExists(admin(), userId);
      // Commission cents are POSITIVE (affiliate revenue memo, audit trail).
      await writeLedger(admin(), {
        userId,
        type: "affiliate_cashback",
        amountCents: commission,
        meta: { click_id: clickId, product_id: productId, retailer },
      });
    }
    // Attribution truth even when the click predates a known user id.
    void captureServerEvent(isUuid(userId) ? userId : `affiliate:${clickId}`, "affiliate_order", {
      tier: "free",
      click_id: clickId,
      ...(productId ? { product_id: productId } : {}),
      ...(retailer ? { retailer } : {}),
      commission_cents: commission,
      source: "postback",
    });
    return json({ ok: true });
  } catch (e) {
    return toErrorResponse(e);
  }
});
