// Expo Push sender (Deno, strict TS). No SDK dependency — raw HTTPS to Expo.
// Renders take 10–55s IRL: async queue + push "ready", never fake countdowns.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface Ticket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

/** Send to all of a user's tokens; prunes unregistered tokens. Never throws. */
export async function pushToUser(
  sb: SupabaseClient,
  userId: string,
  msg: PushMessage,
): Promise<void> {
  const { data, error } = await sb.from("push_tokens").select("expo_token").eq("user_id", userId);
  if (error || !data || data.length === 0) return;
  const tokens = (data as Array<{ expo_token: string }>)
    .map((r) => r.expo_token)
    .filter((t) => t.startsWith("ExponentPushToken["));

  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((to) => ({ to, ...msg, sound: "default" }))),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Ticket[] };
      const dead: string[] = [];
      (body.data ?? []).forEach((t, idx) => {
        if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
          const tok = chunk[idx];
          if (tok) dead.push(tok);
        }
      });
      for (const tok of dead) {
        await sb.from("push_tokens").delete().eq("expo_token", tok);
      }
    } catch (e) {
      console.error("[push] send failed", (e as Error).message);
    }
  }
}

export const renderReadyPush = (renderId: string): PushMessage => ({
  title: "Try-on ready",
  body: "Your look is ready to view.",
  data: { kind: "render_ready", render_id: renderId },
});

export const renderFailedPush = (keepBestUrl: string | null): PushMessage => ({
  title: "Try-on didn't finish",
  body: keepBestUrl
    ? "This one failed — kept your best version. Retrying is free."
    : "This one failed — retrying won't cost a render.",
  data: { kind: "render_failed", keep_best_url: keepBestUrl },
});
