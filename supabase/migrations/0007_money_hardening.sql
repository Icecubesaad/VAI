-- 0007 — money-path hardening (security audit P0-1/P1-2/P1-5/P1-6).
--
-- 1. Provider-event dedupe: a UNIQUE index on ledger(type, meta->>'provider_event_id')
--    makes every webhook claim exactly-once at the DB level (Stripe retries
--    concurrently; the old read-check-write raced and double-credited packs).
--    Pre-existing duplicate memos (from the old race) are collapsed, keeping
--    the earliest.
-- 2. grant_pack_credits / debit_pack_credits SECURITY DEFINER RPCs: the
--    ledger claim insert IS the concurrency boundary — only the first
--    delivery of an event id proceeds to the entitlements update, and the
--    entitlements increment is a single atomic UPDATE (no read-modify-write).
--    EXECUTE granted to service_role only.
-- 3. users INSERT narrowed to (id, email) for authenticated: blocks minting
--    your own referral_code / trial_ends_at via PostgREST on first insert
--    (referral farm). requireUser provisioning runs as service_role and is
--    unaffected. RLS still pins id = auth.uid().
--
-- Apple/Google webhook signature verification ships in the billing-* edge
-- functions (_shared/jws.ts) and needs no schema change.

-- 1) Collapse any pre-existing duplicate provider-event memos (earliest wins).
delete from ledger a using ledger b
  where a.type = b.type
    and a.meta->>'provider_event_id' is not null
    and a.meta->>'provider_event_id' = b.meta->>'provider_event_id'
    and (a.created_at, a.id) > (b.created_at, b.id);

create unique index if not exists ledger_provider_event_dedupe
  on ledger (type, (meta->>'provider_event_id'))
  where meta->>'provider_event_id' is not null;

-- 2) Atomic pack grant: claim event → increment credits (single UPDATE).
create or replace function grant_pack_credits(
  p_user_id uuid,
  p_pack text,
  p_event_id text,
  p_amount_cents int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_std int;
  v_hd int;
  v_claimed uuid;
begin
  if p_pack = 'credits_10' then
    v_std := 10; v_hd := 0;
  elsif p_pack = 'credits_25' then
    v_std := 25; v_hd := 0;
  elsif p_pack = 'hd_single' then
    v_std := 0; v_hd := 1;
  else
    raise exception 'pack_unknown';
  end if;

  begin
    insert into ledger (user_id, type, amount_cents, meta)
    values (
      p_user_id,
      'sub',
      0,
      jsonb_build_object(
        'kind', 'pack',
        'provider', 'stripe',
        'provider_event_id', p_event_id,
        'pack', p_pack,
        'amount_cents', p_amount_cents
      )
    )
    returning id into v_claimed;
  exception
    when unique_violation then
      return jsonb_build_object('deduped', true, 'std', v_std, 'hd', v_hd);
  end;

  if v_claimed is null then
    return jsonb_build_object('deduped', true, 'std', v_std, 'hd', v_hd);
  end if;

  update entitlements
    set std_credits = std_credits + v_std,
        hd_credits = hd_credits + v_hd,
        updated_at = now()
    where user_id = p_user_id;
  if not found then
    insert into entitlements (user_id, std_credits, hd_credits)
    values (p_user_id, v_std, v_hd);
  end if;

  return jsonb_build_object('deduped', false, 'std', v_std, 'hd', v_hd);
end $$;

-- 2b) Atomic refund debit: claim event → decrement credits, floored at 0.
create or replace function debit_pack_credits(
  p_user_id uuid,
  p_std int,
  p_hd int,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid;
begin
  begin
    insert into ledger (user_id, type, amount_cents, meta)
    values (
      p_user_id,
      'sub',
      0,
      jsonb_build_object(
        'kind', 'refund_debit',
        'provider', 'stripe',
        'provider_event_id', p_event_id
      )
    )
    returning id into v_claimed;
  exception
    when unique_violation then
      return false;
  end;

  if v_claimed is null then
    return false;
  end if;

  update entitlements
    set std_credits = greatest(std_credits - p_std, 0),
        hd_credits = greatest(hd_credits - p_hd, 0),
        updated_at = now()
    where user_id = p_user_id;
  if not found then
    insert into entitlements (user_id, std_credits, hd_credits)
    values (p_user_id, 0, 0);
  end if;

  return true;
end $$;

revoke execute on function grant_pack_credits(uuid, text, text, int) from public, anon, authenticated;
grant execute on function grant_pack_credits(uuid, text, text, int) to service_role;
revoke execute on function debit_pack_credits(uuid, int, int, text) from public, anon, authenticated;
grant execute on function debit_pack_credits(uuid, int, int, text) to service_role;

-- 3) users INSERT: only (id, email) — every other column is server-owned.
revoke insert on table users from authenticated;
grant insert (id, email) on table users to authenticated;
grant insert on table users to service_role;
