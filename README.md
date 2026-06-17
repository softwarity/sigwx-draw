# @softwarity/sigwx-draw

**Works with** &nbsp;<sub>(via <code>@softwarity/draw-adapter</code>)</sub>

<p align="left">
  <a href="https://maplibre.org/" title="MapLibre"><img src="demo/src/assets/logos/maplibre.svg" alt="MapLibre" height="24"></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openlayers.org/" title="OpenLayers"><img src="demo/src/assets/logos/openlayers.svg" alt="" height="22">&nbsp;<b>OpenLayers</b></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://leafletjs.com/" title="Leaflet"><img src="demo/src/assets/logos/leaflet.png" alt="Leaflet" height="26"></a>
</p>

Headless **SIGWX** (significant weather) chart editor that grafts onto an existing
**MapLibre GL**, **OpenLayers** or **Leaflet** map — the sibling of
[`@softwarity/sigmet-draw`](../sigmet-draw). The host owns the map; this library
adds the drawing overlays, edit handles and a phenomenon-driven metadata model.
The three engines render identically: the map layer is the shared, data-driven
[`@softwarity/draw-adapter`](../draw-adapter), so styling lives in the data and no
domain type ever reaches the engine.

The defining idea: **a phenomenon's metadata drives its rendering.** A jet
stream's wind barbs are computed from its `maxWindSpeed`; a CB gets a scalloped
edge and an `ISOL/OCNL/FRQ` label; turbulence gets a dashed outline and a MOD/SEV
glyph. Each phenomenon is a self-contained, data-driven `PhenomenonDef` in a
registry, so adding one never touches the controller.

> Status: phenomena are pure-JSON **descriptors** compiled into a registry and bundled into
> self-contained **profiles** — **WAFS SWH** (the inline default) and **TEMSI** (`temsi-france`
> ground→FL150, `temsi-euroc` ground→FL450). Shipped phenomena: jet stream, CB, turbulence (CAT),
> icing, tropopause, zero-isotherm, fronts, WMO point symbols, point markers (volcano / TC /
> radioactive), and convective / non-convective cloud areas (the latter with zone-level
> icing + turbulence composites). All metadata editing is **inline on the map** — there is no form.

## Install

```sh
npm i @softwarity/sigwx-draw
# peer deps (only the engine you use):
npm i maplibre-gl   # and/or  ol   and/or  leaflet
```

## Quick start (MapLibre)

```ts
import { SigwxDraw, type SigwxProfile } from "@softwarity/sigwx-draw";
import { MapLibreAdapter, createMapLibreMap } from "@softwarity/sigwx-draw/maplibre";
import temsiEuroc from "@softwarity/sigwx-draw/profiles/temsi-euroc.json";

const map = createMapLibreMap({ container: "map", center: [10, 48], zoom: 4 });
const sigwx = new SigwxDraw({
  adapter: new MapLibreAdapter({ map }),
  toolbar: true,
  profile: temsiEuroc as unknown as SigwxProfile, // omit ⇒ WAFS SWH (the inline default)
});
await sigwx.ready();

// All metadata editing is INLINE on the map (cards / pickers / FL gauges) — there is no form.
sigwx.on("change", (geojson) => console.log(geojson)); // FeatureCollection output
```

OpenLayers is identical via `@softwarity/sigwx-draw/openlayers`
(`OpenLayersAdapter` / `createOpenLayersMap`), and Leaflet via
`@softwarity/sigwx-draw/leaflet` (`LeafletAdapter` / `createLeafletMap`, an `L.Map`).
The consumer loads the engine's stylesheet (`maplibre-gl/dist/maplibre-gl.css`,
`ol/ol.css`, or `leaflet/dist/leaflet.css`). Each engine is an **optional**
`peerDependency` — install only the one(s) you use. Capabilities differ: the globe
projection is MapLibre-only (OpenLayers & Leaflet are 2D).

## API

- `new SigwxDraw({ adapter, profile?, registry?, style?, toolbar?, symbolSprite?, phenomena?, turbulenceTypes? })`
  — `profile` defaults to WAFS SWH (inline); pass a `SigwxProfile` (e.g. a TEMSI JSON) to swap the set.
- `draw(type) → id` (enter draw mode), `select(id|null)`, `updateMetadata(id, patch)`,
  `updateListItem(id, list, i, patch)`, `removeListItem(id, list, i)`,
  `delete(id)`, `clear()`, `bringToFront(id)`, `sendToBack(id)`
- `save(): FeatureCollection`, `load(fc)` — metadata lives in feature `properties`
- `on("change" | "select" | "metadata", cb)`, `off(...)`, `ready()`, `destroy()`
- `setProfile(profile)` (live re-ingest, document preserved), `setArea(id|null)` (frame a chart area),
  `setStyle(partial)`, `setPhenomenonStyle(type, style)`,
  `setPhenomenonFlightLevel(type, { min, max })`, `addTurbulenceTypes(types)`

## Profiles & phenomena

Phenomena are pure-JSON **descriptors** bundled into self-contained **profiles** (descriptors + glyph
atlas + grouped toolbar), each npm/CDN-servable on its own and loaded via `new SigwxDraw({ profile })`
or live `setProfile()`. Bundled under the `./profiles` entry point:

- **`wafs`** — WAFS SWH, the **inline default**: jet stream, CB, turbulence (CAT), icing, …
- **`temsi-france`** (ground→FL150) and **`temsi-euroc`** (ground→FL450): cloud areas, fronts,
  tropopause, zero-isotherm, WMO point-symbol pickers, point markers, …

**Cloud areas** follow ICAO/WAFC doctrine and split in two: **`cloudConvective`** (CU / CB — a CB
already *implies* turbulence + icing via the chart legend) and **`cloudNonConvective`** (CI / CC / CS /
AC / AS / NS / SC / ST). A non-convective cloud zone can carry **zone-level icing and turbulence
composites** — each one its own card glued above / below the zone (severity picker + its own FL gauge,
delete ✕), declared with a `composites: [{ key, ref, place }]` token that reuses the stock
`icing` / `turbulence` descriptors (no data duplication). Editing is fully inline.

## Headless core (no map)

`@softwarity/sigwx-draw/core` exposes the pure pieces — the `PhenomenonRegistry`,
the metadata schema/validation, the decoration generators (`barbCounts`,
`windBarbFeatures`, `scallopRing`, …) and the GeoJSON (de)serialization. All
unit-testable without a map.

## Develop

```sh
npm run build        # tsc → dist (ESM + d.ts)
npm test             # vitest (pure core + controller via a mock adapter)
cd demo && npm start # Angular demo at http://localhost:4211 (MapLibre + OpenLayers + Leaflet)
```
