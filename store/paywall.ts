import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api, type PaywallStatus, type Tier } from '@/lib/api';
import {
  BillingError,
  PRODUCT_IDS,
  initBilling,
  purchaseSubscription,
  restorePurchases,
} from '@/lib/billing';
import { scheduleTrialDay5Reminder } from '@/lib/push';
import { useQuotas } from './quotas';
import { useSession } from './session';
import { mmkvStorage } from './mmkv';

/**
 * Paywall trigger logic (build pack §6): show paywall at the aha-peak —
 *   quiz_done && closet>=3 && first_outfit_seen && !trial && !sub
 */
export function shouldTriggerPaywall(args: {
  quizDone: boolean;
  closetCount: number;
  firstOutfitSeen: boolean;
  tier: Tier;
}): boolean {
  return args.quizDone && args.closetCount >= CLOSET_MIN && args.firstOutfitSeen && args.tier === 'free';
}

export const CLOSET_MIN = 3;

interface PaywallState {
  tier: Tier;
  trialEndsAt: string | null;
  rendersLeft: number;
  lifetimeUsed: number;
  lifetimeCap: number;
  monthlyUsed: number;
  monthlyCap: number;
  lastPlacement: string | null;
  lastFetchedAt: string | null;
  fetching: boolean;
  fetchError: string | null;
  /** True while a StoreKit/Play purchase or restore is in flight. */
  purchasing: boolean;
  purchaseError: string | null;

  fetchStatus: () => Promise<PaywallStatus | null>;
  /**
   * Trial purchase handoff (CONTRACT-frontend §3 — P1-6): executes the
   * StoreKit2/Play Billing trial flow via lib/billing (`vai_premium_monthly`
   * or `vai_premium_yearly` — both carry the store-configured 7-day intro
   * offer), schedules the local day-5 reminder backup
   * (`scheduleTrialDay5Reminder`, T+96h), then merges server paywall-status
   * truth into this store + the quota mirror.
   * Resolves `{ purchased: true }` when the store charged/started the trial
   * (caller dismisses into the app; the server webhook reconciles tier).
   * User-cancelled purchases resolve `{ purchased: false }` with NO error UI.
   */
  startTrial: (plan?: 'monthly' | 'yearly') => Promise<{ purchased: boolean; status: PaywallStatus | null }>;
  /**
   * Restore handoff: restores store purchases, then merges paywall-status.
   * Resolves the merged status (caller shows "no active subscription" when
   * the merged tier is still `free`). User-cancelled → `{ restored: false }`.
   */
  restore: () => Promise<{ restored: boolean; status: PaywallStatus | null }>;
  clearPurchaseError: () => void;
  setPlacement: (p: string) => void;
  reset: () => void;
}

type PaywallPersisted = Pick<
  PaywallState,
  | 'tier'
  | 'trialEndsAt'
  | 'rendersLeft'
  | 'lifetimeUsed'
  | 'lifetimeCap'
  | 'monthlyUsed'
  | 'monthlyCap'
  | 'lastPlacement'
  | 'lastFetchedAt'
>;

export const usePaywall = create<PaywallState>()(
  persist<PaywallState, [], [], PaywallPersisted>(
    (set, get) => ({
      tier: 'free',
      trialEndsAt: null,
      rendersLeft: 5,
      lifetimeUsed: 0,
      lifetimeCap: 5,
      monthlyUsed: 0,
      monthlyCap: 30,
      lastPlacement: null,
      lastFetchedAt: null,
      fetching: false,
      fetchError: null,
      purchasing: false,
      purchaseError: null,

      fetchStatus: async () => {
        // No session = no point calling: the server 401s and the console
        // fills with auth noise on every cold start. Stay quiet, stay local.
        if (!useSession.getState().userId) {
          set({ fetching: false, fetchError: null });
          return null;
        }
        set({ fetching: true, fetchError: null });
        try {
          const s = await api.paywallStatus();
          // Server-minted share code (added in 0007) — feeds the watermark.
          if (s.referralCode && s.referralCode !== useSession.getState().referralCode) {
            useSession.getState().setReferralCode(s.referralCode);
          }
          set({
            tier: s.tier,
            trialEndsAt: s.trialEndsAt,
            rendersLeft: s.rendersLeft,
            lifetimeUsed: s.lifetimeUsed,
            lifetimeCap: s.lifetimeCap,
            monthlyUsed: s.monthlyUsed,
            monthlyCap: s.monthlyCap,
            lastFetchedAt: new Date().toISOString(),
            fetching: false,
          });
          // Quota mirror merges from the same server truth (badges read it).
          try {
            useQuotas.getState().syncFromServer({
              lifetimeUsed: s.lifetimeUsed,
              monthlyUsed: s.monthlyUsed,
            });
          } catch {
            // Mirror sync must never fail the status fetch.
          }
          return s;
        } catch (e) {
          set({
            fetching: false,
            fetchError: e instanceof Error ? e.message : 'Could not load subscription status.',
          });
          return null;
        }
      },

      startTrial: async (plan = 'monthly') => {
        set({ purchasing: true, purchaseError: null });
        try {
          const userId = useSession.getState().userId;
          if (!userId) {
            set({
              purchasing: false,
              purchaseError: 'Please sign in before starting the trial.',
            });
            return { purchased: false, status: null };
          }
          await initBilling(userId);
          await purchaseSubscription(plan === 'yearly' ? PRODUCT_IDS.yearly : PRODUCT_IDS.monthly);
          // Day-5 trial reminder (local backup; the server sends the
          // authoritative push + email). Best-effort: never fail checkout.
          try {
            await scheduleTrialDay5Reminder(new Date());
          } catch {
            // Reminder scheduling must never fail the purchase.
          }
          // Paywall-status merge: server (webhook) is tier truth; refresh it.
          // If the webhook lags, the purchase still succeeded at the store —
          // the caller dismisses and the next fetchStatus converges.
          const status = await get().fetchStatus();
          set({ purchasing: false });
          return { purchased: true, status };
        } catch (e) {
          if (e instanceof BillingError && e.userCancelled) {
            set({ purchasing: false });
            return { purchased: false, status: null };
          }
          set({
            purchasing: false,
            purchaseError:
              e instanceof Error ? e.message : 'Checkout failed. Nothing was charged.',
          });
          return { purchased: false, status: null };
        }
      },

      restore: async () => {
        set({ purchasing: true, purchaseError: null });
        try {
          const userId = useSession.getState().userId;
          if (!userId) {
            set({
              purchasing: false,
              purchaseError: 'Please sign in before restoring purchases.',
            });
            return { restored: false, status: null };
          }
          await initBilling(userId);
          await restorePurchases();
          const status = await get().fetchStatus();
          if (!status) {
            // Store restore succeeded but the server couldn't be reached —
            // never report success (the old code fell through to restored:true
            // and dismissed the user while the tier mirror stayed free).
            set({
              purchasing: false,
              purchaseError: 'Restored, but we could not verify it just now. Check your connection and try again.',
            });
            return { restored: false, status: null };
          }
          if (status.tier === 'free') {
            set({
              purchasing: false,
              purchaseError: 'No active subscription found on this store account.',
            });
            return { restored: false, status };
          }
          set({ purchasing: false });
          return { restored: true, status };
        } catch (e) {
          if (e instanceof BillingError && e.userCancelled) {
            set({ purchasing: false });
            return { restored: false, status: null };
          }
          set({
            purchasing: false,
            purchaseError:
              e instanceof Error ? e.message : 'Could not restore purchases. Please try again.',
          });
          return { restored: false, status: null };
        }
      },

      clearPurchaseError: () => set({ purchaseError: null }),

      setPlacement: (lastPlacement) => set({ lastPlacement }),
      reset: () =>
        set({
          tier: 'free',
          trialEndsAt: null,
          rendersLeft: 5,
          lifetimeUsed: 0,
          lifetimeCap: 5,
          monthlyUsed: 0,
          monthlyCap: 30,
          lastPlacement: null,
          lastFetchedAt: null,
          fetching: false,
          fetchError: null,
          purchasing: false,
          purchaseError: null,
        }),
    }),
    {
      name: 'vai-paywall',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (s) => ({
        tier: s.tier,
        trialEndsAt: s.trialEndsAt,
        rendersLeft: s.rendersLeft,
        lifetimeUsed: s.lifetimeUsed,
        lifetimeCap: s.lifetimeCap,
        monthlyUsed: s.monthlyUsed,
        monthlyCap: s.monthlyCap,
        lastPlacement: s.lastPlacement,
        lastFetchedAt: s.lastFetchedAt,
      }),
    },
  ),
);
