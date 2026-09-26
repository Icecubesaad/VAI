-- Modal QA is limited to one request per approved user and three requests per UTC day.
create table public.qa_modal_user_usage (
  user_id uuid not null references public.users (id) on delete cascade,
  usage_day date not null,
  requests int not null default 0 check (requests >= 0),
  primary key (user_id, usage_day)
);

create table public.qa_modal_global_usage (
  usage_day date primary key,
  requests int not null default 0 check (requests >= 0)
);

create table public.qa_modal_request_reservations (
  user_id uuid not null references public.users (id) on delete cascade,
  usage_day date not null,
  request_key text not null check (request_key ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('reserved', 'released', 'claimed')),
  claimed_render_id uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, usage_day, request_key),
  check (
    (state = 'claimed' and claimed_render_id is not null and claimed_at is not null)
    or (state <> 'claimed' and claimed_render_id is null and claimed_at is null)
  )
);

create unique index ledger_modal_qa_render_cost_once_idx
  on public.ledger ((meta ->> 'render_id'))
  where type = 'render_cost'
    and meta ->> 'provider' = 'qwen-image-edit-2511-modal-qa';

create index qa_modal_request_reservations_day_idx
  on public.qa_modal_request_reservations (usage_day);
create unique index qa_modal_request_reservations_render_idx
  on public.qa_modal_request_reservations (claimed_render_id)
  where claimed_render_id is not null;

alter table public.qa_modal_user_usage enable row level security;
alter table public.qa_modal_global_usage enable row level security;
alter table public.qa_modal_request_reservations enable row level security;
revoke all on public.qa_modal_user_usage, public.qa_modal_global_usage,
  public.qa_modal_request_reservations from anon, authenticated;
grant all on public.qa_modal_user_usage, public.qa_modal_global_usage,
  public.qa_modal_request_reservations to service_role;

-- Render state drives provider selection, quota refunds, and cost accounting.
revoke insert, update, delete on public.renders from anon, authenticated;
grant select on public.renders to authenticated;
grant select, insert, update, delete on public.renders to service_role;

create or replace function public.consume_qa_modal_slot(
  p_user_id uuid,
  p_day date,
  p_request_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_user_requests int;
  v_global_requests int;
begin
  if p_user_id is null or p_day is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' then
    raise exception 'qa_modal_request_invalid';
  end if;

  delete from public.qa_modal_request_reservations as reservation
    where reservation.usage_day < p_day - 30
      and not (
        reservation.state = 'claimed'
        and exists (
          select 1 from public.renders as render
            where render.id = reservation.claimed_render_id
              and render.user_id = reservation.user_id
              and render.status in ('queued', 'processing')
        )
      );
  delete from qa_modal_user_usage where usage_day < p_day - 30;
  delete from qa_modal_global_usage where usage_day < p_day - 30;

  insert into qa_modal_request_reservations (user_id, usage_day, request_key, state)
  values (p_user_id, p_day, p_request_key, 'reserved')
  on conflict (user_id, usage_day, request_key) do nothing;

  if not found then
    select state into v_reservation_state
      from qa_modal_request_reservations
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
      for update;

    if v_reservation_state = 'reserved' then
      return true;
    end if;

    if v_reservation_state is distinct from 'released' then
      return false;
    end if;

    update qa_modal_request_reservations
      set state = 'reserved', claimed_render_id = null, claimed_at = null
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key;
  end if;

  insert into qa_modal_user_usage (user_id, usage_day, requests)
  values (p_user_id, p_day, 1)
  on conflict (user_id, usage_day) do update
    set requests = qa_modal_user_usage.requests + 1
    where qa_modal_user_usage.requests < 1
  returning requests into v_user_requests;

  if v_user_requests is null then
    update qa_modal_request_reservations
      set state = 'released'
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key;
    return false;
  end if;

  insert into qa_modal_global_usage (usage_day, requests)
  values (p_day, 1)
  on conflict (usage_day) do update
    set requests = qa_modal_global_usage.requests + 1
    where qa_modal_global_usage.requests < 3
  returning requests into v_global_requests;

  if v_global_requests is null then
    update qa_modal_user_usage
      set requests = greatest(requests - 1, 0)
      where user_id = p_user_id and usage_day = p_day;
    update qa_modal_request_reservations
      set state = 'released'
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key;
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.release_qa_modal_slot(
  p_user_id uuid,
  p_day date,
  p_request_key text,
  p_render_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_released boolean;
begin
  if p_user_id is null or p_day is null or p_request_key is null or p_render_id is null then
    raise exception 'qa_modal_request_invalid';
  end if;

  select state into v_reservation_state
    from qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;
  if v_reservation_state is distinct from 'reserved' then
    return false;
  end if;

  perform 1 from public.renders as r
    where r.id = p_render_id
      and r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.status in ('queued', 'processing')
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
      and nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', '') is null
    for update;
  if not found then
    return false;
  end if;

  update qa_modal_request_reservations
    set state = 'released'
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
      and state = 'reserved'
    returning true into v_released;

  if v_released is distinct from true then
    return false;
  end if;

  update qa_modal_user_usage
    set requests = greatest(requests - 1, 0)
    where user_id = p_user_id and usage_day = p_day and requests > 0;
  update qa_modal_global_usage
    set requests = greatest(requests - 1, 0)
    where usage_day = p_day and requests > 0;
  return true;
end;
$$;

create or replace function public.abort_qa_modal_render(
  p_user_id uuid,
  p_day date,
  p_request_key text,
  p_render_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_render_status public.render_status;
  v_started_at text;
  v_claim_id uuid;
  v_pool text;
  v_deleted_id uuid;
begin
  if p_user_id is null or p_day is null or p_render_id is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' then
    raise exception 'qa_modal_abort_invalid';
  end if;

  select state into v_reservation_state
    from public.qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;

  select r.status,
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', ''),
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_claim_id', '')::uuid,
         r.garment_refs -> 'meta' ->> 'pool'
    into v_render_status, v_started_at, v_claim_id, v_pool
    from public.renders as r
    where r.id = p_render_id
      and r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
    for update;
  if not found then
    return 'missing';
  end if;
  if v_render_status not in ('queued', 'processing') then
    return 'terminal';
  end if;
  if v_started_at is not null then
    return 'claimed';
  end if;
  if v_reservation_state = 'claimed' then
    -- Once a worker claims the slot, a duplicate enqueue must not cancel it.
    return 'claimed';
  end if;
  if v_claim_id is not null and v_reservation_state is distinct from 'claimed' then
    return 'claimed';
  end if;
  if v_pool is null or v_pool not in ('ok_free', 'ok_monthly', 'ok_std_credit', 'ok_hd_credit') then
    raise exception 'qa_modal_pool_invalid';
  end if;

  if v_reservation_state in ('reserved', 'claimed') then
    update public.qa_modal_request_reservations
      set state = 'released', claimed_render_id = null, claimed_at = null
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
        and state = v_reservation_state;
    if not found then
      raise exception 'qa_modal_reservation_changed';
    end if;
    update public.qa_modal_user_usage
      set requests = greatest(requests - 1, 0)
      where user_id = p_user_id and usage_day = p_day and requests > 0;
    update public.qa_modal_global_usage
      set requests = greatest(requests - 1, 0)
      where usage_day = p_day and requests > 0;
  elsif v_reservation_state not in ('released', 'claimed') and v_reservation_state is not null then
    raise exception 'qa_modal_reservation_invalid';
  end if;

  perform public.refund_render_allowance(p_user_id, v_pool, 1);
  delete from public.renders as r
    where r.id = p_render_id and r.user_id = p_user_id
    returning r.id into v_deleted_id;
  if v_deleted_id is null then
    raise exception 'qa_modal_render_changed';
  end if;
  return 'aborted';
end;
$$;

create or replace function public.fail_qa_modal_render(
  p_render_id uuid,
  p_user_id uuid,
  p_day date,
  p_request_key text,
  p_claim_id uuid,
  p_dispatch_id uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_claimed_render_id uuid;
  v_pool text;
  v_started_at text;
  v_claim_id uuid;
  v_dispatch_id uuid;
  v_failed_id uuid;
begin
  if p_render_id is null or p_user_id is null or p_day is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' then
    raise exception 'qa_modal_failure_invalid';
  end if;

  select state, claimed_render_id into v_reservation_state, v_claimed_render_id
    from public.qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;

  select r.garment_refs -> 'meta' ->> 'pool',
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', ''),
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_claim_id', '')::uuid,
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_dispatch_id', '')::uuid
    into v_pool, v_started_at, v_claim_id, v_dispatch_id
    from public.renders as r
    where r.id = p_render_id
      and r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.status in ('queued', 'processing')
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
    for update;
  if not found then
    return false;
  end if;

  if v_started_at is not null and (
    p_dispatch_id is null or v_dispatch_id is distinct from p_dispatch_id
  ) then
    return false;
  end if;
  if v_started_at is null and p_dispatch_id is not null then
    return false;
  end if;

  if p_claim_id is null then
    if v_started_at is not null or v_claim_id is not null then
      return false;
    end if;
  else
    if v_claim_id is distinct from p_claim_id
      or v_reservation_state is distinct from 'claimed'
      or v_claimed_render_id is distinct from p_render_id then
      return false;
    end if;
  end if;

  if v_pool is null or v_pool not in ('ok_free', 'ok_monthly', 'ok_std_credit', 'ok_hd_credit') then
    raise exception 'qa_modal_pool_invalid';
  end if;

  if v_started_at is null and v_reservation_state in ('reserved', 'claimed') then
    update public.qa_modal_request_reservations
      set state = 'released', claimed_render_id = null, claimed_at = null
      where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
        and state = v_reservation_state;
    if not found then
      raise exception 'qa_modal_reservation_changed';
    end if;
    update public.qa_modal_user_usage
      set requests = greatest(requests - 1, 0)
      where user_id = p_user_id and usage_day = p_day and requests > 0;
    update public.qa_modal_global_usage
      set requests = greatest(requests - 1, 0)
      where usage_day = p_day and requests > 0;
  end if;

  update public.renders
    set status = 'failed', error = left(coalesce(p_error, 'Modal QA failed.'), 500)
    where id = p_render_id and user_id = p_user_id
      and status in ('queued', 'processing')
    returning id into v_failed_id;
  if v_failed_id is null then
    return false;
  end if;

  perform public.refund_render_allowance(p_user_id, v_pool, 1);
  return true;
end;
$$;

create or replace function public.reset_retryable_qa_modal_render(
  p_user_id uuid,
  p_day date,
  p_request_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_render_status public.render_status;
  v_started_at text;
  v_deleted_id uuid;
begin
  if p_user_id is null or p_day is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' then
    raise exception 'qa_modal_retry_invalid';
  end if;

  select state into v_reservation_state
    from public.qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;

  select r.status,
         nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', '')
    into v_render_status, v_started_at
    from public.renders as r
    where r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
    for update;
  if not found or v_render_status <> 'failed' or v_started_at is not null
    or v_reservation_state not in ('released') and v_reservation_state is not null then
    return false;
  end if;

  delete from public.renders as r
    where r.user_id = p_user_id and r.idempotency_key = p_request_key
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
      and r.status = 'failed'
    returning r.id into v_deleted_id;
  return v_deleted_id is not null;
end;
$$;

create or replace function public.claim_qa_modal_render(
  p_render_id uuid,
  p_user_id uuid,
  p_day date,
  p_request_key text,
  p_started_at text,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_render_id uuid;
  v_reservation_state text;
  v_claimed_render_id uuid;
  v_existing_claim_id uuid;
begin
  if p_render_id is null or p_user_id is null or p_day is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' or p_started_at is null or p_claim_id is null then
    raise exception 'qa_modal_claim_invalid';
  end if;
  if p_day <> (now() at time zone 'UTC')::date then
    raise exception 'qa_modal_request_expired';
  end if;

  select state, claimed_render_id into v_reservation_state, v_claimed_render_id
    from qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;

  if v_reservation_state = 'claimed' and v_claimed_render_id = p_render_id then
    select nullif(r.garment_refs -> 'meta' ->> 'qa_modal_claim_id', '')::uuid
      into v_existing_claim_id
      from public.renders as r
      where r.id = p_render_id
        and r.user_id = p_user_id
        and r.idempotency_key = p_request_key
        and r.status in ('queued', 'processing')
        and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
        and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
      for update;
    return coalesce(v_existing_claim_id = p_claim_id, false);
  end if;
  if v_reservation_state is distinct from 'reserved' then
    return false;
  end if;

  update public.renders as r
    set status = 'processing',
        provider = 'qwen-image-edit-2511-modal-qa',
        garment_refs = jsonb_set(
          coalesce(r.garment_refs, '{}'::jsonb),
          '{meta}',
          coalesce(r.garment_refs -> 'meta', '{}'::jsonb)
            || jsonb_build_object('qa_modal_claim_id', p_claim_id),
          true
        )
    where r.id = p_render_id
      and r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.status in ('queued', 'processing')
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
      and nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', '') is null
    returning r.id into v_render_id;

  if v_render_id is null then
    return false;
  end if;

  update public.qa_modal_request_reservations
    set state = 'claimed', claimed_render_id = p_render_id, claimed_at = now()
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
      and state = 'reserved';
  if not found then
    raise exception 'qa_modal_reservation_changed';
  end if;
  return true;
end;
$$;

create or replace function public.start_qa_modal_dispatch(
  p_render_id uuid,
  p_user_id uuid,
  p_day date,
  p_request_key text,
  p_claim_id uuid,
  p_dispatch_id uuid,
  p_started_at text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_state text;
  v_claimed_render_id uuid;
  v_render_id uuid;
begin
  if p_render_id is null or p_user_id is null or p_day is null or p_request_key is null
    or p_request_key !~ '^[0-9a-f]{64}$' or p_claim_id is null
    or p_dispatch_id is null or p_started_at is null then
    raise exception 'qa_modal_dispatch_invalid';
  end if;
  if p_day <> (now() at time zone 'UTC')::date then
    raise exception 'qa_modal_request_expired';
  end if;

  select state, claimed_render_id into v_reservation_state, v_claimed_render_id
    from public.qa_modal_request_reservations
    where user_id = p_user_id and usage_day = p_day and request_key = p_request_key
    for update;
  if v_reservation_state is distinct from 'claimed'
    or v_claimed_render_id is distinct from p_render_id then
    return false;
  end if;

  update public.renders as r
    set garment_refs = jsonb_set(
          coalesce(r.garment_refs, '{}'::jsonb),
          '{meta}',
          coalesce(r.garment_refs -> 'meta', '{}'::jsonb)
            || jsonb_build_object(
              'qa_modal_started_at', p_started_at,
              'qa_modal_dispatch_id', p_dispatch_id
            ),
          true
        )
    where r.id = p_render_id
      and r.user_id = p_user_id
      and r.idempotency_key = p_request_key
      and r.status in ('queued', 'processing')
      and r.garment_refs -> 'meta' ->> 'qa_provider' = 'modal-qwen-qa'
      and r.garment_refs -> 'meta' ->> 'qa_modal_usage_day' = p_day::text
      and nullif(r.garment_refs -> 'meta' ->> 'qa_modal_claim_id', '')::uuid = p_claim_id
      and nullif(r.garment_refs -> 'meta' ->> 'qa_modal_started_at', '') is null
    returning r.id into v_render_id;

  return v_render_id is not null;
end;
$$;

revoke all on function public.consume_qa_modal_slot(uuid, date, text) from public, anon, authenticated;
revoke all on function public.release_qa_modal_slot(uuid, date, text, uuid) from public, anon, authenticated;
revoke all on function public.abort_qa_modal_render(uuid, date, text, uuid) from public, anon, authenticated;
revoke all on function public.fail_qa_modal_render(uuid, uuid, date, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reset_retryable_qa_modal_render(uuid, date, text) from public, anon, authenticated;
revoke all on function public.claim_qa_modal_render(uuid, uuid, date, text, text, uuid) from public, anon, authenticated;
revoke all on function public.start_qa_modal_dispatch(uuid, uuid, date, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_qa_modal_slot(uuid, date, text) to service_role;
grant execute on function public.release_qa_modal_slot(uuid, date, text, uuid) to service_role;
grant execute on function public.abort_qa_modal_render(uuid, date, text, uuid) to service_role;
grant execute on function public.fail_qa_modal_render(uuid, uuid, date, text, uuid, uuid, text) to service_role;
grant execute on function public.reset_retryable_qa_modal_render(uuid, date, text) to service_role;
grant execute on function public.claim_qa_modal_render(uuid, uuid, date, text, text, uuid) to service_role;
grant execute on function public.start_qa_modal_dispatch(uuid, uuid, date, text, uuid, uuid, text) to service_role;
