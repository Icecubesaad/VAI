# VAI Storage — buckets, policies, lifecycle

Canonical enforcement lives in `supabase/migrations/0001_schema.sql` (storage.buckets
seed + `storage.objects` RLS). This doc is the human reference: what goes where,
who can read it, and when it gets deleted.

## Buckets

| Bucket | Public | Contents | Path convention |
|---|---|---|---|
| `raw` | no | Original uploads (camera, bulk) before cutout | `{user_id}/raw/{uuid}.jpg` |
| `base` | no | Mirror-selfie base photos (biometric-adjacent) | `{user_id}/base/{uuid}.jpg` |
| `garments` | **yes** | Cutout PNGs (+ originals pending cutout) | `cutout/{user_id}/{garment_id}.png` |
| `renders` | **yes** | Finished try-on outputs (watermarked) | `{user_id}/{render_id}.png` |

Why this split: base photos can identify a person → private, signed URLs only
(1h TTL, minted server-side in `pipeline.ts` → `signedUrl()`). Garment cutouts
and renders are shown in grids, share cards, and (v2) feed → public buckets with
unguessable `{user_id}/{uuid}` paths. Renders carry the `Made with VAI` watermark;
Premium may move it, never remove it (build pack §6).

Limits: `raw`/`base` 15MB (HEIC/HEIF allowed for iOS camera), `garments`/`renders`
10MB, jpeg/png/webp only.

## Storage policies (mirror of the migration)

```sql
-- Private: owner read/write only. service_role (the pipeline) bypasses RLS.
create policy raw_owner_rw on storage.objects for all to authenticated
  using (bucket_id = 'raw' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'raw' and auth.uid()::text = (storage.foldername(name))[1]);

create policy base_owner_rw on storage.objects for all to authenticated
  using (bucket_id = 'base' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'base' and auth.uid()::text = (storage.foldername(name))[1]);

-- Public: owner writes, world reads (SELECT to anon + authenticated).
create policy garments_owner_write  on storage.objects for insert to authenticated
  with check (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'garments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy garments_public_read  on storage.objects for select to anon, authenticated
  using (bucket_id = 'garments');

create policy renders_public_read   on storage.objects for select to anon, authenticated
  using (bucket_id = 'renders');
create policy renders_owner_delete  on storage.objects for delete to authenticated
  using (bucket_id = 'renders' and auth.uid()::text = (storage.foldername(name))[1]);
-- Renders are WRITTEN by the pipeline via service_role (no user-insert policy).
```

Client rule: never upload to `renders/` from the app; never hotlink `raw/` or
`base/` — request a signed URL via `render-tryon`/`restyle` responses instead.

## Lifecycle (Supabase has no S3-style lifecycle → Inngest cron `storage-lifecycle`, nightly)

| Rule | Action |
|---|---|
| `raw/{user}/…` older than 90d with a garment row pointing at a cutout | delete object |
| `renders/{user}/{id}.png` whose row is `failed` and older than 7d | delete object |
| `base/` photo superseded by a retake (is_active=false) for 30d+ | delete object |
| Aborted multipart uploads / orphan `cutout/` with no garment row | delete object |
| Delete-account request | purge all four prefixes immediately, then 30-day DB purge (§6) |

The sweeper lists with `service_role`, deletes objects, and never touches rows —
DB rows are the audit trail (retention: renders/ledger 13mo for disputes).
