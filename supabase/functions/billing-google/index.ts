// billing-google — Play RTDN via Pub/Sub push (fallback / audit path).
// POST /functions/v1/billing-google  (no JWT — Google-signed instead)
// Verify (_shared/jws.ts, fail closed):
//   1. Pub/Sub OIDC JWT in `Authorization: Bearer` — FULL verification: RS256
//      signature against Google's published JWKS, iss = accounts.google.com,
//      exp in the future, and the email claim MUST equal
//      GOOGLE_PUBSUB_SERVICE_ACCOUNT. The env var is REQUIRED (unset → 500
//      not_configured; the endpoint never runs unauthenticated).
//   2. message.data (base64) → { packageName, subscriptionNotification? } —
//      packageName must equal ANDROID_PACKAGE_NAME when configured.
// notificationType → sub_status: 1 RECOVERED/2 RENEWED/4 PURCHASED/7 RESTARTED/
// 9 DEFERRED → active · 3 CANCELED → active-paid-thru w/ auto_renew=false
// (cut only at expiry) · 5 ON_HOLD/6 GRACE/10 PAUSED → past_due ·
// 12 REVOKED/13 EXPIRED → expired · 8/11 → noop ack.
// Identity: RTDN carries only a purchaseToken — the VAI user UUID comes from
// the Play Developer API (purchases.subscriptionsv2.get →
// linkedAccountInfo.obfuscatedExternalAccountId, which the app sets at
// purchase). Requires GOOGLE_SERVICE_ACCOUNT_JSON; without it the event is
// ACKed unmapped { mapped:false } + logged (no retry storm) for later
// reconciliation — RC remains the entitling path.

import { admin } from "../_shared/auth.ts";
import {
  base64UrlDecode,
  isUuid,
  notConfigured,
  requireUserExists,
  upsertSubscription,
  type SubStatus,
} from "../_shared/billing.ts";
import { verifyGoogleOidcToken, type OidcClaims } from "../_shared/jws.ts";
import { handleOptions, HttpError, json, requireMethod, toErrorResponse } from "../_shared/http.ts";

interface RtdnEnvelope {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  oneTimeProductNotification?: unknown;
  testNotification?: unknown;
}

async function verifyPubSubOidc(req: Request): Promise<OidcClaims> {
  const expectedEmail = Deno.env.get("GOOGLE_PUBSUB_SERVICE_ACCOUNT");
  if (!expectedEmail) {
    // Fail closed: an unauthenticated push endpoint must never run. Operators
    // must set GOOGLE_PUBSUB_SERVICE_ACCOUNT (supabase/secrets.md).
    throw notConfigured("GOOGLE_PUBSUB_SERVICE_ACCOUNT");
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new Error("missing OIDC bearer (Pub/Sub push auth)");
  const claims = await verifyGoogleOidcToken(token);
  if (claims.email !== expectedEmail) {
    throw new Error("OIDC service-account email mismatch");
  }
  return claims;
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

/** OAuth2 JWT-bearer grant → Google access token (androidpublisher scope). */
async function playAccessToken(sa: ServiceAccountJson): Promise<string> {
  if (!sa.client_email || !sa.private_key) throw new Error("service account missing client_email/private_key");
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const claim = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  const jwt = `${header}.${claim}.${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`Play OAuth HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Play OAuth returned no access_token");
  return body.access_token;
}

/** purchaseToken → obfuscatedExternalAccountId (the VAI user UUID). */
async function resolvePlayUser(packageName: string, purchaseToken: string): Promise<string | null> {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  const sa = JSON.parse(raw) as ServiceAccountJson;
  const token = await playAccessToken(sa);
  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Play Developer API HTTP ${res.status}`);
  const body = (await res.json()) as {
    linkedAccountInfo?: { obfuscatedExternalAccountId?: string };
  };
  return body.linkedAccountInfo?.obfuscatedExternalAccountId ?? null;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    try {
      await verifyPubSubOidc(req);
    } catch (e) {
      // HttpError (not_configured) propagates with its own status/code; every
      // other failure is an auth rejection.
      if (e instanceof HttpError) throw e;
      console.error("[billing-google] OIDC verify failed", (e as Error).message);
      return json({ ok: false, error: { code: "bad_signature", message: "Invalid Pub/Sub push auth" } }, 401);
    }

    const push = (await req.json()) as {
      message?: { data?: string; messageId?: string };
      subscription?: string;
    };
    if (!push.message?.data) {
      return json({ ok: false, error: { code: "payload_required", message: "Pub/Sub message.data required" } }, 400);
    }
    const envelope = JSON.parse(base64UrlDecode(push.message.data)) as RtdnEnvelope;
    if (envelope.testNotification !== undefined) return json({ ok: true, test: true });

    const expectedPkg = Deno.env.get("ANDROID_PACKAGE_NAME");
    if (expectedPkg) {
      if (envelope.packageName !== expectedPkg) {
        return json({ ok: false, error: { code: "bad_signature", message: "packageName mismatch" } }, 401);
      }
    } else {
      console.warn("[billing-google] ANDROID_PACKAGE_NAME unset — package check skipped (set it per supabase/secrets.md)");
    }

    const sub = envelope.subscriptionNotification;
    if (!sub) {
      console.log("[billing-google] non-subscription notification acked", {
        messageId: push.message.messageId,
      });
      return json({ ok: true, ignored: true, reason: "one_time_or_unknown" });
    }

    const nt = sub.notificationType ?? -1;
    const eventId = `google:${push.message.messageId ?? `${sub.subscriptionId}:${sub.purchaseToken}:${nt}`}`;
    let status: SubStatus | null = null;
    let autoRenew: boolean | null = null;
    switch (nt) {
      case 1: case 2: case 4: case 7: case 9:
        status = "active";
        break;
      case 3:
        status = "active"; // paid-through; RC expiry flips it later
        autoRenew = false;
        break;
      case 5: case 6: case 10:
        status = "past_due";
        break;
      case 12: case 13:
        status = "expired"; // 12 REVOKED, 13 EXPIRED
        break;
      case 8: case 11:
        return json({ ok: true, ignored: true, reason: `noop_type:${nt}` });
      default:
        console.log("[billing-google] unknown notificationType", { nt, eventId });
        return json({ ok: true, ignored: true, reason: `unknown_type:${nt}` });
    }

    if (!sub.purchaseToken || !envelope.packageName) {
      return json({ ok: false, error: { code: "payload_required", message: "purchaseToken/packageName required" } }, 400);
    }
    if (status === null) {
      console.log("[billing-google] unmapped notificationType", { nt, eventId });
      return json({ ok: true, ignored: true, reason: "unmapped" });
    }

    let userId: string | null = null;
    try {
      userId = await resolvePlayUser(envelope.packageName, sub.purchaseToken);
    } catch (e) {
      console.error("[billing-google] Play API lookup failed", (e as Error).message);
    }
    if (!userId || !isUuid(userId)) {
      // ACK without mapping (no retry storm); RC remains the entitling path.
      // purchaseToken is kept in the log for later reconciliation.
      console.error("[billing-google] user unresolvable for purchase", {
        eventId,
        notificationType: nt,
        subscriptionId: sub.subscriptionId,
        purchaseToken: sub.purchaseToken.slice(0, 12) + "…",
      });
      return json({ ok: true, mapped: false, reason: "play_api_unavailable_or_unlinked" });
    }

    const sb = admin();
    await requireUserExists(sb, userId);
    const { deduped } = await upsertSubscription(sb, {
      userId,
      platform: "android",
      productId: sub.subscriptionId ?? null,
      status,
      trialEndsAt: null,
      renewsAt: null,
      receipt: {
        auto_renew: autoRenew,
        purchase_token_prefix: sub.purchaseToken.slice(0, 12),
        event_time_ms: envelope.eventTimeMillis ?? null,
      },
      provider: "google",
      eventType: `SUBSCRIPTION_${nt}`,
      eventId,
    });
    return json({ ok: true, deduped, status });
  } catch (e) {
    return toErrorResponse(e);
  }
});
