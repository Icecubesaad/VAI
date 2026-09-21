// posthog — server-authoritative PostHog capture (GTM turf).
// Fire-and-forget: analytics must never fail a billing/webhook path.
// Secrets (supabase secrets set): POSTHOG_API_KEY, optional POSTHOG_HOST
// (default https://us.i.posthog.com). No-ops when the key is absent.

export async function captureServerEvent(
  distinctId: string,
  event: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  const key = Deno.env.get("POSTHOG_API_KEY");
  if (!key || !distinctId) return;
  try {
    const host = Deno.env.get("POSTHOG_HOST") ?? "https://us.i.posthog.com";
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        properties: props,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Events are evidence, not flow — a failed capture is dropped, never thrown.
  }
}
