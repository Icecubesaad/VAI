-- ============================================================================
-- VAI v1 — 0005 pinterest inspiration (ADDITIVE ONLY; never edits 0001-0004)
-- Turf: backend.
--
-- Pinterest v5 facts (verified Sep 2026 — do not reshape without re-verify):
--   OAuth2 token endpoint api.pinterest.com/v5/oauth/token; scopes
--   boards:read (+:secret variant) pins:read (+:secret) user_accounts:read
--   pins:write; endpoints /v5/user_account /v5/boards?page_size
--   /v5/boards/{id} /v5/boards/{id}/pins /v5/pins/{pin_id} (image originals).
--   NO public search/trending endpoint — inspiration comes ONLY from the
--   user's own boards/pins. Trial 1000 req/day; Standard org_read 1000/min +
--   org_write 300/100 with 429+headers; Trial apps see sandbox-only data
--   (fine for dev); Standard needs video-demo review.
--   Pinterest rules honored: explicit per-action consent for writes
--   (pins:write requested only on user opt-in; pinterest-share is
--   explicit-tap only, never called by any cron/queue), 13+ only (gated by
--   the 0002 age gate — Pinterest onboarding is blocked for u13 server-side
--   in pinterest-auth).
--
-- Tables:
--   pinterest_accounts — OAuth tokens, ENCRYPTED (AES-GCM, PINTEREST_TOKEN_KEY).
--     NO Data API exposure: RLS on + owner policies defined but ZERO grants
--     to anon/authenticated (cf. 0001 app_config) → service_role only. Edge
--     fns decrypt server-side; tokens never leave the edge.
--   style_pins — synced copies of the user's own pins (style/pose inspiration).
--     Owner RLS + explicit grants (like 0001 garments). dismissed rows are
--     never overwritten by re-sync (sync skips them).
--   pose_refs — one pose reference = EXACTLY ONE of (pin_id | base_photo_id).
--     Pin-sourced rows are purged on disconnect; base-photo rows survive.
-- Renders: pose_mode ('keep'|'adapt', default 'keep') + pose_ref_id (nullable
--   FK → pose_refs, on delete set null — disconnect keeps renders working).
--
-- Deploy order: `supabase db push` (this file) BEFORE deploying the
-- pinterest-* functions — they SELECT these tables.
-- ============================================================================

-- ------------------------------------------------- pinterest_accounts ---
-- One row per user (PK = user_id). Tokens are ciphertext (see
-- functions/_shared/pinterest.ts encryptToken); plaintext never stored.
create table if not exists pinterest_accounts (
  user_id uuid primary key references users (id) on delete cascade,
  pinterest_user_id text,
  username text,
  scopes text[] not null default '{}',
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  secret_ok bool not null default false,
  status text not null default 'connected'
    check (status in ('connected', 'expired', 'revoked', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists pinterest_accounts_updated_at on pinterest_accounts;
create trigger pinterest_accounts_updated_at before update on pinterest_accounts
  for each row execute function set_updated_at();

alter table pinterest_accounts enable row level security;
-- Defense-in-depth owner policies (deny-by-default still holds: NO grants
-- below, so Data API roles cannot read/write regardless of policy).
drop policy if exists pinterest_accounts_owner on pinterest_accounts;
create policy pinterest_accounts_owner on pinterest_accounts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Explicit non-exposure (Apr-2026 behavior, cf. 0001 §Data API + app_config):
-- NO GRANTs to anon/authenticated. service_role bypasses RLS.
revoke all on pinterest_accounts from anon, authenticated;

-- ---------------------------------------------------------- style_pins --
-- Synced copies of the user's OWN pins. UNIQUE(user_id, pin_id) is the sync
-- key (upsert target). dismissed = user hid it → sync skips, never unhides.
create table if not exists style_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  pin_id text not null,
  board_id text,
  board_name text,
  image_url text,
  title text,
  description text,
  link text,
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  use_as_pose bool not null default false,
  use_as_style bool not null default true,
  dismissed bool not null default false,
  synced_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'style_pins_user_pin_unique') then
    alter table style_pins add constraint style_pins_user_pin_unique unique (user_id, pin_id);
  end if;
end $$;

create index if not exists style_pins_user_idx on style_pins (user_id);
create index if not exists style_pins_user_board_idx on style_pins (user_id, board_id);
create index if not exists style_pins_user_live_idx on style_pins (user_id, synced_at desc)
  where dismissed = false;

alter table style_pins enable row level security;
drop policy if exists style_pins_owner on style_pins;
create policy style_pins_owner on style_pins for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------- pose_refs --
-- Exactly one source per row: a Pinterest pin (pin_id = Pinterest pin id,
-- text — NOT an FK, pins live at Pinterest) or a VAI base photo.
create table if not exists pose_refs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  pin_id text,
  base_photo_id uuid references base_photos (id) on delete set null,
  label text,
  created_at timestamptz not null default now(),
  constraint pose_refs_exactly_one_source check (num_nonnulls(pin_id, base_photo_id) = 1)
);

create index if not exists pose_refs_user_idx on pose_refs (user_id);

alter table pose_refs enable row level security;
drop policy if exists pose_refs_owner on pose_refs;
create policy pose_refs_owner on pose_refs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------- renders --
-- pose_mode: 'keep' (default — base photo pose untouched, pipeline prompt
-- unchanged) | 'adapt' (pose guided by the pose_ref image; contract in
-- functions/render-tryon/index.ts header — AI crew owns prompt consumption).
alter table renders add column if not exists pose_mode text
  not null default 'keep' check (pose_mode in ('keep', 'adapt'));
-- Nullable FK, SET NULL on delete: disconnect purges pin-sourced pose_refs
-- but renders keep working (pose falls back to 'keep').
alter table renders add column if not exists pose_ref_id uuid
  references pose_refs (id) on delete set null;
create index if not exists renders_pose_ref_idx on renders (pose_ref_id)
  where pose_ref_id is not null;

-- ---------------------------------------------------------- Data API ----
-- EXPLICIT exposure (Apr-2026 behavior, cf. 0001 §Data API + 0003).
-- pinterest_accounts is DELIBERATELY ABSENT (service_role only — tokens).
grant select, insert, update, delete on style_pins, pose_refs to authenticated;
