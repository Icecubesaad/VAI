# ONBOARDING-QA — 24-step device checklist

Funnel: carousel → auth → quiz → selfie → closet-min3 → first-outfit →
paywall → home. Run on a physical device (camera + purchases need a dev-client
build; Expo Go cannot run native modules). Kill + relaunch between steps 8–9
to verify resume. Expected results are exact.

## Carousel (entry)

1. **Cold launch signed-out lands on carousel.** Fresh install → value carousel
   with 3 slides, dots, Next + Skip. Expected: no paywall, no tabs, no crash.
2. **Carousel Next pages 1→2→3, then Get started → auth.** Expected: slide 3
   button reads “Get started” and routes to `/onboarding/auth`.
3. **Carousel Skip → auth immediately.** Expected: skips remaining slides,
   same auth route, onboarding step = `auth`.

## Auth (kind errors, age gate, back)

4. **Back → carousel, state kept.** Tap Back on auth → carousel. Expected:
   no logout, no crash (signed-out baseline preserved).
5. **Empty/invalid email + short password → kind inline error.** Enter
   `a@b` + `123` → Create account. Expected: “Enter a valid email and a
   password of 8+ characters.” — never raw server text.
6. **Wrong password → actionable copy.** Existing email + wrong 8+ password →
   Sign in. Expected: “Wrong email or password. Check both and try again — or
   create an account below.”
7. **Unknown birth year / under-13 blocked.** Enter `YYYY` garbage → any auth
   attempt. Expected: “Enter your 4-digit birth year (1900–YYYY).” Enter a
   year making age < 13. Expected: under-13 refusal copy, no account created.
8. **Ages 13–17 need the consent checkbox.** Birth year = 16yo + unchecked box
   → auth attempt. Expected: parental-consent copy, blocked. Check the box →
   attempt proceeds.
9. **Dev login (dev builds only).** `__DEV__` build shows dashed “Dev login”
   (`auth-dev-login`); prod build hides it entirely. Expected: dev tap signs
   in with `EXPO_PUBLIC_DEV_EMAIL/PASS` and resumes the funnel; prod has zero
   dev UI. Removal: see `DEV-AUTH-README.md`.

## Quiz (skippable, back-safe)

10. **Progress + Back keep answers.** Answer step 1, advance, tap Back.
    Expected: step 1 choice still selected (MMKV persisted).
11. **Skip → starter style, straight to selfie.** Tap “Skip — use starter
    style”. Expected: routes to selfie-capture; paywall gate later treats quiz
    as done (neutral defaults + local starter DNA).
12. **Submit → DNA card with watermark + referral.** Complete all 5 steps →
    See my DNA. Expected: `ShareCard` teaser + labels + color season with
    `Made with VAI · vai.style/r/<code>` watermark.
13. **Result Back keeps answers.** Tap “← Back to answers (kept)” on the DNA
    card. Expected: returns to answer steps with all choices intact; can
    resubmit without re-answering.

## Selfie (retake loop, consent, age block)

14. **Camera denied → grant path, no dead end.** Deny camera permission.
    Expected: “Camera access needed” + Allow camera button (no blank screen).
15. **Guide + consent copy visible.** Expected: full-body guide overlay and
    verbatim “Used only for your try-ons. Never public without opt-in.”
16. **Bad photo → inline reason + Retake loop.** Capture a dark/cropped photo.
    Expected: specific fail copy (resolution / portrait / dark-blurry) + Retake;
    “Use this photo” on a gated photo is refused with retake guidance.
17. **Back keeps photo flow position.** Tap “← Back (photo is kept)” → quiz.
    Expected: forward navigation returns to selfie without losing step.

## Closet-min3 (camera + library, min-3 gate)

18. **Camera add tags automatically.** Add item via camera. Expected: tagging
    spinner → item appears with category/colors/fabric; progress dot advances.
19. **Library add uses the same pipeline.** Choose from library. Expected:
    identical compress → upload → auto-tag flow; denied library permission →
    kind inline error, screen stays usable.
20. **Continue locked until 3, Back keeps items.** With 1–2 items Continue reads
    “Add N more to continue” and is disabled. Tap Back → selfie, return.
    Expected: items persist (count unchanged).

## First-outfit (fallback, no dead end)

21. **AI failure → fallback template + live Continue.** Airplane-mode (or 5xx)
    on first-outfit. Expected: starter look from your first 3 closet pieces +
    “Showing your starter look instead — you can retry or continue.” + free
    “Try again” + live Continue. Back (“← Back (items are kept)”) → closet-min3
    with items intact. Never a spinner-only or error-only dead end.

## Paywall (trial terms, restore, free mode)

22. **Trial terms verbatim + plan choice.** After first-outfit Continue with
    quiz done + ≥3 items + free tier. Expected: “7 days free, then $4.99/mo ·
    cancel anytime · no charge today” (yearly variant on yearly card), counter
    “X of 5 left”, downgrade-keeps-data note.
23. **Restore + close → free mode.** Tap Restore with no purchase → stays with
    an explanatory error (never stuck). Tap “Not now” → tabs home in free mode
    with quota badge “X of 5 left” + one-tap upgrade. Expected: dismissing the
    paywall never blocks the app.
24. **Relaunch resumes the furthest step.** Kill the app mid-funnel (e.g. on
    closet-min3), relaunch signed-in. Expected: lands back on closet-min3 with
    items, quiz answers, and selfie intact — never restarts at the carousel.
