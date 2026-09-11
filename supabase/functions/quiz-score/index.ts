// quiz-score — quiz + selfie answers → style DNA + labels + color season.
// POST { answers: { everyday_style, palette, dress_code, boldness 1-5,
//                   budget_band, body_shape?, fit_prefs?, undertone? },
//         selfie_url? }
// Response: { style_dna[64], labels, color_season, teaser, full_report|null }.
// The onboarding funnel shows the TEASER (shareable DNA card); the full report
// unlocks with trial/Premium — computed here, gated here, single source.

import { admin, requireUser } from "../_shared/auth.ts";
import { dna64, type QuizAnswers } from "../_shared/embed.ts";
import { generateJson } from "../_shared/gemini.ts";
import { badRequest, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { getEntitlementState } from "../_shared/quota.ts";

interface QuizBody {
  answers?: QuizAnswers;
  selfie_url?: string;
}

interface AiStyle {
  color_season?: unknown;
  style_labels?: unknown;
  palette_notes?: unknown;
}
const isAiStyle = (v: unknown): v is AiStyle => typeof v === "object" && v !== null;

const SEASONS = ["spring", "summer", "autumn", "winter"] as const;

function fallbackSeason(undertone: string | undefined, palette: QuizAnswers["palette"]): string {
  const u = (undertone ?? "").toLowerCase();
  const colors = (Array.isArray(palette) ? palette : String(palette ?? "").split(/[,/]/))
    .join(" ").toLowerCase();
  if (u.includes("warm")) return colors.includes("bright") ? "spring" : "autumn";
  if (u.includes("cool")) return colors.includes("muted") || colors.includes("soft") ? "summer" : "winter";
  if (colors.includes("bright") || colors.includes("jewel")) return "winter";
  if (colors.includes("muted") || colors.includes("soft")) return "summer";
  if (colors.includes("earth") || colors.includes("warm")) return "autumn";
  return "spring";
}

function validateQuiz(a: QuizAnswers, selfieUrl: unknown): void {
  if (!a || typeof a !== "object") throw badRequest("quiz_invalid", "answers object required");
  if (!a.everyday_style || !a.dress_code || !a.budget_band) {
    throw badRequest("quiz_incomplete", "everyday_style, dress_code and budget_band are required");
  }
  const b = Number(a.boldness);
  if (!Number.isFinite(b) || b < 1 || b > 5) {
    throw badRequest("quiz_invalid", "boldness must be 1–5");
  }
  if (a.selfie_url !== undefined && typeof a.selfie_url !== "string") {
    throw badRequest("quiz_invalid", "selfie_url must be a string");
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<QuizBody>(req);
    const answers: QuizAnswers = body.answers ?? {};
    validateQuiz({ ...answers, selfie_url: body.selfie_url } as QuizAnswers & { selfie_url?: string });

    const styleDna = dna64(answers);

    // AI polish: labels + season (temp 0, strict JSON). Deterministic fallback
    // keeps onboarding working when the model is unreachable — never a stub.
    let labels: string[] = [String(answers.everyday_style).toLowerCase()];
    let colorSeason = fallbackSeason(answers.undertone, answers.palette);
    let paletteNotes = "";
    try {
      const ai = await generateJson({
        system: "You are a professional stylist. Reply with JSON only: " +
          '{"color_season": "spring|summer|autumn|winter", "style_labels": ["<=4 short labels"], "palette_notes": "<=20 words"}.',
        user: `Quiz answers: ${JSON.stringify(answers)}. ` +
          "Infer the 12-season color season family (reply with the parent season only) and 3 style labels.",
        validate: (v): v is { color_season: string; style_labels: string[]; palette_notes: string } => {
          if (!isAiStyle(v)) return false;
          const o = v as { color_season?: unknown; style_labels?: unknown; palette_notes?: unknown };
          return typeof o.color_season === "string" && Array.isArray(o.style_labels) &&
            typeof o.palette_notes === "string";
        },
      });
      const season = ai.color_season.toLowerCase();
      if ((SEASONS as readonly string[]).includes(season)) colorSeason = season;
      const clean = ai.style_labels.map((l) => String(l).slice(0, 32)).filter(Boolean).slice(0, 4);
      if (clean.length > 0) labels = clean;
      paletteNotes = ai.palette_notes.slice(0, 140);
    } catch (e) {
      console.error("[quiz-score] AI polish failed, deterministic fallback", (e as Error).message);
      const dc = String(answers.dress_code).toLowerCase();
      if (dc) labels = [...labels, dc].slice(0, 4);
    }

    const sb = admin();
    const { error: upErr } = await sb.from("style_profiles").upsert({
      user_id: user.id,
      everyday_style: answers.everyday_style,
      palette: Array.isArray(answers.palette) ? answers.palette.join(", ") : (answers.palette ?? null),
      dress_code: answers.dress_code,
      boldness: Math.round(Number(answers.boldness)),
      budget_band: answers.budget_band,
      body_shape: answers.body_shape ?? null,
      fit_prefs: answers.fit_prefs ?? {},
      undertone: answers.undertone ?? null,
      color_season: colorSeason,
      style_dna: styleDna,
      style_labels: labels,
      quiz_version: 1,
    });
    if (upErr) throw upErr;

    const ent = await getEntitlementState(sb, user.id);
    const unlocked = ent.tier === "premium";

    return json({
      style_dna: styleDna,
      labels,
      color_season: colorSeason,
      teaser: {
        labels: labels.slice(0, 2),
        color_season_initial: colorSeason.charAt(0).toUpperCase(),
        archetype: labels[0] ?? null,
      },
      full_report: unlocked
        ? { labels, color_season: colorSeason, palette_notes: paletteNotes, dna_version: 1 }
        : null,
      full_locked: !unlocked,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
