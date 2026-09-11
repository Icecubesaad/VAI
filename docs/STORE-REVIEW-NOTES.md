# VAI Store Review Notes (pre-written, v1)

Fill every `[BRACKETED]` item before first submission. Keep answers identical
across App Store Connect, Play Console, and in-app copy.

## 0. Reviewer login (both stores)

- Type: email + password test account (no SSO-only, no CAPTCHA).
- Email: `[REVIEWER-LOGIN-EMAIL]`
- Password: `[REVIEWER-LOGIN-PASSWORD]` (rotate after approval if you wish)
- The account is pre-loaded with: ~15 closet items, 3 saved outfits, **2 of 5
  lifetime free renders remaining**, so the reviewer can complete a full render
  without paying. State: `[SEED-ACCOUNT-STATUS: seeded/not-yet]`.
- If the reviewer needs more renders, they can use `[REVIEW-TRIGGER: e.g. shake
  device / settings → "Reviewer reset"]` which resets the demo quota — this
  path is only reachable on the seeded account / `preview` builds.

## 1. AI-generated imagery disclosure (Apple 5.2.3 / Google Deceptive Behavior)

> VAI's virtual try-on images are **AI-generated renders**, not photographs of
> real garments on the user. Every render is produced by an image model
> (Gemini image generation, `gemini-3.1-flash-image` primary) from the user's
> garment photo + body/photo input, takes 10–55s via an async queue, and is
> labeled "AI try-on preview" in-app `[+ watermark: yes/no — WATERMARK-STATUS]`.
> Renders are style previews for shopping decisions; fit, fabric, and color
> fidelity are not guaranteed. No render is presented as a real photo.

- In-app label location: `[SCREEN: render result sheet, caption under image]`.
- No photorealistic faces of real people are generated; the subject is always
  the user's own uploaded photo.

## 2. Body-photo privacy (Apple 5.1.1 / Play User Data policy)

> Body/mirror photos are **private by default**. They are used solely to
> generate the user's own try-on renders, are never public in v1 (no social
> feed — deferred, see §6), and are never used for advertising or sold.
> Retention: `[RETENTION, e.g. kept until user deletes the item or account;
> server copies auto-purged after N days]`. Deletion: in-app per-photo delete
> + Settings → Delete account (deletes all photos server-side within `[N]`
> days). Camera / photo-library permission strings are in `app.json`
> (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) and match
> this use. Support/privacy contact: `[PRIVACY-EMAIL]`, policy URL:
> `[PRIVACY-POLICY-URL]`.

- Play Data Safety → Photos: collected, app functionality, encrypted in
  transit, user can delete. Apple nutrition label → Photos: linked to user,
  used for app functionality only.

## 3. Subscriptions / trial terms (Apple 3.1.2 / Play Subscriptions policy)

Current v1 model (must match paywall copy **exactly**):

- Free: 50 closet items · 1 outfit/day · **5 lifetime renders**, then hard
  paywall. "Lifetime" is stated on the paywall — no daily refill implied.
- Premium (`premium` entitlement via RevenueCat): **30 renders/month**. The
  word "unlimited" appears nowhere in the app, screenshots, or description.
- HD renders: one-off credit packs only (consumable, prices `[HD-PACK-PRICES]`).
- Price points: `[e.g. $X.99/mo, $XX.99/yr — FINAL-PRICES]` incl. Apple/Google
  30%. Free trial: `[NONE in v1 — or: 7-day free trial, converts to $X.99/mo
  unless cancelled ≥24h before renewal; trial terms shown on the paywall]`.
- Account deletion URL (required by both stores): `[DELETE-ACCOUNT-URL]` and
  in-app path `[Settings → Delete account]`.

## 4. Affiliate disclosure (Apple 3.1.1 IAP-exempt + FTC)

> "Shop the look" links are affiliate links to third-party retailers
> (ShopStyle / LTK, IDs server-side only) for **physical garments only** —
> no digital goods, no IAP bypass. The app shows "We may earn a commission"
> adjacent to shop links `[SCREEN: outfit detail → shop row]` and in Terms
> `[TERMS-URL]`. All payment for garments happens on the retailer's site.

## 5. Permissions justification matrix

| Permission | Why (reviewer-facing) |
|---|---|
| Camera | Photograph garments + mirror selfie for try-on only |
| Photo library (`READ_MEDIA_IMAGES`) | Import existing garment photos into the private closet |
| Notifications (`POST_NOTIFICATIONS`) | "Your try-on is ready" (async 10–55s renders) + quota/paywall reminders only |
| Tracking (`NSUserTrackingUsageDescription`) | Aggregated feature analytics (PostHog) only, never ads |

No background location, no contacts/SMS/phone-state access. No third-party
ad SDKs.

## 6. UGC / social — DEFERRED in v1 (tell reviewers explicitly)

> v1 has **no public feed, no battles, no comments, no public profiles**
> (cut per scope). All photos/outfits are private to the account. No UGC
> moderation system is required because there is no user-to-server-to-other-user
> content path. When social ships in a later version, we will add reporting,
> blocking, and takedown before submission and update these notes.

## 7. Content rating / age

- Self-declared: **17+** — mild mature/suggestive themes possible
  (fitted-clothing try-ons of the user's own body); no nudity, no sexual
  content, no UGC, no unrestricted web access, no gambling.
- If a reviewer flags the rating, accept the higher rating rather than
  contesting on first submission.

## 8. Rejection rebuttal stubs

- "Minimum functionality" (4.2): try-on is a full async pipeline (queue +
  push + HD packs), not a repackaged gallery — point to demo account renders.
- "Payments outside IAP" (3.1.1): only physical-goods affiliate links;
  consumable HD packs + subscriptions go through Apple/Google via RevenueCat.
- "AI safety": renders are user-initiated, subject-is-self only, labeled AI,
  private by default; no deepfakes of others possible (no face-swap of third
  parties — input is the user's own photo).
