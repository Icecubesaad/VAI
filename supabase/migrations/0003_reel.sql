-- ============================================================================
-- VAI v1 — 0003 reel weekly drop (ADDITIVE ONLY; never edits 0001/0002)
-- Turf: backend. Contract (exact, shared by all crews — do not reshape):
--   ReelPose front|step|detail; WeeklyDrop teaser(3)/full(7);
--   POST reel-drop {weekOf Monday} idempotent per (user,weekOf);
--   POST reel-regenerate {cardId} via restyle core (1 credit);
--   GET reel-week {weekOf} → WeeklyDrop|null.
--
-- DECISION — renders.mode: REUSE `tryon` + `garment_refs.meta.source='reel-drop'`
-- (NOT a new 'reel' mode). Rationale: the pipeline provider chain, spend
-- guard, DLQ/refund, and push paths key off tier (std), and only the
-- compare-tiling branch keys off mode; a fourth mode would force a
-- PipelineMode widen + a re-audit of every `mode ===` branch for zero
-- behavior change. Reel renders stay queryable via
-- `garment_refs->meta->>'source' = 'reel-drop'` (+ pose/week_of/day_index in
-- the same meta). renders_mode_check is intentionally untouched.
--
-- Quota law (enforced in the edge fns via consume_render_allowance, unchanged
-- here): weekly cards consume the NORMAL std pool — free teaser draws the
-- 5-lifetime pool (ok_free), premium full draws the 30/mo pool (ok_monthly),
-- credit packs overflow (ok_std_credit); terminal failure refunds (0 cost).
--
-- Deploy order: `supabase db push` (this file) BEFORE deploying the reel-*
-- functions — they SELECT base_photos.pose + reel_drops.
-- ============================================================================

-- ------------------------------------------------- base_photos.pose -------
-- Nullable + additive: pre-0003 rows keep pose NULL and the reel read path
-- treats NULL as 'front' (no backfill, no user action needed).
alter table base_photos add column if not exists pose text
  check (pose is null or pose in ('front', 'step', 'detail'));

-- One active photo per user per pose (partial: inactive history + legacy
-- NULL-pose rows never collide).
create unique index if not exists base_photos_user_pose_unique
  on base_photos (user_id, pose)
  where is_active = true and pose is not null;

create index if not exists base_photos_user_active_pose_idx
  on base_photos (user_id, is_active, pose);

-- -------------------------------------------------------- reel_drops ------
-- Spec columns (user_id, week_of, tier, card_ids, created_at,
-- UNIQUE(user_id, week_of)) + additive id PK (edge/PostgREST convention, cf.
-- 0001 tables) + nullable trend_tag (drop-level mirror of the per-card
-- meta.trend_tag passthrough; the per-card meta stays the source of truth).
create table if not exists reel_drops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  week_of date not null,
  tier text not null check (tier in ('teaser', 'full')),
  card_ids uuid[] not null default '{}',
  trend_tag text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reel_drops_user_week_unique') then
    alter table reel_drops add constraint reel_drops_user_week_unique unique (user_id, week_of);
  end if;
end $$;

create index if not exists reel_drops_user_week_idx on reel_drops (user_id, week_of);

-- --------------------------------------------------------------- RLS ------
-- Owner-only (cf. 0001 outfits/renders). Edge fns use service_role (bypass);
-- Data API clients see owner rows only.
alter table reel_drops enable row level security;
drop policy if exists reel_drops_owner on reel_drops;
create policy reel_drops_owner on reel_drops for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------- Data API ------
-- EXPLICIT exposure (Apr-2026 behavior, cf. 0001 §Data API).
grant select, insert, update, delete on reel_drops to authenticated;
