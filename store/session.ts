import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from './mmkv';

export type OnboardingStep =
  | 'carousel'
  | 'auth'
  | 'quiz'
  | 'selfie'
  | 'closet'
  | 'firstOutfit'
  | 'paywall'
  | 'done';

/** Server age band mirror (users.age_band, migration 0002 SEC-006). */
export type AgeBand = 'u13' | 'p13_17' | 'adult';

/** Current calendar year (UTC) — single source for DOB → age math. */
export function currentYear(): number {
  return new Date().getUTCFullYear();
}

/** Map a self-declared birth year to the server age band. */
export function ageBandForBirthYear(birthYear: number): AgeBand {
  const age = currentYear() - birthYear;
  if (age < 13) return 'u13';
  if (age < 18) return 'p13_17';
  return 'adult';
}

/** True when the stored gate permits the body-photo (selfie) flow. */
export function ageGatePassed(s: {
  ageBand: AgeBand | null;
  parentalConsent: boolean;
}): boolean {
  if (s.ageBand === 'adult') return true;
  if (s.ageBand === 'p13_17' && s.parentalConsent) return true;
  return false;
}

interface SessionState {
  userId: string | null;
  email: string | null;
  /** My own referral code (from users.referral_code), used for watermark + share. */
  referralCode: string | null;
  /** Inviter code captured from vai://r/<code> deep link. Sent to referral-credit post-onboarding. */
  referredBy: string | null;
  referralRedeemed: boolean;
  basePhotoId: string | null;
  /** Current signed display URL for the private `base` object (1h TTL — re-mint via path). */
  basePhotoUrl: string | null;
  /** Storage object path (`<uid>/base-<ts>.jpg`) backing `basePhotoUrl`. Persisted so the
   *  try-on screen can re-mint a fresh signed URL after expiry without a row fetch. */
  basePhotoPath: string | null;
  onboardingStep: OnboardingStep;
  firstOutfitSeen: boolean;
  /** P0 age gate (mirrors server users.birth_year/age_band/parental_consent_at). */
  birthYear: number | null;
  ageBand: AgeBand | null;
  parentalConsent: boolean;
  parentalConsentAt: string | null;
  ageVerifiedAt: string | null;
  /** Who the persisted funnel data (closet/quiz/base photo) belongs to. Set on
   *  first sign-in; a DIFFERENT user signing in triggers the cross-user wipe
   *  in auth.tsx so user B never resumes user A's funnel. */
  funnelOwnerId: string | null;

  setAuth: (p: { userId: string; email: string | null }) => void;
  setFunnelOwner: (userId: string | null) => void;
  /** Session died (expired/revoked) but funnel progress + age gate survive. */
  clearAuth: () => void;
  setReferralCode: (code: string | null) => void;
  setReferredBy: (code: string | null) => void;
  setReferralRedeemed: () => void;
  setBasePhoto: (p: { id: string; url: string; path?: string | null } | null) => void;
  setOnboardingStep: (step: OnboardingStep) => void;
  setFirstOutfitSeen: () => void;
  setAgeGate: (p: {
    birthYear: number;
    ageBand: AgeBand;
    parentalConsent: boolean;
    parentalConsentAt?: string | null;
    ageVerifiedAt?: string | null;
  }) => void;
  reset: () => void;
}

const initial: Pick<
  SessionState,
  | 'userId'
  | 'email'
  | 'referralCode'
  | 'referredBy'
  | 'referralRedeemed'
  | 'basePhotoId'
  | 'basePhotoUrl'
  | 'basePhotoPath'
  | 'onboardingStep'
  | 'firstOutfitSeen'
  | 'birthYear'
  | 'ageBand'
  | 'parentalConsent'
  | 'parentalConsentAt'
  | 'ageVerifiedAt'
  | 'funnelOwnerId'
> = {
  userId: null,
  email: null,
  referralCode: null,
  referredBy: null,
  referralRedeemed: false,
  basePhotoId: null,
  basePhotoUrl: null,
  basePhotoPath: null,
  onboardingStep: 'carousel',
  firstOutfitSeen: false,
  birthYear: null,
  ageBand: null,
  parentalConsent: false,
  parentalConsentAt: null,
  ageVerifiedAt: null,
  funnelOwnerId: null,
};

type SessionPersisted = Pick<
  SessionState,
  | 'userId'
  | 'email'
  | 'referralCode'
  | 'referredBy'
  | 'referralRedeemed'
  | 'basePhotoId'
  | 'basePhotoUrl'
  | 'basePhotoPath'
  | 'onboardingStep'
  | 'firstOutfitSeen'
  | 'birthYear'
  | 'ageBand'
  | 'parentalConsent'
  | 'parentalConsentAt'
  | 'ageVerifiedAt'
  | 'funnelOwnerId'
>;

export const useSession = create<SessionState>()(
  persist<SessionState, [], [], SessionPersisted>(
    (set, get) => ({
      ...initial,
      setAuth: ({ userId, email }) =>
        set({ userId, email, funnelOwnerId: get().funnelOwnerId ?? userId }),
      setFunnelOwner: (funnelOwnerId) => set({ funnelOwnerId }),
      clearAuth: () => set({ userId: null, email: null }),
      setReferralCode: (referralCode) => set({ referralCode }),
      setReferredBy: (referredBy) => set({ referredBy }),
      setReferralRedeemed: () => set({ referralRedeemed: true }),
      setBasePhoto: (p) =>
        set({
          basePhotoId: p?.id ?? null,
          basePhotoUrl: p?.url ?? null,
          basePhotoPath: p?.path ?? null,
        }),
      setOnboardingStep: (onboardingStep) => set({ onboardingStep }),
      setFirstOutfitSeen: () => set({ firstOutfitSeen: true }),
      setAgeGate: (p) =>
        set({
          birthYear: p.birthYear,
          ageBand: p.ageBand,
          parentalConsent: p.parentalConsent,
          parentalConsentAt: p.parentalConsentAt ?? null,
          ageVerifiedAt: p.ageVerifiedAt ?? new Date().toISOString(),
        }),
      reset: () => set({ ...initial }),
    }),
    {
      name: 'vai-session',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
      partialize: (s) => ({
        userId: s.userId,
        email: s.email,
        referralCode: s.referralCode,
        referredBy: s.referredBy,
        referralRedeemed: s.referralRedeemed,
        basePhotoId: s.basePhotoId,
        basePhotoUrl: s.basePhotoUrl,
        basePhotoPath: s.basePhotoPath,
        onboardingStep: s.onboardingStep,
        firstOutfitSeen: s.firstOutfitSeen,
        birthYear: s.birthYear,
        ageBand: s.ageBand,
        parentalConsent: s.parentalConsent,
        parentalConsentAt: s.parentalConsentAt,
        ageVerifiedAt: s.ageVerifiedAt,
        funnelOwnerId: s.funnelOwnerId,
      }),
    },
  ),
);
