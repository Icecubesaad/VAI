/**
 * Watermark helpers — viral attribution stamp.
 *
 * Printed on Style DNA cards + AI renders (pack §6/§9):
 *   `Made with VAI · vai.style/r/<code>`
 * Premium may MOVE the stamp, never remove it. Always rendered with an
 * "AI try-on · may differ from fit" label on renders (store compliance).
 */

export const WATERMARK_BASE_URL = 'https://vai.style/r';

export function buildReferralUrl(code: string): string {
  return `${WATERMARK_BASE_URL}/${code.trim()}`;
}

export function buildWatermarkText(code: string): string {
  return `Made with VAI · ${buildReferralUrl(code).replace('https://', '')}`;
}

/** Short AI-disclosure line required next to every render watermark. */
export const AI_DISCLOSURE = 'AI try-on · may differ from fit';
