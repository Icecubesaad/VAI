// auto-tag — garment photo → vision tags + cutout + embedding → garments row.
// POST { image_url (https), source?: camera|bulk|receipt|shop }
// Guards: auth, free 50-item closet cap. Cutout via the primary image model
// (isolate-on-white edit); falls back to the original URL with
// cutout_fallback=true — a documented degradation, never silent.

import { admin, requireUser } from "../_shared/auth.ts";
import { embeddingTokens, hash512 } from "../_shared/embed.ts";
import { generateImage, generateJson } from "../_shared/gemini.ts";
import { badRequest, handleOptions, json, readJson, requireMethod, toErrorResponse } from "../_shared/http.ts";
import { checkClosetCap, getEntitlementState } from "../_shared/quota.ts";

const CATEGORIES = [
  "top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "onepiece", "active",
] as const;
const SEASONS = ["ss", "fw", "all"] as const;
const KNOWN_COLORS = [
  "black", "white", "grey", "gray", "navy", "blue", "red", "pink", "green", "olive",
  "brown", "beige", "cream", "yellow", "orange", "purple", "teal", "burgundy", "khaki", "denim",
];

interface TagResult {
  category: string;
  subcat: string;
  colors: string[];
  fabric: string;
  formality: number;
  seasons: string[];
}

const isTagResult = (v: unknown): v is TagResult => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.category === "string" && typeof o.subcat === "string" &&
    Array.isArray(o.colors) && typeof o.fabric === "string" &&
    typeof o.formality === "number" && Array.isArray(o.seasons);
};

function coerceTags(raw: TagResult): TagResult {
  const category = (CATEGORIES as readonly string[]).includes(raw.category.toLowerCase())
    ? raw.category.toLowerCase()
    : "top";
  const colors = raw.colors.map((c) => String(c).toLowerCase().replace(/gray/g, "grey"))
    .filter((c) => KNOWN_COLORS.includes(c)).slice(0, 4);
  const seasons = raw.seasons.map((s) => String(s).toLowerCase())
    .filter((s): s is "ss" | "fw" | "all" => (SEASONS as readonly string[]).includes(s));
  return {
    category,
    subcat: String(raw.subcat ?? "").slice(0, 48) || category,
    colors: colors.length > 0 ? colors : ["black"],
    fabric: String(raw.fabric ?? "").slice(0, 48) || "unknown",
    formality: Math.min(5, Math.max(1, Math.round(raw.formality))),
    seasons: seasons.length > 0 ? seasons : ["all"],
  };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    requireMethod(req, "POST");
    const user = await requireUser(req);
    const body = await readJson<{ image_url?: string; source?: string }>(req);

    const imageUrl = body.image_url ?? "";
    if (!/^https:\/\//i.test(imageUrl)) throw badRequest("image_invalid", "image_url must be https");
    const source = body.source ?? "camera";
    if (!["camera", "bulk", "receipt", "shop"].includes(source)) {
      throw badRequest("source_invalid", "source must be camera|bulk|receipt|shop");
    }

    const sb = admin();
    const ent = await getEntitlementState(sb, user.id);
    const closetUsed = await checkClosetCap(sb, user.id, ent.tier); // throws 403 when free+full

    // 1. Vision tagging (temp 0, strict JSON).
    const tags = coerceTags(await generateJson({
      system: "You are a wardrobe cataloguer. Reply with JSON only: " +
        '{"category": "top|bottom|dress|outerwear|shoes|bag|accessory|onepiece|active", ' +
        '"subcat": "e.g. t-shirt, jeans, blazer", "colors": ["<=3 dominant colors, lowercase"], ' +
        '"fabric": "e.g. cotton, denim, wool", "formality": 1-5, "seasons": ["ss"|"fw"|"all"]}. ' +
        "One main garment only; ignore background clutter.",
      user: "Catalog the main garment in this photo.",
      imageUrls: [imageUrl],
      validate: isTagResult,
      timeoutMs: 45000,
    }));

    const embedding = hash512(embeddingTokens(tags));

    // 2. Insert first (need the id for a stable cutout path).
    const { data: garment, error: insErr } = await sb.from("garments").insert({
      user_id: user.id,
      image_url: imageUrl,
      cutout_url: imageUrl, // replaced below when the cutout edit succeeds
      category: tags.category,
      subcat: tags.subcat,
      colors: tags.colors,
      fabric: tags.fabric,
      formality: tags.formality,
      seasons: tags.seasons,
      embedding,
      source,
    }).select("id,image_url,category,subcat,colors,fabric,formality,seasons,wear_count,cost_per_wear")
      .single();
    if (insErr || !garment) throw insErr ?? new Error("Garment insert failed");

    // 3. Cutout via image edit; fallback = original (flagged, not silent).
    let cutoutFallback = false;
    try {
      const cutout = await generateImage({
        prompt: "Cut out the main garment precisely along its edges and place it centered " +
          "on a pure white (#FFFFFF) background. Preserve the garment's exact shape, " +
          "colors, print and texture. No person, no hanger, no shadows, no text.",
        refImageUrls: [imageUrl],
      });
      const path = `cutout/${user.id}/${(garment as { id: string }).id}.png`;
      const { error: upErr } = await sb.storage.from("garments").upload(path, cutout.bytes, {
        contentType: "image/png",
        upsert: true,
      });
      if (upErr) throw upErr;
      const { data: pub } = sb.storage.from("garments").getPublicUrl(path);
      await sb.from("garments").update({ cutout_url: pub.publicUrl })
        .eq("id", (garment as { id: string }).id);
      (garment as Record<string, unknown>).cutout_url = pub.publicUrl;
    } catch (e) {
      cutoutFallback = true;
      console.error("[auto-tag] cutout edit failed, using original", (e as Error).message);
    }

    return json({
      garment,
      tags,
      cutout_fallback: cutoutFallback,
      closet_used: closetUsed + 1,
      closet_limit: ent.tier === "free" ? 50 : null,
    }, 201);
  } catch (e) {
    return toErrorResponse(e);
  }
});
