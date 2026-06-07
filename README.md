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

> Status: **v1 demonstrator** — `jetStream`, `cb`, `turbulence`. The architecture
> (registry + decoration pipeline + layer manifest + schema-driven form) is built
> so the remaining phenomena (icing, fronts, tropopause, tropical cyclone,
> volcanic ash, …) plug in as new `PhenomenonDef`s.

## Install

```sh
npm i @softwarity/sigwx-draw
# peer deps (only the engine you use):
npm i maplibre-gl   # and/or  ol   and/or  leaflet
```

## Quick start (MapLibre)

```ts
import { SigwxDraw } from "@softwarity/sigwx-draw";
import { MapLibreAdapter, createMapLibreMap } from "@softwarity/sigwx-draw/maplibre";
import { registerSigwxMetadataForm } from "@softwarity/sigwx-draw/form";

const map = createMapLibreMap({ container: "map", center: [2.3, 46.6], zoom: 5 });
const sigwx = new SigwxDraw({ adapter: new MapLibreAdapter({ map }), toolbar: true });

// Drive the metadata form (optional convenience web component):
registerSigwxMetadataForm();
const form = document.querySelector("sigwx-metadata-form");
sigwx.on("select",   (spec) => (form.spec = spec));   // selection changed
sigwx.on("metadata", (spec) => (form.spec = spec));   // values/visibility/errors
form.addEventListener("change", (e) =>
  sigwx.updateMetadata(e.detail.featureId, { [e.detail.key]: e.detail.value }),
);

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

- `new SigwxDraw({ adapter, registry?, style?, toolbar?, symbolSprite?, phenomena?, turbulenceTypes? })`
- `draw(type) → id` (enter draw mode), `select(id|null)`, `updateMetadata(id, patch)`,
  `updateListItem(id, list, i, patch)`, `removeListItem(id, list, i)`,
  `delete(id)`, `clear()`, `bringToFront(id)`, `sendToBack(id)`
- `save(): FeatureCollection`, `load(fc)` — metadata lives in feature `properties`
- `on("change" | "select" | "metadata", cb)`, `off(...)`, `ready()`, `destroy()`
- `setStyle(partial)`, `setPhenomenonStyle(type, style)`,
  `setPhenomenonFlightLevel(type, { min, max })`, `addTurbulenceTypes(types)`

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
