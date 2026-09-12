// billing-apple — App Store Server Notifications v2 (fallback / audit path).
// POST /functions/v1/billing-apple { signedPayload }  (no JWT)
// Verify (_shared/jws.ts, fail closed):
//   1. FULL cryptographic verification of the signedPayload JWS: ES256
//      signature against the x5c leaf key, every chain link verified
//      cryptographically, chain anchored to Apple Root CA - G3, all certs
//      inside their validity windows. Unsigned/forged payloads → 401.
//   2. data.bundleId must equal APPLE_BUNDLE_ID — the env var is REQUIRED
//      (unset → 500 not_configured; the check never silently skips).
//   3. signedDate recency (±24h).
//   4. The nested signedTransactionInfo JWS is verified the same way.
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
  isUuid,
  notConfigured,
  requireUserExists,
  upsertSubscription,
  type SubStatus,
} from "../_shared/billing.ts";
import { verifyAppleJws } from "../_shared/jws.ts";
import { handleOptions, HttpError, json, requireMethod, toErrorResponse } from "../_shared/http.ts";

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
      n = await verifyAppleJws<AppleNotification>(signedPayload);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw badSignature("signedPayload failed verification");
    }
    const type = n.notificationType ?? "";
    const subtype = n.subtype ?? "";
    if (!type) throw badSignature("notification missing notificationType");

    const expectedBundle = Deno.env.get("APPLE_BUNDLE_ID");
    if (!expectedBundle) {
      // Fail closed: without the bundle pin a forged notification could name
      // any bundle. Operators must set APPLE_BUNDLE_ID (supabase/secrets.md).
      throw notConfigured("APPLE_BUNDLE_ID");
    }
    if (n.data?.bundleId !== expectedBundle) throw badSignature("bundleId mismatch");
    if (typeof n.signedDate === "number") {
      if (Math.abs(Date.now() - n.signedDate) > 24 * 3600 * 1000) {
        throw badSignature("stale notification (signedDate outside 24h)");
      }
    }

    const eventId = `apple:${n.notificationUUID ?? `${type}:${subtype}:${n.signedDate ?? Date.now()}`}`;

    let txn: AppleTransaction = {};
    if (n.data?.signedTransactionInfo) {
      try {
        txn = await verifyAppleJws<AppleTransaction>(n.data.signedTransactionInfo);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw badSignature("signedTransactionInfo failed verification");
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
