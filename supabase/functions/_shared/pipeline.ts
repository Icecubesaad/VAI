// Render pipeline engine (Deno, strict TS) — shared by `render-tryon` and `restyle`.
// Flow: enqueueRender() inserts `queued` row + fires Inngest `vai/render.requested`.
// Inngest Cloud then POSTs back to `render-tryon?process=1` (HMAC-verified),
// which runs processRender(): ONE provider attempt per invocation so every try
// fits Edge wall-clock limits. Inngest retries (3x, see supabase/inngest.md)
// advance the provider cursor: gemini-flash → gemini-pro → fashn(-max).
// Terminal failure (3 attempts) → DLQ: status `failed`, allowance REFUNDED,
// push with keep-best. Failed predictions always cost the user 0.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { supabaseUrl } from "./auth.ts";
import { GEMINI_FLASH_IMAGE, GEMINI_PRO_IMAGE, GEMINI_STD_COST_USD, generateImage } from "./gemini.ts";
import { FASHN_MAX_COST_USD, FASHN_STD_COST_USD, pollToDone, runTryon } from "./fashn.ts";
import { logRenderCost, todaySpendUsd } from "./ledger.ts";
import { pushToUser, renderFailedPush, renderReadyPush } from "./push.ts";
import type { PoolCode } from "./quota.ts";

export const MAX_ATTEMPTS = 3;
const EST_STD_USD = 0.075;
const EST_MAX_USD = 0.38;

export type PipelineMode = "tryon" | "restyle" | "compare";
export type PipelineTier = "std" | "max";

interface EnqueueInput {
  userId: string;
  outfitId: string | null;
  basePhotoId: string | null;
  garmentIds: string[];
  mode: PipelineMode;
  tier: PipelineTier;
  idempotencyKey: string;
  parentRenderId?: string | null;
  note?: string | null;
  pool: PoolCode;
  /** Pinterest pose (0005): 'keep' default — pipeline prompt unchanged. */
  poseMode?: "keep" | "adapt";
  /** pose_refs.id (owner-resolved by the caller) — nullable FK, SET NULL safe. */
  poseRefId?: string | null;
  /**
   * Extra analytics/debug meta merged into garment_refs.meta (client
   * `model_hint` / `resolution` / `fallback_of`, restyle `rewritten_prompt`
   * + tags). Informational only — NEVER influences provider selection.
   */
  metaExtra?: Record<string, unknown>;
}

interface RenderMeta {
  pool?: PoolCode;
  provider_cursor?: number;
  downgraded?: boolean;
  note?: string;
  simplified?: boolean;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ events
export async function fireRenderRequested(renderId: string, userId: string): Promise<void> {
  const key = Deno.env.get("INNGEST_EVENT_KEY");
  if (!key) throw new Error("INNGEST_EVENT_KEY is not configured");
  const res = await fetch(`https://inn.gs/e/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [{ name: "vai/render.requested", data: { render_id: renderId, user_id: userId } }],
    }),
  });
  if (!res.ok) throw new Error(`Inngest event rejected: HTTP ${res.status}`);
}

/** HMAC-SHA256 over the raw body; header may be hex with or without `sha256=` prefix. */
export async function verifyInngestSignature(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("INNGEST_SIGNING_KEY");
  if (!secret) return false;
  const header = req.headers.get("x-inngest-signature") ?? "";
  const sent = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-f]{64}$/i.test(sent)) return false;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(rawBody),
  );
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sent.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

// ----------------------------------------------------------------- enqueue
export async function enqueueRender(
  sb: SupabaseClient,
  input: EnqueueInput,
): Promise<{ id: string; status: string }> {
  const meta: RenderMeta = { pool: input.pool, ...input.metaExtra };
  if (input.note) meta.note = input.note.slice(0, 280);

  const { data, error } = await sb.from("renders").insert({
    user_id: input.userId,
    outfit_id: input.outfitId,
    base_photo_id: input.basePhotoId,
    parent_render_id: input.parentRenderId ?? null,
    garment_refs: { garment_ids: input.garmentIds, meta },
    mode: input.mode,
    tier: input.tier,
    pose_mode: input.poseMode ?? "keep",
    pose_ref_id: input.poseRefId ?? null,
    credits: 1,
    idempotency_key: input.idempotencyKey,
    status: "queued",
  }).select("id,status").single<{ id: string; status: string }>();
  if (error) throw error;

  try {
    await fireRenderRequested(data.id, input.userId);
  } catch (e) {
    // Client retries with the same idempotency key and gets this same row.
    await sb.from("renders").update({ error: `event_failed: ${(e as Error).message}` })
      .eq("id", data.id);
    throw new Error(`Render queued locally but Inngest unreachable: ${(e as Error).message}`);
  }
  return data;
}

// ------------------------------------------------------------------ prompt
interface PromptCtx {
  mode: PipelineMode;
  note: string | null;
  baseMeta: Record<string, unknown>;
  priorFailTags: string[];
  garmentCount: number;
  simplified: boolean;
}

export function buildTryonPrompt(ctx: PromptCtx): string {
  const base = ctx.baseMeta;
  const conditions = [
    base.lighting ? `lighting: ${String(base.lighting)}` : null,
    base.background ? `background: ${String(base.background)}` : null,
    base.pose ? `pose: ${String(base.pose)}` : null,
  ].filter(Boolean).join("; ");
  const lines = [
    "Photorealistic virtual try-on. Dress the person from the FIRST image (base photo) in the garment(s) from the reference image(s).",
    "Hard constraints: preserve the person's face identity, skin tone, body shape and pose EXACTLY. Do not beautify, slim, age-shift, or change the background.",
    conditions ? `Match base-photo conditions — ${conditions}.` : null,
    ctx.mode === "compare"
      ? "Output ONE image, two panels side by side: LEFT = the untouched base photo, RIGHT = the try-on result. Thin neutral divider, no text."
      : "Output ONLY the try-on result, same framing and aspect as the base photo.",
    ctx.priorFailTags.length > 0
      ? `Avoid these prior failures: ${ctx.priorFailTags.join("; ")}.`
      : null,
    ctx.note ? `Styling adjustment: ${ctx.note}` : null,
    ctx.simplified
      ? "Simplify: clean studio lighting, plain background, single clear garment drape."
      : null,
    "Garment fabric, print, color and logos must match the references exactly.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ----------------------------------------------------------------- process
interface JobRow {
  id: string;
  user_id: string;
  outfit_id: string | null;
  base_photo_id: string | null;
  garment_refs: { garment_ids?: string[]; meta?: RenderMeta } | null;
  mode: string;
  tier: string;
  status: string;
  attempts: number;
  output_url: string | null;
}

function providerChain(tier: PipelineTier): string[] {
  // VERIFIED Sep-2026 (INTEGRATION-REPORT founder decision #1): Gemini is
  // PRIMARY for try-on, FASHN is fallback-only. Order per tier:
  //   std → gemini-3.1-flash-image → gemini-3-pro-image → fashn-std
  //   max → gemini-3-pro-image → gemini-3.1-flash-image → fashn-max
  // Max leads with pro (not flash) on purpose: the caller spent an HD-pack
  // credit for top fidelity, so the highest-fidelity Gemini model goes first;
  // flash remains the safety fallback before FASHN. `model_hint` from the
  // client is recorded in render meta for analytics but NEVER reorders this
  // chain — the server owns provider selection and cost attribution.
  return tier === "max"
    ? [GEMINI_PRO_IMAGE, GEMINI_FLASH_IMAGE, "fashn-max"]
    : [GEMINI_FLASH_IMAGE, GEMINI_PRO_IMAGE, "fashn-std"];
}

function providerCostUsd(provider: string): number {
  if (provider === "fashn-max") return FASHN_MAX_COST_USD;
  if (provider === "fashn-std") return FASHN_STD_COST_USD;
  return GEMINI_STD_COST_USD;
}

function providerLabel(provider: string): string {
  if (provider === GEMINI_FLASH_IMAGE) return "gemini-flash";
  if (provider === GEMINI_PRO_IMAGE) return "gemini-pro";
  return provider;
}

async function downloadToBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Output download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function publicRenderUrl(
  sb: SupabaseClient,
  userId: string,
  renderId: string,
  bytes: Uint8Array,
): Promise<string> {
  const path = `${userId}/${renderId}.png`;
  const { error } = await sb.storage.from("renders").upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw error;
  const { data } = sb.storage.from("renders").getPublicUrl(path);
  return data.publicUrl;
}

async function latestDoneUrl(
  sb: SupabaseClient,
  userId: string,
  excludeId: string,
): Promise<string | null> {
  const { data } = await sb.from("renders").select("output_url").eq("user_id", userId)
    .eq("status", "done").neq("id", excludeId).order("created_at", { ascending: false }).limit(1)
    .maybeSingle<{ output_url: string | null }>();
  return data?.output_url ?? null;
}

async function signedUrl(sb: SupabaseClient, bucket: string, path: string): Promise<string> {
  // Paths stored are already full URLs (public buckets) or storage paths (private).
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error || !data) throw new Error(`Cannot sign ${bucket}/${path}`);
  return data.signedUrl;
}

/**
 * Run ONE provider attempt for a queued/processing render.
 * Throws on retryable failure (Inngest retries → next provider). On the final
 * attempt the row is marked `failed`, the allowance refunded, push sent (DLQ).
 */
export async function processRender(sb: SupabaseClient, renderId: string): Promise<void> {
  const { data: job, error } = await sb.from("renders").select(
    "id,user_id,outfit_id,base_photo_id,garment_refs,mode,tier,status,attempts,output_url",
  ).eq("id", renderId).single<JobRow>();
  if (error || !job) throw new Error(`Render not found: ${renderId}`);
  if (job.status === "done") return; // redelivery-safe

  const meta: RenderMeta = job.garment_refs?.meta ?? {};
  const attempts = job.attempts + 1;

  if (attempts > MAX_ATTEMPTS) {
    await failTerminal(sb, job, meta, "Retry budget exhausted (3 attempts)");
    return;
  }

  await sb.from("renders").update({ status: "processing", attempts, error: null })
    .eq("id", job.id);

  const started = Date.now();
  try {
    // ---- resolve inputs (ownership-checked: every id must belong to the user)
    const garmentIds: string[] = job.garment_refs?.garment_ids ?? [];
    const { data: base } = job.base_photo_id
      ? await sb.from("base_photos").select("url,pose_meta").eq("id", job.base_photo_id)
        .eq("user_id", job.user_id).maybeSingle<{ url: string; pose_meta: Record<string, unknown> }>()
      : await sb.from("base_photos").select("url,pose_meta").eq("user_id", job.user_id)
        .eq("is_active", true).order("created_at", { ascending: false }).limit(1)
        .maybeSingle<{ url: string; pose_meta: Record<string, unknown> }>();
    if (!base) throw new Error("No base photo — retake your mirror selfie first");

    let garmentUrls: string[] = [];
    if (garmentIds.length > 0) {
      const { data: garments } = await sb.from("garments").select("id,cutout_url,image_url")
        .eq("user_id", job.user_id).in("id", garmentIds).is("deleted_at", null);
      const rows = (garments ?? []) as Array<{ id: string; cutout_url: string | null; image_url: string | null }>;
      if (rows.length !== garmentIds.length) throw new Error("Outfit references a removed item");
      garmentUrls = rows.map((g) => g.cutout_url ?? g.image_url ?? "");
      if (garmentUrls.some((u) => !u)) throw new Error("Garment image missing");
    } else if (job.outfit_id) {
      const { data: outfit } = await sb.from("outfits").select("garment_ids").eq("id", job.outfit_id)
        .eq("user_id", job.user_id).maybeSingle<{ garment_ids: string[] }>();
      const ids: string[] = outfit?.garment_ids ?? [];
      if (ids.length > 0) {
        const { data: garments } = await sb.from("garments").select("id,cutout_url,image_url")
          .eq("user_id", job.user_id).in("id", ids).is("deleted_at", null);
        garmentUrls = ((garments ?? []) as Array<{ cutout_url: string | null; image_url: string | null }>)
          .map((g) => g.cutout_url ?? g.image_url ?? "").filter(Boolean);
      }
    }
    if (garmentUrls.length === 0) throw new Error("Nothing to try on — pick at least one garment");

    // ---- spend guard: auto-downgrade Max→std when the daily budget is hot
    let tier = job.tier as PipelineTier;
    const { data: guard } = await sb.from("app_config").select("value").eq("key", "render_guard")
      .maybeSingle<{ value: { max_daily_spend_usd?: number; force_std?: boolean } }>();
    const maxSpend = guard?.value?.max_daily_spend_usd ?? 25;
    if (tier === "max") {
      const spent = await todaySpendUsd(sb);
      if (guard?.value?.force_std === true || spent + EST_MAX_USD > maxSpend) {
        tier = "std";
        meta.downgraded = true;
      }
    }

    const chain = providerChain(tier);
    const cursor = Math.min(meta.provider_cursor ?? 0, chain.length - 1);
    const provider = chain[cursor] as string;
    const url = supabaseUrl();
    void url;

    const prompt = buildTryonPrompt({
      mode: job.mode as PipelineMode,
      note: meta.note ?? null,
      baseMeta: (base.pose_meta ?? {}) as Record<string, unknown>,
      priorFailTags: Array.isArray((base.pose_meta as Record<string, unknown>)?.prior_fail_tags)
        ? ((base.pose_meta as Record<string, unknown>).prior_fail_tags as string[])
        : [],
      garmentCount: garmentUrls.length,
      simplified: meta.simplified === true,
    });

    let bytes: Uint8Array;
    if (provider === "fashn-std" || provider === "fashn-max") {
      const run = await runTryon({
        modelImageUrl: await signedUrl(sb, "base", base.url),
        garmentImageUrls: await Promise.all(
          garmentUrls.map((u) => signedUrl(sb, "garments", u)),
        ),
        max: provider === "fashn-max",
      });
      await sb.from("renders").update({ fashn_id: run.id }).eq("id", job.id);
      const outputs = await pollToDone(run.id);
      bytes = await downloadToBytes(outputs[0] as string);
    } else {
      const img = await generateImage({
        model: provider,
        prompt,
        refImageUrls: [await signedUrl(sb, "base", base.url),
          ...await Promise.all(garmentUrls.map((u) => signedUrl(sb, "garments", u)))],
      });
      bytes = img.bytes;
    }

    const outputUrl = await publicRenderUrl(sb, job.user_id, job.id, bytes);
    const latencyMs = Date.now() - started;
    const costUsd = providerCostUsd(provider);

    await sb.from("renders").update({
      status: "done",
      output_url: outputUrl,
      provider: providerLabel(provider),
      tier,
      garment_refs: { garment_ids: garmentIds, meta },
      error: null,
    }).eq("id", job.id);

    await logRenderCost(sb, {
      userId: job.user_id,
      renderId: job.id,
      provider: providerLabel(provider),
      tier,
      pool: meta.pool ?? "unknown",
      costUsd,
      latencyMs,
    });

    // Daily analytics counter (never blocks success).
    const day = new Date().toISOString().slice(0, 10);
    const { data: q } = await sb.from("render_quotas").select("tryons").eq("user_id", job.user_id)
      .eq("day", day).maybeSingle<{ tryons: number }>();
    if (q) {
      await sb.from("render_quotas").update({ tryons: q.tryons + 1 })
        .eq("user_id", job.user_id).eq("day", day);
    } else {
      await sb.from("render_quotas").insert({ user_id: job.user_id, day, tryons: 1 });
    }

    await pushToUser(sb, job.user_id, renderReadyPush(job.id));
  } catch (e) {
    const message = (e as Error).message;
    meta.provider_cursor = (meta.provider_cursor ?? 0) + 1;
    // Simplify the prompt for the next provider (restyle fallback ladder).
    meta.simplified = true;
    await sb.from("renders").update({
      garment_refs: { garment_ids: job.garment_refs?.garment_ids ?? [], meta },
      error: `attempt ${attempts}: ${message}`.slice(0, 500),
    }).eq("id", job.id);

    if (attempts >= MAX_ATTEMPTS) {
      await failTerminal(sb, job, meta, message);
      return;
    }
    // Throw → Inngest retries the step with the next provider in the chain.
    throw new Error(`Render attempt ${attempts} failed (${message}); retrying`);
  }
}

async function failTerminal(
  sb: SupabaseClient,
  job: JobRow,
  meta: RenderMeta,
  message: string,
): Promise<void> {
  await sb.from("renders").update({ status: "failed", error: message.slice(0, 500) })
    .eq("id", job.id);
  if (meta.pool) {
    const { error } = await sb.rpc("refund_render_allowance", {
      p_user: job.user_id,
      p_pool: meta.pool,
      p_credits: 1,
    });
    if (error) console.error("[pipeline] refund failed", error.message);
  }
  const keepBest = await latestDoneUrl(sb, job.user_id, job.id);
  await pushToUser(sb, job.user_id, renderFailedPush(keepBest));
}
