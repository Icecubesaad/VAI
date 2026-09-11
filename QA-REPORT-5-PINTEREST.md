# QA-REPORT-5-PINTEREST — Pinterest Taste Graph (REPORT ONLY)

`npx tsc --noEmit`: GREEN (re-verified 2026-09-11, zero output).
Scope: `supabase/migrations/0005_pinterest.sql`, `functions/pinterest-{auth,sync,disconnect,share}`, `render-tryon`/`reel-regenerate` pose handling, `app/pinterest-connect.tsx`, `app/pinterest-boards.tsx`, tryon pose UI + reel regen + profile row, `store/taste.ts`, `PoseToggle`/`PinGrid`/`PinPoseCompare`/`ShareBackSheet`/`PinterestConsent`, `lib/ai/{pose-transfer,closet-guard,taste-seeds,pinterest-share}`, `lib/perf/pin-cache.ts`, `lib/analytics.ts`.

## Gate verdicts

1. **OAuth (denied/expired/secret-opt-in/sandbox) — FAIL (P0)**
   Client states covered: denied/cancel `app/pinterest-connect.tsx:101-118`, expired `app/pinterest-connect.tsx:39-45,121-125`, sandbox `app/pinterest-connect.tsx:26-27,196-200`, secret toggle `app/pinterest-connect.tsx:171-194`.
   Contract break: client POSTs `lib/api.ts:881-896` (`{action:'auth-url'…}` / `{action:'callback',code}` via POST `lib/api.ts:331-349`) but edge expects `GET ?action=auth-url&with_secret&with_write` (`supabase/functions/pinterest-auth/index.ts:44-59`) and `POST {code,state}` (`…/pinterest-auth/index.ts:64-76`). Both calls 400 (`code_required`/`action_invalid`). Flag-name mismatch (`include_secret_boards` vs `with_secret`) + redirect (`vai://pinterest-callback` client `pinterest-connect.tsx:12` vs `vai://pinterest-callback` server `supabase/functions/_shared/pinterest.ts:25` — match, OK). Server state expiry `…/pinterest.ts:125-137` + u13 gate `…/pinterest.ts:371-377` are correct but unreachable.
2. **Token storage service-role-only — PASS**
   `0005_pinterest.sql:59-67` RLS + `revoke all … from anon, authenticated`, exposure list omits accounts `0005:142-143`; AES-GCM `…/pinterest.ts:68-89`, decrypt edge-only, all account access via `admin()` (`pinterest-auth:42`, `pinterest-sync:234`, `pinterest-share:30`). Zero `pinterest_accounts` refs in `app/|lib/|store/`.
3. **Sync budget + 429 + dismissed — PASS**
   Trial cap 800 `…/pinterest.ts:218,229-253`, 429 Retry-After+backoff `…/pinterest.ts:272-310`, truncation `pinterest-sync/index.ts:137-144,158-161`, dismissed-skip `pinterest-sync:191-192,215`, caps `pinterest-sync:24-27`; client gate `lib/perf/pin-cache.ts:564-579`, newest-first cap `pin-cache:600-602`. P1 caveat: `api.pinterestBoards()` GETs `pinterest-sync?action=list` (`lib/api.ts:910-923`) — server has no GET/`action=list` handler (`pinterest-sync:229-270` POST-only) → board list fails while `pinterestSync` POST (`lib/api.ts:929-934`) works (extra `action` field ignored).
4. **Disconnect purge, keeps renders — PASS (P2 note)**
   Deletes tokens + all `style_pins` + pin-sourced `pose_refs` only `pinterest-disconnect/index.ts:37-42`; renders survive via `SET NULL` `0005:135-138`; client server-first purge `app/(tabs)/profile.tsx:143-147`, store keeps prefs `store/taste.ts:73-74`, MMKV purge `lib/perf/pin-cache.ts:669-678`. P2: `purged` counts always 0 — `delete()` without `.select()` returns null data (`pinterest-disconnect:47-48`).
5. **pose_mode keep-default, adapt-requires-pin, idempotency — FAIL (P1)**
   Good: default keep `…/pinterest.ts:426-429`, `DEFAULT_POSE_MODE` `lib/ai/pose-transfer.ts:41`, store `store/taste.ts:52`; fail-closed resolve before money `render-tryon/index.ts:329-331`, `reel-regenerate/index.ts:86-89`; UI gates `app/(tabs)/tryon.tsx:199,320-323`, `app/(tabs)/reel.tsx:411-414`; key includes pose `render-tryon:382-385`, `restyle.ts:147`, stable legacy keep. Defect P1: tryon-screen restyle drops pose — `tryon.tsx:357` calls `api.restyle()` which has no pose fields (`lib/api.ts:743-752`); only direct `render-tryon mode:restyle` (`render-tryon:348-351`) and `reelRegenerate` (`lib/api.ts:804-817`) carry pose.
6. **Closet-guard (pin never garment) — PASS (P2 hardening)**
   Client: idless reject + pin-URL overlap `lib/ai/closet-guard.ts:105-120`, pose-transfer idless throw `lib/ai/pose-transfer.ts:127-132`, prompt closed-world `pose-transfer:136-140`. Server: URL refs matched to owned garments, unmatched fail closed `render-tryon:118-145`; pose resolved via separate `resolvePoseRef` and never merged into `garmentIds`. P2: server never calls `validateRenderGarments`/overlap check (zero server refs) — safe by construction today, no explicit defense-in-depth assertion.
7. **Share-back explicit-tap only — PASS**
   Confirm-gated `tryon.tsx:449-461,827-834`, `ShareBackSheet.tsx:21,194-201` (disabled until board picked), ownership+done+`pins:write`+board re-verify `pinterest-share/index.ts:39-60`, single caller (grep), no cron/queue (header `pinterest-share:5-7`). Note: kit `ShareBackSheet` is dead code — tryon uses its own modal (`tryon.tsx:760-855`); behavior equivalent.
8. **Quota adapt=1, share=$0 — PASS**
   Adapt consumes standard pool, `credits:1` (`render-tryon:396-408`, `restyle.ts:130-180`, `pipeline.ts:108`), no new bucket (`pin-cache:23-25`, `POSE_ADAPT_COST_USD` display-only `pose-transfer:43-50`); share fn makes zero quota calls (`pinterest-share/index.ts:23-88`).
9. **Secret boards opt-in only — FAIL (P0, same root cause as #1)**
   Server correctly gates `…/pinterest.ts:140-145`, `pinterest-auth:52-58`, `secret_ok` from granted scopes `pinterest-auth:79-86`. But client opt-in never arrives (POST `include_secret_boards` vs GET `with_secret`, `lib/api.ts:877-887` vs `pinterest-auth:52`); fallback `body.with_secret` (`pinterest-auth:83`) never sent. Secret scope can never be requested or recorded.
10. **Analytics — FAIL (P1)**
    Taxonomy + props defined `lib/analytics.ts:52-58,123-128`. Zero `track('pinterest_connected|pinterest_disconnected|boards_synced|pose_mode_selected|taste_seed_applied|pin_shared')` call sites (grep empty); connect/boards/share/pose-toggle flows fire no events. `reel_card_regenerated` fires without pose_mode (`reel.tsx:425-432`).

## Defects
- P0: client↔edge contract mismatch kills OAuth + secret opt-in + board list (gates 1, 9; list part of 3). Fix: align to one contract (GET auth-url with `with_secret/with_write`, POST `{code,state,with_secret,with_write}`, implement `GET ?action=list` or switch client to POST).
- P1: tryon-restyle drops pose (gate 5); Pinterest analytics never fire (gate 10).
- P2: disconnect `purged` counts always 0; no server-side `validateRenderGarments` overlap assert; `ShareBackSheet` dead duplicate of tryon share modal.
