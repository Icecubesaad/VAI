// account — self-service deletion (docs/SECURITY.md §3, P0-001/P0-002).
// DELETE /functions/v1/account { mode: 'photos' | 'account' } (JWT via
// requireUser; POST accepted as a body-carrying alias — canonical is DELETE).
//   → 200 { status, purge_after, purged: { storage_objects, ...rowCounts } }
// Queue: every call inserts deletion_requests{user_id, kind} (0002 table —
// insert+select-own for users, transitions service_role-only) and then the
// worker drains the caller's `requested` rows FIFO (pre-existing requests are
// processed, never orphaned).
//   photos:  purge Storage base/{uid}/* + renders/{uid}/* (garments/ STAYS —
//            closet survives per profile-screen copy); delete base_photos +
//            renders rows; signed URLs die with the objects (1h TTL anyway).
//            Row sets status 'db_purged' synchronously.
//   account: photos + garments/ + raw/ prefixes; delete garments,
//            style_profiles, outfits, wishlist, push_tokens (cancels server
//            reminders), coach_plans, style_scores, posts (+likes/saves),
//            referrals, render_quotas, entitlements; anonymize the users row
//            (PII → null BEFORE auth deletion, so partial failure still
//            scrubs identity); then auth.admin.deleteUser(uid) — the FK
//            cascade (users.id → auth.users, on delete cascade) completes the
//            row purge. Row is marked 'storage_purged' pre-cascade.
// purge_after = requested_at + 30d (0002 default): storage-replica/backup
// eventual-purge horizon; the client clears MMKV + routes to /onboarding/auth.
// KNOWN TRADE-OFF (stated): the auth.deleteUser cascade also removes ledger +
// subscriptions rows immediately, so the 13-month dispute-retention ideal in
// SECURITY.md §2 cannot hold without a ledger-archive table. Mitigation: a
// dispute memo (counts + sums) is logged server-side per account purge, and
// the follow-up is a 0003 ledger_archive table if legal requires it.

import { admin, requireUser } from "../_shared/auth.ts";
import { badRequest, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";

type Db = ReturnType<typeof admin>;

interface DeletionRow {
  id: string;
  kind: string;
  status: string;
  requested_at: string;
  purge_after: string;
}

/** Recursively remove every object under bucket/prefix. Returns count. */
async function purgePrefix(sb: Db, bucket: string, prefix: string): Promise<number> {
  let removed = 0;
  for (let guard = 0; guard < 100; guard++) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 100 });
    if (error) throw new Error(`Storage list failed ${bucket}/${prefix}: ${error.message}`);
    const entries = (data ?? []) as Array<{ id?: string | null; name: string }>;
    if (entries.length === 0) break;
    // Folders come back with id null → recurse; files → batch remove.
    for (const e of entries) {
      if (e.id == null && !e.name.includes(".")) {
        removed += await purgePrefix(sb, bucket, `${prefix}/${e.name}`);
      }
    }
    const files = entries.filter((e) => e.id != null || e.name.includes("."))
      .map((e) => `${prefix}/${e.name}`);
    if (files.length > 0) {
      const { error: rmErr } = await sb.storage.from(bucket).remove(files);
      if (rmErr) throw new Error(`Storage remove failed ${bucket}/${prefix}: ${rmErr.message}`);
      removed += files.length;
    }
    if (entries.length < 100) break;
  }
  return removed;
}

async function deleteRows(
  sb: Db,
  table: string,
  userId: string,
): Promise<number> {
  // delete() takes no options arg; the deleted rows come back as data.
  const { error, data } = await sb.from(table).delete().eq("user_id", userId);
  if (error) throw new Error(`Delete failed ${table}: ${error.message}`);
  return (data as unknown[] | null)?.length ?? 0;
}

async function purgePhotos(sb: Db, userId: string): Promise<Record<string, number>> {
  const [baseObjs, renderObjs] = await Promise.all([
    purgePrefix(sb, "base", userId),
    purgePrefix(sb, "renders", userId),
  ]);
  const [basePhotos, renders] = await Promise.all([
    deleteRows(sb, "base_photos", userId),
    deleteRows(sb, "renders", userId),
  ]);
  return { storage_objects: baseObjs + renderObjs, base_photos: basePhotos, renders };
}

async function purgeAccountContent(sb: Db, userId: string): Promise<Record<string, number>> {
  const photos = await purgePhotos(sb, userId);
  const [garmentObjs, rawObjs] = await Promise.all([
    purgePrefix(sb, "garments", userId),
    purgePrefix(sb, "raw", userId),
  ]);
  const [garments, styleProfiles, outfits, wishlist, pushTokens, coachPlans,
    styleScores, posts, postSaves, renderQuotas, entitlements] = await Promise.all([
    deleteRows(sb, "garments", userId),
    deleteRows(sb, "style_profiles", userId),
    deleteRows(sb, "outfits", userId),
    deleteRows(sb, "wishlist", userId),
    deleteRows(sb, "push_tokens", userId),
    deleteRows(sb, "coach_plans", userId),
    deleteRows(sb, "style_scores", userId),
    deleteRows(sb, "posts", userId),
    deleteRows(sb, "post_saves", userId),
    deleteRows(sb, "render_quotas", userId),
    deleteRows(sb, "entitlements", userId),
  ]);
  const { error: likesErr } = await sb.from("post_likes").delete().eq("voter_id", userId);
  if (likesErr) throw new Error(`Delete failed post_likes: ${likesErr.message}`);
  const { error: refErr } = await sb.from("referrals").delete().or(`invitee_id.eq.${userId},inviter_id.eq.${userId}`);
  if (refErr) throw new Error(`Delete failed referrals: ${refErr.message}`);
  return {
    ...photos,
    storage_objects: photos.storage_objects + garmentObjs + rawObjs,
    garments,
    style_profiles: styleProfiles,
    outfits,
    wishlist,
    push_tokens: pushTokens,
    coach_plans: coachPlans,
    style_scores: styleScores,
    posts,
    post_saves: postSaves,
  };
}

/** Scrub PII before auth deletion — partial failure must never leak identity. */
async function anonymizeUser(sb: Db, userId: string): Promise<void> {
  const { error } = await sb.from("users").update({
    email: null,
    name: null,
    avatar_url: null,
    country: null,
    referral_code: null,
    referred_by: null,
    birth_year: null,
    age_band: null,
    parental_consent_at: null,
    age_verified_at: null,
    trial_ends_at: null,
  }).eq("id", userId);
  if (error) throw new Error(`Anonymize failed: ${error.message}`);
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, ["DELETE", "POST"]);
    const user = await requireUser(req);
    const body = await readJson<{ mode?: unknown }>(req);
    const mode = body.mode === "photos" || body.mode === "account" ? body.mode : null;
    if (!mode) throw badRequest("mode_invalid", "mode must be 'photos' | 'account'");

    const sb = admin();

    // 1. Queue the request (0002 table).
    const { data: queued, error: qErr } = await sb.from("deletion_requests").insert({
      user_id: user.id,
      kind: mode,
    }).select("id,requested_at,purge_after").single<{ id: string; requested_at: string; purge_after: string }>();
    if (qErr || !queued) throw new Error(`Deletion queue insert failed: ${qErr?.message ?? "unknown"}`);

    // 2. Drain the caller's pending queue FIFO (pre-existing first).
    const { data: pending } = await sb.from("deletion_requests").select("id,kind,status,requested_at,purge_after")
      .eq("user_id", user.id).eq("status", "requested").order("requested_at", { ascending: true });
    const rows = ((pending ?? []) as DeletionRow[]).sort((a, b) =>
      a.requested_at < b.requested_at ? -1 : 1);

    const purged: Record<string, number> = {};
    const merge = (part: Record<string, number>): void => {
      for (const [k, v] of Object.entries(part)) purged[k] = (purged[k] ?? 0) + v;
    };
    let needsAuthDelete = false;
    for (const row of rows) {
      if (row.kind === "account") {
        merge(await purgeAccountContent(sb, user.id));
        needsAuthDelete = true;
        await sb.from("deletion_requests")
          .update({ status: "storage_purged", processed_at: new Date().toISOString() })
          .eq("id", row.id);
      } else {
        merge(await purgePhotos(sb, user.id));
        await sb.from("deletion_requests")
          .update({ status: "db_purged", processed_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

    // 3. Account mode: anonymize + delete the auth user (cascade purges rows,
    //    including the queue rows above — statuses were recorded pre-cascade).
    let status: string;
    if (needsAuthDelete) {
      const { data: ledger } = await sb.from("ledger").select("amount_cents")
        .eq("user_id", user.id);
      const memoCount = (ledger ?? []).length;
      const memoAbs = ((ledger ?? []) as Array<{ amount_cents: number }>)
        .reduce((s, r) => s + Math.abs(r.amount_cents), 0);
      console.log("[account] dispute memo (cascade purges ledger)", {
        user_id: user.id,
        ledger_rows: memoCount,
        ledger_abs_cents: memoAbs,
      });
      await anonymizeUser(sb, user.id);
      const { error: delErr } = await sb.auth.admin.deleteUser(user.id);
      if (delErr) throw new Error(`Auth deletion failed: ${delErr.message}`);
      status = "storage_purged";
    } else {
      status = "db_purged";
    }

    return json({ status, purge_after: queued.purge_after, purged });
  } catch (e) {
    return toErrorResponse(e);
  }
});
