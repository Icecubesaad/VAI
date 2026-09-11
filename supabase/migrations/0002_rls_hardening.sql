-- ============================================================================
-- VAI v1 — 0002 RLS + compliance hardening (ADDITIVE ONLY; never edits 0001)
-- Author: security & compliance crew. Each block cites the 0001/app finding it
-- closes (SEC-### → docs/SECURITY.md). All statements are re-runnable:
--   guards use IF NOT EXISTS / DROP IF EXISTS, inserts use ON CONFLICT DO NOTHING.
-- ============================================================================

-- ------------------------------------------------- SEC-007: users ----------
-- 0001 grants authenticated UPDATE on ALL users columns (0001:489) behind the
-- owner-wide users_self policy (0001:426). That lets a user rewrite their own
-- referral_code / referred_by / trial_ends_at (self-granted referral + trial
-- display manipulation). Narrow to server-owned vs user-editable columns.
-- Edge Functions use service_role (bypasses grants) — unaffected.
revoke update on users from authenticated;
grant update (email, name, avatar_url, country) on users to authenticated;

-- --------------------------------- SEC-005/012: row timestamps ------------
-- base_photos has no created_at (0001:86-94) yet pipeline.ts:249-254 orders by
-- it → implicit-base renders error out. garments has none either, which makes
-- the 90d/12mo retention sweeps (docs/SECURITY.md §retention) unenforceable.
alter table base_photos add column if not exists created_at timestamptz
  not null default now();
alter table garments add column if not exists created_at timestamptz
  not null default now();
create index if not exists base_photos_user_active_idx
  on base_photos (user_id, is_active);

-- --------------------------------------- SEC-006: age-gate columns ---------
-- Nullable + additive. The onboarding age gate (P0, app crew) persists here:
--   birth_year      — self-declared at signup, immutable after verify
--   age_band        — 'u13' | 'p13_17' | 'adult' (server-computed, server-only)
--   parental_consent_at / age_verified_at — audit timestamps for 13–17 gate
alter table users add column if not exists birth_year smallint
  check (birth_year is null or (birth_year between 1900 and 2100));
alter table users add column if not exists age_band text
  check (age_band is null or age_band in ('u13', 'p13_17', 'adult'));
alter table users add column if not exists parental_consent_at timestamptz;
alter table users add column if not exists age_verified_at timestamptz;
-- age_band + consent timestamps stay server-owned (excluded from the §SEC-007
-- column grant above, so Data API clients cannot self-certify as adult).

-- --------------------------------- SEC-001/002: deletion queue ------------
-- Self-service deletion queue for the DELETE /functions/v1/account + /photos
-- endpoints (spec: docs/SECURITY.md §deletion). Server worker (service_role)
-- does the Storage purge + 30-day DB purge; the app only inserts/reads.
create table if not exists deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('photos', 'account')),
  status text not null default 'requested'
    check (status in ('requested', 'storage_purged', 'db_purged')),
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '30 days'),
  processed_at timestamptz
);
alter table deletion_requests enable row level security;
drop policy if exists deletion_requests_read_own on deletion_requests;
create policy deletion_requests_read_own on deletion_requests for select
  to authenticated using (auth.uid() = user_id);
drop policy if exists deletion_requests_insert_own on deletion_requests;
create policy deletion_requests_insert_own on deletion_requests for insert
  to authenticated with check (auth.uid() = user_id);
-- No update/delete policies: status transitions are service_role-only.
grant select, insert on deletion_requests to authenticated;

-- --------------------------------- SEC-013: storage update check ----------
-- garments_owner_update (0001:545) has USING but no WITH CHECK: a crafted
-- UPDATE could move another user's object path. Re-issue with both clauses.
drop policy if exists garments_owner_update on storage.objects;
create policy garments_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);

-- Renders are pipeline-written (service_role); give owners an explicit
-- update-own (metadata corrections) instead of silent denial.
drop policy if exists renders_owner_update on storage.objects;
create policy renders_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'renders' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'renders' and auth.uid()::text = (storage.foldername(name))[1]);

-- NOTE (SEC-004, no DDL): the app constant BUCKETS.basePhotos = 'base-photos'
-- (lib/supabase.ts:30) matches NO bucket — canonical private bucket is 'base'
-- (0001:518-531). Do NOT create a 'base-photos' bucket; the frontend crew must
-- point at 'base' and use signed URLs (spec: docs/SECURITY.md §P0-004).

-- --------------------------------- SEC-009: atomic restyle bump -----------
-- quota.ts bumpRestyleDaily() is read-modify-write → concurrent restyles can
-- double-spend the 1/day free slot. Atomic single-statement upsert; backend
-- crew wires checkFreeRestyleDaily/bumpRestyleDaily to call it instead.
create or replace function bump_restyle_daily(p_user uuid, p_day date)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_restyles int;
begin
  insert into render_quotas (user_id, day, restyles)
  values (p_user, p_day, 1)
  on conflict (user_id, day) do update
    set restyles = render_quotas.restyles + 1;
  select restyles into v_restyles from render_quotas
   where user_id = p_user and day = p_day;
  return v_restyles;
end $$;
revoke all on function bump_restyle_daily(uuid, date) from public, anon, authenticated;
grant execute on function bump_restyle_daily(uuid, date) to service_role;
