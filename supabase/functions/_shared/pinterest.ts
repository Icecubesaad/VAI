// Shared Pinterest v5 client (Deno, strict TS) — used by `pinterest-auth`,
// `pinterest-sync`, `pinterest-disconnect`, and `pinterest-share`, plus the
// pose_ref resolver used by `render-tryon` / `reel-regenerate`.
//
// VERIFIED v5 facts (Sep 2026): OAuth2 token endpoint
// `https://api.pinterest.com/v5/oauth/token`; scopes boards:read(+:secret)
// pins:read(+:secret) user_accounts:read pins:write; endpoints
// /v5/user_account /v5/boards?page_size /v5/boards/{id} /v5/boards/{id}/pins
// /v5/pins/{pin_id} (image originals). NO public search/trending endpoint —
// inspiration comes ONLY from the user's own boards/pins.
// Rate limits: Trial 1000 req/day (app-wide); Standard org_read 1000/min +
// org_write 300/100 with 429 + Retry-After/rate-limit headers. Trial apps see
// sandbox-only data (fine for dev).
//
// Security: tokens are AES-GCM-encrypted with PINTEREST_TOKEN_KEY before
// storage (pinterest_accounts.access/refresh_token_enc) and decrypted only in
// edge memory. u13 users are refused at connect (0002 age gate, 13+ only).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { badRequest, forbidden, HttpError } from "./http.ts";

export const PIN_API_BASE = "https://api.pinterest.com/v5";
export const PIN_TOKEN_URL = `${PIN_API_BASE}/oauth/token`;
/** Registered in the Pinterest app dashboard + the client deep link. */
export const PIN_REDIRECT_URI = "vai://pinterest-callback";

export const PIN_READ_SCOPES = [
  "boards:read",
  "pins:read",
  "user_accounts:read",
] as const;
export const PIN_SECRET_SCOPES = ["boards:secret", "pins:secret"] as const;
export const PIN_WRITE_SCOPES = ["pins:write"] as const;

export type PoseMode = "keep" | "adapt";

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing server secret: ${name}`);
  return v;
}

export function pinterestAppId(): string {
  return mustEnv("PINTEREST_APP_ID");
}

function pinterestAppSecret(): string {
  return mustEnv("PINTEREST_APP_SECRET");
}

// ------------------------------------------------------------------ crypto
async function tokenKey(): Promise<CryptoKey> {
  const raw = mustEnv("PINTEREST_TOKEN_KEY");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** AES-GCM encrypt an OAuth token → "v1.<b64(iv)>.<b64(ct)>". */
export async function encryptToken(plain: string): Promise<string> {
  const key = await tokenKey();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  return `v1.${b64encode(iv)}.${b64encode(ct)}`;
}

/** Decrypt a value produced by encryptToken(). Throws 500 on tamper/version. */
export async function decryptToken(enc: string): Promise<string> {
  const parts = enc.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unknown token encoding");
  }
  const key = await tokenKey();
  const ivBytes = b64decode(parts[1]);
  const iv = new ArrayBuffer(ivBytes.byteLength);
  new Uint8Array(iv).set(ivBytes);
  const ciphertextBytes = b64decode(parts[2]);
  const ciphertext = new ArrayBuffer(ciphertextBytes.byteLength);
  new Uint8Array(ciphertext).set(ciphertextBytes);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(pt);
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(msg),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** CSRF state bound to the user: "<nonce>.<expMs>.<hmac>". Stateless — no table. */
export async function signState(userId: string): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const exp = String(Date.now() + STATE_TTL_MS);
  const sig = await hmacHex(
    mustEnv("PINTEREST_TOKEN_KEY"),
    `${userId}.${nonce}.${exp}`,
  );
  return `${nonce}.${exp}.${sig}`;
}

/** Verify signState() output for this user; throws 400 on any mismatch (fail closed). */
export async function verifyState(
  state: string,
  userId: string,
): Promise<void> {
  const parts = state.split(".");
  if (parts.length !== 3) {
    throw badRequest(
      "state_invalid",
      "Invalid OAuth state — restart Pinterest connect",
    );
  }
  const [nonce, exp, sig] = parts as [string, string, string];
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(exp)) {
    throw badRequest(
      "state_invalid",
      "Invalid OAuth state — restart Pinterest connect",
    );
  }
  if (Number(exp) < Date.now()) {
    throw badRequest("state_expired", "Pinterest connect expired — try again");
  }
  const want = await hmacHex(
    mustEnv("PINTEREST_TOKEN_KEY"),
    `${userId}.${nonce}.${exp}`,
  );
  if (!timingSafeEq(want, sig.toLowerCase())) {
    throw badRequest(
      "state_invalid",
      "Invalid OAuth state — restart Pinterest connect",
    );
  }
}

// ------------------------------------------------------------------- oauth
export function buildAuthUrl(
  state: string,
  opts: { withSecret: boolean; withWrite: boolean },
): string {
  const scopes: string[] = [...PIN_READ_SCOPES];
  // Secret-board scopes ONLY on explicit user opt-in (permission minimization).
  if (opts.withSecret) scopes.push(...PIN_SECRET_SCOPES);
  // pins:write ONLY on explicit opt-in (per-action consent law for writes).
  if (opts.withWrite) scopes.push(...PIN_WRITE_SCOPES);
  const q = new URLSearchParams({
    client_id: pinterestAppId(),
    redirect_uri: PIN_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(","),
    state,
  });
  return `https://www.pinterest.com/oauth/?${q.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function tokenRequest(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const basic = btoa(`${pinterestAppId()}:${pinterestAppSecret()}`);
  const res = await fetch(PIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw badRequest(
      "token_exchange_failed",
      `Pinterest token request failed (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: PIN_REDIRECT_URI,
  });
}

export function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** Best-effort revoke (both tokens); never throws — disconnect purges locally regardless. */
export async function revokeTokenBestEffort(token: string): Promise<void> {
  try {
    const basic = btoa(`${pinterestAppId()}:${pinterestAppSecret()}`);
    await fetch(`${PIN_API_BASE}/oauth/token/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (e) {
    console.error(
      "[pinterest] revoke attempt failed (best-effort)",
      (e as Error).message,
    );
  }
}

// ------------------------------------------------------------ rate limits
/**
 * Trial-tier daily budget guard (app-wide 1000 req/day on Trial).
 * Counter lives in app_config.pinterest_budget = { date: 'YYYY-MM-DD', count }
 * (service_role only, like render_guard). Cap 800 leaves 20% headroom for
 * auth callbacks + user-initiated shares. Standard tier never hits this cap
 * (per-minute limits are handled by 429 backoff instead), so the guard is
 * safe to enforce unconditionally — it only binds Trial apps.
 */
const PIN_BUDGET_CAP = 800;

interface BudgetValue {
  date?: string;
  count?: number;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function checkPinBudget(sb: SupabaseClient): Promise<void> {
  const { data } = await sb.from("app_config").select("value").eq(
    "key",
    "pinterest_budget",
  )
    .maybeSingle<{ value: BudgetValue }>();
  const v = (data?.value ?? {}) as BudgetValue;
  if (v.date !== todayISO()) return; // new day → resets on first spend below
  if ((v.count ?? 0) >= PIN_BUDGET_CAP) {
    throw new HttpError(
      429,
      "pinterest_budget_exhausted",
      "Pinterest daily sync budget used — try again tomorrow.",
    );
  }
}

export async function spendPinBudget(sb: SupabaseClient, n = 1): Promise<void> {
  const today = todayISO();
  const { data } = await sb.from("app_config").select("value").eq(
    "key",
    "pinterest_budget",
  )
    .maybeSingle<{ value: BudgetValue }>();
  const v = (data?.value ?? {}) as BudgetValue;
  const next: BudgetValue = v.date === today
    ? { date: today, count: (v.count ?? 0) + n }
    : { date: today, count: n };
  // Best-effort (read-modify-write; the 20% headroom absorbs races — the hard
  // Pinterest-side 429 backoff below is the real backstop).
  const { error } = await sb.from("app_config")
    .upsert({ key: "pinterest_budget", value: next }, { onConflict: "key" });
  if (error) {
    console.error("[pinterest] budget counter write failed", error.message);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface PinApiOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  /** Count this call against the Trial daily budget (default true). */
  budgeted?: boolean;
  /** Max 429 retries (default 4 → waits ~1s/2s/4s/8s + Retry-After). */
  maxRetries?: number;
}

/**
 * Authenticated Pinterest v5 call with rate-limit handling:
 *  - 429 → honor Retry-After (cap 60s), else exponential backoff, then throw
 *    429 pinterest_rate_limited (caller surfaces "try again", never busy-loops).
 *  - 401 → throw 401 pinterest_token_invalid (caller refreshes ONCE + retries).
 */
export async function pinApi(
  sb: SupabaseClient,
  token: string,
  path: string,
  opts: PinApiOptions = {},
): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 4;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.budgeted !== false) await spendPinBudget(sb, 1);
    const res = await fetch(`${PIN_API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    lastStatus = res.status;
    if (res.status === 429) {
      const retryAfter = Math.min(
        Number(res.headers.get("retry-after") ?? "0") || 0,
        60,
      );
      const backoff = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 8000);
      if (attempt === maxRetries) break;
      await sleep(backoff);
      continue;
    }
    if (res.status === 401) {
      throw new HttpError(
        401,
        "pinterest_token_invalid",
        "Pinterest session expired — reconnect.",
      );
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw badRequest(
        "pinterest_api_error",
        `Pinterest request failed (HTTP ${res.status})`,
        { detail: text },
      );
    }
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }
  throw new HttpError(
    429,
    "pinterest_rate_limited",
    "Pinterest is rate-limiting us — try again in a minute.",
    { http_status: lastStatus },
  );
}

// ------------------------------------------------------------------ account
export interface PinterestAccountRow {
  user_id: string;
  pinterest_user_id: string | null;
  username: string | null;
  scopes: string[];
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  secret_ok: boolean;
  status: string;
}

/** Load the caller's account row; throws 400 when never connected. */
export async function loadAccount(
  sb: SupabaseClient,
  userId: string,
): Promise<PinterestAccountRow> {
  const { data, error } = await sb.from("pinterest_accounts").select(
    "user_id,pinterest_user_id,username,scopes,access_token_enc,refresh_token_enc,expires_at,secret_ok,status",
  ).eq("user_id", userId).maybeSingle<PinterestAccountRow>();
  if (error) throw error;
  if (!data) {
    throw badRequest("pinterest_not_connected", "Connect Pinterest first.");
  }
  return data;
}

/**
 * Decrypted, valid access token. Refreshes ONCE via the stored refresh token
 * when expiring within 60s (persists the rotation server-side); throws 401
 * pinterest_reconnect when no usable credential remains.
 */
export async function getValidToken(
  sb: SupabaseClient,
  userId: string,
): Promise<{ token: string; account: PinterestAccountRow }> {
  const account = await loadAccount(sb, userId);
  if (!account.access_token_enc) {
    throw forbidden(
      "pinterest_reconnect",
      "Pinterest session expired — reconnect.",
    );
  }
  const expMs = account.expires_at ? Date.parse(account.expires_at) : 0;
  if (expMs - Date.now() > 60_000) {
    return { token: await decryptToken(account.access_token_enc), account };
  }
  if (!account.refresh_token_enc) {
    await sb.from("pinterest_accounts").update({ status: "expired" }).eq(
      "user_id",
      userId,
    );
    throw forbidden(
      "pinterest_reconnect",
      "Pinterest session expired — reconnect.",
    );
  }
  let rotated: TokenResponse;
  try {
    rotated = await refreshAccessToken(
      await decryptToken(account.refresh_token_enc),
    );
  } catch {
    await sb.from("pinterest_accounts").update({ status: "expired" }).eq(
      "user_id",
      userId,
    );
    throw forbidden(
      "pinterest_reconnect",
      "Pinterest session expired — reconnect.",
    );
  }
  const patch: Record<string, unknown> = {
    access_token_enc: await encryptToken(rotated.access_token),
    status: "connected",
  };
  if (rotated.refresh_token) {
    patch.refresh_token_enc = await encryptToken(rotated.refresh_token);
  }
  if (rotated.expires_in) {
    patch.expires_at = new Date(Date.now() + rotated.expires_in * 1000)
      .toISOString();
  }
  await sb.from("pinterest_accounts").update(patch).eq("user_id", userId);
  return {
    token: rotated.access_token,
    account: { ...account, status: "connected" },
  };
}

/** 13+ gate: refuse Pinterest connect for u13 (Pinterest rules; 0002 age_band). */
export async function assertAgeAllowed(
  sb: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data } = await sb.from("users").select("age_band").eq("id", userId)
    .maybeSingle<{ age_band: string | null }>();
  if (data?.age_band === "u13") {
    throw forbidden("age_restricted", "Pinterest connect requires age 13+.");
  }
}

// ---------------------------------------------------------------- pose refs
export interface ResolvedPoseRef {
  poseRefId: string;
  /** Direct image URL for the AI crew (adapt path) / record (keep path). */
  imageUrl: string | null;
  /** Set when sourced from a VAI base photo (keep path can reuse the base). */
  basePhotoId: string | null;
}

/**
 * Resolve a pose_ref_id to a server-side image URL. FAILS CLOSED (400) on
 * unknown ids, other users' rows, dismissed/deleted pins, or imageless rows —
 * the client NEVER supplies image bytes/URLs for pose (ownership-checked here).
 */
export async function resolvePoseRef(
  sb: SupabaseClient,
  userId: string,
  poseRefId: string,
): Promise<ResolvedPoseRef> {
  const { data: ref } = await sb.from("pose_refs").select(
    "id,pin_id,base_photo_id",
  )
    .eq("id", poseRefId).eq("user_id", userId)
    .maybeSingle<
      { id: string; pin_id: string | null; base_photo_id: string | null }
    >();
  if (!ref) throw badRequest("pose_ref_not_found", "Pose reference not found.");

  if (ref.base_photo_id) {
    const { data: bp } = await sb.from("base_photos").select("id,url")
      .eq("id", ref.base_photo_id).eq("user_id", userId)
      .maybeSingle<{ id: string; url: string }>();
    if (!bp) {
      throw badRequest("pose_ref_not_found", "Pose reference not found.");
    }
    return { poseRefId: ref.id, imageUrl: bp.url, basePhotoId: bp.id };
  }

  if (ref.pin_id) {
    const { data: pin } = await sb.from("style_pins").select(
      "image_url,dismissed",
    )
      .eq("user_id", userId).eq("pin_id", ref.pin_id)
      .maybeSingle<{ image_url: string | null; dismissed: boolean }>();
    if (!pin || pin.dismissed || !pin.image_url) {
      throw badRequest(
        "pose_ref_unavailable",
        "That inspiration was removed or hidden — pick another.",
      );
    }
    return { poseRefId: ref.id, imageUrl: pin.image_url, basePhotoId: null };
  }

  // Unreachable while the 0005 CHECK holds; fail closed anyway.
  throw badRequest("pose_ref_not_found", "Pose reference not found.");
}

/** Assert a pose_mode value; defaults missing → 'keep'. */
export function parsePoseMode(v: unknown): PoseMode {
  if (v === undefined || v === null || v === "") return "keep";
  if (v === "keep" || v === "adapt") return v;
  throw badRequest("pose_mode_invalid", "pose_mode must be 'keep' | 'adapt'");
}
