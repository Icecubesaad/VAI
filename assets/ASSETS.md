# VAI app assets — exact spec + generation prompts

`app.json` expects these files (all paths relative to `VAI-app/`):
| File | Size | Used for |
|---|---|---|
| `./assets/icon.png` | **1024×1024** PNG, no alpha (iOS flattens) | App icon |
| `./assets/adaptive-icon.png` | **1024×1024** PNG, centered motif in safe **432dp circle** | Android adaptive foreground |
| `./assets/splash.png` | **1284×2778** PNG (portrait 9:19.5), motif centered in middle 40% | Expo splash (`resizeMode: contain` on `#FAF8F5`) |
| `./assets/notification-icon.png` | **96×96** PNG, white glyph on transparent, **no color** (Android tints) | Push icon (`expo-notifications`, tinted `#1A1A1A`) |
| `./assets/favicon.png` (web only, optional) | 48×48 | Expo web |

Brand: warm paper `#FAF8F5`, ink `#1A1A1A`, terracotta `#C65D3B`, sage `#66855F`.
Art direction (shared suffix for every prompt): "flat minimal vector mark, warm
minimalist fashion-tech brand, cream paper background #FAF8F5, terracotta #C65D3B
and ink #1A1A1A only, no gradients, no text, no letters, generous negative space,
premium Apple-tier app icon, crisp edges".

## Prompts (paste into an image model, then downscale exactly)

1. **icon.png** — "App icon: a minimal terracotta thread-needle loop forming an
   abstract 'V' inside a rounded squircle of warm cream #FAF8F5 with a thin ink
   #1A1A1A keyline border. {art-direction}" Export 1024×1024, strip alpha.
2. **adaptive-icon.png** — same mark, but motif must fit inside the center 50%
   (Android crops to a 432dp circle; keep 108dp padding on all sides).
   Background must be solid `#FAF8F5` (matches `adaptiveIcon.backgroundColor`).
3. **splash.png** — same mark at ~420px centered on a solid `#FAF8F5` canvas,
   1284×2778. Nothing else on canvas (name is rendered by the OS/splash API).
4. **notification-icon.png** — the 'V' thread mark ONLY, pure white `#FFFFFF`
   on transparent, 96×96, silhouette style (Android status bar forces alpha
   mask; any color will be ignored and look broken).

## Expo notes (SDK 57)
- Icons/splash are bundled via `app.json` (`icon`, `splash.image`,
  `android.adaptiveIcon`, `expo-notifications.icon`). No code import needed.
- After adding PNGs: `npx expo prebuild --clean` (regenerates native shells),
  then EAS dev-client build (Expo Go cannot test notifications/purchases).
- Validate: `npx expo-doctor`, iOS 1024 no-alpha check
  (`sips -g all assets/icon.png`), Android adaptive safe-zone preview in
  Android Studio Asset Studio.

## Placeholders
Until generated, keep `assets/.gitkeep` semantics: do NOT commit random stock
PNGs — a wrong-voice icon is worse than a missing one. The four `.md` stubs
below (`icon.md`, `splash.md`, `adaptive-icon.md`, `notification-icon.md`)
track generation status per file.
