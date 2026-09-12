// Shared billing-webhook core (Deno, strict TS) for billing-rc,
// billing-apple, billing-google, billing-stripe.
//
// Money flow (per supabase/secrets.md + docs/SECURITY.md P0-003):
//   verify provider signature → normalize to a SubscriptionUpsert → upsert
//   `subscriptions` via service_role → append a $0 `ledger(type='sub')` memo.
// Ledger memos are amount_cents=0 BY DESIGN: multi-currency IAP receipts are
// audit memos, not revenue postings (revenue truth lives in the provider
// dashboards + these memos). Credit-pack fulfillment (Stripe) increments
// `entitlements` std/hd credits via the atomic grant_pack_credits RPC (0007).
// Dedupe: provider event ids are claimed through the ledger's UNIQUE
// (type, meta->>'provider_event_id') index — exactly-once at the DB level.
// System of record is RevenueCat; Apple/Google-direct are the fallback/audit
// path (secrets.md). Handlers never throw raw secrets — failures return
// bad_signature / not_configured codes without key material. Signature
// verification lives in _shared/jws.ts (Apple x5c chain / Google OIDC JWKS).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { HttpError } from "./http.ts";
import { writeLedger } from "./ledger.ts";

export type SubStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type BillingPlatform = "ios" | "android" | "stripe";

export const badSignature = (message = "Invalid webhook signature") =>
  new HttpError(401, "bad_signature", message);
export const notConfigured = (name: string) =>
  new HttpError(500, "not_configured", `Webhook secret missing: ${name}`);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Constant-time string compare (webhook secrets, Stripe v1 digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** HMAC-SHA256 hex (Stripe-style `t.payload` signatures). */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    enc(payload),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64URL → UTF-8 string (JWS segments). Throws on malformed input. */
export function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);
  return atob(padded);
}

// NOTE: there is deliberately no decode-only JWS helper here. Payloads are
// trusted only after cryptographic verification (_shared/jws.ts) — a
// structural decode that skips the signature is how billing-apple used to
// grant premium to forged webhooks.

export interface SubscriptionUpsert {
  userId: string;
  platform: BillingPlatform | null; // null → keep the stored platform
  productId: string | null;
  status: SubStatus;
  trialEndsAt: string | null;
  renewsAt: string | null;
  receipt: Record<string, unknown>;
  provider: "revenuecat" | "apple" | "google" | "stripe";
  eventType: string;
  eventId: string;
}

/** True when this provider event was already applied (retry-safe). */
export async function alreadyApplied(sb: SupabaseClient, eventId: string): Promise<boolean> {
  const { data } = await sb.from("ledger").select("id")
    .eq("type", "sub").filter("meta->>provider_event_id", "eq", eventId)
    .limit(1).maybeSingle<{ id: string }>();
  return !!data;
}

export async function upsertSubscription(
  sb: SupabaseClient,
  u: SubscriptionUpsert,
): Promise<{ deduped: boolean }> {
  if (await alreadyApplied(sb, u.eventId)) return { deduped: true };

  const { data: existing } = await sb.from("subscriptions")
    .select("platform,product_id").eq("user_id", u.userId)
    .maybeSingle<{ platform: string | null; product_id: string | null }>();

  const { error } = await sb.from("subscriptions").upsert({
    user_id: u.userId,
    platform: u.platform ?? existing?.platform ?? "ios",
    product_id: u.productId ?? existing?.product_id ?? "unknown",
    status: u.status,
    trial_ends_at: u.trialEndsAt,
    renews_at: u.renewsAt,
    receipt: {
      provider: u.provider,
      event_type: u.eventType,
      event_id: u.eventId,
      ...u.receipt,
    },
  }, { onConflict: "user_id" });
  if (error) throw error;

  await writeLedger(sb, {
    userId: u.userId,
    type: "sub",
    amountCents: 0,
    meta: {
      kind: "subscription",
      provider: u.provider,
      provider_event_id: u.eventId,
      event_type: u.eventType,
      product_id: u.productId,
      status: u.status,
      trial_ends_at: u.trialEndsAt,
      renews_at: u.renewsAt,
    },
  });
  return { deduped: false };
}

/** Consumable credit packs (Stripe; IAP-exempt physical-goods rule doesn't
 *  apply — these are app consumables sold via Stripe per build pack §1). */
export const PACKS: Record<string, { std: number; hd: number; label: string }> = {
  credits_10: { std: 10, hd: 0, label: "10 std credits" },
  credits_25: { std: 25, hd: 0, label: "25 std credits" },
  hd_single: { std: 0, hd: 1, label: "1 HD render" },
};

export async function grantPackCredits(
  sb: SupabaseClient,
  opts: {
    userId: string;
    pack: string;
    provider: "stripe";
    eventId: string;
    productId?: string | null;
    amountCents?: number | null;
  },
): Promise<{ deduped: boolean; std: number; hd: number }> {
  const spec = PACKS[opts.pack];
  if (!spec) throw new HttpError(400, "pack_unknown", `Unknown credit pack: ${opts.pack}`);

  // Atomic claim + grant inside grant_pack_credits (migration 0007): the
  // provider_event_id ledger claim is the concurrency boundary, so two
  // concurrent deliveries of the same event can never both credit. The
  // pre-check here is only a fast path for the common retry case.
  if (await alreadyApplied(sb, opts.eventId)) return { deduped: true, std: spec.std, hd: spec.hd };

  const { data, error } = await sb.rpc("grant_pack_credits", {
    p_user_id: opts.userId,
    p_pack: opts.pack,
    p_event_id: opts.eventId,
    p_amount_cents: opts.amountCents ?? null,
  }).single<{ deduped: boolean; std: number; hd: number }>();
  if (error) throw error;
  return {
    deduped: data?.deduped === true,
    std: typeof data?.std === "number" ? data.std : spec.std,
    hd: typeof data?.hd === "number" ? data.hd : spec.hd,
  };
}

/**
 * Atomic refund debit for a credit pack (migration 0007): claims the refund
 * event id in the ledger, then floors std/hd credits at 0. Returns false when
 * this refund was already applied (retry-safe) or the pack is unknown.
 */
export async function debitPackCreditsForRefund(
  sb: SupabaseClient,
  opts: { userId: string; pack: string; eventId: string },
): Promise<{ debited: boolean; std: number; hd: number }> {
  const spec = PACKS[opts.pack];
  if (!spec) return { debited: false, std: 0, hd: 0 };
  const { data, error } = await sb.rpc("debit_pack_credits", {
    p_user_id: opts.userId,
    p_std: spec.std,
    p_hd: spec.hd,
    p_event_id: opts.eventId,
  }).single<boolean>();
  if (error) throw error;
  return { debited: data === true, std: spec.std, hd: spec.hd };
}

/** Confirm the user exists before writing money rows (webhooks carry raw ids). */
export async function requireUserExists(sb: SupabaseClient, userId: string): Promise<void> {
  const { data } = await sb.from("users").select("id").eq("id", userId)
    .maybeSingle<{ id: string }>();
  if (!data) throw new HttpError(400, "user_unresolvable", "No VAI account matches this purchase identity");
}
