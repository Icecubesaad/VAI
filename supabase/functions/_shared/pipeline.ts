// Render pipeline engine (Deno, strict TS) — shared by `render-tryon` and `restyle`.
// Flow: enqueueRender() inserts `queued` row + fires Inngest `vai/render.requested`.
// Inngest Cloud then POSTs back to `render-tryon?process=1` (HMAC-verified),
// which runs processRender(): ONE provider attempt per invocation so every try
// fits Edge wall-clock limits. Inngest retries (3x, see supabase/inngest.md)
// advance the provider cursor: gemini-flash → gemini-pro → fashn(-max).
// Terminal failure (3 attempts) → DLQ: status `failed`, allowance REFUNDED,
// push with keep-best. Failed predictions always cost the user 0.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  GEMINI_STD_COST_USD,
  generateImage,
  OR_IMAGE_MODEL,
} from "./gemini.ts";
import {
  FASHN_MAX_COST_USD,
  FASHN_STD_COST_USD,
  pollToDone,
  runTryon,
} from "./fashn.ts";
import { HttpError } from "./http.ts";
import { logRenderCost, renderCostUsd, todaySpendUsd } from "./ledger.ts";
import {
  estimateModalGpuCostUsd,
  MAX_MODAL_WORKER_RUNTIME_SECONDS,
  ModalQaAlreadyClaimedError,
  ModalQaError,
  QA_MODAL_PROVIDER,
  runModalQaTryon,
} from "./modal-qa.ts";
import { pushToUser, renderFailedPush, renderReadyPush } from "./push.ts";
import { type PoolCode, refundAllowance } from "./quota.ts";
import { signedAssetUrl, signedRenderUrl } from "./storage.ts";

export const MAX_ATTEMPTS = 3;
const EST_STD_USD = 0.075;
const EST_MAX_USD = 0.38;
const MODAL_QA_CLAIM_WINDOW_MS = 150_000;
const MODAL_QA_RECOVERY_WAIT_MS = 90_000;
const MODAL_QA_RECOVERY_POLL_MS = 2_000;

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
  /** Reserve provider-specific resources after insert but before dispatch. */
  prepareDispatch?: (renderId: string) => Promise<void>;
  /** Atomically clean up only when a provider dispatch has not been claimed. */
  abortDispatch?: (
    renderId: string,
  ) => Promise<"aborted" | "claimed" | "terminal" | "missing">;
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
export async function fireRenderRequested(
  renderId: string,
  userId: string,
): Promise<void> {
  const key = Deno.env.get("INNGEST_EVENT_KEY");
  if (!key) throw new Error("INNGEST_EVENT_KEY is not configured");
  const res = await fetch(`https://inn.gs/e/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [{
        name: "vai/render.requested",
        data: { render_id: renderId, user_id: userId },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Inngest event rejected: HTTP ${res.status}`);
}

/** HMAC-SHA256 over the raw body; header may be hex with or without `sha256=` prefix. */
export async function verifyInngestSignature(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  const secret = Deno.env.get("INNGEST_SIGNING_KEY");
  if (!secret) return false;
  const header = req.headers.get("x-inngest-signature") ?? "";
  const sent = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-f]{64}$/i.test(sent)) return false;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(rawBody),
  );
  const hex = [...new Uint8Array(mac)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  if (hex.length !== sent.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ sent.charCodeAt(i);
  }
  return diff === 0;
}

// ----------------------------------------------------------------- enqueue
export async function enqueueRender(
  sb: SupabaseClient,
  input: EnqueueInput,
): Promise<{ id: string; status: string }> {
  const meta: RenderMeta = { ...input.metaExtra, pool: input.pool };
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

  // RENDER_INLINE=true (dev / pre-Inngest deployments): skip the queue — the
  // caller processes the render inline. With Inngest, enqueue as before.
  let eventDispatchAttempted = false;
  try {
    await input.prepareDispatch?.(data.id);
    if (Deno.env.get("RENDER_INLINE") !== "true") {
      eventDispatchAttempted = true;
      await fireRenderRequested(data.id, input.userId);
    } else {
      console.log("[pipeline] RENDER_INLINE — skipping Inngest enqueue", {
        renderId: data.id,
      });
    }
  } catch (e) {
    if (input.abortDispatch) {
      let outcome: "aborted" | "claimed" | "terminal" | "missing";
      try {
        outcome = await input.abortDispatch(data.id);
      } catch (abortError) {
        console.error("[pipeline] Modal QA dispatch cleanup is uncertain", {
          renderId: data.id,
          error: (abortError as Error).message,
        });
        throw new HttpError(
          503,
          "qa_modal_dispatch_uncertain",
          "The QA request could not be confirmed. Retry with the same request.",
        );
      }

      if (outcome === "aborted") {
        if (e instanceof HttpError) throw e;
        throw new HttpError(
          503,
          "render_queue_unavailable",
          "The render queue is momentarily unreachable — try again in a moment.",
        );
      }

      if (
        eventDispatchAttempted &&
        (outcome === "claimed" || outcome === "terminal")
      ) {
        const { data: current, error: currentError } = await sb.from("renders")
          .select("id,status").eq("id", data.id).maybeSingle<
          { id: string; status: string }
        >();
        if (currentError) throw currentError;
        if (current) return current;
      }

      throw new HttpError(
        503,
        "qa_modal_dispatch_uncertain",
        "The QA request could not be confirmed. Retry with the same request.",
      );
    }

    console.error("[pipeline] render enqueue failed — refunding", {
      renderId: data.id,
      userId: input.userId,
      error: (e as Error).message,
    });
    await refundAllowance(sb, input.userId, input.pool);
    await sb.from("renders").delete().eq("id", data.id);
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      503,
      "render_queue_unavailable",
      "The render queue is momentarily unreachable — try again in a moment.",
    );
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
  idempotency_key: string;
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
  // One AI leg + FASHN: the founder's mandated image model (OpenRouter
  // flash-lite) IS the top leg; FASHN remains the safety fallback.
  // `model_hint` from the
  // client is recorded in render meta for analytics but NEVER reorders this
  // chain — the server owns provider selection and cost attribution.
  return tier === "max"
    ? [OR_IMAGE_MODEL, "fashn-max"]
    : [OR_IMAGE_MODEL, "fashn-std"];
}

function providerCostUsd(provider: string): number {
  if (provider === "fashn-max") return FASHN_MAX_COST_USD;
  if (provider === "fashn-std") return FASHN_STD_COST_USD;
  return GEMINI_STD_COST_USD;
}

function providerLabel(provider: string): string {
  if (provider === OR_IMAGE_MODEL) return "gemini-flash-image";
  if (provider === QA_MODAL_PROVIDER) return "qwen-image-edit-2511-modal-qa";
  return provider;
}

async function downloadToBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Output download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Upload finished render bytes to the private `renders` bucket under the
 * owner's prefix and return the bucket PATH. Serving mints fresh 1h signed
 * URLs from this path (signedRenderUrl) — the bucket has no public-read
 * policy (migration 0008), so nothing here can be listed or fetched anonymously.
 */
async function uploadRender(
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
  return path;
}

async function latestDoneSignedUrl(
  sb: SupabaseClient,
  userId: string,
  excludeId: string,
): Promise<string | null> {
  const { data } = await sb.from("renders").select("output_path,output_url").eq(
    "user_id",
    userId,
  )
    .eq("status", "done").neq("id", excludeId).order("created_at", {
      ascending: false,
    }).limit(1)
    .maybeSingle<{ output_path: string | null; output_url: string | null }>();
  if (!data) return null;
  if (data.output_path) {
    return await signedRenderUrl(sb, userId, data.output_path);
  }
  return data.output_url; // legacy row predating 0008 (already expired-safe: transient push copy)
}

/**
 * Resolve a stored base/garment image reference to a 1h signed URL — SSRF-
 * and ownership-hardened in _shared/storage.ts (users can update their own
 * url columns via the Data API; the pipeline never fetches untrusted URLs).
 */
const signedUrl = signedAssetUrl;

async function releaseModalQaSlot(
  sb: SupabaseClient,
  job: JobRow,
  meta: RenderMeta,
): Promise<boolean> {
  const usageDay = meta.qa_modal_usage_day;
  if (typeof usageDay !== "string" || !job.idempotency_key) return false;
  const { data, error } = await sb.rpc("release_qa_modal_slot", {
    p_user_id: job.user_id,
    p_day: usageDay,
    p_request_key: job.idempotency_key,
    p_render_id: job.id,
  });
  if (error) {
    console.error("[pipeline] Modal QA reservation release failed", {
      renderId: job.id,
      error: error.message,
    });
    throw error;
  }
  return data === true;
}

async function loadModalQaState(
  sb: SupabaseClient,
  renderId: string,
): Promise<{ status: string; garment_refs: JobRow["garment_refs"] } | null> {
  const { data, error } = await sb.from("renders").select("status,garment_refs")
    .eq("id", renderId).maybeSingle<
    { status: string; garment_refs: JobRow["garment_refs"] }
  >();
  if (error) throw error;
  return data;
}

async function recordModalQaCost(
  sb: SupabaseClient,
  job: JobRow,
  meta: RenderMeta,
  workerRuntimeSeconds: number,
  latencyMs: number,
): Promise<void> {
  const rate = Number(meta.qa_modal_gpu_usd_per_second);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 0.01) {
    throw new Error(
      "Modal QA GPU rate is missing or invalid; refusing unaccounted completion.",
    );
  }

  const runtime = Number.isFinite(workerRuntimeSeconds)
    ? Math.min(
      Math.max(workerRuntimeSeconds, 0),
      MAX_MODAL_WORKER_RUNTIME_SECONDS,
    )
    : MAX_MODAL_WORKER_RUNTIME_SECONDS;
  const costUsd = estimateModalGpuCostUsd(runtime, rate);
  meta.qa_modal_worker_runtime_seconds = runtime;
  meta.qa_modal_estimated_gpu_cost_usd = costUsd;

  const { error: metaError } = await sb.from("renders").update({
    garment_refs: { garment_ids: job.garment_refs?.garment_ids ?? [], meta },
  }).eq("id", job.id);
  if (metaError) {
    console.error(
      "[pipeline] Modal QA estimate metadata write failed",
      metaError.message,
    );
  }

  if (await renderCostUsd(sb, job.id) === null) {
    try {
      await logRenderCost(sb, {
        userId: job.user_id,
        renderId: job.id,
        provider: providerLabel(QA_MODAL_PROVIDER),
        tier: job.tier,
        pool: meta.pool ?? "unknown",
        costUsd,
        latencyMs,
        gpuRuntimeSeconds: runtime,
        required: true,
      });
    } catch (error) {
      // A DB uniqueness constraint is the race-safe backstop for retries.
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  console.info("[pipeline] Modal QA GPU cost estimate", {
    renderId: job.id,
    workerRuntimeSeconds: runtime,
    estimatedCostUsd: costUsd,
  });
}

/**
 * Run ONE provider attempt for a queued/processing render.
 * Throws on retryable failure (Inngest retries → next provider). On the final
 * attempt the row is marked `failed`, the allowance refunded, push sent (DLQ).
 */
export async function processRender(
  sb: SupabaseClient,
  renderId: string,
): Promise<void> {
  const { data: job, error } = await sb.from("renders").select(
    "id,user_id,idempotency_key,outfit_id,base_photo_id,garment_refs,mode,tier,status,attempts,output_url",
  ).eq("id", renderId).single<JobRow>();
  if (error || !job) throw new Error(`Render not found: ${renderId}`);

  const meta: RenderMeta = job.garment_refs?.meta ?? {};
  const modalQa = meta.qa_provider === QA_MODAL_PROVIDER;
  if (job.status === "done") {
    if (modalQa && meta.qa_modal_started_at) {
      const runtime = meta.qa_modal_worker_runtime_seconds;
      await recordModalQaCost(
        sb,
        job,
        meta,
        typeof runtime === "number"
          ? runtime
          : MAX_MODAL_WORKER_RUNTIME_SECONDS,
        0,
      );
    }
    return; // redelivery-safe
  }
  if (job.status === "failed") {
    if (modalQa && meta.qa_modal_started_at) {
      const runtime = meta.qa_modal_worker_runtime_seconds;
      await recordModalQaCost(
        sb,
        job,
        meta,
        typeof runtime === "number"
          ? runtime
          : MAX_MODAL_WORKER_RUNTIME_SECONDS,
        0,
      );
    }
    return;
  }
  if (modalQa && meta.qa_modal_started_at) {
    const startedAt = Date.parse(String(meta.qa_modal_started_at));
    if (typeof meta.qa_modal_failure === "string") {
      const runtime = meta.qa_modal_worker_runtime_seconds;
      await recordModalQaCost(
        sb,
        job,
        meta,
        typeof runtime === "number"
          ? runtime
          : MAX_MODAL_WORKER_RUNTIME_SECONDS,
        Number.isFinite(startedAt) ? Date.now() - startedAt : 150_000,
      );
      await failTerminal(sb, job, meta, meta.qa_modal_failure);
      return;
    }
    if (
      !Number.isFinite(startedAt) ||
      Date.now() - startedAt >= MODAL_QA_CLAIM_WINDOW_MS
    ) {
      await recordModalQaCost(
        sb,
        job,
        meta,
        MAX_MODAL_WORKER_RUNTIME_SECONDS,
        150_000,
      );
      await failTerminal(
        sb,
        job,
        meta,
        "Modal QA exceeded its safe processing window.",
      );
      return;
    }

    const recoveryDeadline = Math.min(
      Date.now() + MODAL_QA_RECOVERY_WAIT_MS,
      startedAt + MODAL_QA_CLAIM_WINDOW_MS,
    );
    let latest = await loadModalQaState(sb, job.id);
    while (
      latest && latest.status !== "done" && latest.status !== "failed" &&
      typeof latest.garment_refs?.meta?.qa_modal_failure !== "string" &&
      Date.now() < recoveryDeadline
    ) {
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(MODAL_QA_RECOVERY_POLL_MS, recoveryDeadline - Date.now()),
        )
      );
      latest = await loadModalQaState(sb, job.id);
    }

    if (!latest) {
      await recordModalQaCost(
        sb,
        job,
        meta,
        MAX_MODAL_WORKER_RUNTIME_SECONDS,
        Date.now() - startedAt,
      );
      return;
    }
    const latestMeta = latest.garment_refs?.meta ?? {};
    const runtime =
      typeof latestMeta.qa_modal_worker_runtime_seconds === "number"
        ? latestMeta.qa_modal_worker_runtime_seconds
        : MAX_MODAL_WORKER_RUNTIME_SECONDS;
    const latencyMs = Date.now() - startedAt;
    if (latest.status === "done" || latest.status === "failed") {
      await recordModalQaCost(sb, job, latestMeta, runtime, latencyMs);
      return;
    }
    if (typeof latestMeta.qa_modal_failure === "string") {
      await recordModalQaCost(sb, job, latestMeta, runtime, latencyMs);
      await failTerminal(sb, job, latestMeta, latestMeta.qa_modal_failure);
      return;
    }
    if (Date.now() - startedAt >= MODAL_QA_CLAIM_WINDOW_MS) {
      await recordModalQaCost(
        sb,
        job,
        latestMeta,
        MAX_MODAL_WORKER_RUNTIME_SECONDS,
        latencyMs,
      );
      await failTerminal(
        sb,
        job,
        latestMeta,
        "Modal QA exceeded its safe processing window.",
      );
      return;
    }
    throw new Error(
      "Modal QA dispatch is still active; retrying until its recovery window expires.",
    );
  }
  const attempts = job.attempts + 1;

  if (attempts > MAX_ATTEMPTS) {
    if (modalQa) {
      const released = await releaseModalQaSlot(sb, job, meta);
      if (!released) {
        const latest = await loadModalQaState(sb, job.id);
        const latestMeta = latest?.garment_refs?.meta ?? {};
        if (!latest || latest.status === "failed") return;
        if (latest.status === "done") {
          const runtime = latestMeta.qa_modal_worker_runtime_seconds;
          if (latestMeta.qa_modal_started_at) {
            await recordModalQaCost(
              sb,
              job,
              latestMeta,
              typeof runtime === "number"
                ? runtime
                : MAX_MODAL_WORKER_RUNTIME_SECONDS,
              150_000,
            );
          }
          return;
        }
        if (latestMeta.qa_modal_started_at) return;
      }
    }
    await failTerminal(sb, job, meta, "Retry budget exhausted (3 attempts)");
    return;
  }

  await sb.from("renders").update({
    status: "processing",
    attempts,
    error: null,
  })
    .eq("id", job.id);

  const started = Date.now();
  try {
    // ---- resolve inputs (ownership-checked: every id must belong to the user)
    const garmentIds: string[] = job.garment_refs?.garment_ids ?? [];
    const { data: base } = job.base_photo_id
      ? await sb.from("base_photos").select("url,pose_meta").eq(
        "id",
        job.base_photo_id,
      )
        .eq("user_id", job.user_id).maybeSingle<
        { url: string; pose_meta: Record<string, unknown> }
      >()
      : await sb.from("base_photos").select("url,pose_meta").eq(
        "user_id",
        job.user_id,
      )
        .eq("is_active", true).order("created_at", { ascending: false }).limit(
          1,
        )
        .maybeSingle<{ url: string; pose_meta: Record<string, unknown> }>();
    if (!base) {
      throw new Error("No base photo — retake your mirror selfie first");
    }

    let garmentUrls: string[] = [];
    if (garmentIds.length > 0) {
      const { data: garments } = await sb.from("garments").select(
        "id,cutout_url,image_url",
      )
        .eq("user_id", job.user_id).in("id", garmentIds).is("deleted_at", null);
      const rows = (garments ?? []) as Array<
        { id: string; cutout_url: string | null; image_url: string | null }
      >;
      if (rows.length !== garmentIds.length) {
        throw new Error("Outfit references a removed item");
      }
      garmentUrls = rows.map((g) => g.cutout_url ?? g.image_url ?? "");
      if (garmentUrls.some((u) => !u)) throw new Error("Garment image missing");
    } else if (job.outfit_id) {
      const { data: outfit } = await sb.from("outfits").select("garment_ids")
        .eq("id", job.outfit_id)
        .eq("user_id", job.user_id).maybeSingle<{ garment_ids: string[] }>();
      const ids: string[] = outfit?.garment_ids ?? [];
      if (ids.length > 0) {
        const { data: garments } = await sb.from("garments").select(
          "id,cutout_url,image_url",
        )
          .eq("user_id", job.user_id).in("id", ids).is("deleted_at", null);
        garmentUrls = ((garments ?? []) as Array<
          { cutout_url: string | null; image_url: string | null }
        >)
          .map((g) => g.cutout_url ?? g.image_url ?? "").filter(Boolean);
      }
    }
    if (garmentUrls.length === 0) {
      throw new Error("Nothing to try on — pick at least one garment");
    }

    // ---- spend guard: auto-downgrade Max→std when the daily budget is hot
    let tier = job.tier as PipelineTier;
    const { data: guard } = await sb.from("app_config").select("value").eq(
      "key",
      "render_guard",
    )
      .maybeSingle<
        { value: { max_daily_spend_usd?: number; force_std?: boolean } }
      >();
    const maxSpend = guard?.value?.max_daily_spend_usd ?? 25;
    if (tier === "max") {
      const spent = await todaySpendUsd(sb);
      if (guard?.value?.force_std === true || spent + EST_MAX_USD > maxSpend) {
        tier = "std";
        meta.downgraded = true;
      }
    }

    const chain = modalQa ? [QA_MODAL_PROVIDER] : providerChain(tier);
    const cursor = modalQa
      ? 0
      : Math.min(meta.provider_cursor ?? 0, chain.length - 1);
    const provider = chain[cursor] as string;

    const prompt = buildTryonPrompt({
      mode: job.mode as PipelineMode,
      note: meta.note ?? null,
      baseMeta: (base.pose_meta ?? {}) as Record<string, unknown>,
      priorFailTags: Array.isArray(
          (base.pose_meta as Record<string, unknown>)?.prior_fail_tags,
        )
        ? ((base.pose_meta as Record<string, unknown>)
          .prior_fail_tags as string[])
        : [],
      garmentCount: garmentUrls.length,
      simplified: meta.simplified === true,
    });

    let bytes: Uint8Array;
    let modalWorkerRuntimeSeconds: number | null = null;
    if (provider === QA_MODAL_PROVIDER) {
      const personImageUrl = await signedUrl(sb, "base", base.url, job.user_id);
      const garmentImageUrls = await Promise.all(
        garmentUrls.map((url) => signedUrl(sb, "garments", url, job.user_id)),
      );
      const result = await runModalQaTryon({
        userId: job.user_id,
        renderId: job.id,
        personImageUrl,
        garmentImageUrls,
        claimDispatch: async () => {
          const claimAttemptedAt = new Date().toISOString();
          const claimId = typeof meta.qa_modal_claim_id === "string"
            ? meta.qa_modal_claim_id
            : crypto.randomUUID();
          const { data: claimed, error: claimError } = await sb.rpc(
            "claim_qa_modal_render",
            {
              p_render_id: job.id,
              p_user_id: job.user_id,
              p_day: String(meta.qa_modal_usage_day ?? ""),
              p_request_key: job.idempotency_key,
              p_started_at: claimAttemptedAt,
              p_claim_id: claimId,
            },
          );
          if (claimError || claimed !== true) {
            const { data: current } = await sb.from("renders").select(
              "garment_refs",
            )
              .eq("id", job.id).maybeSingle<{
              garment_refs:
                | { garment_ids?: string[]; meta?: RenderMeta }
                | null;
            }>();
            const currentMeta = current?.garment_refs?.meta ?? {};
            if (currentMeta.qa_modal_claim_id === claimId) {
              meta.qa_modal_claim_uncertain = false;
              meta.qa_modal_claim_id = claimId;
            } else if (
              currentMeta.qa_modal_started_at || currentMeta.qa_modal_claim_id
            ) {
              meta.qa_modal_claim_uncertain = false;
              return false;
            } else if (claimError || !current) {
              meta.qa_modal_claim_uncertain = true;
              throw new Error("Modal QA claim could not be confirmed safely.");
            } else {
              meta.qa_modal_claim_uncertain = false;
              return false;
            }
          } else {
            meta.qa_modal_claim_uncertain = false;
            meta.qa_modal_claim_id = claimId;
          }

          const startedAt = new Date().toISOString();
          const dispatchId = crypto.randomUUID();
          const { data: started, error: startError } = await sb.rpc(
            "start_qa_modal_dispatch",
            {
              p_render_id: job.id,
              p_user_id: job.user_id,
              p_day: String(meta.qa_modal_usage_day ?? ""),
              p_request_key: job.idempotency_key,
              p_claim_id: claimId,
              p_dispatch_id: dispatchId,
              p_started_at: startedAt,
            },
          );
          if (startError || started !== true) {
            const { data: current, error: currentError } = await sb.from(
              "renders",
            ).select("garment_refs")
              .eq("id", job.id).maybeSingle<{
              garment_refs:
                | { garment_ids?: string[]; meta?: RenderMeta }
                | null;
            }>();
            const currentMeta = current?.garment_refs?.meta ?? {};
            if (
              !currentError && currentMeta.qa_modal_dispatch_id === dispatchId
            ) {
              meta.qa_modal_claim_uncertain = false;
              meta.qa_modal_claim_id = claimId;
              meta.qa_modal_dispatch_id = dispatchId;
              meta.qa_modal_started_at = startedAt;
              return true;
            }
            if (
              !currentError &&
              (currentMeta.qa_modal_started_at ||
                currentMeta.qa_modal_claim_id !== claimId)
            ) {
              meta.qa_modal_claim_uncertain = false;
              return false;
            }
            meta.qa_modal_claim_uncertain = true;
            throw new Error("Modal QA dispatch could not be confirmed safely.");
          }

          meta.qa_modal_claim_uncertain = false;
          meta.qa_modal_claim_id = claimId;
          meta.qa_modal_dispatch_id = dispatchId;
          meta.qa_modal_started_at = startedAt;
          return true;
        },
      });
      bytes = result.imageBytes;
      modalWorkerRuntimeSeconds = result.workerRuntimeSeconds;
      meta.qa_modal_worker_runtime_seconds = modalWorkerRuntimeSeconds;
      meta.qa_modal_estimated_gpu_cost_usd = estimateModalGpuCostUsd(
        modalWorkerRuntimeSeconds,
        Number(meta.qa_modal_gpu_usd_per_second),
      );
    } else if (provider === "fashn-std" || provider === "fashn-max") {
      const run = await runTryon({
        modelImageUrl: await signedUrl(sb, "base", base.url, job.user_id),
        garmentImageUrls: await Promise.all(
          garmentUrls.map((u) => signedUrl(sb, "garments", u, job.user_id)),
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
        refImageUrls: [
          await signedUrl(sb, "base", base.url, job.user_id),
          ...await Promise.all(
            garmentUrls.map((u) => signedUrl(sb, "garments", u, job.user_id)),
          ),
        ],
      });
      bytes = img.bytes;
    }

    const outputPath = await uploadRender(sb, job.user_id, job.id, bytes);
    const latencyMs = Date.now() - started;
    const costUsd = modalQa
      ? Number(meta.qa_modal_estimated_gpu_cost_usd ?? 0)
      : providerCostUsd(provider);

    const completionUpdate = sb.from("renders").update({
      status: "done",
      output_path: outputPath,
      output_url: null, // served via signedRenderUrl — never a public URL (0008)
      provider: providerLabel(provider),
      tier,
      garment_refs: { garment_ids: garmentIds, meta },
      error: null,
    }).eq("id", job.id);
    const completionWrite = modalQa
      ? completionUpdate.eq("status", "processing")
      : completionUpdate;
    const { data: completed, error: completeError } = await completionWrite
      .select("id")
      .maybeSingle<{ id: string }>();
    if (completeError) throw completeError;
    if (modalQa && !completed) {
      throw new Error("Modal QA render row disappeared before completion.");
    }

    if (modalQa && modalWorkerRuntimeSeconds !== null) {
      await recordModalQaCost(
        sb,
        job,
        meta,
        modalWorkerRuntimeSeconds,
        latencyMs,
      );
    } else {
      await logRenderCost(sb, {
        userId: job.user_id,
        renderId: job.id,
        provider: providerLabel(provider),
        tier,
        pool: meta.pool ?? "unknown",
        costUsd,
        latencyMs,
      });
    }

    // Daily analytics counter (never blocks success).
    const day = new Date().toISOString().slice(0, 10);
    const { data: q } = await sb.from("render_quotas").select("tryons").eq(
      "user_id",
      job.user_id,
    )
      .eq("day", day).maybeSingle<{ tryons: number }>();
    if (q) {
      await sb.from("render_quotas").update({ tryons: q.tryons + 1 })
        .eq("user_id", job.user_id).eq("day", day);
    } else {
      await sb.from("render_quotas").insert({
        user_id: job.user_id,
        day,
        tryons: 1,
      });
    }

    await pushToUser(sb, job.user_id, renderReadyPush(job.id));
  } catch (e) {
    const message = (e as Error).message;
    if (modalQa) {
      if (e instanceof ModalQaAlreadyClaimedError) return;
      if (meta.qa_modal_claim_uncertain === true) {
        throw new Error(
          "Modal QA dispatch claim is uncertain; retrying without another GPU dispatch.",
        );
      }

      if (!meta.qa_modal_started_at) await releaseModalQaSlot(sb, job, meta);
      const latest = await loadModalQaState(sb, job.id);
      if (!latest) {
        if (meta.qa_modal_started_at) {
          const reportedRuntime = e instanceof ModalQaError
            ? e.workerRuntimeSeconds
            : undefined;
          await recordModalQaCost(
            sb,
            job,
            meta,
            typeof reportedRuntime === "number"
              ? reportedRuntime
              : MAX_MODAL_WORKER_RUNTIME_SECONDS,
            Date.now() - started,
          );
        }
        return;
      }
      const latestMeta = latest.garment_refs?.meta ?? {};
      if (latest?.status === "done") {
        if (latestMeta.qa_modal_started_at) {
          const runtime = latestMeta.qa_modal_worker_runtime_seconds;
          await recordModalQaCost(
            sb,
            job,
            latestMeta,
            typeof runtime === "number"
              ? runtime
              : MAX_MODAL_WORKER_RUNTIME_SECONDS,
            Date.now() - started,
          );
        }
        return;
      }
      if (latest.status === "failed") {
        if (latestMeta.qa_modal_started_at) {
          const runtime = latestMeta.qa_modal_worker_runtime_seconds;
          await recordModalQaCost(
            sb,
            job,
            latestMeta,
            typeof runtime === "number"
              ? runtime
              : MAX_MODAL_WORKER_RUNTIME_SECONDS,
            Date.now() - started,
          );
        }
        return;
      }
      if (!meta.qa_modal_started_at && latestMeta.qa_modal_started_at) return;

      if (meta.qa_modal_started_at) {
        const reportedRuntime = e instanceof ModalQaError
          ? e.workerRuntimeSeconds
          : undefined;
        const runtime = typeof reportedRuntime === "number"
          ? reportedRuntime
          : typeof meta.qa_modal_worker_runtime_seconds === "number"
          ? meta.qa_modal_worker_runtime_seconds
          : MAX_MODAL_WORKER_RUNTIME_SECONDS;
        meta.qa_modal_failure = message.slice(0, 500);
        const { error: failureMetaError } = await sb.from("renders").update({
          garment_refs: {
            garment_ids: job.garment_refs?.garment_ids ?? [],
            meta,
          },
          error: `Modal QA attempt failed: ${message}`.slice(0, 500),
        }).eq("id", job.id);
        if (failureMetaError) throw failureMetaError;
        await recordModalQaCost(sb, job, meta, runtime, Date.now() - started);
      }

      await failTerminal(sb, job, meta, message);
      return;
    }

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
  if (meta.qa_provider === QA_MODAL_PROVIDER) {
    const { data, error } = await sb.rpc("fail_qa_modal_render", {
      p_render_id: job.id,
      p_user_id: job.user_id,
      p_day: String(meta.qa_modal_usage_day ?? ""),
      p_request_key: job.idempotency_key,
      p_claim_id: typeof meta.qa_modal_claim_id === "string"
        ? meta.qa_modal_claim_id
        : null,
      p_dispatch_id: typeof meta.qa_modal_dispatch_id === "string"
        ? meta.qa_modal_dispatch_id
        : null,
      p_error: message.slice(0, 500),
    });
    if (error) throw error;
    if (data !== true) return;
  } else {
    await sb.from("renders").update({
      status: "failed",
      error: message.slice(0, 500),
    })
      .eq("id", job.id);
  }
  if (meta.qa_provider !== QA_MODAL_PROVIDER && meta.pool) {
    const { error } = await sb.rpc("refund_render_allowance", {
      p_user: job.user_id,
      p_pool: meta.pool,
      p_credits: 1,
    });
    if (error) console.error("[pipeline] refund failed", error.message);
  }
  const keepBest = await latestDoneSignedUrl(sb, job.user_id, job.id);
  await pushToUser(sb, job.user_id, renderFailedPush(keepBest));
}
