# Release Notes

## NEXT RELEASE

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
