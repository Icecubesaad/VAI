# TASTE-ARCHITECTURE.md — Pinterest invisible-autopilot (0006)

Thesis: Pinterest is a background compiler, not a UI. One cron builds ONE
`taste_context` row per user per week; planner + reel-drop read that row and
never touch Pinterest data. Clients expose only connect + cadence.

## Layers (ingest → extract → context-row → consume)

1. **Ingest** — `taste-build` calls the `pinterest-sync?sync=1` worker inline
   (same HMAC, same Trial 800/day pool — budget shared, never bypassed).
   0005 caps bound every run (10 board pages, 20 pin pages/board).
2. **Extract** — server port of `lib/ai/taste-seeds.ts` vocab tagger
   (`_shared/taste.ts`). Board/pin titles → `taste:*`/`fit:*` tags, max 8,
   deterministic, $0, no LLM. Only vocab phrases become tags — pin marketing
   fluff can never leak into prompts.
3. **Context-row** — upsert `taste_context(user_id PK, seed_tags, pose_ref_ids,
   style_note, computed_at, week_of)`. Idempotent per (user,week): replay
   returns cached, 0 cost.
4. **Consume** — `buildDayOutfit` auto-reads row + `style_influence`, adds
   `tasteBonus` (≤1.5 × influence/100 — taste biases WITHIN the owned closet,
   never outvotes season/formality, never conjures garments). `reel-drop`
   rotates `pose_ref_ids` across cards + mirrors `taste_tags` into render meta.

## Why one-row reads

The naive design fans out per render: 7 planner calls × pin scans + prompt
growth, every week, per user. Ours: 1 indexed PK select (~1ms, $0) on the
planner path + 1 on the drop path. Planner/drop never know Pinterest exists —
they read tags + ref ids. Pinterest latency, rate limits, and token expiry
are quarantined in the nightly build, never on the render critical path.

## Incremental cursors + dedup

Sync dedups on `UNIQUE(user_id, pin_id)` (0005) — re-runs only upsert
new/changed pins; dismissed rows are never rewritten. The builder's cursor is
implicit: `max(style_pins.synced_at)` per user; extraction reads a 90d window
(stability over novelty — taste shouldn't whiplash weekly), while `new_pins`
(newer than prev `computed_at`) is reported for observability. Eviction
compares refs against the FULL live-pin set (2000-row cursor), not the 200
extraction window, so rotation never drops refs for pins merely outside the
taste window.

## 12-ref cap + eviction

`pose_ref_ids` ≤ 12 enforced twice: builder logic + 0006 CHECK backstop.
Fill order: explicit `use_as_pose` pins → portrait-readable (height ≥ width,
pose transfers need a body to read) → recency. Eviction: refs pointing at
dismissed/deleted pins first (stale rotation), then oldest-created. Renders
hold `pose_ref_id SET NULL` (0005) — disconnect purges pin refs, renders and
drops keep working on `keep`.

## Cost per user / week (marginal)

| Item | Cost |
|---|---|
| taste-build compute (DB reads/writes, vocab tagger) | $0.00 |
| Pinterest API (~25 calls: ~5 boards + ~10 pin pages + ~10 detail fills) | $0 (Trial pool / Standard flat) |
| LLM calls in taste path | 0 ($0 — vocab, not Gemini) |
| Renders spent by the build itself | 0 (context only; renders still draw the 5-life/30-mo pools) |
| Planner/drop taste reads (2 PK selects) | $0.00 |
| **Total marginal / user / week** | **≈$0.00 + ~25 Pinterest calls** |

The build SHIFTS spend, not adds it: better-seeded drops fail less → fewer
regenerates (each $0.067 + 1 credit). Break-even is one avoided regen per
~infinite builds — the build is free, the saving is real.

## How it scales to 100k users

- **Batch windows**: fan-out paginates `user_taste_prefs ⋈ pinterest_accounts`
  500/batch, cursor-ordered, concurrency 10 (inngest.md). No thundering herd.
- **Budget pools**: Trial 800/day ⇒ autopilot users share ONE pool with sync;
  taste-built-today users are skipped by the 04:00 generic sync (no double
  spend). 100k weekly users × 25 calls ÷ 7 ≈ 357k calls/day ⇒ Trial impossible
  at scale — Standard tier required (org_read 1000/min = 1.44M/day headroom;
  429 + Retry-After backoff already in `pinApi`).
- **Cadence sharding**: daily users nightly, weekly users Sunday 01:00 UTC
  (before the 02:00 reel gen). Weekly cohort dominates → ~1/7 daily load.
- **Hot path is O(1)**: render-time cost is constant regardless of pins/user —
  the row absorbs all growth. 10M pins or 10 pins, planner does 1 select.
- **Retry-happy**: every stage idempotent (sync upsert, (user,week) row, reel
  per-card keys) → cron retries and overlapping runs cost 0.

## Failure modes (all degrade to stale taste, never a blocked drop)

- Token expired/revoked → sync 401 → build from existing pins, flip
  `pinterest_connected=false`, skip next run until reconnect.
- Budget exhausted → `truncated:true`, partial pins kept, context still built.
- Disconnect → 0005 purges pin refs; dangling `pose_ref_ids` fail OPEN to
  `keep` per card; next build cleans the row.
- Empty/no-signal pins → empty tags, planner untouched (`tasteBonus` = 0),
  `style_note` records the miss for observability.
- `pose_mode_default`: `keep` never adapts; `adapt` adapts iff any ref;
  `auto` adapts iff a <14d-fresh ref exists — fresh-sync failure auto-downgrades.
- Concurrent builds → same PK upsert, last-writer-wins, identical shape.

## Files

`migrations/0006_taste_autopilot.sql` · `functions/_shared/taste.ts`
(port + prefs + resolvers) · `functions/taste-build/index.ts` (writer) ·
`_shared/plan.ts` + `reel-drop/index.ts` (readers) · `inngest.md` (fan-out) ·
`secrets.md` (no new env). Manual pickers unchanged: 0005 API stays.
