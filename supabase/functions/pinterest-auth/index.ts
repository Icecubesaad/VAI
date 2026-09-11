// pinterest-auth — Pinterest OAuth2 connect (Deno, strict TS).
//
// CANONICAL client contract (lib/api.ts — tolerance pattern: accept both,
// respond canonical):
// POST / { action: 'auth-url', redirect_uri?, include_secret_boards?|with_secret?, with_write? } (JWT)
//   → 200 { url, state, scopes }
// POST / { action: 'callback', code, state, include_secret_boards?|with_secret?, with_write? } (JWT)
//   → 200 { connected: true, username, boardCount, hasMore }
// Legacy server shapes still accepted (same handler, same canonical response):
// GET  /?action=auth-url&with_secret=0|1&with_write=0|1 (JWT)
// POST / { code, state, with_secret?, with_write? } (no action — callback implied)
//
//   `with_secret` / `include_secret_boards` adds boards:secret+pins:secret
//   ONLY on explicit user opt-in.
//   `with_write` adds pins:write ONLY on explicit opt-in (per-action consent
//   law for writes — the connect screen requests reads; the share sheet
//   re-runs this with with_write=1 right before the explicit tap).
//   u13 is refused here (Pinterest 13+ rule; 0002 age_band).
//   The callback verifies the HMAC state (CSRF, bound to the JWT subject), exchanges the
//   code server-side (client secret never leaves the edge), AES-GCM-encrypts
//   both tokens with PINTEREST_TOKEN_KEY, upserts pinterest_accounts, then
//   reads /v5/user_account + first /v5/boards page for the confirmation.
//   Granted scopes prefer the token-response `scope` field; the body flags are
//   the fallback bookkeeping for secret_ok.
// NOTE: Trial apps see sandbox-only data (fine for dev); Standard needs the
// video-demo review. No auto-post anywhere in this module.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import {
  assertAgeAllowed,
  buildAuthUrl,
  encryptToken,
  exchangeCode,
  PIN_READ_SCOPES,
  PIN_SECRET_SCOPES,
  PIN_WRITE_SCOPES,
  pinApi,
  signState,
  verifyState,
} from "../_shared/pinterest.ts";

const flag = (v: string | null): boolean => v === "1" || v?.toLowerCase() === "true";

/** Body-flag tolerance: true | 1 | "1" | "true" (client sends real booleans). */
const truthyFlag = (v: unknown): boolean =>
  v === true || v === 1 || v === "1" || (typeof v === "string" && v.toLowerCase() === "true");

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const sb = admin();

    if (req.method === "GET") {
      requireMethod(req, "GET");
      const user = await requireUser(req);
      const url = new URL(req.url);
      if (url.searchParams.get("action") !== "auth-url") {
        throw badRequest("action_invalid", "Use ?action=auth-url");
      }
      await assertAgeAllowed(sb, user.id);
      const withSecret = flag(url.searchParams.get("with_secret"));
      const withWrite = flag(url.searchParams.get("with_write"));
      const state = await signState(user.id);
      const scopes = [...PIN_READ_SCOPES];
      if (withSecret) scopes.push(...PIN_SECRET_SCOPES);
      if (withWrite) scopes.push(...PIN_WRITE_SCOPES);
      return json({ url: buildAuthUrl(state, { withSecret, withWrite }), state, scopes });
    }

    requireMethod(req, "POST");
    const user = await requireUser(req);
    await assertAgeAllowed(sb, user.id);
    const body = await readJson<{
      action?: unknown;
      code?: unknown;
      state?: unknown;
      with_secret?: unknown;
      include_secret_boards?: unknown;
      with_write?: unknown;
    }>(req);
    // Tolerance: canonical client sends { action: 'auth-url' | 'callback', … };
    // legacy server shape omits action (callback implied by { code, state }).
    if (
      body.action !== undefined && body.action !== null &&
      body.action !== "auth-url" && body.action !== "callback"
    ) {
      throw badRequest("action_invalid", "Use { action: 'auth-url' | 'callback', ... }");
    }
    if (body.action === "auth-url") {
      const withSecret = truthyFlag(body.with_secret ?? body.include_secret_boards);
      const withWrite = truthyFlag(body.with_write);
      const state = await signState(user.id);
      const scopes = [...PIN_READ_SCOPES];
      if (withSecret) scopes.push(...PIN_SECRET_SCOPES);
      if (withWrite) scopes.push(...PIN_WRITE_SCOPES);
      return json({ url: buildAuthUrl(state, { withSecret, withWrite }), state, scopes });
    }
    if (typeof body.code !== "string" || body.code.length === 0) {
      throw badRequest("code_required", "Authorization code required");
    }
    if (typeof body.state !== "string" || body.state.length === 0) {
      throw badRequest("state_required", "OAuth state required");
    }
    await verifyState(body.state, user.id);

    const tokens = await exchangeCode(body.code);
    // BOTH flag names accepted (canonical client: include_secret_boards).
    const secretFlag = truthyFlag(body.with_secret ?? body.include_secret_boards);
    const writeFlag = truthyFlag(body.with_write);
    const granted = typeof tokens.scope === "string" && tokens.scope.length > 0
      ? tokens.scope.split(/[ ,]+/).filter(Boolean)
      : [
        ...PIN_READ_SCOPES,
        ...(secretFlag ? [...PIN_SECRET_SCOPES] : []),
        ...(writeFlag ? [...PIN_WRITE_SCOPES] : []),
      ];
    const secretOk = granted.includes("pins:secret") || granted.includes("boards:secret");

    const patch: Record<string, unknown> = {
      user_id: user.id,
      scopes: granted,
      access_token_enc: await encryptToken(tokens.access_token),
      secret_ok: secretOk,
      status: "connected",
    };
    if (tokens.refresh_token) patch.refresh_token_enc = await encryptToken(tokens.refresh_token);
    if (tokens.expires_in) {
      patch.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    }

    const { error: upErr } = await sb.from("pinterest_accounts").upsert(patch, { onConflict: "user_id" });
    if (upErr) throw upErr;

    // Confirmation reads (server-side token, budgeted like any other call).
    const me = (await pinApi(sb, tokens.access_token, "/user_account")) as {
      username?: string;
      account_type?: string;
    };
    const boards = (await pinApi(sb, tokens.access_token, "/boards?page_size=25")) as {
      items?: Array<{ id: string }>;
      bookmark?: string | null;
    };
    const username = typeof me.username === "string" ? me.username : null;
    await sb.from("pinterest_accounts").update({
      pinterest_user_id: (me as { user_id?: string }).user_id ?? null,
      username,
    }).eq("user_id", user.id);

    return json({
      connected: true,
      username,
      boardCount: Array.isArray(boards.items) ? boards.items.length : 0,
      hasMore: (boards.bookmark ?? null) !== null,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
