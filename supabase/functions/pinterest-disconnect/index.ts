// pinterest-disconnect — revoke (best-effort) + purge Pinterest data.
// DELETE / (JWT; POST accepted as alias, cf. account fn) → 200
//   { disconnected: true, purged: { style_pins, pose_refs } }
// Purges: pinterest_accounts row (tokens), ALL style_pins rows, PIN-SOURCED
// pose_refs only (pin_id NOT NULL — base-photo pose refs survive).
// KEEPS: renders (pose_ref_id FK is SET NULL — old renders keep working,
// falling back to 'keep'), every non-Pinterest table.
// The Pinterest-side revoke is best-effort: local purge is authoritative and
// never blocked by a revoke failure.

import { admin, requireUser } from "../_shared/auth.ts";
import { handleOptions, json, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { decryptToken, loadAccount, revokeTokenBestEffort } from "../_shared/pinterest.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, ["DELETE", "POST"]);
    const user = await requireUser(req);
    const sb = admin();

    // Best-effort remote revoke — never blocks the local purge. A missing
    // account row still purges orphan pins/refs below (idempotent).
    try {
      const account = await loadAccount(sb, user.id);
      if (account.access_token_enc) {
        await revokeTokenBestEffort(await decryptToken(account.access_token_enc));
      }
      if (account.refresh_token_enc) {
        await revokeTokenBestEffort(await decryptToken(account.refresh_token_enc));
      }
    } catch {
      // loadAccount throws when never connected — purge orphans anyway.
    }

    const pins = await sb.from("style_pins").delete().eq("user_id", user.id);
    if (pins.error) throw new Error(`Purge failed style_pins: ${pins.error.message}`);
    const refs = await sb.from("pose_refs").delete().eq("user_id", user.id).not("pin_id", "is", null);
    if (refs.error) throw new Error(`Purge failed pose_refs: ${refs.error.message}`);
    const acct = await sb.from("pinterest_accounts").delete().eq("user_id", user.id);
    if (acct.error) throw new Error(`Purge failed pinterest_accounts: ${acct.error.message}`);

    return json({
      disconnected: true,
      purged: {
        style_pins: (pins.data as unknown[] | null)?.length ?? 0,
        pose_refs: (refs.data as unknown[] | null)?.length ?? 0,
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
