// Auth guard for VAI Edge Functions (Deno, strict TS).
// Verifies the caller's Supabase JWT with the SERVICE_ROLE client, then ensures
// a public.users row exists (first-call provisioning + referral code minting).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { unauthorized } from "./http.ts";

export interface AuthedUser {
  id: string;
  email: string | null;
}

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing server secret: ${name}`);
  return v;
}

export function supabaseUrl(): string {
  return mustEnv("SUPABASE_URL");
}

/** service_role client — bypasses RLS. NEVER expose its key to the client. */
export function admin(): SupabaseClient {
  return createClient(supabaseUrl(), mustEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function newReferralCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of buf) s += alphabet[b % alphabet.length];
  return `VAI-${s}`;
}

/**
 * Verify `Authorization: Bearer <jwt>` and provision public.users.
 * Throws 401 HttpError on any auth failure (fail closed).
 */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw unauthorized();

  const sb = admin();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw unauthorized("Session expired. Sign in again.");

  const user: AuthedUser = { id: data.user.id, email: data.user.email ?? null };

  // First-call provisioning: idempotent upsert, never clobbers existing data.
  const { data: existing } = await sb
    .from("users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (!existing) {
    const { error: insErr } = await sb.from("users").insert({
      id: user.id,
      email: user.email,
      referral_code: newReferralCode(),
    });
    // Race between concurrent first calls → unique violation is fine.
    if (insErr && insErr.code !== "23505") throw insErr;
  }
  return user;
}
