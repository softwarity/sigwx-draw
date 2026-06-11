# Release Notes

## NEXT RELEASE

---

## 1.0.0

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
