// FASHN caller — fallback provider (Deno, strict TS).
// README stack: Gemini image models are primary; FASHN is fallback-only.
// Build pack §5 rules honored: std (v1.6, 1 credit ~$0.075) default everywhere
// incl. free; Try-On Max (2–3 credits, $0.15–0.38) premium/compare/hero only;
// failed predictions cost 0 — only `done` decrements quota/ledger.

export const FASHN_STD_MODEL = "tryon-v1.6";
export const FASHN_MAX_MODEL = "tryon-max";
export const FASHN_STD_COST_USD = 0.075;
export const FASHN_MAX_COST_USD = 0.38;

/** §5: terminal wait is 90s — then mark failed, retry once on std. */
export const FASHN_TIMEOUT_MS = 90_000;

export class FashnError extends Error {
  readonly kind: "config" | "transport" | "failed" | "timeout";
  constructor(kind: FashnError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function apiKey(): string {
  const k = Deno.env.get("FASHN_API_KEY");
  if (!k) throw new FashnError("config", "FASHN_API_KEY is not configured");
  return k;
}

const BASE = "https://api.fashn.ai/v1";

async function fashnFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export interface FashnRun {
  id: string;
}

export async function runTryon(opts: {
  modelImageUrl: string;
  garmentImageUrls: string[];
  max: boolean;
}): Promise<FashnRun> {
  if (opts.garmentImageUrls.length === 0) {
    throw new FashnError("failed", "FASHN needs at least one garment image");
  }
  let res: Response;
  try {
    res = await fashnFetch("/run", {
      method: "POST",
      body: JSON.stringify({
        model_name: opts.max ? FASHN_MAX_MODEL : FASHN_STD_MODEL,
        inputs: {
          model_image: opts.modelImageUrl,
          // v1: single-garment try-on; multi-garment composites are pre-tiled by the caller.
          garment_image: opts.garmentImageUrls[0],
        },
      }),
    }, 30000);
  } catch (e) {
    throw new FashnError("transport", `FASHN run failed: ${(e as Error).message}`);
  }
  if (res.status === 429) throw new FashnError("transport", "FASHN rate limited");
  if (!res.ok) throw new FashnError("transport", `FASHN run HTTP ${res.status}`);
  const body = (await res.json()) as { id?: string; error?: string };
  if (!body.id) throw new FashnError("transport", body.error ?? "FASHN returned no prediction id");
  return { id: body.id };
}

type FashnStatus = "starting" | "in_queue" | "processing" | "completed" | "failed";

interface FashnStatusBody {
  status: FashnStatus;
  output?: string[];
  error?: string;
}

export async function getStatus(id: string): Promise<FashnStatusBody> {
  let res: Response;
  try {
    res = await fashnFetch(`/status/${encodeURIComponent(id)}`, { method: "GET" }, 20000);
  } catch (e) {
    throw new FashnError("transport", `FASHN status failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new FashnError("transport", `FASHN status HTTP ${res.status}`);
  return (await res.json()) as FashnStatusBody;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll with backoff (2s→4s→8s→cap 12s) until completed/failed or 90s.
 * Resolves to output image URLs; throws FashnError("failed"|"timeout").
 * Failed/timeout predictions cost 0 credits — the caller must not ledger them.
 */
export async function pollToDone(id: string, timeoutMs = FASHN_TIMEOUT_MS): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let wait = 2000;
  for (;;) {
    const s = await getStatus(id);
    if (s.status === "completed") {
      if (!s.output || s.output.length === 0) throw new FashnError("failed", "FASHN done, no output");
      return s.output;
    }
    if (s.status === "failed") throw new FashnError("failed", s.error ?? "FASHN prediction failed");
    if (Date.now() + wait > deadline) throw new FashnError("timeout", "FASHN exceeded 90s");
    await sleep(wait);
    wait = Math.min(12000, wait * 2);
  }
}
