/**
 * Leaflet adapter for SIGWX — a thin wrapper over the shared
 * `@softwarity/draw-adapter` Leaflet adapter that pre-binds the SIGWX layer
 * manifest + hit set + default symbol ink. Construction: `new LeafletAdapter({ map })`
 * (a host-owned `L.Map`). Styling is data-driven (baked by the controller via
 * `decorate`).
 *
 * Leaflet is an OPTIONAL peer: import this entry point only if you use Leaflet.
 */
import type { Map as LeafletMap } from "leaflet";

import { LeafletAdapter as BaseLeafletAdapter, createLeafletMap } from "@softwarity/draw-adapter/leaflet";

import { HIT_OVERLAYS, SIGWX_LAYERS } from "./layers.js";
import { DEFAULT_SYMBOL_COLOR } from "./symbols.js";

export { createLeafletMap };

export class LeafletAdapter extends BaseLeafletAdapter {
  constructor(opts: { map: LeafletMap }) {
    super({
      map: opts.map,
      layers: SIGWX_LAYERS,
      hitOverlays: HIT_OVERLAYS,
      defaultSymbolColor: DEFAULT_SYMBOL_COLOR,
    });
  }
}
