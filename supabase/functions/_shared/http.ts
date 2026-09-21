// Shared HTTP helpers for VAI Edge Functions (Deno, strict TS).
// CORS + JSON envelope + typed HttpError. No business logic here.

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ingest-signature, x-inngest-signature, x-idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  return null;
}

/** Success envelope: { ok: true, data } */
export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpError(400, code, message, extra);
export const unauthorized = (message = "Missing or invalid session") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpError(403, code, message, extra);
/** 402 with { upgrade: true } payload drives the client paywall sheet. */
export const paymentRequired = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new HttpError(402, code, message, { upgrade: true, ...extra });

/** Error envelope: { ok: false, error: { code, message, ...extra } } */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: err.code, message: err.message, ...err.extra },
      }),
      { status: err.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
  console.error("[unhandled]", err);
  // DEBUG_ERRORS=true (dev/triage only): surface the real message instead of
  // the generic internal — never enable in production.
  if (Deno.env.get("DEBUG_ERRORS") === "true") {
    let message: string;
    try {
      message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : JSON.stringify(err);
    } catch {
      message = String(err);
    }
    return new Response(
      JSON.stringify({ ok: false, error: { code: "internal", message } }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "internal", message: "Something went wrong. Check connection and retry." },
    }),
    { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

export function requireMethod(req: Request, method: "GET" | "POST" | "DELETE" | Array<"GET" | "POST" | "DELETE">): void {
  const allowed = Array.isArray(method) ? method : [method];
  if (!allowed.includes(req.method as "GET")) {
    throw new HttpError(405, "method_not_allowed", `Use ${allowed.join(" or ")}`);
  }
}

const MAX_JSON_BYTES = 256 * 1024;

/** Parse JSON body with a size cap; throws 400 on invalid/oversized payloads. */
export async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) {
    throw badRequest("payload_too_large", "Request body exceeds 256KB");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest("invalid_json", "Request body must be valid JSON");
  }
}

export function getQuery(req: Request, key: string): string | null {
  return new URL(req.url).searchParams.get(key);
}

/**
 * Idempotency key from the `X-Idempotency-Key` header (preferred — the
 * integrations `callEdgeFunction` helper sends it on every idempotent POST)
 * or the body (`idempotency_key` canonical, `idempotencyKey` transition
 * alias). Keys < 16 chars are ignored so callers fall back to the
 * server-computed key instead of colliding on short guesses.
 */
export function getIdempotencyKey(
  req: Request,
  body: { idempotency_key?: unknown; idempotencyKey?: unknown },
): string | null {
  const header = (req.headers.get("x-idempotency-key") ?? "").trim();
  if (header.length >= 16) return header;
  for (const candidate of [body.idempotency_key, body.idempotencyKey]) {
    if (typeof candidate === "string" && candidate.trim().length >= 16) {
      return candidate.trim();
    }
  }
  return null;
}
