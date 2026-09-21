// Gemini callers (Deno, strict TS).
// README stack: `gemini-3.1-flash-image` primary (~$0.067/img), `gemini-3-pro-image`
// fallback for image work; a Flash text model for outfit reasoning/auto-tag/quiz.
// All server-side only — GEMINI_API_KEY never leaves Edge Function secrets.

// Primary = Nano Banana 2 LITE (gemini-3.1-flash-lite-image): the cheapest
// image model (~$0.005/img) — founder runs without billing attached today, so
// the chain must start at the cheapest viable model and only fall upward.
// Override with GEMINI_IMAGE_MODEL. Free-tier quota for ALL image models is
// currently 0 (verified against the live API), so renders stay quota-gated.
export const GEMINI_FLASH_IMAGE = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-lite-image";
export const GEMINI_PRO_IMAGE = "gemini-3.1-flash-image";
/**
 * Overridable via env; README pins "Gemini Flash" for text/vision reasoning.
 * Default `gemini-2.5-flash`: stable AND on the Gemini API free tier (the
 * founder runs without billing attached — gemini-3-flash is a PREVIEW model
 * with billing enabled and 402s on free keys; 2.5-flash does multimodal
 * image INPUT free, which auto-tag needs).
 */
export const geminiTextModel = (): string => Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";

export const GEMINI_STD_COST_USD = 0.067;

export class GeminiError extends Error {
  readonly kind: "safety" | "quota" | "parse" | "transport";
  constructor(kind: GeminiError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function apiKey(): string {
  const k = Deno.env.get("GEMINI_API_KEY");
  if (!k) throw new GeminiError("transport", "GEMINI_API_KEY is not configured");
  return k;
}

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

async function postGenerate(
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<GenerateResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    if (res.status === 429) throw new GeminiError("quota", "Gemini rate limit hit");
    if (!res.ok) throw new GeminiError("transport", `Gemini HTTP ${res.status}`);
    return (await res.json()) as GenerateResponse;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new GeminiError("transport", `Gemini timed out after ${timeoutMs}ms`);
    }
    throw new GeminiError("transport", `Gemini request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

/** Fetch any URL (http/https) and return base64 + mime for Gemini inlineData. */
export async function urlToInlinePart(url: string): Promise<Part> {
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
  return {
    inlineData: {
      mimeType: res.headers.get("content-type")?.split(";")[0] || "image/jpeg",
      data: btoa(bin),
    },
  };
}

function firstText(resp: GenerateResponse): string {
  const block = resp.promptFeedback?.blockReason;
  if (block) throw new GeminiError("safety", `Blocked by Gemini safety filter: ${block}`);
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  if (!text) {
    const reason = resp.candidates?.[0]?.finishReason ?? "empty";
    throw new GeminiError("safety", `Gemini returned no text (${reason})`);
  }
  return text;
}

/**
 * Strict-JSON text/vision call (temp 0). `validate` narrows unknown → T;
 * throws GeminiError("parse") when the model will not conform.
 */
export async function generateJson<T>(opts: {
  system: string;
  user: string;
  imageUrls?: string[];
  model?: string;
  validate: (v: unknown) => v is T;
  timeoutMs?: number;
}): Promise<T> {
  const model = opts.model ?? geminiTextModel();
  const parts: Part[] = [{ text: opts.user }];
  for (const url of opts.imageUrls ?? []) {
    parts.push(await urlToInlinePart(url));
  }
  const resp = await postGenerate(model, {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" },
  }, opts.timeoutMs ?? 30000);
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
 * Image generation/edit. Reference photos go in as inlineData ahead of the prompt.
 * Throws on safety blocks so the caller can fall through to the next provider.
 */
export async function generateImage(opts: {
  prompt: string;
  refImageUrls?: string[];
  model?: string;
  timeoutMs?: number;
}): Promise<GeneratedImage> {
  const model = opts.model ?? GEMINI_FLASH_IMAGE;
  const parts: Part[] = [];
  for (const url of opts.refImageUrls ?? []) {
    parts.push(await urlToInlinePart(url));
  }
  parts.push({ text: opts.prompt });
  const resp = await postGenerate(model, {
    contents: [{ parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  }, opts.timeoutMs ?? 85000);

  if (resp.promptFeedback?.blockReason) {
    throw new GeminiError("safety", `Image blocked: ${resp.promptFeedback.blockReason}`);
  }
  for (const p of resp.candidates?.[0]?.content?.parts ?? []) {
    if (p.inlineData?.data) {
      const bin = atob(p.inlineData.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mimeType: p.inlineData.mimeType || "image/png" };
    }
  }
  throw new GeminiError(
    "safety",
    `No image returned (${resp.candidates?.[0]?.finishReason ?? "empty"})`,
  );
}
