import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, tokenColors } from '@/theme';
import { ShareCard, DnaFilmstrip, type DnaLook } from '@/components';
import { api, apiErrorCopy, type QuizAnswers } from '@/lib/api';
import { dnaGalleryFor } from '@/lib/dna-gallery';
import { useQuiz, QUIZ_STEPS, type QuizStepKey } from '@/store/quiz';
import { useSession } from '@/store/session';

/**
 * Style catalog — curated personas per side. Product copy (real options the
 * stylist prompt and shop picks consume), never fabricated results.
 */
const MENSWEAR = [
  'Streetwear', 'Old Money', 'Minimal', 'Techwear', 'Tailored',
  'Smart casual', 'Athleisure', 'Vintage', 'Denim & Boots', 'Gorpcore',
];
const WOMENSWEAR = [
  'Clean girl', 'Old Money', 'Minimalist', 'Coquette', 'Streetwear',
  'Boho', 'Y2K', 'Cottagecore', 'Office chic', 'Athleisure',
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
  'India', 'Pakistan', 'Bangladesh', 'Japan', 'South Korea', 'China',
  'Singapore', 'Indonesia', 'Philippines', 'Vietnam', 'UAE', 'Saudi Arabia',
  'Turkey', 'Germany', 'France', 'Italy', 'Spain', 'Portugal',
  'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Poland', 'Switzerland',
  'Ireland', 'Brazil', 'Mexico', 'Argentina', 'Chile', 'South Africa',
  'Nigeria', 'Kenya', 'Egypt',
];

const OCCUPATIONS = [
  'Student', 'Working professional', 'Remote worker',
  'Creative / artist', 'Athlete / fitness', 'Retail & hospitality',
  'Retired', 'Other',
];

const LIKES = [
  'Gym & training', 'Going out', 'Travel', 'Office',
  'Outdoors & hiking', 'Coffee & casual', 'Sports events',
  'Music & festivals', 'Studying', 'Photography',
];

const CHOICES: Partial<Record<QuizStepKey, string[]>> = {
  palette: ['Neutrals', 'Earth tones', 'Pastels', 'Dark & moody', 'Bright & bold'],
  dressCode: ['Casual', 'Smart casual', 'Business', 'Creative', 'Uniformed'],
  boldness: ['1', '2', '3', '4', '5'],
  budget: ['Under $50', '$50–$150', '$150–$300', '$300+'],
};

const STEP_LABEL: Record<QuizStepKey, { kicker: string; title: string; hint: string }> = {
  gender: { kicker: 'Your side of the catalog', title: 'Who are we styling?', hint: 'Pick one — it shapes every look.' },
  style: { kicker: 'Style catalog', title: 'Pick your personas', hint: 'Up to 3 — this is your style DNA.' },
  palette: { kicker: 'Color', title: 'Colors you reach for?', hint: 'Up to 3.' },
  dressCode: { kicker: 'Dress code', title: 'How do most days look?', hint: 'Up to 3.' },
  boldness: { kicker: 'Boldness', title: 'How bold?', hint: '1 = quiet classics · 5 = main-character energy.' },
  budget: { kicker: 'Budget', title: 'Budget per piece?', hint: 'Gap picks respect this band.' },
  about: { kicker: 'About you', title: 'A little about you', hint: 'Country, day-to-day, and what you love — AI tailors everything to it.' },
};

const MULTI_STEPS: ReadonlySet<QuizStepKey> = new Set(['style', 'palette', 'dressCode']);
const MULTI_MAX = 3;
const LIKES_MAX = 4;

/** Quiz step key → the answers field it persists to. */
function storeKeyFor(k: QuizStepKey): keyof QuizAnswers {
  if (k === 'style') return 'everydayStyle';
  if (k === 'budget') return 'budgetBand';
  return k as keyof QuizAnswers;
}

function splitPicks(raw: string | number | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 7-step style onboarding: catalog side → personas → palette → dress code →
 * boldness → budget → about-you (country / occupation / likes). Scored by the
 * quiz-score edge fn (free Gemini text) into the DNA teaser card.
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
  const referralCode = useSession((s) => s.referralCode);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepKey: QuizStepKey = QUIZ_STEPS[stepIndex] ?? 'gender';
  const isLast = stepIndex === QUIZ_STEPS.length - 1;
  const isMulti = MULTI_STEPS.has(stepKey);
  const choices = stepKey === 'gender'
    ? ['Menswear', 'Womenswear']
    : stepKey === 'style'
      ? (String(answers.gender) === 'Womenswear' ? WOMENSWEAR : MENSWEAR)
      : (CHOICES[stepKey] ?? []);
  const picks = splitPicks(answers[stepKey === 'style' ? 'everydayStyle' : (stepKey as keyof QuizAnswers)] as string | number | undefined);
  const likes = splitPicks(answers.interests);
  const label = STEP_LABEL[stepKey];

  const canContinue =
    stepKey === 'gender' ? Boolean(answers.gender)
    : stepKey === 'style' ? splitPicks(answers.everydayStyle).length > 0
    : stepKey === 'palette' ? Boolean(answers.palette)
    : stepKey === 'dressCode' ? Boolean(answers.dressCode)
    : stepKey === 'boldness' ? answers.boldness !== undefined
    : stepKey === 'budget' ? Boolean(answers.budgetBand)
    : Boolean(answers.country && answers.occupation); // about

  const choose = useCallback(
    (choice: string) => {
      setError(null);
      if (isMulti) {
        const storeKey = storeKeyFor(stepKey);
        const current = splitPicks(answers[storeKey] as string | number | undefined);
        const nextPicks = current.includes(choice)
          ? current.filter((p) => p !== choice)
          : current.length >= MULTI_MAX
            ? current
            : [...current, choice];
        if (!current.includes(choice) && current.length >= MULTI_MAX) {
          setError(`Up to ${MULTI_MAX} — unpick one to change it.`);
          return;
        }
        setAnswer(storeKey, nextPicks.join(', ') as never);
        return;
      }
      const value = stepKey === 'boldness' ? Number(choice) : choice;
      const storeKey = (stepKey === 'gender' ? 'gender' : stepKey === 'budget' ? 'budgetBand' : stepKey) as keyof QuizAnswers;
      setAnswer(storeKey, value as never);
      if (!isLast && stepKey !== 'gender') next();
      if (stepKey === 'gender') next(); // catalog side → personas
    },
    [stepKey, isMulti, isLast, next, setAnswer, answers],
  );

  const toggleLike = useCallback(
    (like: string) => {
      const current = splitPicks(answers.interests);
      const nextPicks = current.includes(like)
        ? current.filter((p) => p !== like)
        : current.length >= LIKES_MAX
          ? current
          : [...current, like];
      setAnswer('interests', nextPicks.join(', ') as never);
    },
    [answers.interests, setAnswer],
  );

  const submit = useCallback(async () => {
    const complete: QuizAnswers = {
      gender: String(answers.gender ?? ''),
      everydayStyle: String(answers.everydayStyle ?? ''),
      palette: String(answers.palette ?? ''),
      dressCode: String(answers.dressCode ?? ''),
      boldness: Number(answers.boldness ?? 3),
      budgetBand: String(answers.budgetBand ?? ''),
      country: String(answers.country ?? ''),
      occupation: String(answers.occupation ?? ''),
      interests: String(answers.interests ?? ''),
    };
    if (
      !complete.everydayStyle || !complete.palette || !complete.dressCode ||
      !complete.budgetBand || !complete.gender || !complete.country || !complete.occupation
    ) {
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

  const skipQuiz = useCallback(() => {
    skipWithDefaults();
    setStep('selfie');
    router.replace('/onboarding/selfie-capture');
  }, [router, setStep, skipWithDefaults]);

  const goSelfie = useCallback(() => {
    setStep('selfie');
    router.replace('/onboarding/selfie-capture');
  }, [router, setStep]);

  // Result state: DNA teaser card (shareable, watermarked) — except the
  // skip path, whose result is a local starter style, never server-scored.
  // Fresh gallery shots of the kept personas ride the filmstrip above the
  // card — bundled lookbook frames, never the quiz-deck photos.
  if (result) {
    const keptLooks: DnaLook[] = result.starter
      ? []
      : dnaGalleryFor(splitPicks(answers.everydayStyle), String(answers.gender) === 'Womenswear');
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]} testID="quiz-result">
        <Text style={[styles.title, { color: colors.text }]}>
          {result.starter ? 'Your starter style' : 'Your style DNA'}
        </Text>
        {!result.starter && keptLooks.length > 0 ? <DnaFilmstrip looks={keptLooks} /> : null}
        {!result.starter && (
          <ShareCard
            teaser={typeof result.teaser === 'string' ? result.teaser : ''}
            labels={result.labels}
            colorSeason={result.colorSeason}
            watermark
            referralCode={referralCode}
          />
        )}
        {result.starter && (
          <Text style={[styles.hint, { color: colors.muted }]} testID="quiz-starter-note">
            Not AI-scored yet — take the quiz or add clothes and your DNA refines itself.
          </Text>
        )}
        <Pressable style={[styles.button, { backgroundColor: colors.primary }]} onPress={goSelfie} testID="quiz-continue">
          <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Continue to your photo</Text>
        </Pressable>
        <Pressable onPress={clearResult} testID="quiz-result-back">
          <Text style={[styles.hint, { color: colors.muted }]}>Back to answers</Text>
        </Pressable>
      </View>
    );
  }

  const isAbout = stepKey === 'about';

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="quiz-screen">
      <View style={styles.header}>
        <Text style={[styles.kicker, { color: colors.primary }]}>{label.kicker}</Text>
        <Text style={[styles.progress, { color: colors.muted }]} testID="quiz-progress">
          Step {stepIndex + 1} of {QUIZ_STEPS.length}
        </Text>
      </View>
      <Text style={[styles.title, { color: colors.text }]}>{label.title}</Text>
      <Text style={[styles.hint, { color: colors.muted }]}>{label.hint}</Text>

      {isAbout ? (
        <ScrollView style={styles.aboutScroll} contentContainerStyle={styles.aboutContent} showsVerticalScrollIndicator={false}>
          <Text style={[styles.aboutLabel, { color: colors.text }]}>Where do you live?</Text>
          <View style={styles.chipCloud}>
            {COUNTRIES.map((c) => (
              <Pressable
                key={c}
                onPress={() => {
                  setAnswer('country', c as never);
                  setError(null);
                }}
                style={[
                  styles.chip,
                  { backgroundColor: answers.country === c ? colors.primary : colors.surface, borderColor: colors.border },
                ]}
                testID={`quiz-country-${c.replace(/\W+/g, '-').toLowerCase()}`}
              >
                <Text
                  style={[styles.chipText, { color: answers.country === c ? colors.onPrimary : colors.text }]}
                  numberOfLines={1}
                >
                  {c}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.aboutLabel, { color: colors.text }]}>What do you do?</Text>
          <View style={styles.chipCloud}>
            {OCCUPATIONS.map((o) => (
              <Pressable
                key={o}
                onPress={() => {
                  setAnswer('occupation', o as never);
                  setError(null);
                }}
                style={[
                  styles.chip,
                  { backgroundColor: answers.occupation === o ? colors.primary : colors.surface, borderColor: colors.border },
                ]}
                testID={`quiz-occupation-${o.replace(/\W+/g, '-').toLowerCase()}`}
              >
                <Text
                  style={[styles.chipText, { color: answers.occupation === o ? colors.onPrimary : colors.text }]}
                  numberOfLines={1}
                >
                  {o}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.aboutLabel, { color: colors.text }]}>What do you love? (up to {LIKES_MAX})</Text>
          <View style={styles.chipCloud}>
            {LIKES.map((l) => (
              <Pressable
                key={l}
                onPress={() => toggleLike(l)}
                style={[
                  styles.chip,
                  { backgroundColor: likes.includes(l) ? colors.primary : colors.surface, borderColor: colors.border },
                ]}
                testID={`quiz-like-${l.replace(/\W+/g, '-').toLowerCase()}`}
              >
                <Text style={[styles.chipText, { color: likes.includes(l) ? colors.onPrimary : colors.text }]} numberOfLines={1}>
                  {l}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.choices}>
          {choices.map((c) => {
            const current = stepKey === 'gender' ? answers.gender : answers[storeKeyFor(stepKey)];
            const chosen = isMulti
              ? picks.includes(c)
              : typeof current === 'number'
                ? Number(c) === current
                : current === c;
            return (
              <Pressable
                key={c}
                onPress={() => choose(c)}
                style={[
                  styles.choice,
                  chosen
                    ? { backgroundColor: tokenColors.terracottaWash, borderColor: tokenColors.terracottaDeep }
                    : { backgroundColor: colors.surface, borderColor: colors.border },
                ]}
                testID={`quiz-choice-${c}`}
              >
                <View
                  style={[
                    styles.choiceDot,
                    chosen
                      ? { backgroundColor: tokenColors.terracottaDeep, borderColor: tokenColors.terracottaDeep }
                      : { borderColor: colors.border },
                  ]}
                  aria-hidden
                >
                  {chosen ? <View style={styles.choiceDotInner} /> : null}
                </View>
                <Text
                  style={[styles.choiceText, { color: chosen ? tokenColors.terracottaDeep : colors.text }]}
                  numberOfLines={1}
                >
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
        <Pressable
          style={[
            styles.button,
            { backgroundColor: canContinue ? colors.primary : colors.border },
          ]}
          onPress={() => {
            if (!canContinue || submitting) return;
            setError(null);
            if (isLast) void submit();
            else next();
          }}
          disabled={!canContinue || submitting}
          testID={isLast ? 'quiz-submit' : canContinue && isMulti ? 'quiz-multi-continue' : 'quiz-continue'}
        >
          {submitting ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={[styles.buttonText, { color: canContinue ? colors.onPrimary : colors.muted }]}>
              {isLast ? 'See my style DNA' : isMulti && picks.length > 0 ? `Continue (${picks.length} picked)` : 'Continue'}
            </Text>
          )}
        </Pressable>
        <View style={styles.footerRow}>
          {stepIndex > 0 ? (
            <Pressable onPress={back} testID="quiz-back">
              <Text style={[styles.hint, { color: colors.muted }]}>Back</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={skipQuiz} testID="quiz-skip">
            <Text style={[styles.hint, { color: colors.muted }]}>Skip and use a starter style</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  // Kicker in sentence case — a marker, not template chrome (the tracked
  // ALL-CAPS eyebrow is the generated look; the serif headline carries the
  // screen so the kicker stays quiet).
  kicker: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3 },
  progress: { fontSize: 12, fontWeight: '600' },
  title: { fontSize: 31, lineHeight: 37, fontWeight: '700', fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: -0.2, marginTop: 10 },
  hint: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  choices: { marginTop: 24, gap: 10 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  // Radio-dot language: the selected ring fills, its core is white — picking
  // a style reads as a committed mark, not a highlight.
  choiceDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceDotInner: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FFFFFF' },
  choiceText: { fontSize: 16, fontWeight: '600', flex: 1 },
  aboutScroll: { marginTop: 16, flex: 1 },
  aboutContent: { paddingBottom: 16 },
  aboutLabel: { fontSize: 15, fontWeight: '700', marginTop: 14, marginBottom: 8 },
  chipCloud: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 14 },
  chipText: { fontSize: 13, fontWeight: '600' },
  error: { fontSize: 13, marginTop: 10 },
  footer: { marginTop: 'auto', paddingBottom: 8 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  button: { borderRadius: 999, paddingVertical: 17, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
