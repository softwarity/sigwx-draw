# Release Notes

## NEXT RELEASE

- **Non-convective cloud → composite ICING + TURBULENCE**: clicking the icing button on a
  `cloudNonConvective` card creates a ZONE-LEVEL icing sub-object (`metadata.icing =
  { symbol, baseFL, topFL }`, moderate by default) and shows its OWN card glued above the zone card,
  edited like the stock icing (MOD/SEV picker + its own FL gauge). One icing + one turb per zone
  (zone-level, per WAFS §4.4), each with its own FL — NOT per cloud layer. Behaviours:
  - **Two cards coexist**: the zone card and the icing card both render, the icing card glued
    edge-to-edge to the zone card's MEASURED top edge via the adapter's new `MarkerWidget.anchorTo`
    (`{ id, side, gap }`). A **tap on either card switches the focus** to it; only the FOCUSED card
    carries its FL gauge (never two gauges at once).
  - **Delete ✕** sits exactly where the add button was (the two cards' shared frontier edge), but is
    drawn on the composite card so it stays on top / clickable; the zone's add button is removed once
    the composite exists. It drops the composite and returns focus to the zone.
  - Declarative: a new `composites: [{ key, ref, place }]` on the descriptor REUSES the referenced
    stock phenomenon (`ref: "icing"`) for the sub-object's fields/picker/gauge/defaults — no data
    duplication. Controller mechanics: `composite:<key>` / `removeComposite:<key>` card actions,
    `focusedComposite` state with `focusComposite`/`focusZone`, the glued card rendered via the ref's
    own widget builder, and `#<key>`-suffixed edits routed into `metadata[key]` (FL-clamped, base ≤ top).
    The composite card always renders as a framed **sidecar** (bg / border / `small` radius / `large`
    padding) matching the other cards — even turbulence, whose standalone call-out is `framed:false`.
  - **Turbulence too** (the bottom button, `ref: "turbulence"`, `place: "bottom"`): same generic
    mechanism — clicking it creates `metadata.turb` (MOD default) glued BELOW the zone (`anchorTo`
    `side:"bottom"`), with its own severity picker + FL gauge and a ✕ on its top (frontier) edge. Both
    composites declare in `composites[]`; everything (focus toggle, edit routing, delete) is
    composite-agnostic.
  - **icing AND turb at once now stack cleanly** (icing / zone / turb, no overlap) thanks to
    `anchorTo` measuring the zone card — replacing the earlier `origin`-offset hack.
  - **FL gauge migrated to `anchorTo`** (`side:"right"`): every area/composite gauge now sits flush at
    its panel's REAL right edge (exact gap, re-snapped on resize) instead of a fixed approximate
    offset — and a composite's gauge correctly hugs the composite card, not the zone. The jet's
    break-point dial/gauge keep the legacy positioning (not a simple side-of-card satellite).

- **The single "significant weather area" cloud button (`sigwxArea`) is split in two** in both TEMSI
  profiles (france + euroc), per ICAO/WAFC doctrine (a CB *implies* turbulence + icing via the chart
  legend — never composited; only a NON-convective cloud area composites turb/icing in its call-out):
  - **`cloudConvective`** — Cumulus / Cumulonimbus (CB keeps ISOL/OCNL/FRQ/EMBD, CU the octa amounts);
    toolbar icon `cb`.
  - **`cloudNonConvective`** — CI/CC/CS/AC/AS/NS/SC/ST, octa amounts; toolbar icon `sigwxArea` (the
    generic scallop). Hosts the icing/turbulence composites. The add buttons use new moderate-severity
    *pure* glyphs `icingMod` (fork) / `turbulenceMod` (peak) — `svgs/buttons/*.svg`.
  Both stay scalloped multi-layer areas; everything else (gauge band, multi-layer stack, summary) is
  unchanged. ⚠️ the old `sigwxArea` type id is gone — its tests now target `cloudConvective`.
- **Supporting mechanics (lib-only)**: `CardButtonSpec.place` now accepts `"top"`/`"bottom"`; the
  multi-layer panel builder (`compileLayerPanel`) now emits card-edge buttons (it silently dropped
  them before, so a `repeat` area could never carry a top/bottom button).
- **The multi-layer cloud-area (`sigwxArea`) editing box & gauge spacing match the other cards now**:
  - its box gets the same `"large"` padding (it defaulted to `"small"` — the multi-layer panel's
    default — while single areas default to `"large"`, so it looked tighter); pinned explicitly to
    `"large"` in temsi-france + temsi-euroc.
  - its side FL gauge no longer sits FURTHER from the card than the others — the `SIDE_X_STACK` (−1.4)
    offset was a leftover from the (removed) wide layer-stack panel; the panel is now the same flat
    card as a simple area, so the gauge uses the same `−1.0` offset (~16px gap → ~2px, like icing).
- **The turbulence & icing symbols in the editing card are bigger** (the MOD/SEV glyph was too small) —
  single-area panels (`compilePanelWidget`) now honour a card item's `size` on its picker trigger glyph,
  like the marker/layer cards already did. Turbulence's `symbol` carousel carries `size: 36` (its glyph
  is a sparse curve, so it needs more), icing's `size: 24` (a denser fork) — each tuned to its glyph.
- **Base/top AREA FL gauges are now a single DRAGGABLE band** (CB, icing, turbulence/CAT) — they were
  two independent cursors; they now render as a 1-band `WidgetGauge.ranges` (grab the middle → base+top
  move together), inked in the phenomenon's identity colour (CB red, icing violet, CAT grey — the band
  stays VISIBLE so it's grab-able), consistent with the multi-layer cloud zone. One band code path now
  serves every base/top FL area (`flBandNode`); `flGaugeNode` shrinks to the single-FL case (tropopause,
  isotherm). Single-FL gauges and the jet's 3-cursor break-point gauge keep the cursor mode (a point /
  a labelled core can't be a band). The band is the default render for any 2-cursor base/top area (no
  per-profile opt-in). Lib-only — no adapter change.
- **The multi-layer cloud-layer area (`sigwxArea`) is edited on ONE shared multi-range FL gauge**
  (adapter `WidgetGauge.ranges`): N coloured `[base, top]` bands on a single axis, one colour per
  layer, the active layer on top, the editing card framed in the active layer's accent over a
  very-light tint. The PANEL always shows just the active layer's flat card (1 or N layers look
  identical); the per-layer bands + add/remove all live on the side gauge. Behaviours:
  - **First segment CENTRED on the range** — a lone default layer is a 1/`max`-tall band centred on
    the mid-altitude (France 0–150/max 4 ⇒ `[55,95]`; EUROC 0–450/max 3 ⇒ `[150,300]`), leaving room
    BOTH above and below so either add works straight away (not pinned to the floor).
  - **Add a layer by hovering an EMPTY axis span** — the adapter's hover-`+` ("add here", anywhere a
    band isn't — including a GAP between two layers) emits `addLayerAt:<fl>`; the lib inserts a band
    **centred on that FL** (a 1/`max`-tall slice, 5-FL snapped, clamped). The old fixed `+` at the
    axis ends (`addLayer`/`addLayerBelow`, `place:"axis-top"/"axis-bottom"`) are **removed** in favour
    of this. The lib gates the whole affordance with a new `WidgetGauge.canAdd` (false at `repeat.max`,
    so no `+` is offered when full); `addLayer` survives as a generic "stack one on top" (programmatic).
  - **Fling a band off the axis to delete it** — dragging a layer's band horizontally clear of the
    track (adapter gesture, danger-tinted) emits `removeRange:<index>`; the lib drops that layer,
    **min-1 guarded**, survivors keep their FL (no re-slice).
  - **The editing UI no longer slides sideways when you add/remove a layer** — a selected call-out's
    box offset is FROZEN at selection (like the FL `flRef`): previously the cartouche grew a line per
    layer, widening the placement box and sliding its centre — where the gauge+card pin — ~55px right
    on every add. A manual box drag promotes the freeze to a sticky pin.
  - **Track length is STABLE (~3× its card)** instead of resizing with the FL extent — was
    `(max−min)×0.5` clamped 110–200px (a tall EUROC chart drew a longer slider than a short France
    one, the control jumping between profiles); now a fixed `GAUGE_STACK_LENGTH` (~230px ≈ 3× the
    editor card, itself constant). The FL extent is absorbed by the **ticks**: the adapter maps
    `[min,max]` onto the fixed length, so a wider range just packs the step-5 notches tighter.
  - **Requires the adapter release** carrying `WidgetGauge.ranges` + the band drag-off-axis gesture +
    the new hover-`+` over empty axis spans (`canAdd` gate → `addLayerAt:<fl>`). Spec:
    `ADAPTER-GAUGE-HOVER-ADD.md`.
- **Removed: the old layer-`stack` editor** (the adapter `stack` control — the "multicard with the FL
  listed below"). The cloud-layer area is now ALWAYS the multi-range gauge above, and the redundant
  `sigwxAreaGauges` button (identical bar the editor) was folded back into `sigwxArea` — one button,
  canonical name. The `repeat.editor` / `editorPlacement` descriptor tokens are gone (a `repeat` now
  means exactly this editor). sigwx-draw no longer emits the adapter's `WidgetStack` / `WidgetStackItem`
  (`kind:"stack"`) controls — they can be retired adapter-side if nothing else uses them.
- **Fix: a multi-layer area (`sigwxArea`) no longer shows a stray draggable handle** — the on-path
  break-point sliders (a jet feature, items parameterized by `t`) were also rendered for the
  cloud-layer list, whose items are FL LAYERS with no `t` ⇒ a phantom slider landed at the path start
  (vertex 0). It dragged with no effect and flashed the danger colour. The slider pass is now gated to
  non-`repeat` lists.
- **Add: the TEMSI isotherm draws as a SPOT or a CONTOUR, with a selectable temperature** (like the
  tropopause for the geometry) — its gesture is now `lasso-or-spot`, so a click drops a boxed
  `<T>°: FL` spot and a stroke draws the contour line. A new `render.point` branch boxes the spot
  label; the spot inherits the no-handle / drag-the-box behaviour. The temperature is a **discrete
  enum picker** (chart convention — multiples of 5 °C, not free input): **France 0 / −10 °C**,
  **EUROC 0 / −10 / −20 °C** (default 0). The picker rides the FL-gauge satellite, so it works in
  BOTH spot and contour mode (a new `picker` item type is honoured in satellites). The label,
  picker, and summary all read the chosen `temp`. Renamed in the UI to “Isotherme” (the type id
  stays `zeroIsotherm`). Only the TEMSI profiles carry it.
- **Fix: a tropopause SPOT is now moved by dragging its FL box; the move handle is gone** — a boxed
  spot label sits centered ON its point, exactly where the vertex/selection handle used to be drawn.
  That handle covered the value's most-significant digit, so dragging the FL gauge *looked* frozen
  even though the box updated live. The handle is **removed** (a lone spot has no editable shape) and
  the **box IS the spot**: drag the box to move the point, tap it to select. The box stays anchored
  and centered on the spot. The contour (line) label/handles are unchanged.
- **Change: the FL gauge satellite centres its RANGE on the call-out anchor** — the side gauge now
  pins the **middle of its range** at the box anchor (so the slider straddles the box symmetrically)
  instead of the selection-time level; still drag-stable. Applies to every FL gauge (tropopause,
  turbulence/CB/icing areas, jet break point).
- **Change: the "add another area" button moved from the card edge to the arrow TIP** — every
  area phenomenon's `draw-more` (`+`) control now rides the selected zone's **leader arrow tip**
  (where the old scallop-flip tap was), CENTERED on the tip — not straddling the call-out card.
  It uses the **Material "draw" pencil** glyph in a **framed badge** styled like the card's own edge
  buttons (white disc, hairline ink border, black glyph), a bit bigger than the former `+`. The badge
  is **not a widget button** (a button swallows the pointer and would block the re-aim drag it sits
  on): the controller treats it as the **anchor control itself** — **drag it to re-aim the arrow
  tip**, **tap it to draw a linked area**. Declared in the
  profile with a card button `place: "anchor"` (new): the lib relocates it to `def.anchorButton` and
  the controller paints + drives it at the tip; the card itself now carries no edge buttons (so
  unframed call-outs go truly bare). Same visibility gate as the anchor handle (selected + leader
  showing).
- **Add: multi-layer significant-weather area (TEMSI cloud-layer stack)** — `sigwxArea` now holds
  a STACK of cloud layers, each `amount × type × base/top FL`, edited inline via the adapter's new
  `stack` control: one layer expanded (the amount/type pickers), the others collapsed to a one-line
  **FL-only** preview, with `+`/`−` to add/remove. The **FL gauge stays a side satellite** pinned to
  the right of the card (so the card stays narrow), bound to the active layer and re-bound when you
  switch layers. New **`repeat`** descriptor token
  (`{ listField, preview, min, max, editorPlacement }`) compiles a list field into the stack panel.
  The list stays **altitude-sorted** (highest on top), re-sorted on (re)selection / add / remove and
  frozen during a single FL drag. **Per-type FL defaults on add** (read from each cloud type's
  `meta`, coerced into the profile's `flightLevel`→`vertical` range — CB top defaults to XXX). The
  **rest cartouche** stacks one `qty type base/top` line per layer; with a **single layer** it falls
  back to the **normal centered column** (amount / type / top / base — each on its own line), via a
  new `callout.contentSingle` descriptor template. **Edit mode mirrors this**: a single layer's
  selected panel reads **as if it were one simple card** — framed like the deselected cartouche
  (white box + ink border, so select/deselect don't flip boxed↔bare) with the **amount/type
  pickers** over the **top and base FL each on its own line** (mirroring `contentSingle`; the side
  gauge edits them), plus a bottom-edge `+` to add a layer. It carries **none of the stack chrome**
  (no blue active-editor box); the adapter `stack` control only appears from **two layers up**.
  France allows up to 4 layers (all cloud amounts), EUROC up to 3 (BKN/OVC only); `min:1` everywhere.
- **Fix: a single-layer `sigwxArea` showed no flight level while selected** — the selected panel
  rendered only the amount/type pickers, dropping the FL the deselected cartouche prints. It now
  shows the top and base FL on their own lines (the side gauge edits them), matching the cartouche.
- **Fix: the multi-layer `sigwxArea` rest cartouche read `top/base` (top first) while the selected
  stack preview and the FL gauge cursors read `base/top` (base first)** — the deselected compact line
  now reads **`base/top`** (e.g. `OCNL CB FL025/FL155`), consistent with the layer preview and the
  `[baseFL, topFL]` gauge. The single-layer vertical column is unchanged (top stays the upper line —
  higher on the page = higher altitude). Both TEMSI profiles (France + EUROC).

---

## 1.2.0

- **Add: declarative phenomenon framework** — phenomena are now pure-JSON **descriptors**
  compiled by `defFromDescriptor`; the only TS rendering code left is the **named extensions**
  (`jet-barbs`, `front-symbols`), registered explicitly via `registerExtensions`. Descriptor +
  profile **JSON Schemas** ship for validation.
- **Change: the JSON profile is the single source of truth** — `BUILTIN_DESCRIPTORS` /
  `STOCK_GLYPHS` are DERIVED from the profile JSON (no TS↔JSON duplication). The **profile is
  the single ingestion unit**: `new SigwxDraw({ profile })`, live `setProfile`, npm/CDN-servable;
  `wafs.json` is the inline default.
- **Add: TEMSI profiles** — `temsi-france` (ground→FL150) and `temsi-euroc` (ground→FL450),
  fully self-contained. **TEMSI fronts** (cold / warm / occluded / stationary / convergence
  line / ITCZ / squall line) drawn via the `front-symbols` extension.
- **Add: SVG glyph atlas pipeline** — `svgs/**/*.svg` is the SINGLE source of glyph art (ICAO
  Annex 3 + project glyphs). `build-atlas` resolves a profile's glyph **references** to inline
  SVG in the dist profiles (autoportant), validates every wired `atlas:*`, and reports unused
  bank files. `stock-glyphs.json` (the lib's built-in icons) is derived from `wafs.json`'s
  references — adding a profile-only icon never bloats the lib. New scripts: `build:stock`,
  `build:profiles`, and a dev `build:watch` (stock → tsc -w → re-inline dist profiles → bounce
  the demo). No inline SVG remains in the profiles — every icon is a bank reference.
- **Add: WMO point-symbol pickers** — 9 `wmo-<family>` category markers with an on-map
  `picker` control (carousel ≤5 / flower 6–10 / grid >10, auto-degrading) and `optionsBy`
  (an enum's options driven by another field, e.g. CB amount by cloud type). Composable
  `sigwxArea` (scalloped significant-weather area: type × amount × base/top FL).
- **Add: chart areas** — a profile `areas` set (WAFS SWH A…M) with lon/lat extent + projection
  (mercator / polar stereographic). `setArea()` pins the camera, frames the area and locks the
  map (released on `null`).
- **Add: Ctrl/⌘ eraser (replaces the `−` button)** — hold the platform modifier (⌘ on macOS,
  Ctrl on Windows/Linux) and click/drag over an area to gnaw a hole; a brush footprint previews
  what a rub will remove.
- **Add: active-tool highlight** — the toolbar button is highlighted **while its draw mode is
  active** (set on `draw`, cleared on commit / cancel / Escape); the lib drives it, the adapter
  styles it via the toolbar's `activeStyle`.
- **Fix: `load()` id collision on re-hydrate** — loading a saved collection into a fresh
  controller (e.g. the demo switching engines) now advances the id counter past the loaded
  `fN` ids, so a later draw can no longer reuse an id and overwrite a loaded feature.
- **Change: upgrade `@softwarity/draw-adapter` to 0.5.0** — gauge/dial value-editors,
  non-rectangular card frames + `boxShape`, nested toolbar submenus, the `picker` control,
  and `setActiveTool` / toolbar `activeStyle`.

---

## 1.1.0

- **Add: eraser & holes** — rub an area to gnaw a CLEAR hole in real time (true boolean
  difference via `polyclip-ts`): a hole inside, a reshaped border on a bite, a SPLIT
  (MultiPolygon) on a cut-through; gnawing it all deletes the feature. Hole vertices are
  editable, and the scallop / tick orientation stays correct on concave rings (normalised CCW
  winding).
- **Change: hole-aware geometry** — a call-out arrow tip always clamps into CLOUD, never into
  an erased clear zone; added area-ring + point-in-area helpers for the complex geometries.
- **Change: upgrade `@softwarity/draw-adapter` to 0.3.3** — polygons-with-holes rendering and
  more robust point-in-complex-geometry clamping.

---

## 1.0.0

- **Add: point markers** — **volcano**, **tropical cyclone** and **radioactive spot**, as
  inline-editable anchored widgets (glyph + name input + live coordinates), grouped under a
  toolbar submenu.
- **Add: multi-area phenomena** — one phenomenon can span several areas (Polygon →
  MultiPolygon): one call-out / metadata set, one arrow per area. The call-out `+` draws a
  linked extra area; shift-click adds/removes an area from the selection; areas delete
  individually (the last one demotes back to a simple polygon).
- **Add: chart profiles** — a `SigwxProfile` selects the phenomenon set and toolbar; the
  `WAFS_SWH` preset ships under the `./profiles` entry point.
- **Change: the metadata form is removed** — all metadata editing is INLINE on the map (cards
  / gauges / carousels); the `src/form` component is gone.

---

## 0.3.0

- **Add: Tropopause phenomenon** — the height of the tropopause as a single flight level
  (WAFC SIGWX guide §3.9), in two forms chosen by gesture from **one** toolbar button:
  **click** drops a **spot height** (a `Point`, the FL in a box), **drag** draws a **contour**
  (a `LineString`, a thin blue dashed iso-line with its FL marked at the middle). A stroke too
  short to read as a line collapses to a spot; deleting a contour's vertices one by one
  collapses it back to a spot at the last. On-map single-FL gauge. The H/L maximum/minimum
  markers are intentionally not modelled ("no longer included", §3.9.1).
- **Change: feature deletion is keyboard-only** — the on-map red ✕ control was removed from
  every phenomenon; `Backspace` / `Delete` on the selection removes it.
- **Change: keyboard handling delegated to the adapter** — uses `@softwarity/draw-adapter`'s
  `onKey` (scoped to the map container, multi-instance safe, editable fields skipped) instead
  of a window-level listener.
- **Fix: turbulence FL call-out is no longer boxed** — draw-adapter 0.2.8 boxes any label
  carrying a border, and the turbulence border (leader/arrow ink) was triggering an unwanted
  box; the call-out box now follows a background only.
- **Change: upgrade `@softwarity/draw-adapter` to 0.2.9** — adds the built-in "lock map"
  toolbar toggle (exposed in the demo), per-feature label-box controls, and the keyboard
  transport.
- **Demo:** the per-phenomenon config cards wrap onto multiple lines (all visible at once);
  a "lock map" toolbar toggle.

---

## 0.2.0

- **Add: Icing phenomenon** — a purple dashed-edge area with the WAFC MOD/SEV intensity
  "fork" glyph and a black & white FL call-out, plus small inward boundary ticks. New
  `IcingStyle`; a showcase config card. Tap the glyph to cycle MOD ↔ SEV.
- **Change: jet & turbulence FL labels are no longer boxed** — plain haloed text (a box would
  not rotate with the rotated label on OpenLayers / Leaflet).
- **Change:** upgrade `@softwarity/draw-adapter` to 0.2.6.

---

## 0.1.0

- **Add: Leaflet support** — a third rendering engine alongside MapLibre GL and OpenLayers,
  via the `./leaflet` entry point.
- **Change: the map adapters are extracted into the shared `@softwarity/draw-adapter`
  package** (0.2.5). `sigwx-draw` keeps thin per-engine wrappers + the SIGWX layer manifest,
  and the engine adapters ship as separate entry points (`./maplibre`, `./openlayers`,
  `./leaflet`) so a consumer only pulls the engine(s) it uses.
- **Add: CB coverage carousel** — CB rebuilt via `makeCb`; tap its call-out to cycle the
  coverage amount (ISOL / OCNL / FRQ).

---

## 0.0.2

First release. Headless, Terra-Draw-style SIGWX (significant-weather) chart drawing on any
map, driven by a **data-driven phenomenon registry** — a phenomenon's metadata drives its
rendering, so a new phenomenon is just a new registry entry.

- **Jet stream** — a smooth, directional curve; wind barbs / pennants computed from the max
  wind speed, change bars, FL call-outs, and a vertical-extent box at the max-wind point
  (≥ 120 kt).
- **Cumulonimbus (CB)** — a scalloped-edge area with a coverage / FL label.
- **Turbulence** — a dashed-edge area with a MOD/SEV intensity glyph and an FL range.
- **MapLibre GL** and **OpenLayers** adapters, rendering identically from the same baked
  feature props. GeoJSON `save()` / `load()` round-trip (decoration is always derived, never
  stored).
