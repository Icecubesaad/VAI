// billing-stripe — Stripe webhook for CREDIT PACKS (subscriptions NEVER go
// through Stripe: IAP-exempt packs only, per build pack §1 + secrets.md).
// POST /functions/v1/billing-stripe  (no JWT — Stripe-signed instead)
// Verify: `Stripe-Signature: t=<ts>,v1=<hmac>` where hmac = HMAC-SHA256(
// STRIPE_WEBHOOK_SECRET, `<ts>.<rawBody>`) — the RAW body is read BEFORE
// parsing (req.text() first), constant-time compare, 300s tolerance.
// Events:
//   checkout.session.completed / payment_intent.succeeded with
//     metadata { user_id (VAI UUID, required), pack (credits_10 | credits_25 |
//     hd_single, required) } → entitlements std/hd credits + pack ledger memo.
//   charge.refunded → when the charge carries VAI metadata (user_id + pack),
//     pack credits are debited atomically (floored at 0, retry-safe); without
//     attribution → audit memo for ops review (ids only — no PII in logs).
//   customer.subscription.* → ignored + memo (subscriptions route via RC).
// Retry-safe: Stripe event ids dedupe through ledger meta.

import { admin } from "../_shared/auth.ts";
import {
  debitPackCreditsForRefund,
  grantPackCredits,
  hmacSha256Hex,
  isUuid,
  notConfigured,
  requireUserExists,
  timingSafeEqual,
} from "../_shared/billing.ts";
import { HttpError, handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";

const TOLERANCE_S = 300;

function parseSigHeader(header: string): { t: number; v1: string[] } {
  let t = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  return { t, v1 };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!secret) throw notConfigured("STRIPE_WEBHOOK_SECRET");

    // RAW body first — parsing before verify breaks the signature.
    const raw = await req.text();
    const { t, v1 } = parseSigHeader(req.headers.get("stripe-signature") ?? "");
    if (!t || v1.length === 0) {
      return json({ ok: false, error: { code: "bad_signature", message: "Missing Stripe-Signature" } }, 401);
    }
    if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) {
      return json({ ok: false, error: { code: "bad_signature", message: "Signature timestamp outside tolerance" } }, 401);
    }
    const expected = await hmacSha256Hex(secret, `${t}.${raw}`);
    if (!v1.some((sig) => timingSafeEqual(sig, expected))) {
      return json({ ok: false, error: { code: "bad_signature", message: "Invalid Stripe signature" } }, 401);
    }

    let event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Webhook body must be JSON");
    }
    const eventId = typeof event.id === "string" ? `stripe:${event.id}` : null;
    const type = typeof event.type === "string" ? event.type : "";
    if (!eventId || !type) throw new HttpError(400, "payload_required", "Stripe event id/type required");

    const sb = admin();

    if (type === "checkout.session.completed" || type === "payment_intent.succeeded") {
      const obj = event.data?.object ?? {};
      const md = (obj.metadata ?? {}) as Record<string, unknown>;
      const userId = typeof md.user_id === "string" ? md.user_id : "";
      const pack = typeof md.pack === "string" ? md.pack : "";
      if (!isUuid(userId)) {
        console.error("[billing-stripe] purchase without VAI user_id metadata", { eventId, type });
        return json({ ok: true, mapped: false, reason: "metadata_user_id_missing" });
      }
      if (!pack) throw new HttpError(400, "pack_unknown", "metadata.pack required (credits_10|credits_25|hd_single)");
      await requireUserExists(sb, userId);
      const amount = typeof obj.amount_total === "number" ? obj.amount_total : null;
      const productId = typeof md.product_id === "string" ? md.product_id : pack;
      const res = await grantPackCredits(sb, {
        userId,
        pack,
        provider: "stripe",
        eventId,
        productId,
        amountCents: amount,
      });
      return json({ ok: true, deduped: res.deduped, pack, std: res.std, hd: res.hd });
    }

    if (type === "charge.refunded") {
      // Refund handling: when the charge carries VAI attribution metadata
      // (user_id + pack, set at checkout creation), debit the pack credits
      // atomically (floored at 0, retry-safe via the ledger claim). Without
      // attribution the refund is logged for ops review — ids only, never
      // the raw charge object (customer email/PII).
      const obj = event.data?.object ?? {};
      const md = (obj.metadata ?? {}) as Record<string, unknown>;
      const userId = typeof md.user_id === "string" ? md.user_id : "";
      const pack = typeof md.pack === "string" ? md.pack : "";
      const chargeId = typeof obj.id === "string" ? obj.id : null;
      if (isUuid(userId) && pack) {
        await requireUserExists(sb, userId);
        const res = await debitPackCreditsForRefund(sb, {
          userId,
          pack,
          eventId: `${eventId}:refund`,
        });
        return json({ ok: true, action: "credits_debited", debited: res.debited });
      }
      console.error("[billing-stripe] refund without VAI attribution requires ops review", {
        eventId,
        chargeId,
        has_user_metadata: isUuid(userId),
        has_pack_metadata: pack.length > 0,
      });
      return json({ ok: true, action: "refund_logged_for_review" });
    }

    if (type.startsWith("customer.subscription.")) {
      console.log("[billing-stripe] subscription event ignored (packs-only)", { eventId, type });
      return json({ ok: true, ignored: true, reason: "subscriptions_via_rc" });
    }

    console.log("[billing-stripe] unhandled event acked", { eventId, type });
    return json({ ok: true, ignored: true, reason: `unhandled:${type}` });
  } catch (e) {
    return toErrorResponse(e);
  }
});
