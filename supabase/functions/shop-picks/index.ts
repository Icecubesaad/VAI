// shop-picks — { outfit | gap } → shoppable cards via the affiliate resolver.
// POST { user_id?, outfit_id?, gap?, gap_query?, budget_band?, budget_max?,
//        limit?, action?: 'click', render_id?, click_id?, product_id?, retailer? }
// CANONICAL RESPONSE (`data` payload): { shoppable, picks, gaps, disclosure }
// where picks[] is the CONTRACT AffiliateProduct in camelCase:
//   { retailer, productId, title, imageUrl, price, currency?, rating?,
//     affiliateUrl, network, valueAddReason?, badge? }
// NULL-URL RULE (P0-5): imageUrl and affiliateUrl are NEVER null — products
// missing an image, click URL, or price are FILTERED OUT (a card that cannot
// render or check out is worse than no card). Without SHOPSTYLE_KEY there are
// no real products, so picks is [] (filtered, not nulled) and the client
// renders gap cards from `gaps`; shoppable:false marks the state honestly.
// CLICK LOG (CONTRACT §2): { action:'click', user_id, render_id, click_id,
//   product_id, retailer } → { ok:true }. Best-effort attribution memo only
//   (PostHog affiliate_click is the analytics source of truth); never blocks.
// Server-side resolver (build pack §7): ShopStyle Collective first,
// subid=user_id attribution, Skimlinks wrap when configured.

import { admin, requireUser } from "../_shared/auth.ts";
import { forbidden, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { fetchCloset } from "../_shared/plan.ts";

interface ShopBody {
  action?: unknown;
  user_id?: unknown;
  userId?: unknown;
  outfit_id?: unknown;
  outfitId?: unknown;
  gap?: unknown;
  gap_query?: unknown;
  gapQuery?: unknown;
  budget_max?: unknown;
  budgetMax?: unknown;
  budget_band?: unknown;
  budgetBand?: unknown;
  limit?: unknown;
  render_id?: unknown;
  click_id?: unknown;
  product_id?: unknown;
  retailer?: unknown;
}

/** Canonical camelCase pick (CONTRACT AffiliateProduct). URLs never null. */
interface CanonicalPick {
  retailer: string;
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  currency?: string;
  rating?: number;
  affiliateUrl: string;
  network: "shopstyle" | "ltk" | "skimlinks";
  valueAddReason?: string;
  badge?: "Fills gap" | "Own similar";
}

interface Gap {
  kind: "missing_category" | "missing_color" | "complement";
  label: string;
  query: string;
}

const CORE_CATEGORIES = ["outerwear", "shoes", "bag", "dress", "bottom", "top"];

/** Real gap analysis from the user's own closet (no API key needed). */
export function analyzeGaps(
  closet: Array<{ category: string | null; colors: string[] }>,
  palette: string | null,
): Gap[] {
  const gaps: Gap[] = [];
  const have = new Set(closet.map((g) => g.category ?? ""));
  for (const cat of CORE_CATEGORIES) {
    if (!have.has(cat)) {
      gaps.push({
        kind: "missing_category",
        label: `No ${cat} yet — one versatile piece unlocks 5+ outfits`,
        query: cat === "dress" ? "midi dress versatile" : `${cat} capsule wardrobe staple`,
      });
    }
  }
  // "6 black tops, no red" insight banner, verbatim from the build pack.
  const colorCount = new Map<string, number>();
  for (const g of closet) {
    for (const c of g.colors ?? []) colorCount.set(c.toLowerCase(), (colorCount.get(c.toLowerCase()) ?? 0) + 1);
  }
  const top = [...colorCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const paletteColors = (palette ?? "").toLowerCase().split(/[,/\s]+/).filter((t) => t.length > 2);
  const missing = paletteColors.find((p) => ![...colorCount.keys()].some((c) => c.includes(p) || p.includes(c)));
  if (top && top[1] >= 4 && missing) {
    gaps.push({
      kind: "missing_color",
      label: `${top[1]} ${top[0]} pieces, no ${missing} — one accent breaks the uniform`,
      query: `${missing} top`,
    });
  }
  return gaps.slice(0, 4);
}

function skimWrap(url: string, userId: string): string {
  const pubId = Deno.env.get("SKIMLINKS_PUB_ID");
  if (!pubId) return url;
  return `https://go.skimlinks.com/?id=${encodeURIComponent(pubId)}&url=${encodeURIComponent(url)}` +
    `&xcust=${encodeURIComponent(userId)}`;
}

interface ShopStyleProduct {
  id?: number | string;
  name?: string;
  price?: number;
  salePrice?: number;
  currency?: string;
  brand?: { name?: string };
  retailer?: { name?: string };
  image?: { sizes?: { Best?: { url?: string } } };
  clickUrl?: string;
  rating?: number;
}

async function shopStyleSearch(query: string, limit: number): Promise<ShopStyleProduct[]> {
  const pid = Deno.env.get("SHOPSTYLE_KEY");
  if (!pid) return [];
  const url = `https://api.shopstyle.com/api/v2/products?pid=${encodeURIComponent(pid)}` +
    `&fts=${encodeURIComponent(query)}&limit=${Math.min(25, Math.max(1, limit))}&offset=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ShopStyle HTTP ${res.status}`);
  const body = (await res.json()) as { products?: ShopStyleProduct[] };
  return body.products ?? [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** budget_max (number) canonical; budget_band strings ("under-75", "$50") → parsed cap. */
function parseBudgetCap(body: ShopBody): number | null {
  const direct = body.budget_max ?? body.budgetMax;
  if (typeof direct === "number" && direct > 0) return direct;
  const band = str(body.budget_band ?? body.budgetBand);
  if (band) {
    const m = band.replace(/,/g, "").match(/\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

const DISCLOSURE = "We may earn commission on recommended products — at no extra cost to you.";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<ShopBody>(req);

    // A body user_id that differs from the JWT subject is rejected — picks
    // carry subid=user_id attribution and must never be minted cross-user.
    const claimed = str(body.user_id ?? body.userId);
    if (claimed && claimed !== user.id) {
      throw forbidden("user_mismatch", "user_id does not match the signed-in session");
    }

    // ---- click attribution (best-effort memo; never blocks checkout)
    if (body.action === "click") {
      console.log("[shop-picks] click", {
        user_id: user.id,
        render_id: str(body.render_id),
        click_id: str(body.click_id),
        product_id: str(body.product_id),
        retailer: str(body.retailer),
      });
      return json({ ok: true });
    }

    const limit = Math.min(12, Math.max(1, Math.round(typeof body.limit === "number" ? body.limit : 6)));
    const outfitId = str(body.outfit_id ?? body.outfitId) ?? undefined;
    const gapQuery = str(body.gap ?? body.gap_query ?? body.gapQuery)?.slice(0, 80) ?? null;

    const sb = admin();
    const [closet, profile] = await Promise.all([
      fetchCloset(sb, user.id),
      sb.from("style_profiles").select("palette").eq("user_id", user.id)
        .maybeSingle<{ palette: string | null }>(),
    ]);
    const gaps = analyzeGaps(
      closet.map((g) => ({ category: g.category, colors: g.colors ?? [] })),
      profile?.palette ?? null,
    );

    let outfitNote: string | null = null;
    if (outfitId) {
      const { data: outfit } = await sb.from("outfits")
        .select("why_line,context").eq("id", outfitId).eq("user_id", user.id)
        .maybeSingle<{ why_line: string | null; context: unknown }>();
      if (outfit?.why_line) outfitNote = outfit.why_line;
    }

    // No affiliate key → honest gap analysis only. picks is [] (FILTERED, not
    // nulled — P0-5): the client renders gap cards from `gaps`.
    if (!Deno.env.get("SHOPSTYLE_KEY")) {
      return json({ shoppable: false, picks: [], gaps, disclosure: DISCLOSURE });
    }

    const queries = [
      gapQuery,
      ...gaps.map((g) => g.query),
      outfitNote ? "complete the look" : null,
    ].filter((q): q is string => !!q).slice(0, 3);
    if (queries.length === 0) queries.push("capsule wardrobe staple");

    const budgetMax = parseBudgetCap(body);

    const picks: CanonicalPick[] = [];
    for (const q of queries) {
      try {
        const products = await shopStyleSearch(q, limit);
        for (const p of products) {
          const price = p.salePrice ?? p.price ?? null;
          const imageUrl = p.image?.sizes?.Best?.url ?? null;
          const click = p.clickUrl ? `${p.clickUrl}&uid=${encodeURIComponent(user.id)}` : null;
          // NULL-URL RULE: drop anything without a renderable image, a
          // checkable-out URL, or a numeric price — never emit null URLs.
          if (price === null || !imageUrl || !click) continue;
          if (budgetMax !== null && price > budgetMax) continue;
          const pick: CanonicalPick = {
            retailer: p.retailer?.name ?? p.brand?.name ?? "ShopStyle",
            productId: String(p.id ?? `${p.retailer?.name ?? "shop"}:${p.name ?? q}`),
            title: p.name ?? q,
            imageUrl,
            price,
            affiliateUrl: skimWrap(click, user.id),
            network: "shopstyle",
            valueAddReason: q === gapQuery
              ? "Matches what you asked for"
              : (gaps.find((g) => g.query === q)?.label ?? "Complements your palette"),
          };
          if (typeof p.currency === "string" && p.currency) pick.currency = p.currency;
          if (typeof p.rating === "number") pick.rating = p.rating;
          if (q === gapQuery || gaps.some((g) => g.query === q)) pick.badge = "Fills gap";
          picks.push(pick);
          if (picks.length >= limit) break;
        }
      } catch (e) {
        console.error("[shop-picks] query failed", q, (e as Error).message);
      }
      if (picks.length >= limit) break;
    }

    return json({
      shoppable: picks.length > 0,
      picks: picks.slice(0, limit),
      gaps,
      disclosure: DISCLOSURE,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
});
