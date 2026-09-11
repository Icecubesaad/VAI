/**
 * VAI · Pinterest share-back copy composer (integrations turf).
 *
 * Builds honest, disclosure-free Pin copy from a finished look: the title,
 * description, and alt text name ONLY caller-supplied garment labels and
 * trend tags — brands are never invented (the input shape has no brand
 * field by design), there is no affiliate/sponsored language and no URLs,
 * so posting it triggers no paid-partnership disclosure. The description is
 * upfront that the image is a VAI virtual try-on, not a photograph.
 *
 * Length caps are Pinterest-contracted: title ≤ 100, description ≤ 800,
 * alt text ≤ 500. Over-long input is truncated on a word boundary with an
 * ellipsis — output NEVER exceeds the caps.
 *
 * Pure + unit-testable. No secrets, no network — BACKEND OWNS the actual
 * Pinterest publish call.
 */

export const PIN_TITLE_MAX = 100;
export const PIN_DESCRIPTION_MAX = 800;
export const PIN_ALT_MAX = 500;

export interface PinLookInput {
  /** Caller-supplied garment labels (e.g. "black blazer", "wide-leg jeans"). */
  garmentLabels: readonly string[];
  /** Trend tags without prefixes (e.g. "Office Siren"). */
  trendTags?: readonly string[];
  /** Planner/explainer line for the outfit, when available. */
  whyLine?: string;
}

export interface PinCopy {
  title: string;
  description: string;
  altText: string;
}

function clean(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Truncate to `max` chars without ever exceeding it. */
function fit(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Compose Pin title/description/alt for a look. Total — never throws on
 * thin input (empty labels fall back to an honest generic); never emits
 * brand names, prices, links, or sponsorship language.
 */
export function buildPinCopy(look: PinLookInput): PinCopy {
  const labels = look.garmentLabels.map(clean).filter((label) => label.length > 0);
  const trends = (look.trendTags ?? []).map(clean).filter((tag) => tag.length > 0);
  const hero = labels.length > 0 ? labels.join(' + ') : 'my own closet staples';
  const trendBit = trends.length > 0 ? ` — ${trends.join(', ')} energy` : '';
  const title = fit(`My VAI look: ${hero}${trendBit}`, PIN_TITLE_MAX);

  const parts: string[] = [];
  const why = look.whyLine !== undefined ? clean(look.whyLine) : '';
  if (why) parts.push(why);
  parts.push(labels.length > 0 ? `Wearing ${hero} from my own closet.` : 'Styled from my own closet.');
  if (trends.length > 0) parts.push(`Inspired by ${trends.join(', ')}.`);
  parts.push('Visualized with a VAI virtual try-on.');
  const description = fit(parts.join(' '), PIN_DESCRIPTION_MAX);

  const altText = fit(
    labels.length > 0
      ? `Virtual try-on photo of a person wearing ${hero}.`
      : 'Virtual try-on photo of a person showing their outfit.',
    PIN_ALT_MAX,
  );
  return { title, description, altText };
}
