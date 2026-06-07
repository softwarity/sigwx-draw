/**
 * MapLibre adapter for SIGWX — a thin wrapper over the shared
 * `@softwarity/draw-adapter` MapLibre adapter that pre-binds the SIGWX layer
 * manifest + hit set + default symbol ink. Construction is unchanged for hosts:
 * `new MapLibreAdapter({ map })`. Styling is data-driven (baked by the controller
 * via `decorate`); there is no `setStyle` on the adapter anymore.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import { MapLibreAdapter as BaseMapLibreAdapter, createMapLibreMap } from "@softwarity/draw-adapter/maplibre";

import { HIT_OVERLAYS, SIGWX_LAYERS } from "./layers.js";
import { DEFAULT_SYMBOL_COLOR } from "./symbols.js";

export { createMapLibreMap };

export class MapLibreAdapter extends BaseMapLibreAdapter {
  constructor(opts: { map: MapLibreMap }) {
    super({
      map: opts.map,
      layers: SIGWX_LAYERS,
      hitOverlays: HIT_OVERLAYS,
      defaultSymbolColor: DEFAULT_SYMBOL_COLOR,
    });
  }
}
