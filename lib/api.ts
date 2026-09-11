/**
 * Typed wrappers for every Supabase Edge Function in the v1 cut scope.
 * Auth header is attached automatically by the supabase-js client.
 * All failures surface as ApiError with a stable `code` for UI mapping
 * (airplane-mode copy, quota upsell, login redirect).
 */
import { supabase } from './supabase';
import { FREE_LIFETIME_CAP, PREMIUM_MONTHLY_CAP } from '@/store/quotas';

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'QUOTA_EXCEEDED'
  | 'VALIDATION'
  | 'NETWORK'
  | 'SERVER'
  | 'V2_NOT_AVAILABLE';

export class ApiError extends Error {
  code: ApiErrorCode;
  status?: number;
  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Edge function names — v2-only fns are listed for explicit blocking. */
const FN = {
  quizScore: 'quiz-score',
  autoTag: 'auto-tag',
  planDay: 'plan-day',
  planWeek: 'plan-week',
  renderTryon: 'render-tryon',
  restyle: 'restyle',
  shopPicks: 'shop-picks',
  styleScore: 'style-score',
  coachDay: 'coach-day',
  evaluateInStore: 'evaluate-instore',
  paywallStatus: 'paywall-status',
  referralCredit: 'referral-credit',
  account: 'account',
  reelDrop: 'reel-drop',
  reelWeek: 'reel-week',
  reelRegenerate: 'reel-regenerate',
  pinterestAuth: 'pinterest-auth',
  pinterestSync: 'pinterest-sync',
  pinterestDisconnect: 'pinterest-disconnect',
  pinterestShare: 'pinterest-share',
  tasteBuild: 'taste-build',
} as const;

// ---------------------------------------------------------------- types ---

export type GarmentCategory =
  | 'top'
  | 'bottom'
  | 'dress'
  | 'outerwear'
  | 'shoes'
  | 'bag'
  | 'accessory'
  | 'onepiece'
  | 'active';

export interface Garment {
  id: string;
  imageUrl: string;
  cutoutUrl?: string | null;
  category: GarmentCategory;
  subcat?: string | null;
  colors: string[];
  fabric?: string | null;
  formality: number; // 1-5
  seasons: string[];
  brand?: string | null;
  pricePaid?: number | null;
  wearCount: number;
  costPerWear?: number | null;
  source: 'camera' | 'bulk' | 'receipt' | 'shop';
}

export interface QuizAnswers {
  everydayStyle: string;
  palette: string;
  dressCode: string;
  boldness: number; // 1-5
  budgetBand: string;
}

export interface QuizResult {
  styleDna: number[];
  labels: string[];
  colorSeason: string;
  teaser: string;
  fullReport?: string | null;
}

export interface PlannedOutfit {
  id: string;
  date: string;
  garmentIds: string[];
  wishlistIds: string[];
  whyLine: string;
  score?: number | null;
  weatherSummary?: string | null;
  eventLabel?: string | null;
}

export type RenderStatus = 'queued' | 'processing' | 'done' | 'failed';
export type RenderMode = 'tryon' | 'restyle' | 'compare';
export type RenderTier = 'std' | 'max';

export interface RenderJob {
  id: string;
  status: RenderStatus;
  outputUrl?: string | null;
  error?: string | null;
  /** Provider that produced the render (server-authoritative, for analytics). */
  model?: string | null;
  /** Server-authoritative USD cost (0 for cached/failed-free renders). */
  costUsd?: number | null;
  /** True when the server served a cached render for this idempotency key. */
  cached?: boolean;
}

export interface ProductPick {
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  rating?: number | null;
  retailer: string;
  affiliateUrl: string;
  badge?: 'Fills gap' | 'Own similar' | null;
  valueAddReason: string;
}

export type Tier = 'free' | 'trial' | 'premium';

export interface PaywallStatus {
  tier: Tier;
  trialEndsAt: string | null;
  /** Free: lifetime renders remaining out of 5. Premium: monthly remaining out of 30. */
  rendersLeft: number;
  /** Lifetime cap accounting (free tier). */
  lifetimeUsed: number;
  lifetimeCap: number;
  monthlyUsed: number;
  monthlyCap: number;
}

export interface StyleScore {
  total: number;
  fit: number;
  color: number;
  vers: number;
  occasion: number;
  percentile?: number | null;
}

export interface CoachTask {
  day: number;
  task: string;
  done: boolean;
}

export interface InStoreVerdict {
  matchScore: number;
  ownsSimilar: boolean;
  verdict: 'buy' | 'skip';
  reason: string;
}

/**
 * Weekly reel drop (shared exact contract — do not reshape).
 * Server: POST reel-drop {weekOf} → WeeklyDrop;
 *         POST reel-regenerate {cardId, note?} → ReelCard;
 *         GET reel-week {weekOf} → WeeklyDrop | null.
 */
export type ReelPose = 'front' | 'step' | 'detail';

export interface ReelCard {
  id: string;
  outfitId: string;
  renderId: string;
  imageUrl: string;
  pose: ReelPose;
  garmentIds: string[];
  whyLine: string;
  trendTag?: string;
  costUsd: number;
  createdAt: string;
}

export interface WeeklyDrop {
  weekOf: string;
  cards: ReelCard[];
  tier: 'teaser' | 'full';
}

/**
 * Pinterest taste graph (parallel backend crew — shapes below are tolerant).
 * Wire is snake_case; every mapper reads snake-first, camel-fallback.
 * - POST pinterest-auth {action:'auth-url'|'callback', …} → auth URL / session
 * - GET  pinterest-sync?action=list → `{ boards: [...] }` (or a bare array)
 * - POST pinterest-sync {action:'sync', board_ids?} → sync counts + pose pins
 * - POST pinterest-disconnect {} → purge confirm
 * - POST pinterest-share {render_id, board_id} → pin URL
 * - render-tryon / reel-regenerate accept `pose_mode` + `pose_ref_id`.
 */
export type PoseMode = 'keep' | 'adapt';

export interface PinterestBoard {
  boardId: string;
  name: string;
  pinCount: number;
  /** 'secret' (private) or 'public'. */
  privacy: string;
}

export interface PosePin {
  id: string;
  imageUrl: string;
  boardId?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface PinterestAuthUrl {
  authUrl: string;
  state: string | null;
  /** True while the Pinterest app is in trial sandbox (limited boards). */
  sandbox: boolean;
}

export interface PinterestCallbackResult {
  username: string | null;
  boards: PinterestBoard[];
  sandbox: boolean;
}

export interface PinterestSyncResult {
  boards: PinterestBoard[];
  boardsSynced: number;
  pinsImported: number;
  /** Pose-marked pins only (pin-picker source). */
  posePins: PosePin[];
}

export interface PinterestShareResult {
  url: string | null;
  pinId: string | null;
}

/**
 * Invisible-autopilot taste prefs (server: `taste-build` fn, migration 0006).
 * Single write surface `api.updateTastePrefs` sends snake_case
 * `{ sync_cadence, pose_mode_default, style_influence }`; the fn upserts the
 * prefs then (re)builds the week's taste_context. Reads are tolerant
 * (snake-first, camel-fallback); writes are canonical snake_case.
 */
export type SyncCadence = 'daily' | 'weekly' | 'off';
export type PoseModeDefault = 'auto' | 'keep' | 'adapt';

export interface TastePrefs {
  syncCadence: SyncCadence;
  poseModeDefault: PoseModeDefault;
  styleInfluence: number;
}

export interface TastePrefsPatch {
  syncCadence?: SyncCadence;
  poseModeDefault?: PoseModeDefault;
  styleInfluence?: number;
}

/**
 * Deletion modes for `DELETE /functions/v1/account` (docs/SECURITY.md §3).
 * `photos` purges base photo + renders (closet stays); `account` purges
 * everything and schedules the 30-day DB purge (ledger kept 13mo, anonymized).
 */
export type DeletionMode = 'photos' | 'account';

export interface DeletionResult {
  status: string;
  purge_after: string | null;
}

// ------------------------------------------------------------- invoke ---

/**
 * Loose server payload. Edge fns wrap success as `{ ok: true, data }`
 * (`supabase/functions/_shared/http.ts`) and errors as
 * `{ ok: false, error: { code, message } }` with the HTTP status on the
 * Response — NEITHER matches the old `{ message, status }` assumption, so
 * both are normalized here (P0-2/P0-3: envelope unwrap + real status codes).
 */
type FnOk = { data: unknown; error: unknown; response?: Response };

function mapStatusToCode(status?: number): ApiErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHENTICATED';
  if (status === 402 || status === 429) return 'QUOTA_EXCEEDED';
  if (status === 422 || status === 400) return 'VALIDATION';
  return 'SERVER';
}

function statusOf(err: unknown, response?: Response): number | undefined {
  const fromResponse = response?.status;
  if (typeof fromResponse === 'number') return fromResponse;
  const ctx = (err as { context?: { status?: unknown } } | null)?.context;
  if (ctx && typeof ctx.status === 'number') return ctx.status;
  const direct = (err as { status?: unknown } | null)?.status;
  return typeof direct === 'number' ? direct : undefined;
}

async function mapFnError(err: unknown, response?: Response): Promise<ApiError> {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError' || name === 'TypeError') {
    return new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
  }
  const status = statusOf(err, response);
  // Best-effort: surface the server's own `{ ok:false, error:{code,message} }`.
  let serverMessage: string | null = null;
  try {
    const body = (await response?.clone().json()) as unknown;
    const rec = isRecord(body) ? body : null;
    const inner = rec && isRecord(rec['error']) ? (rec['error'] as Record<string, unknown>) : null;
    const msg = inner?.['message'];
    if (typeof msg === 'string' && msg.length > 0) serverMessage = msg;
  } catch {
    // Fall through to the per-code copy below.
  }
  const code = mapStatusToCode(status);
  switch (code) {
    case 'UNAUTHENTICATED':
      return new ApiError(code, 'Please sign in to continue.', status);
    case 'QUOTA_EXCEEDED':
      return new ApiError(code, 'You are out of renders.', status);
    case 'VALIDATION':
      return new ApiError(code, serverMessage ?? 'Something went wrong. Please try again.', status);
    default:
      return new ApiError(code, serverMessage ?? 'Something went wrong. Please try again.', status);
  }
}

/** Success envelope `{ ok: true, data }` → inner payload (tolerant: raw passthrough otherwise). */
function unwrap<Res>(raw: unknown): Res {
  if (isRecord(raw) && raw['ok'] === true && 'data' in raw) return raw['data'] as Res;
  return raw as Res;
}

async function invoke<Req extends Record<string, unknown>, Res>(
  fn: string,
  body: Req,
  opts?: { headers?: Record<string, string>; method?: 'POST' | 'GET' | 'DELETE' },
): Promise<Res> {
  let res: FnOk;
  try {
    res = (await supabase.functions.invoke(fn, {
      body,
      ...(opts?.method ? { method: opts.method } : {}),
      ...(opts?.headers ? { headers: opts.headers } : {}),
    })) as FnOk;
  } catch {
    // functions.invoke throws on transport failure (airplane mode, DNS).
    throw new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
  }
  if (res.error) throw await mapFnError(res.error, res.response);
  return unwrap<Res>(res.data);
}

// ------------------------------------------------- snake<->camel mappers ---
//
// Canonical wire format is snake_case (CONTRACT-integrations §2 + edge fn
// headers). Every mapper below is tolerant on READ (snake first, camel
// fallback for transition responses) and canonical on WRITE.

type Loose = Record<string, unknown>;

function isRecord(v: unknown): v is Loose {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pickStr(...vs: unknown[]): string | null {
  for (const v of vs) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}

function pickNum(...vs: unknown[]): number | null {
  for (const v of vs) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

const GARMENT_CATEGORIES: GarmentCategory[] = [
  'top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory', 'onepiece', 'active',
];

function toCategory(v: unknown): GarmentCategory {
  const s = str(v)?.toLowerCase();
  return GARMENT_CATEGORIES.includes(s as GarmentCategory) ? (s as GarmentCategory) : 'top';
}

/** `plan-day` server `{ outfit_id, garment_ids, why_line, score, context }` → camel. */
function mapPlannedOutfit(raw: unknown, fallback: { date: string; eventLabel?: string }): PlannedOutfit {
  const r = isRecord(raw) ? raw : {};
  const ctx = isRecord(r['context']) ? (r['context'] as Loose) : {};
  const weather = isRecord(ctx['weather']) ? (ctx['weather'] as Loose) : {};
  const tempC = pickNum(weather['temp_c'], weather['tempC']);
  return {
    id: pickStr(r['outfit_id'], r['outfitId'], r['id']) ?? '',
    date: str(r['date']) ?? fallback.date,
    garmentIds: strArray(r['garment_ids'] ?? r['garmentIds']),
    wishlistIds: strArray(r['wishlist_ids'] ?? r['wishlistIds']),
    whyLine: pickStr(r['why_line'], r['whyLine']) ?? '',
    score: pickNum(r['score']),
    weatherSummary: tempC !== null ? `${Math.round(tempC)}°C` : null,
    eventLabel: pickStr(ctx['occasion'], ctx['event_label']) ?? fallback.eventLabel ?? null,
  };
}

/** `render-tryon` server `{ render_id, status, output_url, model, cost_usd, … }` → camel. */
function mapRenderJob(raw: unknown): RenderJob {
  const r = isRecord(raw) ? raw : {};
  const status = str(r['status']);
  const okStatus: RenderStatus =
    status === 'done' || status === 'failed' || status === 'processing' || status === 'queued'
      ? status
      : 'queued';
  return {
    id: pickStr(r['render_id'], r['renderId'], r['id']) ?? '',
    status: okStatus,
    outputUrl: pickStr(r['output_url'], r['outputUrl']),
    model: pickStr(r['model'], r['provider']),
    costUsd: pickNum(r['cost_usd'], r['costUsd']),
    cached: typeof r['cached'] === 'boolean' ? r['cached'] : undefined,
    error: pickStr(r['error'], r['error_code'], r['errorCode']),
  };
}

/** `shop-picks` item (camel canonical, snake-tolerant) → `ProductPick`. */
function mapProductPick(raw: unknown): ProductPick {
  const r = isRecord(raw) ? raw : {};
  const badgeRaw = str(r['badge']);
  return {
    productId: pickStr(r['productId'], r['product_id'], r['id']) ?? '',
    title: pickStr(r['title'], r['name']) ?? 'Untitled pick',
    imageUrl: pickStr(r['imageUrl'], r['image_url']) ?? '',
    price: pickNum(r['price'], r['salePrice']) ?? 0,
    rating: pickNum(r['rating']),
    retailer: pickStr(r['retailer'], r['brand']) ?? 'ShopStyle',
    affiliateUrl: pickStr(r['affiliateUrl'], r['affiliate_url'], r['clickUrl']) ?? '',
    badge: badgeRaw === 'Fills gap' || badgeRaw === 'Own similar' ? badgeRaw : null,
    valueAddReason: pickStr(r['valueAddReason'], r['value_add_reason']) ?? '',
  };
}

function mapShopPicks(res: unknown): ProductPick[] {
  const r = isRecord(res) ? res : null;
  const list = r && Array.isArray(r['picks']) ? r['picks'] : Array.isArray(res) ? res : [];
  return (list as unknown[]).map(mapProductPick);
}

export const REEL_POSES: ReelPose[] = ['front', 'step', 'detail'];

function toReelPose(v: unknown): ReelPose {
  const s = str(v)?.toLowerCase();
  if (REEL_POSES.includes(s as ReelPose)) return s as ReelPose;
  // EXPLICIT fallback (P2-1): unknown/missing poses degrade to 'front' rather
  // than crashing the pager — logged so corrupt payloads stay visible in dev.
  if (__DEV__) console.warn('[api] toReelPose: unknown pose, defaulting to front:', v);
  return 'front';
}

/** `reel-drop` / `reel-regenerate` server (snake canonical, camel-tolerant) → `ReelCard`. */
function mapReelCard(raw: unknown): ReelCard {
  const r = isRecord(raw) ? raw : {};
  return {
    id: pickStr(r['id'], r['card_id'], r['cardId']) ?? '',
    outfitId: pickStr(r['outfit_id'], r['outfitId']) ?? '',
    renderId: pickStr(r['render_id'], r['renderId']) ?? '',
    imageUrl: pickStr(r['image_url'], r['imageUrl']) ?? '',
    pose: toReelPose(r['pose']),
    garmentIds: strArray(r['garment_ids'] ?? r['garmentIds']),
    whyLine: pickStr(r['why_line'], r['whyLine']) ?? '',
    trendTag: pickStr(r['trend_tag'], r['trendTag']) ?? undefined,
    costUsd: pickNum(r['cost_usd'], r['costUsd']) ?? 0,
    createdAt: pickStr(r['created_at'], r['createdAt']) ?? new Date().toISOString(),
  };
}

/** `reel-drop` / `reel-week` server `{ week_of, cards: [...], tier }` → camel. */
function mapWeeklyDrop(res: unknown, fallbackWeekOf: string): WeeklyDrop {
  const r = isRecord(res) ? res : null;
  const list =
    r && Array.isArray(r['cards']) ? (r['cards'] as unknown[]) : Array.isArray(res) ? (res as unknown[]) : [];
  const tierRaw = r ? str(r['tier']) : null;
  // EXPLICIT fallback (P2-1): only 'teaser' selects the teaser tier — anything
  // else (including a corrupt value) renders as 'full'. Logged in dev: a
  // corrupt tier showing premium "Full drop" copy to free users must be loud.
  if (tierRaw !== 'teaser' && tierRaw !== 'full' && __DEV__) {
    console.warn('[api] mapWeeklyDrop: unknown tier, defaulting to full:', tierRaw);
  }
  return {
    weekOf: (r ? pickStr(r['week_of'], r['weekOf']) : null) ?? fallbackWeekOf,
    cards: list.map(mapReelCard).filter((c) => c.id.length > 0),
    tier: tierRaw === 'teaser' ? 'teaser' : 'full',
  };
}

/** `plan-week` server `{ start_date, week: [{ date, outfit_id, ...plan }] }` → camel list. */
function mapPlanWeek(res: unknown, fallbackStart: string): PlannedOutfit[] {
  const r = isRecord(res) ? res : null;
  const list =
    r && Array.isArray(r['week']) ? (r['week'] as unknown[]) : Array.isArray(res) ? (res as unknown[]) : [];
  return list.map((d) => mapPlannedOutfit(d, { date: fallbackStart }));
}

/** `pinterest-sync` board (snake canonical, camel-tolerant) → `PinterestBoard`. */
function mapPinterestBoard(raw: unknown): PinterestBoard {
  const r = isRecord(raw) ? raw : {};
  const privacyRaw = pickStr(r['privacy'], r['visibility'])?.toLowerCase();
  return {
    boardId: pickStr(r['board_id'], r['boardId'], r['id']) ?? '',
    name: pickStr(r['name'], r['title']) ?? 'Untitled board',
    pinCount: pickNum(r['pin_count'], r['pinCount'], r['pins']) ?? 0,
    privacy: privacyRaw === 'secret' || privacyRaw === 'private' ? 'secret' : 'public',
  };
}

/** `{ boards: [...] }` envelope (or a bare array) → `PinterestBoard[]`. */
function mapPinterestBoards(res: unknown): PinterestBoard[] {
  const r = isRecord(res) ? res : null;
  const list =
    r && Array.isArray(r['boards']) ? (r['boards'] as unknown[]) : Array.isArray(res) ? (res as unknown[]) : [];
  return (list as unknown[]).map(mapPinterestBoard).filter((b) => b.boardId.length > 0);
}

/** Pose-marked pin (snake canonical, camel-tolerant) → `PosePin`. */
function mapPosePin(raw: unknown): PosePin {
  const r = isRecord(raw) ? raw : {};
  return {
    id: pickStr(r['pin_id'], r['pinId'], r['id']) ?? '',
    imageUrl: pickStr(r['image_url'], r['imageUrl'], r['src'], r['url']) ?? '',
    boardId: pickStr(r['board_id'], r['boardId']),
    width: pickNum(r['width']),
    height: pickNum(r['height']),
  };
}

/** `pose_pins` (or pose-flagged `pins`) → pose-marked `PosePin[]` for the pin picker. */
function mapPosePins(res: unknown): PosePin[] {
  const r = isRecord(res) ? res : null;
  let list: unknown[] = [];
  if (r && Array.isArray(r['pose_pins'])) list = r['pose_pins'] as unknown[];
  else if (r && Array.isArray(r['posePins'])) list = r['posePins'] as unknown[];
  else if (r && Array.isArray(r['pins'])) {
    list = (r['pins'] as unknown[]).filter((p) => {
      const rec = isRecord(p) ? p : null;
      return rec?.['pose'] === true || rec?.['is_pose'] === true || rec?.['pose_marked'] === true;
    });
  } else if (Array.isArray(res)) {
    list = res as unknown[];
  }
  return list
    .map(mapPosePin)
    .filter((p) => p.id.length > 0 && p.imageUrl.length > 0);
}

/** `pinterest-auth` auth-url response (snake canonical, camel-tolerant). */
function mapPinterestAuthUrl(res: unknown): PinterestAuthUrl {
  const r = isRecord(res) ? res : {};
  return {
    authUrl: pickStr(r['auth_url'], r['authUrl'], r['url']) ?? '',
    state: pickStr(r['state']),
    sandbox: r['sandbox'] === true || r['trial'] === true || r['trial_sandbox'] === true,
  };
}

/** `pinterest-sync` response → counts + boards + pose pins. */
function mapPinterestSync(res: unknown): PinterestSyncResult {
  const r = isRecord(res) ? res : {};
  const boards = mapPinterestBoards(res);
  return {
    boards,
    boardsSynced: pickNum(r['boards_synced'], r['boardsSynced']) ?? boards.length,
    pinsImported: pickNum(r['pins_imported'], r['pinsImported']) ?? 0,
    posePins: mapPosePins(res),
  };
}

/**
 * `taste-build` prefs (server camelCase, snake-tolerant) → `TastePrefs`.
 * Corrupt/missing values degrade to the server defaults (weekly/auto/60) —
 * prefs must never crash Settings.
 */
function mapTastePrefs(res: unknown): TastePrefs {
  const root = isRecord(res) ? res : {};
  const r = isRecord(root['prefs']) ? (root['prefs'] as Loose) : root;
  const cadenceRaw = pickStr(r['sync_cadence'], r['syncCadence']);
  const poseRaw = pickStr(r['pose_mode_default'], r['poseModeDefault']);
  const influence = pickNum(r['style_influence'], r['styleInfluence']);
  return {
    syncCadence: cadenceRaw === 'daily' || cadenceRaw === 'off' ? cadenceRaw : 'weekly',
    poseModeDefault: poseRaw === 'keep' || poseRaw === 'adapt' ? poseRaw : 'auto',
    styleInfluence:
      influence !== null && Number.isInteger(influence) && influence >= 0 && influence <= 100
        ? influence
        : 60,
  };
}

/**
 * `auto-tag` server `{ garment (snake row), tags, cutout_fallback, … }` →
 * camel tag result with the REAL garment id (never `Date.now()`).
 */
export interface AutoTagResult {
  id: string;
  imageUrl: string;
  cutoutUrl: string | null;
  category: GarmentCategory;
  subcat: string | null;
  colors: string[];
  fabric: string | null;
  formality: number;
  seasons: string[];
  brand: string | null;
  pricePaid: number | null;
}

function mapAutoTag(res: unknown, fallbackImageUrl: string): AutoTagResult {
  const r = isRecord(res) ? res : {};
  // Legacy flat shape (transition): the whole payload is already the tag set.
  const garment = isRecord(r['garment']) ? (r['garment'] as Loose) : r;
  const tags = isRecord(r['tags']) ? (r['tags'] as Loose) : {};
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (garment[k] !== undefined && garment[k] !== null) return garment[k];
    }
    for (const k of keys) {
      if (tags[k] !== undefined && tags[k] !== null) return tags[k];
    }
    return undefined;
  };
  return {
    id: str(garment['id']) ?? '',
    imageUrl: pickStr(garment['image_url'], garment['imageUrl']) ?? fallbackImageUrl,
    cutoutUrl: pickStr(garment['cutout_url'], garment['cutoutUrl']),
    category: toCategory(pick('category')),
    subcat: pickStr(pick('subcat')),
    colors: strArray(pick('colors')),
    fabric: pickStr(pick('fabric')),
    formality: pickNum(pick('formality')) ?? 3,
    seasons: strArray(pick('seasons')),
    brand: pickStr(pick('brand')),
    pricePaid: pickNum(pick('price_paid'), pick('pricePaid')),
  };
}

/**
 * Canonical `paywall-status` server shape (flat camelCase — server wins):
 * `{ tier, trialing, trialEndsAt, renewsAt, rendersLeft, rendersCap,
 *    rendersUsedPeriod, quotaResetsAt, …, hardBlocked }`
 * → legacy `PaywallStatus` consumed by `store/paywall.ts` + `store/quotas.ts`.
 */
function mapPaywallStatus(res: unknown): PaywallStatus {
  const r = isRecord(res) ? res : {};
  const trialing = (r['trialing'] as unknown) === true;
  const serverTier = str(r['tier']);
  const tier: Tier = trialing ? 'trial' : serverTier === 'premium' ? 'premium' : 'free';
  const isFree = tier === 'free';
  const rendersLeft = pickNum(r['rendersLeft'], r['renders_left']) ?? 0;
  const rendersCap =
    pickNum(r['rendersCap'], r['renders_cap']) ?? (isFree ? FREE_LIFETIME_CAP : PREMIUM_MONTHLY_CAP);
  const usedPeriod =
    pickNum(r['rendersUsedPeriod'], r['renders_used_period']) ?? Math.max(0, rendersCap - rendersLeft);
  return {
    tier,
    trialEndsAt: pickStr(r['trialEndsAt'], r['trial_ends_at']),
    rendersLeft,
    // Server is quota truth; the mirror converges on every fetchStatus.
    // Premium never consults the free lifetime pool (mark it exhausted so a
    // stale tier read can't grant free renders), and vice versa.
    lifetimeUsed: isFree ? usedPeriod : FREE_LIFETIME_CAP,
    lifetimeCap: isFree ? rendersCap : FREE_LIFETIME_CAP,
    monthlyUsed: isFree ? 0 : usedPeriod,
    monthlyCap: isFree ? PREMIUM_MONTHLY_CAP : rendersCap,
  };
}

// ------------------------------------------------------------ wrappers ---

export const api = {
  scoreQuiz: (body: { answers: QuizAnswers; selfieUrl?: string }) =>
    invoke<typeof body, QuizResult>(FN.quizScore, body),

  /**
   * Canonical request `{ image_url, source }`; nested `{ garment, tags }`
   * snake response unwrapped (with the REAL garment id — never Date.now()).
   */
  autoTag: async (body: { imageUrl: string; source?: Garment['source'] }): Promise<AutoTagResult> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.autoTag, {
      image_url: body.imageUrl,
      source: body.source ?? 'camera',
    });
    return mapAutoTag(raw, body.imageUrl);
  },

  /**
   * Canonical request `{ date, occasion, ... }` (`eventLabel` has no server
   * param — `occasion` is the wire name); snake response mapped to camel so
   * the planner hero (chips, why-line) renders.
   */
  planDay: async (body: { date: string; eventLabel?: string }): Promise<PlannedOutfit> => {
    const req: Record<string, unknown> = { date: body.date };
    if (body.eventLabel) req['occasion'] = body.eventLabel;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.planDay, req);
    return mapPlannedOutfit(raw, { date: body.date, eventLabel: body.eventLabel });
  },

  /** Canonical request `{ start_date, ... }`; `{ week: [...] }` mapped to camel list. */
  planWeek: async (body: { startDate: string }): Promise<PlannedOutfit[]> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.planWeek, {
      start_date: body.startDate,
    });
    return mapPlanWeek(raw, body.startDate);
  },

  /**
   * Canonical `render-tryon` request (snake_case + `X-Idempotency-Key`
   * header). `outfitId` is OPTIONAL and must be a REAL outfit row id —
   * callers look it up via plan-day first and omit it otherwise (the server
   * renders from `garment_refs` alone; a fabricated id → `outfit_not_found`).
   */
  requestTryon: async (body: {
    outfitId?: string;
    basePhotoId?: string;
    garmentRefs: string[];
    mode: RenderMode;
    tier: RenderTier;
    idempotencyKey: string;
    /** YYYY-MM-DD — part of the server idempotency key. */
    day?: string;
    /** Restyle-via-render-tryon entry (mode 'restyle' routes to shared core). */
    renderId?: string;
    note?: string;
    /** 'keep' = wear on my base photo; 'adapt' = borrow the pose from poseRefId. */
    poseMode?: PoseMode;
    /** Pose-marked Pinterest pin id (required when poseMode is 'adapt'). */
    poseRefId?: string;
  }): Promise<RenderJob> => {
    const req: Record<string, unknown> = {
      garment_refs: body.garmentRefs,
      mode: body.mode,
      tier: body.tier,
      idempotency_key: body.idempotencyKey,
    };
    if (body.outfitId) req['outfit_id'] = body.outfitId;
    if (body.basePhotoId) req['base_photo_id'] = body.basePhotoId;
    if (body.day) req['day'] = body.day;
    if (body.renderId) req['render_id'] = body.renderId;
    if (body.note) req['note'] = body.note;
    if (body.poseMode) req['pose_mode'] = body.poseMode;
    if (body.poseRefId) req['pose_ref_id'] = body.poseRefId;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.renderTryon, req, {
      headers: { 'X-Idempotency-Key': body.idempotencyKey },
    });
    return mapRenderJob(raw);
  },

  /**
   * Canonical request `{ render_id, note, pose_mode?, pose_ref_id? }`; snake
   * response mapped to camel. Pose rides along so a restyle keeps the
   * currently selected pose (keep = base photo, adapt = pose-marked pin) —
   * mirrors `requestTryon` / `reelRegenerate` (gate 5).
   */
  restyle: async (body: {
    renderId: string;
    note: string;
    idempotencyKey?: string;
    /** 'keep' = wear on my base photo; 'adapt' = borrow the pose from poseRefId. */
    poseMode?: PoseMode;
    /** Pose-marked Pinterest pin id (required when poseMode is 'adapt'). */
    poseRefId?: string;
  }): Promise<RenderJob> => {
    const req: Record<string, unknown> = { render_id: body.renderId, note: body.note };
    if (body.idempotencyKey) req['idempotency_key'] = body.idempotencyKey;
    if (body.poseMode) req['pose_mode'] = body.poseMode;
    if (body.poseRefId) req['pose_ref_id'] = body.poseRefId;
    const raw = await invoke<Record<string, unknown>, unknown>(
      FN.restyle,
      req,
      body.idempotencyKey ? { headers: { 'X-Idempotency-Key': body.idempotencyKey } } : undefined,
    );
    return mapRenderJob(raw);
  },

  /**
   * Status poll via the edge `action: 'status'` read (ownership-checked,
   * resolves `cost_usd` from the ledger once done). The old direct-DB read
   * bypassed the edge and could never return cost/model — analytics depends
   * on this path (P0-3).
   */
  getRender: async (renderId: string): Promise<RenderJob> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.renderTryon, {
      action: 'status',
      render_id: renderId,
    });
    return mapRenderJob(raw);
  },

  /**
   * Canonical `reel-drop` request `{ week_of }`; `{ week_of, cards, tier }`
   * mapped to camel `WeeklyDrop`.
   */
  reelDrop: async (body: { weekOf: string }): Promise<WeeklyDrop> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.reelDrop, {
      week_of: body.weekOf,
    });
    return mapWeeklyDrop(raw, body.weekOf);
  },

  /**
   * Canonical `reel-week` read: GET with `week_of` on the query string
   * (functions-js sends no body on GET — params must be in the URL).
   * Resolves `null` when the server has no drop for the week yet (empty
   * envelope / null data); HTTP errors map via the shared ApiError copy.
   */
  reelWeek: async (body: { weekOf: string }): Promise<WeeklyDrop | null> => {
    const query = `${FN.reelWeek}?week_of=${encodeURIComponent(body.weekOf)}`;
    let res: FnOk;
    try {
      res = (await supabase.functions.invoke(query, { method: 'GET' })) as FnOk;
    } catch {
      throw new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
    }
    if (res.error) throw await mapFnError(res.error, res.response);
    if (res.data === null || res.data === undefined) return null;
    const unwrapped = unwrap<unknown>(res.data);
    if (unwrapped === null || unwrapped === undefined) return null;
    return mapWeeklyDrop(unwrapped, body.weekOf);
  },

  /**
   * Canonical `reel-regenerate` request `{ card_id, note?, pose_mode?, pose_ref_id? }`;
   * snake response mapped to camel `ReelCard` (caller swaps it into the drop).
   */
  reelRegenerate: async (body: {
    cardId: string;
    note?: string;
    poseMode?: PoseMode;
    poseRefId?: string;
  }): Promise<ReelCard> => {
    const req: Record<string, unknown> = { card_id: body.cardId };
    const note = body.note?.trim().slice(0, 280);
    if (note) req['note'] = note;
    if (body.poseMode) req['pose_mode'] = body.poseMode;
    if (body.poseRefId) req['pose_ref_id'] = body.poseRefId;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.reelRegenerate, req);
    return mapReelCard(raw);
  },

  /**
   * Canonical request `{ outfit_id?, gap? }`; `{ picks: [...] }` envelope
   * unwrapped to an array (never feed the envelope object to the grid).
   */
  shopPicks: async (body: { outfitId?: string; gapQuery?: string }): Promise<ProductPick[]> => {
    const req: Record<string, unknown> = {};
    if (body.outfitId) req['outfit_id'] = body.outfitId;
    if (body.gapQuery) req['gap'] = body.gapQuery;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.shopPicks, req);
    return mapShopPicks(raw);
  },

  styleScore: () => invoke<Record<string, never>, StyleScore>(FN.styleScore, {}),

  coachDay: (body: { day: number }) => invoke<typeof body, CoachTask>(FN.coachDay, body),

  evaluateInStore: (body: { imageUrl: string }) =>
    invoke<typeof body, InStoreVerdict>(FN.evaluateInStore, body),

  /**
   * Canonical flat-camelCase `paywall-status` response (server wins) mapped
   * onto the legacy `PaywallStatus` consumed by `store/paywall.ts` +
   * `store/quotas.ts` (QA3 P0-1).
   */
  paywallStatus: async (): Promise<PaywallStatus> => {
    const raw = await invoke<Record<string, never>, unknown>(FN.paywallStatus, {});
    return mapPaywallStatus(raw);
  },

  applyReferral: (body: { code: string }) =>
    invoke<typeof body, { ok: boolean; message: string }>(FN.referralCredit, body),

  /**
   * Request server-side deletion (docs/SECURITY.md §3 — GDPR Art. 17 /
   * Apple 5.1.1(v)). Auth via the supabase-js session JWT. The client clears
   * local state + routes ONLY after this resolves — never before.
   */
  requestDeletion: async (mode: DeletionMode): Promise<DeletionResult> => {
    let res: { data: unknown; error: { message?: string; status?: number } | null };
    try {
      res = await supabase.functions.invoke(FN.account, { method: 'DELETE', body: { mode } });
    } catch {
      throw new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
    }
    if (res.error) throw mapFnError(res.error);
    return res.data as DeletionResult;
  },

  // ---- pinterest taste graph ----

  /**
   * Canonical `pinterest-auth` auth-url request
   * (`{ action: 'auth-url', redirect_uri, include_secret_boards }`).
   * The app opens `authUrl` via `openAuthSessionAsync` with the
   * `vai://pinterest-callback` redirect, then completes with
   * `pinterestCallback`. `sandbox` flags the Pinterest trial sandbox
   * (limited boards until approval).
   */
  pinterestAuthUrl: async (body: {
    redirectUri: string;
    includeSecret: boolean;
  }): Promise<PinterestAuthUrl> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.pinterestAuth, {
      action: 'auth-url',
      redirect_uri: body.redirectUri,
      include_secret_boards: body.includeSecret,
    });
    return mapPinterestAuthUrl(raw);
  },

  /**
   * Canonical `pinterest-auth` callback (`{ action: 'callback', code, state? }`)
   * → connected username + board list (tolerant: bare array or `{ boards }`).
   */
  pinterestCallback: async (body: { code: string; state?: string }): Promise<PinterestCallbackResult> => {
    const req: Record<string, unknown> = { action: 'callback', code: body.code };
    if (body.state) req['state'] = body.state;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.pinterestAuth, req);
    const r = isRecord(raw) ? raw : {};
    return {
      username: pickStr(r['username'], r['user_name'], r['handle']),
      boards: mapPinterestBoards(raw),
      sandbox: r['sandbox'] === true,
    };
  },

  /**
   * Board list read: GET `pinterest-sync?action=list` (functions-js sends no
   * body on GET — params must be in the URL; same recipe as `reelWeek`).
   * Accepts `{ boards: [...] }` or a bare array; never throws on empty.
   */
  pinterestBoards: async (): Promise<PinterestBoard[]> => {
    const query = `${FN.pinterestSync}?action=list`;
    let res: FnOk;
    try {
      res = (await supabase.functions.invoke(query, { method: 'GET' })) as FnOk;
    } catch {
      throw new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
    }
    if (res.error) throw await mapFnError(res.error, res.response);
    if (res.data === null || res.data === undefined) return [];
    const unwrapped = unwrap<unknown>(res.data);
    if (unwrapped === null || unwrapped === undefined) return [];
    return mapPinterestBoards(unwrapped);
  },

  /**
   * Canonical `pinterest-sync` request (`{ action: 'sync', board_ids? }` —
   * omitted board_ids syncs every board the user granted).
   */
  pinterestSync: async (body: { boardIds?: string[] }): Promise<PinterestSyncResult> => {
    const req: Record<string, unknown> = { action: 'sync' };
    if (body.boardIds) req['board_ids'] = body.boardIds;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.pinterestSync, req);
    return mapPinterestSync(raw);
  },

  /**
   * Server-side taste purge. The client clears local boards + pose refs ONLY
   * after this resolves — never before (same rule as account deletion).
   */
  pinterestDisconnect: async (): Promise<{ purged: boolean }> => {
    const raw = await invoke<Record<string, never>, unknown>(FN.pinterestDisconnect, {});
    const r = isRecord(raw) ? raw : null;
    return { purged: r?.['purged'] !== false };
  },

  /**
   * Canonical `pinterest-share` request (`{ render_id, board_id }`) —
   * always behind an explicit user confirm, never auto-posted.
   */
  pinterestShare: async (body: { renderId: string; boardId: string }): Promise<PinterestShareResult> => {
    const raw = await invoke<Record<string, unknown>, unknown>(FN.pinterestShare, {
      render_id: body.renderId,
      board_id: body.boardId,
    });
    const r = isRecord(raw) ? raw : {};
    return {
      url: pickStr(r['share_url'], r['shareUrl'], r['url'], r['link']),
      pinId: pickStr(r['pin_id'], r['pinId'], r['id']),
    };
  },

  /**
   * THE single taste-prefs write surface (invisible autopilot). Sends
   * canonical snake_case `{ sync_cadence, pose_mode_default, style_influence }`
   * to `taste-build`, which upserts the prefs then (re)builds the week's
   * taste_context. Callers (store/taste-prefs) persist locally FIRST and call
   * this best-effort — a missing/rejecting fn must never crash Settings.
   */
  updateTastePrefs: async (patch: TastePrefsPatch): Promise<TastePrefs> => {
    const req: Record<string, unknown> = {};
    if (patch.syncCadence !== undefined) req['sync_cadence'] = patch.syncCadence;
    if (patch.poseModeDefault !== undefined) req['pose_mode_default'] = patch.poseModeDefault;
    if (patch.styleInfluence !== undefined) req['style_influence'] = patch.styleInfluence;
    const raw = await invoke<Record<string, unknown>, unknown>(FN.tasteBuild, req);
    return mapTastePrefs(raw);
  },

  /**
   * Taste-prefs status read: GET `taste-build` → `{ prefs, taste_context }`
   * (functions-js sends no body on GET — same recipe as `reelWeek`). Resolves
   * defaults when the server has no row yet; HTTP errors map via ApiError.
   */
  fetchTastePrefs: async (): Promise<TastePrefs> => {
    let res: FnOk;
    try {
      res = (await supabase.functions.invoke(FN.tasteBuild, { method: 'GET' })) as FnOk;
    } catch {
      throw new ApiError('NETWORK', 'You appear to be offline. Check your connection and try again.');
    }
    if (res.error) throw await mapFnError(res.error, res.response);
    if (res.data === null || res.data === undefined) {
      return { syncCadence: 'weekly', poseModeDefault: 'auto', styleInfluence: 60 };
    }
    return mapTastePrefs(unwrap<unknown>(res.data));
  },

  // ---- v2 (explicit cut scope — never call in v1) ----
  feedRank: (): Promise<never> =>
    Promise.reject(new ApiError('V2_NOT_AVAILABLE', 'Social feed ships in v2.')),
  scentMatch: (): Promise<never> =>
    Promise.reject(new ApiError('V2_NOT_AVAILABLE', 'Fragrance matching ships in v2.')),

  signOut: async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) throw new ApiError('SERVER', 'Could not sign out. Please try again.');
  },
};

/** UI copy for ApiError codes (airplane-mode + quota + auth mapping). */
export function apiErrorCopy(e: unknown): { title: string; message: string } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'NETWORK':
        return { title: 'You are offline', message: 'Check your connection and try again.' };
      case 'UNAUTHENTICATED':
        return { title: 'Session expired', message: 'Please sign in to continue.' };
      case 'QUOTA_EXCEEDED':
        return { title: 'Out of renders', message: 'Upgrade to keep creating try-ons.' };
      case 'VALIDATION':
        return { title: 'Could not complete', message: e.message };
      case 'V2_NOT_AVAILABLE':
        return { title: 'Coming soon', message: e.message };
      default:
        return { title: 'Something went wrong', message: 'Please try again in a moment.' };
    }
  }
  return { title: 'Something went wrong', message: 'Please try again in a moment.' };
}
