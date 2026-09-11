-- ============================================================================
-- VAI v1 — 0006 taste autopilot (ADDITIVE ONLY; never edits 0001-0005)
-- Turf: backend.
--
-- Pinterest goes INVISIBLE-AUTOPILOT: no user-facing Pinterest UI except the
-- single connect moment + a cadence preference. `taste-build` (cron) fetches
-- on schedule and compiles ONE `taste_context` row per user; `plan-day`,
-- `plan-week` and `reel-drop` read that single row (never fan out to pins).
-- Manual pose/pin pickers stay as API capability (0005 style_pins/pose_refs
-- untouched); clients stop surfacing them.
--
-- Tables:
--   user_taste_prefs — per-user autopilot knobs. Client-editable (cadence
--     preference UI) → Data API exposed like style_pins/pose_refs (0005).
--     `pinterest_connected` mirrors pinterest_accounts and is maintained by
--     taste-build (client writes to it are overwritten — documented, not
--     enforced, to keep the single connect-moment call surface small).
--   taste_context — the weekly built context (ONE row per user, PK = user_id).
--     service_role writes ONLY (taste-build) → Data API SELECT-only, like
--     subscriptions/ledger (0001 system-table pattern). Planner/drop read it
--     server-side via service_role (RLS bypass) — a single indexed PK select.
-- Deploy order: `supabase db push` (this file) BEFORE deploying taste-build —
-- it SELECTs/UPSERTs these tables.
-- ============================================================================

-- ------------------------------------------------------- user_taste_prefs --
create table if not exists user_taste_prefs (
  user_id uuid primary key references users (id) on delete cascade,
  pinterest_connected bool not null default false,
  sync_cadence text not null default 'weekly'
    check (sync_cadence in ('daily', 'weekly', 'off')),
  pose_mode_default text not null default 'auto'
    check (pose_mode_default in ('keep', 'adapt', 'auto')),
  style_influence int not null default 60
    check (style_influence between 0 and 100),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_taste_prefs_updated_at on user_taste_prefs;
create trigger user_taste_prefs_updated_at before update on user_taste_prefs
  for each row execute function set_updated_at();

alter table user_taste_prefs enable row level security;
drop policy if exists user_taste_prefs_owner on user_taste_prefs;
create policy user_taste_prefs_owner on user_taste_prefs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------- taste_context --
-- One row per user: the weekly built context the planner/drop reads in ONE
-- row. seed_tags ≤ 8 vocab tags (taste:/fit:, cf. _shared/taste.ts);
-- pose_ref_ids ≤ 12 pose_refs ids (cap enforced here AND in taste-build —
-- the CHECK is the backstop, the builder does the rotation/eviction);
-- week_of = Monday YYYY-MM-DD this context was built for.
create table if not exists taste_context (
  user_id uuid primary key references users (id) on delete cascade,
  seed_tags text[] not null default '{}',
  pose_ref_ids uuid[] not null default '{}',
  style_note text,
  computed_at timestamptz not null default now(),
  week_of text not null default ''
    check (week_of = '' or week_of ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  check (array_length(pose_ref_ids, 1) is null or array_length(pose_ref_ids, 1) <= 12)
);

alter table taste_context enable row level security;
drop policy if exists taste_context_read_own on taste_context;
create policy taste_context_read_own on taste_context for select to authenticated
  using (auth.uid() = user_id);
-- No insert/update/delete policies: writes are service_role-only (taste-build).
-- Data API clients see owner rows read-only.

-- ---------------------------------------------------------- Data API ------
-- EXPLICIT exposure (Apr-2026 behavior, cf. 0001 §Data API + 0003 + 0005).
-- taste_context is DELIBERATELY select-only (autopilot is invisible; the
-- client edits cadence via user_taste_prefs only). pinterest_accounts stays
-- unexposed (0005, unchanged).
grant select, insert, update, delete on user_taste_prefs to authenticated;
grant select on taste_context to authenticated;
