import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Shared motion language (motion/interaction scope only — no color, type,
 * spacing, or shadow values live here; those belong to theme/tokens).
 *
 * Every animation in the app is transform/opacity-only on the native driver
 * (60fps, zero layout cost). Components read `useReducedMotion()` and render
 * their final state instantly when it is true. Loading shimmer is kept under
 * reduced motion — it is progress feedback (like an ActivityIndicator), not
 * decoration.
 */
export const MOTION = {
  /** Default pressed scale for buttons and large targets. */
  pressScale: 0.97,
  /** Subtler pressed scale for pills and dense chips. */
  pressScaleSubtle: 0.98,
  /** Snappy tactile spring for press in/out (native driver). */
  pressSpring: { tension: 700, friction: 35 } as { tension: number; friction: number },
  /** Try-on result reveal: opacity duration. */
  revealDurationMs: 340,
  /** Try-on result reveal: image starts here, springs to 1. */
  revealScaleFrom: 0.96,
  /** Soft spring for the result settle. */
  revealSpring: { tension: 180, friction: 22 } as { tension: number; friction: number },
  /** Editorial stagger between cover / body / footer. */
  staggerMs: 110,
  /** How long each render-pipeline stage line stays up. */
  stageIntervalMs: 5000,
} as const;

/** True when the OS asks for reduced motion (subscribed, defaults to false). */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    // Promise.resolve wrapper: tolerates both async and sync RN signatures.
    void Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then(
      (v) => {
        if (alive) setReduce(v);
      },
      () => undefined,
    );
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Cycles editorial stage copy while `active` (render pipeline waits).
 * Returns the current line + its index (drives the pip meter).
 */
export function useStagedCopy(
  stages: readonly string[],
  active: boolean,
  intervalMs: number = MOTION.stageIntervalMs,
): { stage: string; index: number } {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (!active || stages.length <= 1) return;
    const t = setInterval(() => {
      setIndex((i) => (i + 1) % stages.length);
    }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, stages]);
  return { stage: stages[index] ?? stages[0] ?? '', index };
}

/**
 * Render-pipeline stage lines. Editorial voice, second-person, zero timing
 * promises — the locked "usually ~20s" timing line lives separately below so
 * copy stays honest while the server works (10–55s IRL).
 */
export const RENDER_STAGES: readonly string[] = [
  'Reading your base photo…',
  'Draping each piece…',
  'Matching light and shadow…',
  'Pressing the final look…',
];

/** Locked timing copy (matches the try-on screen verbatim — do not reword). */
export const RENDER_TIMING_LINE =
  'Creating your try-on, usually ~20s. We will notify you when it is ready.';
