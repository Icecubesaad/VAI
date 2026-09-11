# VAI UI kit — usage

Light-mode only (v1). All components are NativeWind-styled, strict-TS,
memoized where list-rendered, and carry `accessibilityLabel`s. Wrap the app
in `ThemeProvider` (see its docstring for gluestack composition order) and
import `../global.css` in `app/_layout.tsx`.

```tsx
import { ThemeProvider } from '@/theme/ThemeProvider';
import { Button, PremiumCTA } from '@/components/Button';
```

## Button / PremiumCTA (`components/Button.tsx`)

```tsx
<Button title="Generate try-on" onPress={generate} />
<Button title="Save" variant="secondary" size="sm" onPress={save} />
<PremiumCTA title="Start free trial" subtitle="$4.99/mo after" onPress={buy} />
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `title` | `string` | — | Button label |
| `onPress` | `() => void` | — | Fires after haptic |
| `variant` | `primary \| secondary \| ghost \| premium \| danger \| dev` | `primary` | Terracotta / white / quiet / black / red / dashed dev-login |
| `size` | `sm \| md \| lg` | `md` | |
| `loading` | `boolean` | `false` | Spinner, disables press |
| `disabled` | `boolean` | `false` | 50% opacity |
| `haptic` | `confirm \| select \| none` | auto | `confirm` for primary/premium |
| `accessibilityLabel/Hint` | `string` | `title` | |

`PremiumCTA` adds `subtitle?: string` (price line inside the black pill).
Reserve it for money moments (paywall, quota upsell, trial start).

`variant="dev"` is the dashed dev-login style for onboarding debug entry
points only — never ship it on production paths.

## Card (`components/Card.tsx`)

```tsx
<Card><Text>Insights go here</Text></Card>
<Card padded={false}>{/* media bleeds to edges */}</Card>
```

| Prop | Default | Notes |
|---|---|---|
| `elevated` | `true` | Hairline border + warm shadow |
| `padded` | `true` | `p-lg`; set false for full-bleed media |

## GarmentCard (`components/GarmentCard.tsx`)

```tsx
<GarmentCard
  garment={{ id, imageUrl, category: 'Blazer', colors: ['Navy'], fabric: 'Wool', formality: 4, wearCount: 6, costPerWear: 12.5 }}
  onPress={(id) => openDetail(id)}
/>
```

Fixed 3:4 media — safe in FlashList (`numColumns={3}`, no per-item measure).
Badges auto-derive: wear count, `$/wear` (sage), `Dressy` at formality ≥ 4.

| Prop | Type | Notes |
|---|---|---|
| `garment` | `Garment` | `category` + `id` required; rest optional |
| `onPress` | `(id: string) => void` | Optional — card renders static without it |
| `selected` | `boolean` | Terracotta ring for outfit-builder multi-select |

## OutfitCard (`components/OutfitCard.tsx`)

```tsx
<OutfitCard
  imageUrl={hero}
  title="Monday — Studio day"
  whyLine="Navy blazer echoes your sneakers; wool keeps you warm to 14°."
  weatherChip="14° · Light rain"
  eventChip="Office"
  onTryOn={generate} onRestyle={restyle} onSave={save} saved={false}
/>
```

Fixed 4:5 media. Omit any action prop to hide that button (free tier can
hide Restyle; v1 hides week-strip actions by simply not passing handlers).

## Badge (`components/Badge.tsx`)

```tsx
<Badge label="Fills gap" tone="terracotta" />
<Badge label="Own similar" tone="gold" />
<Badge label="AI try-on · may differ from fit" tone="ink" />
```

Tones: `neutral | terracotta | sage | gold | ink | danger`.

## CounterBadge (`components/CounterBadge.tsx`)

```tsx
<CounterBadge remaining={3} total={5} onUpgrade={() => setPaywall(true)} />
```

Renders pip meter + "3 of 5 left" + one-tap `Get more`/`Upgrade` pill.
`remaining <= 0` flips to the exhausted (terracotta) state — never render a
dead-end counter without the upgrade path.

## Sheet / PaywallSheet (`components/Sheet.tsx`)

```tsx
<Sheet
  visible={paywall}
  onClose={() => setPaywall(false)}
  onPurchase={(plan, withTrial) => buy(plan, withTrial)}
  onRestore={restore}
  placement="quota-exhausted"
  initialPlan="yearly"
/>
```

Plan cards: Monthly `$4.99` / Yearly `$39.99` (BEST VALUE). Trial toggle
defaults ON; the line under the CTA is the honest same-screen copy, e.g.
`7 days free, then $4.99/mo · cancel anytime · no charge today`. Includes
Restore + Privacy/Terms links and the downgrade-keeps-data note.
`PaywallSheet` is an alias — import whichever name reads better.
Helper `trialLine(plan, withTrial)` and `PLAN_META` (product ids
`vai_premium_monthly` / `vai_premium_yearly`) are exported for receipts.

## SelfieGuide (`components/SelfieGuide.tsx`)

```tsx
<SelfieGuide
  checks={[{ key: 'light', ok: false, hint: 'Face a window — backlight detected' }]}
  failureReason={null}
  onCapture={capture} onRetake={retake} capturing={false}
/>
```

Ghost-silhouette overlay (dashed SVG, absolute-positioned so the camera
preview never re-lays-out) + good/bad hint panels + inline failure alert
+ consent line. `failureReason` is a machine string from the on-device
checks (blur / luminance / face / keypoints).

## Skeleton (`components/Skeleton.tsx`)

```tsx
{SkeletonGrid} // closet loading — matches GarmentCard 3:4 cells
{SkeletonHero} // planner loading — matches OutfitCard 4:5
<Skeleton className="h-[20px] w-1/2" /> // one-off line
```

Opacity-only shimmer on the native driver; geometries match the real cards
so content swaps without layout shift. `SkeletonTasteRow` matches
`InspirationRow` (avatar dot + two lines + chevron) for the syncing-taste
settings state.

## EmptyState (`components/EmptyState.tsx`)

```tsx
<EmptyState
  title="Your closet is a blank canvas"
  body="Add 3 pieces to unlock your first AI outfit."
  actionTitle="Add your first piece" onAction={add}
/>
<EmptyState variant="offline-cached" title="No fresh boards" body="…" />
```

`variant="offline-cached"` adds the `Offline · saved on this device`
eyebrow for surfaces rendering cached content with no connection.

## ErrorView (`components/ErrorView.tsx`)

```tsx
<ErrorView message={err} onRetry={retry} />
<ErrorView offline onRetry={retry} /> // airplane-mode copy built in
<ErrorView offline cached onRetry={retry} /> // + "last saved version" caption
```

`cached` (typically paired with `offline`) adds the "Showing your last
saved version — we'll refresh when you're back." caption for surfaces that
stay usable from cache through the failure.

## ShareDNA (`components/ShareDNA.tsx`)

```tsx
const ref = useRef<ViewShot>(null);
<ShareDNA ref={ref} name="Maya" styleLabels={['Minimal', 'Soft Tailoring']}
  colorSeason="Soft Autumn" palette={['#C65D3B', '#66855F']} referralCode="MAYA12" />
const uri = await captureShareDNA(ref); // → Share.share({ url: uri })
```

Fixed 4:5 (exports 1080×1350 jpg). Watermark + referral URL baked in.

## Watermark (`components/Watermark.tsx`, `lib/watermark.ts`)

```tsx
<Watermark code="MAYA12" tone="light" />
buildWatermarkText('MAYA12') // "Made with VAI · vai.style/r/MAYA12"
buildReferralUrl('MAYA12')   // "https://vai.style/r/MAYA12"
```

## ReelCard (`components/ReelCard.tsx`)

```tsx
<ReelCard
  card={{ id, outfitId, renderId, imageUrl, pose: 'front', garmentIds, whyLine, trendTag: 'Quiet luxury', costUsd: 42, createdAt }}
  onWear={logToday} onTry={preview} onShop={shop} onSave={save} onRegenerate={remix}
  saved={false}
  garmentThumbs={{ [garmentId]: thumbUrl }}
  quotaLeft={3} quotaCap={5} onUpgrade={openPaywall}
/>
```

Full-screen pager cell (`flex-1`, expo-image cover). Top scrim: pose chip
(`Front fit` / `Street step` / `Detail`) + `✦ trendTag` chip + quota pill
(`"3 of 5 left"` + upgrade) or cost context (`$42 · 4 pcs`). Bottom paper
sheetlet: garment chips with tiny thumbs (first 4 + `+N`), 2-line why-line,
mandatory `AI styled · may differ from fit` microcopy, `Wear it today`
primary + Try / Shop / Save / Remix icon-buttons (rendered only when their
handler is passed). Double-tap the photo = save + native-driver heart
burst. `loading` renders the pager shimmer; `error` renders the failed
variant with free retry (`onRetry ?? onRegenerate`).

| Prop | Type | Notes |
|---|---|---|
| `card` | `ReelCard` | `{id,outfitId,renderId,imageUrl,pose,garmentIds,whyLine,trendTag?,costUsd,createdAt}` |
| `onWear/onTry/onShop/onSave/onRegenerate` | `() => void` | Optional — omit to hide that action |
| `saved` | `boolean` | Save pill active state |
| `garmentThumbs` | `Record<string,string>` | Thumb urls keyed by garment id |
| `quotaLeft/quotaCap/onUpgrade` | `number/number/() => void` | Quota pill; cost pill when absent |
| `error/onRetry/retrying` | `string/() => void/boolean` | Failed variant |
| `loading` | `boolean` | Skeleton variant |

## PoseGuide (`components/PoseGuide.tsx`)

```tsx
<PoseGuide pose={pose} onPoseChange={setPose} onCapture={capture} onRetake={retake} capturing={false} />
```

3-pose capture guide for the reel loop (`front` fit-pic / `step` mid-step
street / `detail` seated detail): per-pose ghost silhouette (dashed SVG,
static layout) + dos/donts panels + inline failure alert + consent line —
same language and layout as `SelfieGuide` so capture feels like one flow.
Pose selector pills render only when `onPoseChange` is passed.

| Prop | Type | Notes |
|---|---|---|
| `pose` | `front \| step \| detail` | Active pose |
| `onPoseChange` | `(pose) => void` | Optional — shows the selector |
| `checks/failureReason` | `PoseCheck[]/string` | Same fail contract as SelfieGuide |
| `onCapture/onRetake/capturing` | | Same button contract as SelfieGuide |

## ReelSkeleton (`components/ReelSkeleton.tsx`)

```tsx
<FlatList data={loading ? PLACEHOLDERS : cards} renderItem={loading ? () => <ReelSkeleton /> : renderCard} pagingEnabled />
```

Full-screen pager shimmer matching `ReelCard` geometry (photo field + top
chips + bottom sheetlet). Opacity-only native-driver pulse, no layout
shift on swap. `ReelCard loading` renders this internally.

## lib/haptics.ts

```tsx
import { haptic, hapticFor } from '@/lib/haptics';
hapticFor.confirm(); // primary CTAs · hapticFor.select() // chips/toggles
hapticFor.blocked(); // paywall hits · hapticFor.done(); // render ready
```

Fire-and-forget, never throws. Buttons already trigger haptics — call these
only for non-button moments (sheet appear, quota hit, async completion).

## PoseToggle (`components/PoseToggle.tsx`)

```tsx
<PoseToggle mode={mode} onChange={setMode} pinThumb={pin.thumbUrl} />
```

Segmented `[My pose | Pin pose]` with pose-dot preview (pin thumb when
provided, glyph dot otherwise) + `select` haptic. Radiogroup semantics;
selection drives the sliding thumb (native driver).

| Prop | Type | Notes |
|---|---|---|
| `mode` | `mine \| pin` | Active source |
| `onChange` | `(mode) => void` | Fires only on change |
| `pinThumb` | `string \| null` | Pin-dot preview image |

## PinGrid (`components/PinGrid.tsx`)

```tsx
<PinGrid pins={pins} selectedId={sel} onSelect={setSel} onRetry={refetch} onEmptyAction={pickBoard} />
```

Memo 3-col picker (`numColumns={3}`, fixed 3:4 cells). expo-image thumbs;
`fullUrl` prefetched once per pin as cells near the viewport (50%
visibility). Pose-marked pins show the `◐ stance` badge; selection shows
the terracotta ring + check. Loading → closet shimmer; empty → `EmptyState`;
error → `ErrorView` (with `onRetry`) or a static alert without.

| Prop | Type | Notes |
|---|---|---|
| `pins` | `PinItem[]` | `{id,thumbUrl,fullUrl?,title?,poseMarked?,stanceLabel?}` |
| `selectedId/onSelect` | `string \| null / (id) => void` | Single-select ring |
| `loading/error/onRetry/retrying` | | Kit-standard async states |
| `onEmptyAction/emptyActionTitle` | | Empty-state CTA (default "Choose a board") |
| `scrollEnabled` | `boolean` | Default `true` |

## PinPoseCompare (`components/PinPoseCompare.tsx`)

```tsx
<PinPoseCompare mineUrl={selfie} pinUrl={pin.fullUrl} stanceLabel="Mid-step street" onUsePose={apply} />
```

Side-by-side Mine-vs-Pin (two fixed 3:4 frames, no layout shift on swap) +
stance caption + one `Use this pose` CTA. Missing `mineUrl` renders the
dashed placeholder, never a void.

| Prop | Type | Notes |
|---|---|---|
| `mineUrl` | `string \| null` | Your photo; placeholder when absent |
| `pinUrl/pinTitle` | `string / string?` | Pin frame + source line |
| `stanceLabel/stanceHint` | `string / string?` | Pose caption |
| `onUsePose/using` | `() => void / boolean` | Explicit apply tap |

## ShareBackSheet (`components/ShareBackSheet.tsx`)

```tsx
<ShareBackSheet
  visible={share} onClose={close}
  boards={boards} selectedBoardId={bid} onSelectBoard={setBid}
  onConfirm={post} posting={busy} postedUrl={url} error={err}
/>
```

Board radio rows (cover + name + Pins/Secret meta) + explicit confirm —
button reads `Post 1 Pin to <board>?` and stays disabled until a board is
picked. Success state shows the posted confirmation + `Open in Pinterest`
link. Consent line on every pre-post render: VAI never auto-posts.
Helper `shareConfirmLabel(boardName)` exported for reuse.

| Prop | Type | Notes |
|---|---|---|
| `boards` | `ShareBackBoard[]` | `{id,name,coverUrl?,pinCount?,secret?}` |
| `selectedBoardId/onSelectBoard` | | Radio single-select |
| `onConfirm/posting` | `() => void / boolean` | ONLY post path — deliberate tap |
| `postedUrl/error` | `string?` | Success flip / inline alert |

## PinterestConsent (`components/PinterestConsent.tsx`)

```tsx
<PinterestConsent secretOptIn={secretScope} />
```

Connect-screen consent block: what we read (boards + Pins, secret only if
opted in) · what we store (IDs + image URLs + titles for styling) · purge
on disconnect · never auto-post. Pure copy — OAuth is frontend's turf.

| Prop | Type | Notes |
|---|---|---|
| `secretOptIn` | `boolean` | Adds the secret-boards line |

## TasteCadence (`components/TasteCadence.tsx`)

```tsx
<TasteCadence value={cadence} onChange={setCadence} lastSyncCaption="Last synced Tue 9:41 AM" />
<TasteCadence value={cadence} onChange={setCadence} syncing />
```

Row 2 of the two-row invisible-Pinterest settings surface (row 1 is
`InspirationRow`). Segmented Daily / Weekly / Off with the sliding thumb +
radiogroup semantics of `PoseToggle`, the product microcopy ("Fresh
inspiration for your reel, automatically"), and an optional last-sync
caption. `syncing` flips the caption to "Syncing taste…" and locks input.

| Prop | Type | Notes |
|---|---|---|
| `value` | `daily \| weekly \| off` | Active cadence |
| `onChange` | `(value) => void` | Fires only on change (+ `select` haptic) |
| `lastSyncCaption` | `string \| null` | Caption under the control |
| `syncing/disabled` | `boolean` | Lock input; syncing overrides the caption |

## InspirationRow (`components/InspirationRow.tsx`)

```tsx
<InspirationRow connected username={name} lastSyncCaption="Last synced Tue 9:41 AM"
  onPress={manage} onDisconnect={disconnect} />
<InspirationRow connected={false} onPress={connect} />
```

Row 1 of the two-row surface. Connected: avatar dot (initial + sage
presence dot), `@username`, last-synced caption, chevron, plus a separate
`Disconnect` danger hit-area (sibling pressable, never nested).
Disconnected: muted avatar dot + one-tap `Connect Pinterest` row.
Pinterest is otherwise invisible in v1.

| Prop | Type | Notes |
|---|---|---|
| `connected` | `boolean` | Switches connected / disconnected states |
| `username` | `string \| null` | Handle shown as `@username` |
| `lastSyncCaption` | `string \| null` | Status line; falls back to `boardCount` ("N boards synced") |
| `syncing` | `boolean` | Status flips to "Syncing taste…", row locks |
| `boardCount` | `number \| null` | Fallback status when no caption |
| `onPress` | `() => void` | Connected → manage; disconnected → connect |
| `onDisconnect/disconnecting` | `() => void / boolean` | Separate danger hit-area when connected |

## Pinterest flow components — @deprecated-in-v1

Pinterest goes invisible in v1: every Pinterest surface except the two
settings rows above (`InspirationRow`, `TasteCadence`) is unwired from
`app/` flows (upsell cards, pin grids, pose pickers in try-on/reel). The
components below stay exported — backend flows may reuse them later — but
no v1 screen should import them:

- `PoseToggle` — `[My pose | Pin pose]` segmented toggle
- `PinGrid` — 3-col pin picker grid
- `PinPoseCompare` — Mine-vs-Pin side-by-side compare
- `ShareBackSheet` — share-back bottom sheet (+ `shareConfirmLabel`)
- `PinterestConsent` — connect-screen consent copy block
