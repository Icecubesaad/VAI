// restyle — restyle an existing render with a natural-language note.
// POST { render_id, note (<=280 chars), rewritten_prompt?, prompt_tags?,
//        photo_conditions?, tier?, model_hint?, idempotency_key? }
//   → 202 render-tryon-shaped response + { restyle_n, restyles_left_session,
//         keep_best_url, rewritten_prompt?, report }
// Canonical shape: CONTRACT-integrations §2 `restyle`. Extra fields are
// accepted and recorded in render meta (server keeps the rewritten prompt for
// audit); cost/caps are server-enforced in ../_shared/restyle.ts — shared
// with render-tryon mode 'restyle' so the two entries can never drift.
// Idempotency: X-Idempotency-Key header > idempotency_key body (either case).

import { admin, requireUser } from "../_shared/auth.ts";
import { getIdempotencyKey, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { requestRestyle } from "../_shared/restyle.ts";

interface RestyleBody {
  render_id?: unknown;
  renderId?: unknown;
  note?: unknown;
  rewritten_prompt?: unknown;
  prompt_tags?: unknown;
  photo_conditions?: unknown;
  tier?: unknown;
  model_hint?: unknown;
  idempotency_key?: unknown;
  idempotencyKey?: unknown;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<RestyleBody>(req);

    const renderId = typeof body.render_id === "string" ? body.render_id
      : typeof body.renderId === "string" ? body.renderId : "";

    const outcome = await requestRestyle(admin(), user.id, {
      renderId,
      note: typeof body.note === "string" ? body.note : "",
      rewrittenPrompt: typeof body.rewritten_prompt === "string" ? body.rewritten_prompt : null,
      promptTags: Array.isArray(body.prompt_tags)
        ? body.prompt_tags.filter((t): t is string => typeof t === "string")
        : undefined,
      photoConditions: body.photo_conditions !== null && typeof body.photo_conditions === "object"
        ? body.photo_conditions as Record<string, unknown>
        : undefined,
      tierHint: typeof body.tier === "string" ? body.tier : null,
      modelHint: typeof body.model_hint === "string" ? body.model_hint : null,
      idempotencyKey: getIdempotencyKey(req, body),
    });

    return json(outcome, 202);
  } catch (e) {
    return toErrorResponse(e);
  }
});
