// billing-apple — App Store Server Notifications v2 (fallback / audit path).
// POST /functions/v1/billing-apple { signedPayload }  (no JWT)
// Verify (secrets.md verify column):
//   1. JWS compact structure (3 segments, JSON payload) — malformed → 400.
//   2. data.bundleId === APPLE_BUNDLE_ID when configured; when the env var is
//      UNSET the check is skipped with a loud server log (operator must set
//      it — documented in supabase/secrets.md).
//   3. signedDate recency (±24h) against replayed notifications.
//   4. The nested signedTransactionInfo JWS is decoded the same way.
// LIMITATION (stated, not hidden): full x5c certificate-chain verification
// against the Apple Root CA is NOT performed here — RevenueCat remains the
// system of record and cross-checks these events. A follow-up can bundle the
// Apple root + WebCrypto ECDSA verify when the direct path becomes primary.
// Notification mapping → sub_status:
//   SUBSCRIBED (INITIAL_BUY + offerType intro) → trialing, else active
//   DID_RENEW / SUBSCRIBED(other) / DID_CHANGE_RENEWAL_STATUS(auto-renew on)
//     → active · auto-renew OFF → active w/ receipt.auto_renew=false (paid-thru)
//   DID_FAIL_TO_RENEW → past_due · EXPIRED / GRACE_PERIOD_EXPIRED → expired
//   REFUND → canceled · REVOKE → expired
// Identity: transactionInfo.appAccountToken MUST be the VAI user UUID (the app
// sets it at purchase). Absent/unresolvable → 200 { mapped:false } + log so
// Apple doesn't retry-storm an unmappable event.

import { admin } from "../_shared/auth.ts";
import {
  badSignature,
  decodeJwsPayload,
  isUuid,
  requireUserExists,
  upsertSubscription,
  type SubStatus,
} from "../_shared/billing.ts";
import { handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";

interface AppleNotification {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

interface AppleTransaction {
  transactionId?: string;
  productId?: string;
  bundleId?: string;
  expiresDate?: number;
  appAccountToken?: string;
  offerType?: number; // 1 = introductory (trial)
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const { signedPayload } = (await req.json()) as { signedPayload?: unknown };
    if (typeof signedPayload !== "string" || !signedPayload) {
      return json({ ok: false, error: { code: "payload_required", message: "signedPayload required" } }, 400);
    }

    let n: AppleNotification;
    try {
      n = decodeJwsPayload<AppleNotification>(signedPayload);
    } catch {
      throw badSignature("signedPayload is not a well-formed JWS");
    }
    const type = n.notificationType ?? "";
    const subtype = n.subtype ?? "";
    if (!type) throw badSignature("notification missing notificationType");

    const expectedBundle = Deno.env.get("APPLE_BUNDLE_ID");
    const bundleId = n.data?.bundleId;
    if (expectedBundle) {
      if (bundleId !== expectedBundle) throw badSignature("bundleId mismatch");
    } else {
      console.warn("[billing-apple] APPLE_BUNDLE_ID unset — bundle check skipped (set it per supabase/secrets.md)");
    }
    if (typeof n.signedDate === "number") {
      if (Math.abs(Date.now() - n.signedDate) > 24 * 3600 * 1000) {
        throw badSignature("stale notification (signedDate outside 24h)");
      }
    }

    const eventId = `apple:${n.notificationUUID ?? `${type}:${subtype}:${n.signedDate ?? Date.now()}`}`;

    let txn: AppleTransaction = {};
    if (n.data?.signedTransactionInfo) {
      try {
        txn = decodeJwsPayload<AppleTransaction>(n.data.signedTransactionInfo);
      } catch {
        throw badSignature("signedTransactionInfo malformed");
      }
    }

    let status: SubStatus | null = null;
    let autoRenew: boolean | null = null;
    switch (type) {
      case "SUBSCRIBED":
        status = (subtype === "INITIAL_BUY" && txn.offerType === 1) ? "trialing" : "active";
        break;
      case "DID_RENEW":
        status = "active";
        break;
      case "DID_CHANGE_RENEWAL_STATUS":
        status = "active";
        autoRenew = subtype === "AUTO_RENEW_ENABLED";
        break;
      case "DID_FAIL_TO_RENEW":
        status = "past_due"; // incl. GRACE_PERIOD subtype — still entitled
        break;
      case "GRACE_PERIOD_EXPIRED":
      case "EXPIRED":
        status = "expired";
        break;
      case "REFUND":
        status = "canceled";
        break;
      case "REVOKE":
        status = "expired";
        break;
      case "TEST":
        return json({ ok: true, test: true });
      default:
        console.log("[billing-apple] unknown notification", { type, subtype, eventId });
        return json({ ok: true, ignored: true, reason: `unknown_type:${type}` });
    }

    const expiresIso = typeof txn.expiresDate === "number" && txn.expiresDate > 0
      ? new Date(txn.expiresDate).toISOString()
      : null;
    const userId = txn.appAccountToken ?? "";
    if (!isUuid(userId)) {
      console.error("[billing-apple] missing/unresolvable appAccountToken", { eventId, type, subtype });
      return json({ ok: true, mapped: false, reason: "appAccountToken_not_vai_uuid" });
    }
    if (status === null) {
      console.log("[billing-apple] unmapped notification", { type, subtype, eventId });
      return json({ ok: true, ignored: true, reason: "unmapped" });
    }

    const sb = admin();
    await requireUserExists(sb, userId);
    const trialing = status === "trialing";
    const { deduped } = await upsertSubscription(sb, {
      userId,
      platform: "ios",
      productId: txn.productId ?? null,
      status,
      trialEndsAt: trialing ? expiresIso : null,
      renewsAt: status === "expired" ? null : expiresIso,
      receipt: {
        auto_renew: autoRenew,
        transaction_id: txn.transactionId ?? null,
        environment: n.data?.environment ?? null,
      },
      provider: "apple",
      eventType: subtype ? `${type}/${subtype}` : type,
      eventId,
    });
    return json({ ok: true, deduped, status });
  } catch (e) {
    return toErrorResponse(e);
  }
});
