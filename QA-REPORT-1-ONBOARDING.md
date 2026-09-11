# QA-REPORT-1 — ONBOARDING→TRIAL (static trace, no device)

Scope: build-pack §6/§11 acceptance. Baseline: `npx tsc --noEmit` exit 0 (re-run this session). No code edited.

## Gates

1. Carousel → auth — PASS. `app/onboarding/index.tsx:7-23,34-37` 3 slides, Skip/Next → `setStep('auth')`. P2: art is emoji placeholders (`:62-66`), UI/UX to replace.
2. Cold launch paywall-free — PASS. `app/index.tsx:22-30` signed-out → `/onboarding` carousel; no paywall import.
3. Auth Apple/Google/email — PASS w/ defect. `app/onboarding/auth.tsx:56-82` Apple+iOS native button (`:153-161`); `:84-122` Google PKCE code-exchange; `:124-144` email 8+ validation; cancel-silent (`:51,:101-104`). P1: no privacy-policy link on signup (pack §9 requires it).
4. Quiz 5 steps — PASS. `store/quiz.ts:6` 5 keys; `app/onboarding/quiz.tsx:10-16,109-111` progress, Back (`:151-155`), all-answered validation (`:68-71`). P2: boldness is buttons, spec says slider.
5. DNA teaser — PASS w/ defect. `quiz.tsx:90-105` → `ShareCard watermark`. P1: no `referralCode` passed (`:94-99`) so `ShareCard.tsx:53-56` falls back to generic `Made with VAI · vai.style` — missing required `/r/<code>` virality URL.
6. Selfie guide+gates+consent — PARTIAL. Guide overlay PASS (`selfie-capture.tsx:161-170`, `GUIDE:23`); consent verbatim PASS (`:185-187`). P1: on-device gates are only `too_small`+`not_portrait` (`:55-64`); no blur/luminance/face/keypoints despite spec §6, and `quiz-score/index.ts:41-53` validates quiz fields only — server re-check claimed in comment (`:26-28`) doesn't exist. Inline fail+Retake PASS (`:175-179,190-191`).
7. Closet-min3 — PASS. `closet-min3.tsx:86,135-144` Continue disabled until ≥3; camera single-item (`:29-40`). P2: counter starts `0/3` (`:90-92`), spec writes `1/3–3/3`.
8. First-outfit hero — PASS w/ defect. `first-outfit.tsx:27-32,90-98` plan-day → hero `OutfitCard` + why-line; error+retry (`:68-87`). P2: Continue (`:102-108`) is live during loading/error — user can mark seen + trigger paywall without seeing an outfit.
9. Paywall trigger — PASS. `store/paywall.ts:19-28` `quizDone && ≥3 && seen && free`; `first-outfit.tsx:39-55` marks seen, `setPlacement('first_outfit')`.
10. Trial start + copy — PASS w/ defect. `paywall.tsx:17` trial copy VERBATIM ✓; `:50-57` → `paywall.ts:132-163` initBilling+purchase(monthly intro offer)+status merge, cancel silent. P1: onboarding paywall offers monthly only; yearly exists solely in `Sheet.tsx:30-33` — funnel inconsistency.
11. Day-5 reminder — FAIL (P1). `lib/push.ts:150-169` defines `TRIAL_REMINDER_OFFSET_MS` + `scheduleTrialDay5Reminder`, but grep shows ZERO call sites — `startTrial` never schedules/cancels. Repro: complete trial purchase → search callers → none → no T+96h local notification.
12. Downgrade preserves data — PARTIAL (P1). Copy lives in `Sheet.tsx:225` + `billing.ts:63`, but the aha-peak `paywall.tsx` shows none; enforcement: `closet.tsx:44-47` blocks adds at 50, but no read-only overflow state and `Upgrade to edit` string exists nowhere (grep 0 hits).
13. Restore — PASS. `paywall.tsx:59-66,164-168`; `paywall.ts:165-200` restore+merge, free → "No active subscription found".
14. Referral deep-link — PASS w/ P2. `_layout.tsx:33-43,62-70,124-128` captures `vai://r/<code>`/`?code`/`?ref`/https + listener; `paywall.tsx:74-83` `applyReferral` once-guarded. P2: `push.ts:45-67` `parseDeepLink` has no `r/` route; `≥3`-char check accepts junk; failures silent (by design, no UX).
15. Splash failsafe — PASS. `lib/perf/loading.ts:24,70-87` 4s race, always `hideAsync`; `_layout.tsx:22-23,131-136`.
16. 17+ / parental gate — FAIL (P0 ship-blocker). No DOB/age step: `auth.tsx:146-224` no age UI; admitted in `docs/SECURITY.md:145-158` (P0-006). Repro: fresh launch → Skip → auth (no DOB) → quiz → selfie body photo capturable by a minor. Plus `STORE-REVIEW-NOTES.md:94` declares `12+/Teen`, contradicting pack §9 `17+` — rejection risk.
17. Analytics — P2. Events defined (`lib/analytics.ts:18-29`) but zero `track()` calls in onboarding (only `affiliate.ts:176`) — aha→trial/trial→paid gates unmeasurable.

## Defects (P0×1, P1×6, P2×7)
- P0-1 §16 age gate absent + rating contradiction.
- P1-1 §3 no privacy link on auth; P1-2 §5 watermark missing /r/code; P1-3 §6 quality gates stub; P1-4 §10 monthly-only funnel; P1-5 §11 reminder never scheduled; P1-6 §12 downgrade copy+read-only unenforced.
- P2s: carousel art, quiz slider, 0/3 counter, continue-on-error, Sheet yearly copy variant, referral parse gaps, analytics blind.
