# VAI Inngest — render pipeline, retries, DLQ, crons

Renders take 10–55s IRL: async queue + push, never fake countdowns. Inngest owns
orchestration; Supabase owns state (`renders` row) and money (allowance RPCs).

## Render pipeline: `queued → processing → done | failed`

```
client → render-tryon (enqueue) ── allowance consumed (consume_render_allowance)
   │  inserts renders(queued) + fires vai/render.requested ──→ Inngest Cloud
   │                                                              │ step.run ×3
   ▼                                                              ▼
renders.processing ◄── render-tryon?process=1 (HMAC) ── ONE provider/attempt
   │  attempt1: gemini-3.1-flash-image (std) / gemini-3-pro-image (max)
   │  attempt2: the other Gemini model            (provider_cursor in meta)
   │  attempt3: fashn (tryon-v1.6 / tryon-max) + poll w/ backoff, hard cap 90s
   ├── success → done: output_url set, ledger render_cost, Expo push "ready"
   └── attempts exhausted → failed (DLQ): allowance REFUNDED, push w/ keep-best
```

One provider per invocation keeps every try inside Edge wall-clock limits.
Inngest redelivery is safe: `done` rows return immediately; same
`idempotency_key` never double-charges (checked before consume).

## Inngest function (deploy on any Node host; calls the edge worker)

```ts
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "vai-app" });

async function callWorker(renderId: string) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/functions/v1/render-tryon?process=1`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inngest-signature": await sign(process.env.INNGEST_SIGNING_KEY!, renderId),
      },
      body: JSON.stringify({ render_id: renderId }),
    },
  );
  if (!res.ok) throw new Error(`worker ${res.status}: ${await res.text()}`);
}

export const renderPipeline = inngest.createFunction(
  {
    id: "render-pipeline",
    retries: 3, // § DLQ after 3 worker invocations (attempts column agrees)
    concurrency: { limit: 20 },
    onFailure: async ({ event }) => {
      // Safety net: pipeline.processRender() already refunds on attempt 3.
      // This only fires if the worker itself was unreachable — alert, don't charge.
      console.error("[dlq] render unreachable", event.data.event.data);
    },
  },
  { event: "vai/render.requested" },
  async ({ event, step }) => {
    const renderId = (event.data as { render_id: string }).render_id;
    await step.run("provider-attempt", () => callWorker(renderId));
  },
);

// Nightly: quota hygiene + spend guard reset + storage lifecycle (see buckets.md).
export const nightly = inngest.createFunction(
  { id: "nightly-maintenance" },
  { cron: "0 3 * * *" }, // 03:00 UTC
  async ({ step }) => {
    await step.run("reset-spend-guard", () =>
      fetch(`${process.env.SUPABASE_URL}/functions/v1/render-tryon?process=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ render_id: "__cron_reset" }),
      }).catch(() => null));
  },
);
```

(`sign()` = hex HMAC-SHA256 of the raw body; verified in
`_shared/pipeline.ts → verifyInngestSignature()`.)

## Polling, retries, DLQ

- FASHN poll: 2s → 4s → 8s → cap 12s, **hard deadline 90s** (`pollToDone()`), then
  `failed`, **retry once on std** (provider cursor advances; Gemini already tried).
- Inngest step retries: **3×** with default exponential backoff. Attempt counter
  lives on the `renders` row (`attempts`), so edge restarts can't over-retry.
- DLQ = `status='failed'` + refunded allowance + `renderFailedPush` carrying
  `keep_best_url` (latest `done` render). Query the DLQ with:
  `select * from renders where status='failed' and created_at > now() - interval '24h'`.
- Failed/errored predictions = **0 credits**: ledger `render_cost` is written only
  on `done`, and `refund_render_allowance(pool)` runs on terminal failure.

## Daily quota reset

`render_quotas` is keyed `(user_id, day)` — daily counters reset by construction
(no cron needed for the reset itself). Monthly premium quota (30/mo) rolls in
`consume_render_allowance()` via `entitlements.period_month`. The nightly cron:
1. clears `app_config.render_guard.force_std` if spend cooled down,
2. runs the storage lifecycle sweeper (buckets.md),
3. pages on-call if DLQ rate > 5% of renders in 24h.

## Spend guard: MAX_DAILY_SPEND_USD (auto-downgrade)

- Source: `app_config.render_guard = {"max_daily_spend_usd": 25, "force_std": false}`.
- Before every Max attempt, `processRender()` sums today's `ledger.render_cost`
  COGS; if `spent + $0.38 > cap` (or `force_std`), the job is **clamped to std**
  (`meta.downgraded=true`) instead of failing — users get a render, margin is safe.
- Manual kill: set `force_std=true` to route ALL renders to std during incidents.
- Alert threshold: 80% of cap → log + push to on-call (wired in the nightly cron).

## Reel weekly drop crons

Drops are idempotent per (user,weekOf) and cards per sha256(user|weekOf|dayIndex):
re-running a scheduler for the same week returns the cached WeeklyDrop at 0
extra cost, so cron fan-out can be retry-happy. Cards reuse the pipeline above
(std tier, Gemini $0.067) — per-card `render_ready` pushes fire as each render
finishes; the Monday push below is the drop-level summary only.

```ts
export const reelScheduler = inngest.createFunction(
  { id: "reel-scheduler" },
  { cron: "0 2 * * 0" }, // Sundays 02:00 — set `timezone` per cohort for local
  async ({ step }) => {
    await step.run("generate-week-drops", async () => {
      // Fan out: for each active user, POST /functions/v1/reel-drop
      // { weekOf: <upcoming Monday YYYY-MM-DD> } with the service_role key.
      // Free → 3-card teaser (draws the 5-lifetime pool); premium → 7-card
      // full (draws the 30/mo pool). 402 = pool exhausted → skip + nudge upgrade.
    });
  },
);

export const reelWeekReady = inngest.createFunction(
  { id: "reel-week-ready" },
  { cron: "0 7 * * 1" }, // Mondays 07:00 local — "week ready" push
  async ({ step }) => {
    await step.run("push-week-ready", async () => {
      // pushToUser(sb, userId, { title: "Your week is styled",
      //   body: "Your looks are ready to review.",
      //   data: { kind: "week_ready", week_of: monday } });
      // Client deep link: vai://outfit/<monday>.
    });
  },
);
```

Conventions: reel renders store mode `tryon` + `garment_refs.meta`
`{ source: 'reel-drop', pose, week_of, day_index, trend_tag? }` (0003 decision —
no new renders mode). Pending cards read `imageUrl: ""` + `costUsd: 0.067`
estimate until `done` (then ledger-authoritative); poll
`GET /functions/v1/reel-drop?weekOf=…` (reel-week) or subscribe the `renders`
realtime feed.

## Pinterest nightly sync (0005)

Pulls each connected user's own boards/pins into `style_pins` (inspiration
only — never posts; `pinterest-share` is explicit-tap only and has NO cron).
Trial-tier design: the app-wide 1000 req/day budget is guarded in-code
(`app_config.pinterest_budget`, cap 800 — `checkPinBudget` fails the run
before it starts, `spendPinBudget` counts every call, mid-run exhaustion
returns `{ imported, skipped, truncated: true }` with partial results kept).
On Trial keep the nightly cohort SMALL (connected users ordered by oldest
sync first, cap ~10/night — a full sync costs 1 + boards + pins + detail
fetches per user); Standard tier can fan out wide (per-minute limits are
absorbed by 429 + Retry-After backoff). The `?sync=1` worker below mirrors
the `render-tryon?process=1` pattern: HMAC-verified, `{ user_id }` body, no
user JWT required.

```ts
export const pinterestNightlySync = inngest.createFunction(
  { id: "pinterest-nightly-sync" },
  { cron: "0 4 * * *" }, // 04:00 UTC — after the 03:00 maintenance cron
  async ({ step }) => {
    await step.run("sync-connected-users", async () => {
      // service_role client: select user_id from pinterest_accounts where
      // status = 'connected' order by least-recent style_pins.synced_at
      // (limit 10 on Trial; wider on Standard). SKIP users taste-built today
      // (taste_context.computed_at >= today 00:00 UTC — taste-build already
      // ran their incremental sync inline, same budget pool; double-sync
      // would burn Trial budget for zero new pins). Per user:
      // POST /functions/v1/pinterest-sync?sync=1 { user_id } with the
      // x-inngest-signature HMAC (verified in pinterest-sync via
      // verifyInngestSignature). Dismissed pins are skipped server-side;
      // failures are per-user (continue the cohort, alert on >20% failing).
    });
  },
);

## Taste autopilot nightly fan-out (0006)

Compiles each autopilot user's weekly `taste_context` row BEFORE the Sunday
02:00 reel gen reads it. Honors per-user cadence from `user_taste_prefs`:
daily users build nightly, weekly users build Sundays only, `off` /
disconnected users are never fanned out (taste-build re-checks both gates
server-side anyway — the cron filter is a budget optimization, not security).
Idempotent per (user,week): replays return the cached row at 0 cost, so the
fan-out can be retry-happy. Budget sharing: taste-build calls the
pinterest-sync `?sync=1` worker inline → same Trial 800/day pool
(`checkPinBudget`/`spendPinBudget`); the 04:00 generic sync skips
taste-built-today users (above), so no cohort ever double-spends.

```ts
export const tasteAutopilot = inngest.createFunction(
  { id: "taste-autopilot", concurrency: { limit: 10 } },
  { cron: "0 1 * * *" }, // 01:00 UTC nightly — before the 02:00 Sunday reel gen
  async ({ step }) => {
    await step.run("build-taste-contexts", async () => {
      // service_role client, batched (500/batch, ordered by user_id, cursor
      // pagination — see TASTE-ARCHITECTURE.md §scale for the 100k plan):
      // select p.user_id from user_taste_prefs p
      //   join pinterest_accounts a on a.user_id = p.user_id
      //   where p.sync_cadence != 'off' and a.status = 'connected'
      //   and (p.sync_cadence = 'daily'
      //        or (p.sync_cadence = 'weekly' and <today is Sunday UTC>))
      //   left join taste_context t on t.user_id = p.user_id
      //   (weekly users with t.week_of = <this Monday> already built → skip).
      // Per user: POST /functions/v1/taste-build?build=1 { user_id } with the
      // x-inngest-signature HMAC (verified in taste-build via
      // verifyInngestSignature — same worker pattern as ?sync=1/?process=1).
      // Failures are per-user (continue the cohort, alert on >20% failing —
      // taste-build itself is fail-soft: sync errors still compile context
      // from existing pins, so a failing user degrades to stale taste, never
      // a blocked drop).
    });
  },
);
```
```
