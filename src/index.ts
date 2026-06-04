/**
 * `@softwarity/sigwx-draw` — headless SIGWX charting that grafts onto MapLibre or
 * OpenLayers. The phenomenon registry + metadata schema drive the rendering
 * (jet barbs scale with wind speed, CB gets a scalloped edge, turbulence dashed).
 *
 * Subpath entry points: `./core` (pure), `./maplibre`, `./openlayers`, `./form`.
 */
export * from "./core/index.js";
export * from "./map/index.js";
