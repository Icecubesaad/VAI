// AI callers (Deno, strict TS) — routed through OpenRouter.
// Founder-mandated routing (Sep 2026):
//   TEXT+VISION → `z-ai/glm-5.3-flash` (vision-capable — deepseek is not),
//           providers pinned to `inference-net/fp4` + `gmicloud/fp8` +
//           `deepinfra/fp4` with fallbacks ON so the three can fail over
//           (request-level `provider.only`, never a different host).
//   IMAGE → `google/gemini-3.1-flash-image` via OpenRouter chat-completions
//           multimodal output (choices[0].message.images[]).
// All server-side only — OPENROUTER_API_KEY never leaves Edge Function secrets.
// The FASHN fallback chain in pipeline.ts still applies BELOW this layer.

export const OR_TEXT_MODEL = Deno.env.get("OR_TEXT_MODEL") ?? "z-ai/glm-5.3-flash";
export const OR_IMAGE_MODEL = Deno.env.get("OR_IMAGE_MODEL") ?? "google/gemini-3.1-flash-lite-image";
/** Founder pin: these three providers, fail over between them. */
const TEXT_PROVIDER_PIN = {
  only: ["inference-net/fp4", "gmicloud/fp8", "deepinfra/fp4"],
  allow_fallbacks: true,
} as const;

// Kept for the cost ledger + pipeline labels (USD per successful render).
export const GEMINI_STD_COST_USD = 0.067;

export class GeminiError extends Error {
  readonly kind: "safety" | "quota" | "parse" | "transport";
  constructor(kind: GeminiError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function apiKey(): string {
  const k = Deno.env.get("OPENROUTER_API_KEY");
  if (!k) throw new GeminiError("transport", "OPENROUTER_API_KEY is not configured");
  return k;
}

interface ORResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      images?: Array<{ image_url?: { url?: string } }>;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: number };
}

async function orPost(body: Record<string, unknown>, timeoutMs: number): Promise<ORResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new GeminiError("quota", "OpenRouter rate limit hit");
    if (res.status === 402) throw new GeminiError("quota", "OpenRouter credits exhausted");
    if (!res.ok) throw new GeminiError("transport", `OpenRouter HTTP ${res.status}`);
    const json = (await res.json()) as ORResponse;
    if (json.error?.message) throw new GeminiError("transport", `OpenRouter: ${json.error.message}`);
    return json;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new GeminiError("transport", `OpenRouter timed out after ${timeoutMs}ms`);
    }
    throw new GeminiError("transport", `OpenRouter request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

type ImageRef = { type: "image_url"; image_url: { url: string } };

/** https URLs pass through; local/data refs are inlined as data URLs. */
async function imageRef(url: string): Promise<ImageRef> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { type: "image_url", image_url: { url } };
  }
  const res = await fetch(url);
  if (!res.ok) throw new GeminiError("transport", `Reference fetch failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 12 * 1024 * 1024) {
    throw new GeminiError("transport", "Reference image exceeds 12MB");
  }
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const mime = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  return { type: "image_url", image_url: { url: `data:${mime};base64,${btoa(bin)}` } };
}

/** Back-compat export (was Gemini inlineData; callers pass URLs today). */
export async function urlToInlinePart(url: string): Promise<{ url: string }> {
  return { url };
}

function firstText(resp: ORResponse): string {
  const choice = resp.choices?.[0];
  const text = (choice?.message?.content ?? "").trim();
  if (!text) {
    throw new GeminiError("safety", `Model returned no text (${choice?.finish_reason ?? "empty"})`);
  }
  return text;
}

/**
 * Strict-JSON text/vision call (temp 0). `validate` narrows unknown → T;
 * throws GeminiError("parse") when the model will not conform. JSON discipline
 * is prompt-driven + stripped (the pinned provider may not honor response_format).
 */
export async function generateJson<T>(opts: {
  system: string;
  user: string;
  imageUrls?: string[];
  model?: string;
  validate: (v: unknown) => v is T;
  timeoutMs?: number;
}): Promise<T> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: opts.user }];
  for (const url of opts.imageUrls ?? []) {
    content.push(await imageRef(url));
  }
  const resp = await orPost(
    {
      model: opts.model ?? OR_TEXT_MODEL,
      provider: { ...TEXT_PROVIDER_PIN },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content },
      ],
      temperature: 0,
      max_tokens: 2048,
    },
    opts.timeoutMs ?? 30000,
  );
  const text = firstText(resp).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError("parse", "Model returned non-JSON");
  }
  if (!opts.validate(parsed)) throw new GeminiError("parse", "Model JSON failed validation");
  return parsed;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Image generation/edit via OpenRouter multimodal output. Reference photos go
 * in as image_url parts ahead of the prompt. Throws on safety blocks so the
 * caller can fall through to the next provider.
 */
export async function generateImage(opts: {
  prompt: string;
  refImageUrls?: string[];
  model?: string;
  timeoutMs?: number;
}): Promise<GeneratedImage> {
  const content: Array<Record<string, unknown>> = [];
  for (const url of opts.refImageUrls ?? []) {
    content.push(await imageRef(url));
  }
  content.push({ type: "text", text: opts.prompt });
  const resp = await orPost(
    {
      model: opts.model ?? OR_IMAGE_MODEL,
      messages: [{ role: "user", content }],
    },
    opts.timeoutMs ?? 85000,
  );

  const dataUrl = resp.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) {
    throw new GeminiError("safety", `No image returned (${resp.choices?.[0]?.finish_reason ?? "empty"})`);
  }
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mimeType: m[1] };
}
