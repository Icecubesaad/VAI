import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { QuizAnswers, QuizResult } from '@/lib/api';
import { mmkvStorage } from './mmkv';

export const QUIZ_STEPS = ['style', 'palette', 'dressCode', 'boldness', 'budget'] as const;
export type QuizStepKey = (typeof QUIZ_STEPS)[number];

/** `starter: true` marks the local skip path — NOT server-scored DNA. */
type StoredQuizResult = QuizResult & { starter?: boolean };

interface QuizState {
  stepIndex: number;
  answers: Partial<QuizAnswers>;
  quizDone: boolean;
  result: StoredQuizResult | null;

  setAnswer: <K extends keyof QuizAnswers>(key: K, value: QuizAnswers[K]) => void;
  next: () => void;
  back: () => void;
  setResult: (r: StoredQuizResult) => void;
  /**
   * Result-screen Back: drops the DNA card back to the answer steps.
   * Answers + stepIndex + quizDone persist (MMKV) so Back never loses state.
   */
  clearResult: () => void;
  /**
   * Skippable-quiz path: fills neutral defaults + a local starter DNA so the
   * funnel never dead-ends offline. The DNA refines from the closet later;
   * quizDone gates the paywall trigger exactly like a scored quiz.
   */
  skipWithDefaults: () => void;
  reset: () => void;
}

export const useQuiz = create<QuizState>()(
  persist(
    (set) => ({
      stepIndex: 0,
      answers: {},
      quizDone: false,
      result: null,
      setAnswer: (key, value) =>
        set((s) => ({ answers: { ...s.answers, [key]: value } })),
      next: () => set((s) => ({ stepIndex: Math.min(s.stepIndex + 1, QUIZ_STEPS.length - 1) })),
      back: () => set((s) => ({ stepIndex: Math.max(s.stepIndex - 1, 0) })),
      setResult: (result) => set({ result, quizDone: true }),
      clearResult: () => set({ result: null }),
      skipWithDefaults: () =>
        set({
          stepIndex: 0,
          answers: {
            everydayStyle: 'Minimal',
            palette: 'Neutrals',
            dressCode: 'Casual',
            boldness: 3,
            budgetBand: 'Under $50',
          },
          result: {
            // Explicitly flagged: this renders under a distinct "starter
            // style" headline — it must never pass as server-scored DNA.
            starter: true,
            styleDna: [],
            labels: ['Minimal', 'Neutrals', 'Casual'],
            colorSeason: 'Undetermined',
            teaser: 'Easy everyday essentials — your DNA refines as your closet grows.',
          },
          quizDone: true,
        }),
      reset: () => set({ stepIndex: 0, answers: {}, quizDone: false, result: null }),
    }),
    {
      name: 'vai-quiz',
      storage: createJSONStorage(() => mmkvStorage),
      // v1: identity migrate — existing persisted state is kept as-is.
      version: 1,
      migrate: (persisted) => persisted as never,
    },
  ),
);
