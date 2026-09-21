// billing-rc — RevenueCat webhook (SYSTEM OF RECORD for entitlements).
// POST /functions/v1/billing-rc  (no JWT — provider-signed instead)
// Verify: `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>` (constant-time
// compare, fail closed; 500 when the secret isn't configured so RC retries).
// Event mapping (RC event types → sub_status):
//   INITIAL_PURCHASE → trialing (is_trial_period/period_type TRIAL) else active
//   RENEWAL / PRODUCT_CHANGE → active (renews_at = expiration)
//   CANCELLATION → auto-renew OFF but paid-through: stays `active` with
//     renews_at = expiration + receipt.auto_renew=false (never cut early)
//   BILLING_ISSUE → past_due · EXPIRATION → expired
// Writes via service_role → subscriptions upsert + ledger(type='sub') memo.
// Retry-safe: provider event ids dedupe through ledger meta.

import { admin } from "../_shared/auth.ts";
import {
  alreadyApplied,
  badSignature,
  isUuid,
  notConfigured,
  requireUserExists,
  timingSafeEqual,
  upsertSubscription,
  type BillingPlatform,
  type SubStatus,
} from "../_shared/billing.ts";
import { handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { captureServerEvent } from "../_shared/posthog.ts";

function mapStore(store: unknown): BillingPlatform | null {
  const s = String(store ?? "").toUpperCase();
  if (s.includes("APP") && s.includes("STORE") || s === "APP_STORE") return "ios";
  if (s.includes("PLAY")) return "android";
  if (s.includes("STRIPE")) return "stripe";
  return null;
}

function msToIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const secret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
    if (!secret) throw notConfigured("REVENUECAT_WEBHOOK_SECRET");

    const auth = req.headers.get("authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${secret}`)) throw badSignature();

    const raw = (await req.json()) as Record<string, unknown>;
    const e = (raw.event ?? raw) as Record<string, unknown>;
    const type = String(e.type ?? "");
    if (!type) return json({ ok: true, ignored: true, reason: "no_event_type" });

    const appUserId = String(e.app_user_id ?? e.app_user_id_alias ?? "");
    const productId = typeof e.product_id === "string" ? e.product_id
      : typeof e.productId === "string" ? e.productId : null;
    const expiration = msToIso(e.expiration_at_ms ?? e.expires_at ?? e.renews_at);
    const eventId = typeof e.id === "string" && e.id
      ? `rc:${e.id}`
      : `rc:${type}:${appUserId}:${expiration ?? "none"}`;

    const sb = admin();
    if (await alreadyApplied(sb, eventId)) return json({ ok: true, deduped: true });

    let status: SubStatus | null = null;
    let trialEndsAt: string | null = null;
    let renewsAt: string | null = expiration;
    let autoRenew: boolean | null = null;

    switch (type) {
      case "INITIAL_PURCHASE": {
        const isTrial = e.is_trial_period === true ||
          String(e.period_type ?? "").toUpperCase() === "TRIAL";
        status = isTrial ? "trialing" : "active";
        trialEndsAt = isTrial ? expiration : null;
        break;
      }
      case "RENEWAL":
      case "PRODUCT_CHANGE":
      case "UNCANCELLATION":
        status = "active";
        break;
      case "CANCELLATION":
        // Paid-through: keep active until expiration; record auto_renew off.
        status = expiration && Date.parse(expiration) > Date.now() ? "active" : "expired";
        autoRenew = false;
        break;
      case "BILLING_ISSUE":
        status = "past_due";
        break;
      case "EXPIRATION":
        status = "expired";
        renewsAt = null;
        break;
      case "TRANSFER":
        // App-user-id alias transfer: nothing to entitle; log and ack.
        console.log("[billing-rc] transfer ignored", { eventId });
        return json({ ok: true, ignored: true, reason: "transfer" });
      default:
        console.log("[billing-rc] unknown event type", { type, eventId });
        return json({ ok: true, ignored: true, reason: `unknown_type:${type}` });
    }

    if (!isUuid(appUserId)) {
      console.error("[billing-rc] non-uuid app_user_id", { eventId, type });
      return json({ ok: true, mapped: false, reason: "app_user_id_not_vai_uuid" });
    }
    if (status === null) {
      console.log("[billing-rc] unmapped event type", { type, eventId });
      return json({ ok: true, ignored: true, reason: `unmapped:${type}` });
    }
    await requireUserExists(sb, appUserId);

    // Previous sub status drives lifecycle event mapping (trial→paid vs churn).
    const { data: prevSub } = await sb.from("subscriptions")
      .select("status")
      .eq("user_id", appUserId)
      .maybeSingle<{ status: string }>();
    const prevStatus = prevSub?.status ?? null;

    const { deduped } = await upsertSubscription(sb, {
      userId: appUserId,
      platform: mapStore(e.store),
      productId,
      status,
      trialEndsAt,
      renewsAt,
      receipt: { auto_renew: autoRenew, expiration },
      provider: "revenuecat",
      eventType: type,
      eventId,
    });

    // Server-authoritative revenue lifecycle events — the client can't see
    // renewals, cancellations or churn (it only observes its own fetches).
    const lifecycle = (() => {
      switch (type) {
        case "RENEWAL":
        case "PRODUCT_CHANGE":
        case "UNCANCELLATION":
          return prevStatus === "trialing"
            ? { event: "trial_converted", props: {} }
            : {
                event: "subscription_renewed",
                props: { ...(productId ? { product_id: productId } : {}) },
              };
        case "CANCELLATION":
          // Auto-renew off during a trial = trial abandonment; paid plans
          // keep access until EXPIRATION (churn fires there, not here).
          return prevStatus === "trialing" ? { event: "trial_cancelled", props: {} } : null;
        case "EXPIRATION":
          return prevStatus === "trialing"
            ? { event: "trial_cancelled", props: {} }
            : { event: "subscription_churned", props: {} };
        default:
          return null;
      }
    })();
    if (lifecycle) {
      void captureServerEvent(appUserId, lifecycle.event, {
        tier: "premium",
        source: "billing-rc",
        ...lifecycle.props,
      });
    }
    return json({ ok: true, deduped, status });
  } catch (e) {
    return toErrorResponse(e);
  }
});
