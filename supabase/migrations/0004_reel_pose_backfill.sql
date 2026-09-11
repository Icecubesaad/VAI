-- ============================================================================
-- VAI v1 — 0004 reel pose backfill + sync (ADDITIVE ONLY; never edits 0001-0003)
-- Turf: backend. P0-1 fix.
--
-- CANONICAL: `base_photos.pose` COLUMN wins. `pose_meta.pose` is LEGACY
-- (pre-0004 pose-pack client writes meta-only and already shipped). The server
-- read path (reel-drop poseBases via _shared/reel.ts resolveBasePhotoPose)
-- reads column-first with meta fallback, so shipped step/detail captures
-- rotate into drops immediately; this migration then backfills the column and
-- keeps it synced going forward via trigger. P1-2 needs NO schema (weekly
-- regen budget is counted in-code via renders in _shared/quota.ts).
--
-- Deploy order: `supabase db push` (this file) BEFORE deploying the reel-*
-- functions — they SELECT base_photos.pose + pose_meta.
-- ============================================================================

-- Safety first: one active photo per (user, pose). Pre-0004 meta-only rows
-- never collided (pose NULL skips the 0003 partial unique index); backfilling
-- them could hit it. Deactivate older duplicates, keep newest — matches the
-- client supersede semantics (one active row per pose).
update base_photos as b
set is_active = false
where b.id in (
  select id from (
    select id,
      row_number() over (
        partition by user_id, coalesce(pose, pose_meta ->> 'pose')
        order by created_at desc, id desc
      ) as rn
    from base_photos
    where is_active = true
      and coalesce(pose, pose_meta ->> 'pose') in ('front', 'step', 'detail')
  ) ranked
  where rn > 1
);

-- Backfill the canonical column from legacy meta (re-runnable: NULL-only).
update base_photos
set pose = pose_meta ->> 'pose'
where pose is null
  and pose_meta ->> 'pose' in ('front', 'step', 'detail');

-- Forward sync: future meta-only writes (shipped client) auto-populate the
-- column; column wins on conflict; canonical mirrors back into meta so legacy
-- meta-only readers (client fetchPoseStatus) keep seeing it.
create or replace function sync_base_photo_pose()
returns trigger language plpgsql as $$
declare
  v_meta_pose text;
begin
  v_meta_pose := NEW.pose_meta ->> 'pose';
  if v_meta_pose is null or v_meta_pose not in ('front', 'step', 'detail') then
    v_meta_pose := null;
  end if;
  -- Column wins when valid; otherwise inherit the legacy meta value.
  if NEW.pose is null or NEW.pose not in ('front', 'step', 'detail') then
    NEW.pose := v_meta_pose;
  end if;
  -- Mirror the canonical value back into meta for legacy readers.
  if NEW.pose in ('front', 'step', 'detail') then
    if (NEW.pose_meta ->> 'pose') is distinct from NEW.pose then
      NEW.pose_meta := coalesce(NEW.pose_meta, '{}'::jsonb)
        || jsonb_build_object('pose', NEW.pose);
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists base_photos_pose_sync on base_photos;
create trigger base_photos_pose_sync
  before insert or update of pose, pose_meta on base_photos
  for each row execute function sync_base_photo_pose();
