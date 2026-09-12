-- 0008 — renders become private: signed URLs everywhere (privacy audit P1-3).
--
-- Try-on renders are derived from the user's PRIVATE base selfie and preserve
-- face identity — they were the only selfie-derived asset exposed by an
-- anon-selectable bucket policy (`renders_public_read` allowed Storage LIST
-- of every user's objects). Serving now mints 1h signed URLs from the stored
-- bucket path (edge functions only); the public-read policy is dropped.
--
-- garments stays public-read (clothing shots, no person) — accepted risk,
-- documented in docs/SECURITY.md.

alter table renders add column if not exists output_path text;

-- Backfill the bucket path from legacy public URLs so pre-existing done
-- renders keep serving through signed URLs after the policy drop.
update renders
  set output_path = regexp_replace(
    output_url,
    '^https?://[^/]+/storage/v1/object/public/renders/',
    ''
  )
  where output_path is null
    and output_url is not null
    and output_url like '%/storage/v1/object/public/renders/%';

drop policy if exists renders_public_read on storage.objects;
