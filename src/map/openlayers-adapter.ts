/**
 * OpenLayers adapter for SIGWX — a thin wrapper over the shared
 * `@softwarity/draw-adapter` OpenLayers adapter that pre-binds the SIGWX layer
 * manifest + hit set + default symbol ink. Construction is unchanged for hosts:
 * `new OpenLayersAdapter({ map })`. Styling is data-driven (baked by the
 * controller via `decorate`).
 */
import type { Map as OlMap } from "ol";

import { OpenLayersAdapter as BaseOpenLayersAdapter, createOpenLayersMap } from "@softwarity/draw-adapter/openlayers";

import { HIT_OVERLAYS, SIGWX_LAYERS } from "./layers.js";
import { DEFAULT_SYMBOL_COLOR } from "./symbols.js";

export { createOpenLayersMap };

export class OpenLayersAdapter extends BaseOpenLayersAdapter {
  constructor(opts: { map: OlMap }) {
    super({
      map: opts.map,
      layers: SIGWX_LAYERS,
      hitOverlays: HIT_OVERLAYS,
      defaultSymbolColor: DEFAULT_SYMBOL_COLOR,
    });
  }
}
