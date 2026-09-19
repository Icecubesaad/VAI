import { Platform } from 'react-native';
import { useSession } from '@/store/session';
import { useCloset } from '@/store/closet';
import type { Garment } from '@/lib/api';

/**
 * QA bridge (dev + web ONLY) — drives browser QA of the signed-in surfaces
 * without a real account. Two localStorage switches read ONCE at boot:
 *
 *   localStorage['vai-qa-seed']  = JSON  → seeds session + closet stores
 *   localStorage['vai-qa-mocks'] = '1'   → stubs edge-function fetches
 *
 * Native builds and production never touch this file's behavior (`__DEV__`
 * gate + web gate). Garment/look imagery uses generated SVG data URIs so the
 * harness needs zero network. Remove both keys to return to the real funnel.
 */

const QA_SEED_KEY = 'vai-qa-seed';
const QA_MOCKS_KEY = 'vai-qa-mocks';

/** Tiny labeled "photo" — deterministic, offline, good enough to judge layout. */
function lookSvg(bg: string, accent: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${accent}"/>` +
    `</linearGradient></defs>` +
    `<rect width="600" height="800" fill="url(#g)"/>` +
    `<circle cx="300" cy="300" r="130" fill="rgba(255,255,255,0.35)"/>` +
    `<rect x="210" y="430" width="180" height="240" rx="60" fill="rgba(42,35,64,0.35)"/>` +
    `<text x="300" y="760" font-family="sans-serif" font-size="34" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function garmentSvg(bg: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">` +
    `<rect width="300" height="400" fill="${bg}"/>` +
    `<text x="150" y="210" font-family="sans-serif" font-size="30" fill="rgba(255,255,255,0.95)" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SEED_GARMENTS = [
  { id: 'g-top-1', category: 'top', formality: 2, colors: ['white'], label: 'Tee' },
  { id: 'g-top-2', category: 'top', formality: 4, colors: ['black'], label: 'Silk shirt' },
  { id: 'g-bottom-1', category: 'bottom', formality: 2, colors: ['blue'], label: 'Jeans' },
  { id: 'g-bottom-2', category: 'bottom', formality: 4, colors: ['grey'], label: 'Trousers' },
  { id: 'g-dress-1', category: 'dress', formality: 4, colors: ['green'], label: 'Dress' },
  { id: 'g-outer-1', category: 'outerwear', formality: 3, colors: ['beige'], label: 'Trench' },
  { id: 'g-shoes-1', category: 'shoes', formality: 2, colors: ['white'], label: 'Sneakers' },
  { id: 'g-shoes-2', category: 'shoes', formality: 4, colors: ['black'], label: 'Loafers' },
  { id: 'g-active-1', category: 'active', formality: 1, colors: ['purple'], label: 'Jersey' },
].map((g) => ({
  ...g,
  imageUrl: garmentSvg('#8B6CEF', g.label ?? g.id),
  cutoutUrl: garmentSvg(g.label === 'Trench' ? '#C9A227' : '#7C5CE0', g.label ?? g.id),
  subcat: null,
  fabric: null,
  seasons: ['all'],
  brand: 'QA',
  pricePaid: null,
  wearCount: 0,
  costPerWear: null,
  source: 'bulk' as const,
})) as unknown as Garment[];

const LOOKS = {
  city: lookSvg('#7C5CE0', '#4B3A8F', 'City Walk'),
  gallery: lookSvg('#F2A3DC', '#B8677E', 'Gallery Night'),
  studio: lookSvg('#8ED9B4', '#2F6B4F', 'Studio Layer'),
  weekend: lookSvg('#F5D06F', '#C97B4E', 'Weekend Run'),
  base: lookSvg('#CBC1EC', '#8B6CEF', 'You'),
};

function applySeed(): void {
  const raw = localStorage.getItem(QA_SEED_KEY);
  if (!raw) return;
  useSession.getState().setAuth({ userId: 'qa-user', email: 'qa@vai.style' });
  useSession.getState().setFunnelOwner('qa-user');
  useSession.getState().setOnboardingStep('done');
  useSession.getState().setBasePhoto({ id: 'qa-base', url: LOOKS.base, path: '' });
  useCloset.getState().addMany(SEED_GARMENTS);
}

type MockDef = { match: RegExp; status?: number; body: unknown };

function qaMocks(): MockDef[] {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      match: /\/functions\/v1\/plan-day/,
      body: {
        ok: true,
        data: {
          outfit_id: 'outfit-qa-hero',
          date: today,
          garment_ids: ['g-dress-1', 'g-shoes-2'],
          why_line: 'The dress carries the look; loafers keep it sharp for the evening.',
          context: { weather: { temp_c: 21 }, occasion: 'Dinner' },
        },
      },
    },
    {
      match: /\/functions\/v1\/plan-week/,
      body: {
        ok: true,
        data: {
          start_date: today,
          week: [
            { date: today, outfit_id: 'outfit-qa-hero', garment_ids: ['g-dress-1', 'g-shoes-2'], why_line: 'Hero day.' },
            { date: today, outfit_id: 'outfit-qa-2', garment_ids: ['g-top-1', 'g-bottom-1'], why_line: 'Easy day.' },
          ],
        },
      },
    },
    {
      match: /\/functions\/v1\/render-tryon/,
      body: { __kind: 'render-tryon' },
    },
    {
      match: /\/functions\/v1\/reel-week/,
      body: {
        ok: true,
        data: {
          week_of: today,
          tier: 'full',
          cards: [
            { id: 'card-1', outfit_id: 'outfit-qa-2', render_id: 'r1', image_url: LOOKS.city, pose: 'front', garment_ids: ['g-top-1', 'g-bottom-1', 'g-shoes-1'], why_line: 'Tee and jeans, brightened with white sneakers.', trend_tag: 'City Walk', cost_usd: 0.07 },
            { id: 'card-2', outfit_id: 'outfit-qa-hero', render_id: 'r2', image_url: LOOKS.gallery, pose: 'step', garment_ids: ['g-dress-1', 'g-shoes-2'], why_line: 'The dress does the talking — loafers ground it.', trend_tag: 'Gallery Night', cost_usd: 0.07 },
            { id: 'card-3', outfit_id: 'outfit-qa-3', render_id: 'r3', image_url: LOOKS.studio, pose: 'detail', garment_ids: ['g-top-2', 'g-bottom-2', 'g-outer-1'], why_line: 'Trench over silk; grey trousers finish the line.', trend_tag: 'Studio Layer', cost_usd: 0.07 },
            { id: 'card-4', outfit_id: 'outfit-qa-4', render_id: 'r4', image_url: LOOKS.weekend, pose: 'front', garment_ids: ['g-active-1', 'g-bottom-1', 'g-shoes-1'], why_line: 'Jersey off-duty with jeans and sneakers.', cost_usd: 0.07 },
          ],
        },
      },
    },
    {
      match: /\/functions\/v1\/reel-drop/,
      body: { __kind: 'reel-drop' },
    },
    {
      match: /\/functions\/v1\/quiz-score/,
      body: {
        ok: true,
        data: {
          style_dna: [0.8, 0.6, 0.4, 0.7, 0.5],
          labels: ['Minimal', 'Mono', 'Soft tailoring'],
          color_season: 'Cool Winter',
          teaser: 'You read clean, contrast-forward, and quietly sharp.',
        },
      },
    },
    {
      // Closet add-image QA: storage upload is a plain REST PUT (not
      // functions/v1), so it passes through untouched — only the auto-tag
      // call needs a stub. Returns a REAL-shaped tag so the funnel completes
      // offline in the browser harness.
      match: /\/functions\/v1\/auto-tag/,
      body: {
        ok: true,
        data: {
          garment: {
            id: 'g-qa-tagged',
            image_url: garmentSvg('#8B6CEF', 'Tagged'),
            cutout_url: null,
            category: 'top',
            subcat: null,
            colors: ['black'],
            fabric: 'cotton',
            formality: 3,
            seasons: ['all'],
            brand: null,
            price_paid: null,
          },
          tags: {},
        },
      },
    },
  ];
}

/** Patch window.fetch for edge-function routes only; everything else passes through. */
function installMocks(): void {
  const original = window.fetch.bind(window);
  const mocks = qaMocks();
  const weekOf = new Date().toISOString().slice(0, 10);
  const dropCards = {
    ok: true,
    data: {
      week_of: weekOf,
      tier: 'full',
      cards: [
        { id: 'card-1', outfit_id: 'outfit-qa-2', render_id: 'r1', image_url: LOOKS.city, pose: 'front', garment_ids: ['g-top-1', 'g-bottom-1', 'g-shoes-1'], why_line: 'Tee and jeans, brightened with white sneakers.', trend_tag: 'City Walk', cost_usd: 0.07 },
        { id: 'card-2', outfit_id: 'outfit-qa-hero', render_id: 'r2', image_url: LOOKS.gallery, pose: 'step', garment_ids: ['g-dress-1', 'g-shoes-2'], why_line: 'The dress does the talking — loafers ground it.', trend_tag: 'Gallery Night', cost_usd: 0.07 },
        { id: 'card-3', outfit_id: 'outfit-qa-3', render_id: 'r3', image_url: LOOKS.studio, pose: 'detail', garment_ids: ['g-top-2', 'g-bottom-2', 'g-outer-1'], why_line: 'Trench over silk; grey trousers finish the line.', trend_tag: 'Studio Layer', cost_usd: 0.07 },
        { id: 'card-4', outfit_id: 'outfit-qa-4', render_id: 'r4', image_url: LOOKS.weekend, pose: 'front', garment_ids: ['g-active-1', 'g-bottom-1', 'g-shoes-1'], why_line: 'Jersey off-duty with jeans and sneakers.', cost_usd: 0.07 },
      ],
    },
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = mocks.find((m) => m.match.test(url));
    if (hit) {
      let body: unknown = hit.body;
      const raw = typeof init?.body === 'string' ? init.body : '';
      if (hit.body && (hit.body as { __kind?: string }).__kind === 'render-tryon') {
        // One route serves three shapes: outfit-status (renders map),
        // a try-on request and status polls (job shape).
        body =
          raw.includes('outfit-status') || url.includes('outfit_ids') || url.includes('outfit-status')
            ? {
                ok: true,
                data: {
                  renders: {
                    'outfit-qa-hero': { render_id: 'r-hero', output_url: LOOKS.gallery, created_at: new Date().toISOString() },
                  },
                },
              }
            : {
                ok: true,
                data: {
                  render_id: 'r-new-' + Math.random().toString(36).slice(2, 7),
                  status: 'done',
                  output_url: LOOKS.city,
                  model: 'qa-mock',
                  cost_usd: 0.07,
                },
              };
      } else if (hit.body && (hit.body as { __kind?: string }).__kind === 'reel-drop') {
        body = dropCards;
      }
      return new Response(JSON.stringify(body), {
        status: hit.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return original(input, init);
  };
}

if (__DEV__ && Platform.OS === 'web' && typeof localStorage !== 'undefined') {
  try {
    if (localStorage.getItem(QA_SEED_KEY)) applySeed();
    if (localStorage.getItem(QA_MOCKS_KEY) === '1') installMocks();
  } catch {
    /* QA bridge must never block boot */
  }
}

export {};
