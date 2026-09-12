import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { ShareCard } from '@/components';
import { api, apiErrorCopy, type QuizAnswers } from '@/lib/api';
import { useQuiz, QUIZ_STEPS, type QuizStepKey } from '@/store/quiz';
import { useSession } from '@/store/session';

const OPTIONS: Record<QuizStepKey, { key: keyof QuizAnswers; choices: string[] }> = {
  style: { key: 'everydayStyle', choices: ['Minimal', 'Streetwear', 'Classic', 'Boho', 'Sporty', 'Bold'] },
  palette: { key: 'palette', choices: ['Neutrals', 'Earth tones', 'Pastels', 'Dark & moody', 'Bright & bold'] },
  dressCode: { key: 'dressCode', choices: ['Casual', 'Smart casual', 'Business', 'Creative', 'Uniformed'] },
  boldness: { key: 'boldness', choices: ['1', '2', '3', '4', '5'] },
  budget: { key: 'budgetBand', choices: ['Under $50', '$50–$150', '$150–$300', '$300+'] },
};

const STEP_LABEL: Record<QuizStepKey, { title: string; hint: string }> = {
  style: { title: 'Your everyday style?', hint: 'Pick all that fit — up to 3.' },
  palette: { title: 'Colors you reach for?', hint: 'Pick all that fit — up to 3.' },
  dressCode: { title: 'Typical dress code?', hint: 'Pick all that fit — up to 3.' },
  boldness: { title: 'How bold? (1–5)', hint: '1 = quiet classics, 5 = main-character energy.' },
  budget: { title: 'Budget per piece?', hint: 'Gap picks respect this band.' },
};

/** Steps that accept multiple picks (stored comma-joined, server-compatible). */
const MULTI_STEPS: ReadonlySet<QuizStepKey> = new Set(['style', 'palette', 'dressCode']);
const MULTI_MAX = 3;

function splitPicks(raw: string | number | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 5-step quiz (style, palette, dress-code, boldness slider, budget) →
 * quiz-score edge fn → DNA teaser card (shareable, watermarked).
 */
export default function QuizScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const stepIndex = useQuiz((s) => s.stepIndex);
  const answers = useQuiz((s) => s.answers);
  const setAnswer = useQuiz((s) => s.setAnswer);
  const next = useQuiz((s) => s.next);
  const back = useQuiz((s) => s.back);
  const setResult = useQuiz((s) => s.setResult);
  const clearResult = useQuiz((s) => s.clearResult);
  const skipWithDefaults = useQuiz((s) => s.skipWithDefaults);
  const result = useQuiz((s) => s.result);
  const setStep = useSession((s) => s.setOnboardingStep);
  // Own referral code feeds the ShareCard watermark (vai.style/r/<code>);
  // null until the server issues one → ShareCard falls back to generic stamp.
  const referralCode = useSession((s) => s.referralCode);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepKey: QuizStepKey = QUIZ_STEPS[stepIndex] ?? 'style';
  const { key, choices } = OPTIONS[stepKey];
  const isLast = stepIndex === QUIZ_STEPS.length - 1;
  const isMulti = MULTI_STEPS.has(stepKey);
  const picks = isMulti ? splitPicks(answers[key] as string | number | undefined) : [];
  const selected = answers[key];

  const choose = useCallback(
    (choice: string) => {
      setError(null);
      if (isMulti) {
        // Toggle within the comma-joined string (server reads joined values).
        const current = splitPicks(answers[key] as string | number | undefined);
        const nextPicks = current.includes(choice)
          ? current.filter((p) => p !== choice)
          : current.length >= MULTI_MAX
            ? current
            : [...current, choice];
        if (!current.includes(choice) && current.length >= MULTI_MAX) {
          setError(`Up to ${MULTI_MAX} — unpick one to change it.`);
          return;
        }
        setAnswer(key, nextPicks.join(', ') as never);
        return;
      }
      const value = key === 'boldness' ? Number(choice) : choice;
      setAnswer(key, value as never);
      if (!isLast) next();
    },
    [key, isLast, isMulti, next, setAnswer, answers],
  );

  const submit = useCallback(async () => {
    const complete: QuizAnswers = {
      everydayStyle: String(answers.everydayStyle ?? ''),
      palette: String(answers.palette ?? ''),
      dressCode: String(answers.dressCode ?? ''),
      boldness: Number(answers.boldness ?? 3),
      budgetBand: String(answers.budgetBand ?? ''),
    };
    if (!complete.everydayStyle || !complete.palette || !complete.dressCode || !complete.budgetBand) {
      setError('Answer every step so your DNA is accurate — go back if you skipped one.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const r = await api.scoreQuiz({ answers: complete });
      setResult(r);
    } catch (e) {
      setError(apiErrorCopy(e).message);
    } finally {
      setSubmitting(false);
    }
  }, [answers, setResult]);

  const goSelfie = useCallback(() => {
    setStep('selfie');
    router.replace('/onboarding/selfie-capture');
  }, [router, setStep]);

  // Skippable → neutral defaults, then straight to the selfie step. State
  // persists in MMKV so Back never loses answers.
  const skipQuiz = useCallback(() => {
    skipWithDefaults();
    setStep('selfie');
    router.replace('/onboarding/selfie-capture');
  }, [router, setStep, skipWithDefaults]);

  // Result state: DNA teaser card (shareable, watermarked).
  if (result) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]} testID="quiz-result">
        <Text style={[styles.title, { color: colors.text }]}>Your style DNA</Text>
        <ShareCard
          teaser={result.teaser}
          labels={result.labels}
          colorSeason={result.colorSeason}
          watermark
          referralCode={referralCode}
        />
        <Pressable style={[styles.button, { backgroundColor: colors.primary }]} onPress={goSelfie} testID="quiz-continue">
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Continue to your photo</Text>
        </Pressable>
        <Pressable onPress={clearResult} testID="quiz-result-back">
          <Text style={[styles.back, { color: colors.muted }]}>Back to answers</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="quiz-screen">
      <Text style={[styles.progress, { color: colors.muted }]} testID="quiz-progress">
        Step {stepIndex + 1} of {QUIZ_STEPS.length}
      </Text>
      <Text style={[styles.title, { color: colors.text }]}>{STEP_LABEL[stepKey].title}</Text>
      <Text style={[styles.hint, { color: colors.muted }]}>{STEP_LABEL[stepKey].hint}</Text>

      {submitting ? (
        <View style={styles.state} testID="quiz-loading">
          <ActivityIndicator size="large" />
          <Text style={[styles.hint, { color: colors.muted }]}>Reading your style DNA…</Text>
        </View>
      ) : (
        <View style={styles.choices}>
          {choices.map((c) => {
            const active = isMulti ? picks.includes(c) : String(selected ?? '') === c;
            return (
              <Pressable
                key={c}
                onPress={() => choose(c)}
                style={[
                  styles.choice,
                  { borderColor: colors.border, borderWidth: 1 },
                  active && { backgroundColor: colors.primary },
                ]}
                testID={`quiz-choice-${c}`}
              >
                <Text style={[styles.choiceText, { color: active ? colors.onPrimary : colors.text }]}>
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {!!error && (
        <Text style={[styles.error, { color: colors.danger }]} testID="quiz-error">
          {error}
        </Text>
      )}

      <View style={styles.footer}>
        {stepIndex > 0 && (
          <Pressable onPress={back} testID="quiz-back">
            <Text style={[styles.back, { color: colors.muted }]}>Back</Text>
          </Pressable>
        )}
        {!result && (
          <Pressable onPress={skipQuiz} testID="quiz-skip">
            <Text style={[styles.back, { color: colors.muted }]}>
              Skip and use a starter style
            </Text>
          </Pressable>
        )}
        {isMulti && !isLast && (
          <Pressable
            style={[
              styles.button,
              { backgroundColor: colors.primary, opacity: picks.length > 0 ? 1 : 0.5 },
            ]}
            onPress={next}
            disabled={picks.length === 0}
            testID="quiz-multi-continue"
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>
              Continue{picks.length > 0 ? ` (${picks.length} picked)` : ''}
            </Text>
          </Pressable>
        )}
        {isLast && (
          <Pressable
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => void submit()}
            disabled={submitting}
            testID="quiz-submit"
          >
            <Text style={[styles.buttonText, { color: colors.onPrimary }]}>See my style DNA</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64 },
  progress: { fontSize: 13, fontWeight: '600' },
  title: { fontSize: 30, fontWeight: '800', fontFamily: 'Georgia', marginTop: 8 },
  hint: { fontSize: 14, marginTop: 4 },
  choices: { gap: 10, marginTop: 24 },
  choice: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  choiceText: { fontSize: 16, fontWeight: '600' },
  footer: { marginTop: 24, gap: 12 },
  button: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700' },
  back: { fontSize: 15, textAlign: 'center' },
  error: { fontSize: 13, marginTop: 12 },
  state: { alignItems: 'center', paddingVertical: 48, gap: 8 },
});
