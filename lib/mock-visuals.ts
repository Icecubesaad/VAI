/**
 * Dev-only mock visuals (__DEV__): generated SVG data-URIs so screens can be
 * reviewed without a closet, base photo or a live image model. Never ships —
 * every call site is gated behind `__DEV__`.
 */

function svgUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Full-body editorial "render" mock — the done-state hero. */
export function mockLookRender(label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="1000">` +
    `<defs><radialGradient id="g" cx="0.5" cy="0.25" r="0.9">` +
    `<stop offset="0" stop-color="#7E2438"/><stop offset="0.55" stop-color="#2A1218"/><stop offset="1" stop-color="#140D12"/>` +
    `</radialGradient></defs>` +
    `<rect width="750" height="1000" fill="url(#g)"/>` +
    `<ellipse cx="375" cy="880" rx="190" ry="34" fill="rgba(0,0,0,0.35)"/>` +
    // silhouette: head, torso, gown flare
    `<circle cx="375" cy="215" r="58" fill="#1D141C"/>` +
    `<path d="M300 300 Q375 265 450 300 L470 520 Q500 700 455 860 L295 860 Q250 700 280 520 Z" fill="#241820"/>` +
    `<path d="M330 340 Q375 320 420 340 L435 560 Q420 640 375 645 Q330 640 315 560 Z" fill="#6B2E44"/>` +
    `<rect x="262" y="820" width="226" height="26" rx="13" fill="rgba(243,236,228,0.14)"/>` +
    `<text x="375" y="150" font-family="Georgia, serif" font-size="30" fill="rgba(243,236,228,0.92)" text-anchor="middle" letter-spacing="4">${label.toUpperCase()}</text>` +
    `<text x="375" y="945" font-family="Helvetica, sans-serif" font-size="17" fill="rgba(243,236,228,0.55)" text-anchor="middle">MOCK RENDER · DEV PREVIEW</text>` +
    `</svg>`;
  return svgUri(svg);
}

/** Garment-cutout mock — chips when the closet is empty. */
export function mockGarment(tone: string, kind: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">` +
    `<rect width="300" height="400" fill="none"/>` +
    (kind === 'dress'
      ? `<path d="M110 70 Q150 55 190 70 L200 170 Q215 300 185 350 L115 350 Q85 300 100 170 Z" fill="${tone}"/>`
      : `<rect x="105" y="90" width="90" height="220" rx="28" fill="${tone}"/>`) +
    `<text x="150" y="382" font-family="Helvetica, sans-serif" font-size="20" fill="rgba(243,236,228,0.5)" text-anchor="middle">MOCK</text>` +
    `</svg>`;
  return svgUri(svg);
}
