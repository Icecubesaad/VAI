-- ============================================================================
-- VAI v1 — full backend schema (Supabase Postgres 15+)
-- Sources: README.md (stack, verified Sep 2026) + VAI-BUILD-PACK.md §3 (DDL),
--          §4 (edge functions) + §5 (FASHN rules). Iron laws enforced here and
--          in supabase/functions/_shared/quota.ts + consume_render_allowance().
--
--   Free    = 50 closet items · 1 outfit/day · 5 LIFETIME renders, then hard block
--   Premium = 30 renders/mo (never "unlimited")
--   HD/Max  = credit packs ONLY, never inside the subscription
--   Restyle = always costs 1 credit
--
-- NOTE — Supabase Apr-2026 change: new tables are NOT auto-exposed to the Data
-- API. Exposure below is EXPLICIT (GRANTs to `authenticated`, §"Data API").
-- Dashboard cross-check: Project Settings → Data API → Exposed schemas/tables
-- must list every table granted below.
-- ============================================================================

-- Extensions (build pack calls it "pgvector"; the Postgres extension is "vector")
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------- enums ----
create type garment_cat as enum
  ('top','bottom','dress','outerwear','shoes','bag','accessory','onepiece','active');
create type season as enum ('ss','fw','all');
create type sub_status as enum ('trialing','active','past_due','canceled','expired');
create type render_status as enum ('queued','processing','done','failed');
create type ledger_type as enum ('sub','affiliate_cashback','referral_credit','render_cost');

-- ---------------------------------------------------------------- core -----
create table users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  avatar_url text,
  country text,
  referral_code text unique,
  referred_by uuid references users (id) on delete set null,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table style_profiles (
  user_id uuid primary key references users (id) on delete cascade,
  everyday_style text,
  palette text,
  dress_code text,
  boldness int check (boldness between 1 and 5),
  budget_band text,
  body_shape text,
  fit_prefs jsonb not null default '{}'::jsonb,
  undertone text,
  color_season text,
  style_dna vector(64),
  style_labels jsonb not null default '[]'::jsonb,
  quiz_version int not null default 1
);

create table garments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  image_url text,
  cutout_url text,
  category garment_cat,
  subcat text,
  colors text[] not null default '{}',
  fabric text,
  formality int check (formality between 1 and 5),
  seasons season[] not null default '{all}',
  brand text,
  price_paid numeric,
  wear_count int not null default 0,
  cost_per_wear numeric generated always as (
    case when wear_count > 0 then price_paid / wear_count else price_paid end
  ) stored,
  embedding vector(512),
  source text check (source in ('camera','bulk','receipt','shop')),
  deleted_at timestamptz
);
create index garments_user_cat_idx on garments (user_id, category)
  where deleted_at is null;
create index garments_embedding_hnsw on garments
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

create table base_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  url text not null,
  pose_meta jsonb not null default '{}'::jsonb,
  fashn_cache_key text,
  is_active bool not null default true,
  consent_social bool not null default false
);

create table outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  date date,
  garment_ids uuid[] not null default '{}',
  wishlist_ids uuid[] not null default '{}',
  context jsonb not null default '{}'::jsonb,
  why_line text,
  source text,
  score numeric
);
create index outfits_user_date_idx on outfits (user_id, date);

create table renders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  outfit_id uuid references outfits (id) on delete set null,
  base_photo_id uuid references base_photos (id) on delete set null,
  -- v1 addition: restyle chain (nullable; spec §4 `restyle` max 3/session)
  parent_render_id uuid references renders (id) on delete set null,
  garment_refs jsonb not null default '{}'::jsonb,
  mode text check (mode in ('tryon','restyle','compare')),
  tier text check (tier in ('std','max')),
  -- provider that produced the final image (README: gemini primary, fashn fallback)
  provider text not null default 'gemini-flash',
  fashn_id text,
  status render_status not null default 'queued',
  attempts int not null default 0 check (attempts >= 0),
  output_url text,
  error text,
  credits int not null default 1,
  -- §5: sha256(user|base|outfit|day[|mode|tier]); identical re-request = cached URL, 0 cost
  idempotency_key text unique not null default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index renders_user_created_idx on renders (user_id, created_at desc);
create index renders_idem_idx on renders (idempotency_key);
alter table renders replica identity full; -- realtime payloads on status flips

create table wishlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  retailer text,
  product_id text,
  title text,
  image_url text,
  price numeric,
  target_price numeric,
  affiliate_url text,
  notified bool not null default false
);

-- Social tables ship in v1 schema (v2 feed reads them); writes stay owner-only.
create table posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  outfit_id uuid references outfits (id) on delete set null,
  render_id uuid references renders (id) on delete set null,
  image_url text,
  caption text,
  tags text[] not null default '{}',
  product_links jsonb not null default '[]'::jsonb,
  likes int not null default 0,
  saves int not null default 0,
  moderated bool not null default false,
  created_at timestamptz not null default now()
);
create table post_likes (
  post_id uuid not null references posts (id) on delete cascade,
  voter_id uuid not null references users (id) on delete cascade,
  primary key (post_id, voter_id)
);
create table post_saves (
  post_id uuid not null references posts (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (post_id, user_id)
);

create table style_scores (
  user_id uuid not null references users (id) on delete cascade,
  date date not null,
  total int,
  fit int,
  color int,
  vers int,
  occasion int,
  percentile numeric,
  primary key (user_id, date)
);

create table coach_plans (
  user_id uuid not null references users (id) on delete cascade,
  day int not null check (day between 1 and 7),
  task text,
  feedback jsonb not null default '{}'::jsonb,
  done bool not null default false,
  primary key (user_id, day)
);

create table subscriptions (
  user_id uuid primary key references users (id) on delete cascade,
  platform text check (platform in ('ios','android','stripe','referral')),
  product_id text,
  status sub_status,
  trial_ends_at timestamptz,
  renews_at timestamptz,
  receipt jsonb not null default '{}'::jsonb
);

create table referrals (
  code text not null,
  inviter_id uuid not null references users (id) on delete cascade,
  invitee_id uuid not null unique references users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','credited')),
  created_at timestamptz not null default now()
);
create index referrals_code_idx on referrals (code);

create table ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  type ledger_type not null,
  amount_cents int not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ledger_user_created_idx on ledger (user_id, created_at desc);

create table push_tokens (
  user_id uuid not null references users (id) on delete cascade,
  expo_token text unique not null,
  primary key (user_id, expo_token)
);

create table render_quotas (
  user_id uuid not null references users (id) on delete cascade,
  day date not null default current_date,
  tryons int not null default 0 check (tryons >= 0),
  restyles int not null default 0 check (restyles >= 0),
  primary key (user_id, day)
);

-- ------------------------------------------------- v1 additions ----------
-- Materialized allowance counters. `ledger` stays the source of truth; this
-- table makes quota checks race-safe (row lock inside consume RPC) and fast.
-- Without it, free-5-LIFETIME and premium-30/mo cannot be enforced.
create table entitlements (
  user_id uuid primary key references users (id) on delete cascade,
  free_lifetime_used int not null default 0 check (free_lifetime_used >= 0),
  period_month date not null default (date_trunc('month', now())::date),
  period_renders_used int not null default 0 check (period_renders_used >= 0),
  std_credits int not null default 0 check (std_credits >= 0),
  hd_credits int not null default 0 check (hd_credits >= 0),
  updated_at timestamptz not null default now()
);

-- Global kill-switches / guards (spend auto-downgrade, v2 flags). service_role only.
create table app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into app_config (key, value) values
  ('render_guard', '{"max_daily_spend_usd": 25, "force_std": false}'::jsonb),
  ('flags', '{"week_plan_enabled": false}'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------- triggers --
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger users_updated_at before update on users
  for each row execute function set_updated_at();
create trigger renders_updated_at before update on renders
  for each row execute function set_updated_at();
create trigger entitlements_updated_at before update on entitlements
  for each row execute function set_updated_at();
create trigger app_config_updated_at before update on app_config
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------ RPCs --
-- Spec §3 RPC (kept verbatim, hardened: owner-only via RLS-safe definer + grant)
create or replace function increment_wear(ids uuid[])
returns void language sql security definer set search_path = public as $$
  update garments set wear_count = wear_count + 1
  where id = any (ids) and user_id = auth.uid() and deleted_at is null;
$$;

-- Atomic allowance consumption. Returns a pool code; NEVER raises for quota
-- outcomes (callers map codes to HTTP 402). Only `done` renders consume —
-- callers must call refund_render_allowance() on terminal failure.
--   ok_free | ok_monthly | ok_std_credit | ok_hd_credit
--   free_exhausted | monthly_exhausted | hd_requires_pack
create or replace function consume_render_allowance(p_user uuid, p_kind text, p_credits int default 1)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_is_premium boolean := false;
  v_month date := (date_trunc('month', now()))::date;
  v_free int; v_used int; v_pmonth date; v_std int; v_hd int;
begin
  if p_kind not in ('std', 'max') then
    raise exception 'bad kind %', p_kind;
  end if;

  insert into entitlements (user_id) values (p_user)
  on conflict (user_id) do nothing;

  select free_lifetime_used, period_renders_used, period_month, std_credits, hd_credits
    into v_free, v_used, v_pmonth, v_std, v_hd
    from entitlements where user_id = p_user for update;

  if v_pmonth is distinct from v_month then
    update entitlements
       set period_month = v_month, period_renders_used = 0, updated_at = now()
     where user_id = p_user;
    v_used := 0;
  end if;

  select exists (
    select 1 from subscriptions s
     where s.user_id = p_user
       and s.status in ('trialing', 'active')
       and (s.trial_ends_at > now() or s.renews_at > now())
  ) into v_is_premium;

  -- HD/Max: consumable packs only. Subscription quota can NEVER pay for Max.
  if p_kind = 'max' then
    if v_hd >= p_credits then
      update entitlements
         set hd_credits = hd_credits - p_credits, updated_at = now()
       where user_id = p_user;
      return 'ok_hd_credit';
    end if;
    return 'hd_requires_pack';
  end if;

  -- std: subscription/free pool first, credit packs as overflow (both tiers)
  if not v_is_premium then
    if v_free < 5 then
      update entitlements
         set free_lifetime_used = free_lifetime_used + p_credits, updated_at = now()
       where user_id = p_user;
      return 'ok_free';
    end if;
  else
    if v_used < 30 then
      update entitlements
         set period_renders_used = period_renders_used + p_credits, updated_at = now()
       where user_id = p_user;
      return 'ok_monthly';
    end if;
  end if;

  if v_std >= p_credits then
    update entitlements
       set std_credits = std_credits - p_credits, updated_at = now()
     where user_id = p_user;
    return 'ok_std_credit';
  end if;

  if not v_is_premium then return 'free_exhausted'; end if;
  return 'monthly_exhausted';
end $$;

-- Reverse a consume (terminal render failure, DLQ). Pool must match the consume code.
create or replace function refund_render_allowance(p_user uuid, p_pool text, p_credits int default 1)
returns void language plpgsql security definer set search_path = public as $$
begin
  update entitlements set
    free_lifetime_used = case when p_pool = 'ok_free'
      then greatest(0, free_lifetime_used - p_credits) else free_lifetime_used end,
    period_renders_used = case when p_pool = 'ok_monthly'
      then greatest(0, period_renders_used - p_credits) else period_renders_used end,
    std_credits = case when p_pool = 'ok_std_credit'
      then std_credits + p_credits else std_credits end,
    hd_credits = case when p_pool = 'ok_hd_credit'
      then hd_credits + p_credits else hd_credits end,
    updated_at = now()
  where user_id = p_user;
end $$;

-- Referral reward: extend premium by N months (preserves existing time).
create or replace function extend_subscription(p_user uuid, p_months int default 1)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_base timestamptz;
  v_new timestamptz;
begin
  select greatest(coalesce(renews_at, now()), now()) into v_base
    from subscriptions where user_id = p_user;
  if v_base is null then v_base := now(); end if;
  v_new := v_base + (p_months || ' months')::interval;
  insert into subscriptions (user_id, platform, product_id, status, renews_at)
  values (p_user, 'referral', 'referral_1mo', 'active', v_new)
  on conflict (user_id) do update set
    status = 'active', renews_at = v_new,
    platform = excluded.platform, product_id = excluded.product_id;
  return v_new;
end $$;

-- ============================================================ RLS ========
-- Owner-only everywhere: auth.uid() = user_id (or id / voter_id as applicable).
-- Edge Functions use service_role and bypass RLS; the Data API never does.

alter table users enable row level security;
alter table style_profiles enable row level security;
alter table garments enable row level security;
alter table base_photos enable row level security;
alter table outfits enable row level security;
alter table renders enable row level security;
alter table wishlist enable row level security;
alter table posts enable row level security;
alter table post_likes enable row level security;
alter table post_saves enable row level security;
alter table style_scores enable row level security;
alter table coach_plans enable row level security;
alter table subscriptions enable row level security;
alter table referrals enable row level security;
alter table ledger enable row level security;
alter table push_tokens enable row level security;
alter table render_quotas enable row level security;
alter table entitlements enable row level security;
alter table app_config enable row level security;
-- (app_config: RLS on, no user policies → authenticated/anon denied, service_role only)

create policy users_self on users for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create policy style_profiles_owner on style_profiles for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy garments_owner on garments for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy base_photos_owner on base_photos for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy outfits_owner on outfits for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy renders_owner on renders for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy wishlist_owner on wishlist for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy posts_owner on posts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy post_likes_read on post_likes for select to authenticated
  using (auth.uid() = voter_id
     or exists (select 1 from posts p where p.id = post_likes.post_id and p.user_id = auth.uid()));
create policy post_likes_write on post_likes for insert to authenticated
  with check (auth.uid() = voter_id);
create policy post_likes_delete on post_likes for delete to authenticated
  using (auth.uid() = voter_id);

create policy post_saves_owner on post_saves for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy style_scores_owner on style_scores for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy coach_plans_owner on coach_plans for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- System tables: user can READ own rows; all writes go through Edge Functions
-- (service_role). No insert/update/delete policies = denied for Data API roles.
create policy subscriptions_read_own on subscriptions for select to authenticated
  using (auth.uid() = user_id);
create policy referrals_read_own on referrals for select to authenticated
  using (auth.uid() = inviter_id or auth.uid() = invitee_id);
create policy ledger_read_own on ledger for select to authenticated
  using (auth.uid() = user_id);
create policy render_quotas_read_own on render_quotas for select to authenticated
  using (auth.uid() = user_id);
create policy entitlements_read_own on entitlements for select to authenticated
  using (auth.uid() = user_id);

create policy push_tokens_owner on push_tokens for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ==================================================== Data API ===========
-- EXPLICIT exposure (Apr-2026 behavior: nothing is exposed unless granted here).
-- anon gets NOTHING (app requires auth; public images are served by Storage,
-- not PostgREST). System tables are SELECT-only for users.
grant usage on schema public to authenticated;

grant select, insert, update on users to authenticated;
grant select, insert, update, delete
  on style_profiles, garments, base_photos, outfits, renders,
     wishlist, posts, post_saves, style_scores, coach_plans, push_tokens
  to authenticated;
grant select, insert, delete on post_likes to authenticated;
grant select on subscriptions, referrals, ledger, render_quotas, entitlements
  to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant execute on function increment_wear(uuid[]) to authenticated;
grant execute on function consume_render_allowance(uuid, text, int) to service_role;
grant execute on function refund_render_allowance(uuid, text, int) to service_role;
grant execute on function extend_subscription(uuid, int) to service_role;

-- Realtime for the render queue (client subscribes to its own rows; RLS applies).
-- Guarded so `supabase db reset` on a bare Postgres 15 still works.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table renders;
    alter publication supabase_realtime add table outfits;
  end if;
end $$;

-- ==================================================== Storage ============
-- Buckets: raw + base PRIVATE (biometric-adjacent) · garments + renders PUBLIC
-- (watermarked outputs, shareable). Path convention: <user_id>/<file>.
-- Full policy reference: supabase/buckets.md.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('raw',      'raw',      false, 15728640,
    array['image/jpeg','image/png','image/webp','image/heic','image/heif']),
  ('base',     'base',     false, 15728640,
    array['image/jpeg','image/png','image/webp','image/heic','image/heif']),
  ('garments', 'garments', true,  10485760,
    array['image/jpeg','image/png','image/webp']),
  ('renders',  'renders',  true,  10485760,
    array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Private buckets: owner RW only (service_role bypasses for the pipeline).
create policy raw_owner_rw on storage.objects for all to authenticated
  using (bucket_id = 'raw' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'raw' and auth.uid()::text = (storage.foldername(name))[1]);

create policy base_owner_rw on storage.objects for all to authenticated
  using (bucket_id = 'base' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'base' and auth.uid()::text = (storage.foldername(name))[1]);

-- Public buckets: owner writes, world reads.
create policy garments_owner_write on storage.objects for insert to authenticated
  with check (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'garments');

-- Renders are written by the pipeline (service_role); users read/update-own.
create policy renders_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'renders');
create policy renders_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'renders' and auth.uid()::text = (storage.foldername(name))[1]);
