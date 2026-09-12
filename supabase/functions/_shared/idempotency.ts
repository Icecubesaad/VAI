// Idempotency for renders (Deno, strict TS).
// Build pack §5: idempotency_key = sha256(user|base|outfit|day[|mode|tier]).
// An identical re-request returns the cached row and costs 0.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface RenderRow {
  id: string;
  user_id: string;
  status: "queued" | "processing" | "done" | "failed";
  output_url: string | null;
  /** Private-bucket path (0008) — served via signedRenderUrl, never public. */
  output_path: string | null;
  provider: string | null;
  mode: string | null;
  tier: string | null;
  idempotency_key: string;
  attempts: number;
  created_at: string;
}

export async function sha256Hex(parts: Array<string | null | undefined>): Promise<string> {
  const joined = parts.map((p) => p ?? "").join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RenderKeyInput {
  userId: string;
  basePhotoId: string | null;
  outfitId: string | null;
  garmentIds: string[];
  day: string; // YYYY-MM-DD
  mode: string;
  tier: string;
  promptHash?: string;
}

/** Canonical key — mode+tier included so std/Max and tryon/restyle never collide. */
export async function buildRenderKey(input: RenderKeyInput): Promise<string> {
  const suit = [...input.garmentIds].sort().join(",");
  return sha256Hex([
    input.userId,
    input.basePhotoId,
    input.outfitId ?? `suit:${suit}`,
    input.day,
    input.mode,
    input.tier,
    input.promptHash ?? "",
  ]);
}

export async function findRenderByKey(
  sb: SupabaseClient,
  userId: string,
  key: string,
): Promise<RenderRow | null> {
  const { data, error } = await sb.from("renders").select(
    "id,user_id,status,output_url,output_path,provider,mode,tier,idempotency_key,attempts,created_at",
  ).eq("user_id", userId).eq("idempotency_key", key).maybeSingle<RenderRow>();
  if (error) throw error;
  return data;
}

/** A terminally-failed row with the same key must not block a genuine retry. */
export function isReusableRow(row: RenderRow): boolean {
  return row.status === "queued" || row.status === "processing" || row.status === "done";
}
