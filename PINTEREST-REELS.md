# Pinterest Reels + Vogue Cover — product direction (founder, Sep 2026)

The AI-render reel (weekly drop) is paused in the UI: each drop rendered 4+
images per user per week — unsustainable API cost with no proven pull. The
rebuild below replaces generation with curation, and spends renders only at
the moments that create pull.

## The loop

1. **Interest catalog (no AI cost).** User connects Pinterest (pinterest-auth
   edge fn exists) or picks aesthetics at onboarding. `pinterest-sync` pulls
   their pins/boards into `style_pins` — a per-user taste catalog. This is
   curation, not generation.
2. **Editorial reels from the catalog.** The reel tab returns as a curated
   masonry feed (the "Vogue Outfit Genie" reference) built from the user's
   pins + matching shoppable picks — zero per-user renders. `reel_opened`,
   `reel_card_viewed`, `reel_shop_tap` already exist for it.
3. **Vogue cover of you (the narcissism hook).** When a user loves a look,
   ONE try-on render puts them in it, framed as a magazine cover: masthead,
   headline from their style DNA teaser, editorial pose, `vai.style/r/<code>`
   watermark. Share = invite (the growth loop), kept = wallpaper (retention).
   Premium-gated: cover renders draw from the 30/mo allowance like any render.

## Cost shape

| Surface | Cost |
|---|---|
| Pinterest sync + curation | $0 AI |
| Browsing reels | $0 |
| Cover render (on demand) | 1 std render (~$0.005–0.01 on flash-lite) |

## What exists vs. to build

- Exists: pinterest-auth / sync / share fns, `style_pins` + pose_refs
  (migration 0005), reel analytics events, ShareDNA/ShareCard + watermark,
  try-on pipeline (pose variation, white-bg output).
- To build (v2): curated-feed screen on style_pins, cover card layout
  (ShareDNA variant over the render output), cover share sheet wiring.
