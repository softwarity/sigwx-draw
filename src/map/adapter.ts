/**
 * `MapAdapter` — grafts the SIGWX drawing onto an *existing* map (à la Terra
 * Draw). The host owns the map (basemap, controls, projection, zoom); the adapter
 * only adds the SIGWX overlays, reports pointer events in lon/lat, registers the
 * glyph sprite atlas, and optionally renders a native toolbar.
 *
 * Unlike sigmet-draw, the overlay set is NOT a closed union: the adapter is
 * driven by a declarative {@link LayerSpec}[] manifest, so SIGWX can add as many
 * layers as it needs (area-fill, edge, decoration, symbols, text-boxes, …).
 *
 * Feature property conventions the adapters read (baked in by `core/decorate` or
 * the controller; the adapters stay dumb):
 *  - `layer` is implicit (one source per overlay id).
 *  - line:   `stroke`, `strokeWidth`, `dash?`.
 *  - fill:   `fillColor`, `fillOpacity`.
 *  - symbol: `symbol` (sprite id), `size?`, `rotation?`.
 *  - text:   `text`, `textColor`, `textSize`, `textHalo`, `textBackground`, `textBorder`.
 *  - circle (handles): `role`, `control?` (control handles styled distinctly).
 *  - hit-testing features carry `featureId` so a click resolves to a chart feature.
 */
import type { FeatureCollection } from "geojson";

import type { LatLng } from "../core/index.js";
import type { SigwxStyle } from "./style.js";

/** How a layer is rendered. */
export type LayerKind = "fill" | "line" | "symbol" | "text" | "circle";

/** One overlay layer in the manifest. The overlay's source shares the `id`. */
export interface LayerSpec {
  id: string;
  kind: LayerKind;
}

/** A glyph atlas: sprite id → inline SVG markup. Registered before first render. */
export type SymbolSprites = Record<string, string>;

export type Projection = "mercator" | "globe";

export interface PointerEvent {
  type: "down" | "move" | "up" | "click" | "dblclick";
  lngLat: LatLng;
  hit?: { overlay: string; props: Record<string, unknown> };
}

export type ToolbarPosition =
  | "top" | "top-left" | "top-right"
  | "bottom" | "bottom-left" | "bottom-right"
  | "left" | "left-top" | "left-bottom"
  | "right" | "right-top" | "right-bottom";

export type ToolbarPadding =
  | string
  | { top?: string; right?: string; bottom?: string; left?: string };

export interface ToolbarOptions {
  position?: ToolbarPosition;
  orientation?: "horizontal" | "vertical";
  padding?: ToolbarPadding;
  gap?: string;
  className?: string;
  /** Phenomenon ids to show (and their order); defaults to all registered. */
  tools?: string[];
  /** Include the "clear all" button (default true). */
  clear?: boolean;
}

export interface ToolbarItem {
  id: string;
  title: string;
  label: string;
  svg?: string;
  toggle?: boolean;
  onClick: () => void;
}

export interface MapAdapter {
  /** Resolves once the adapter has attached its overlays to the host map. */
  ready(): Promise<void>;
  /** Register (or replace) the glyph sprite atlas used by the symbols layer. */
  registerSymbols(sprites: SymbolSprites): Promise<void>;
  setOverlay(id: string, data: FeatureCollection): void;
  setStyle(style: SigwxStyle): void;
  setTooltip(text: string | null, at: LatLng): void;
  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement;
  getCenter(): LatLng;
  /** Rough lon/lat span of the current view, for sizing dropped default geometry. */
  getViewSpan(): number;
  /** Project lon/lat to screen pixels (for the call-out placement pass). */
  project(p: LatLng): [number, number] | null;
  /** Inverse of {@link project} — screen pixels back to lon/lat. */
  unproject(px: [number, number]): LatLng | null;
  /** Notify on pan/zoom end, so the label placement pass can re-run. */
  onViewChange(cb: () => void): void;
  setPanEnabled(enabled: boolean): void;
  /** Toggle the host map's double-click-zoom (disabled while drawing a path). */
  setDoubleClickZoom(enabled: boolean): void;
  /** Set the map cursor (e.g. `"crosshair"` while drawing). `""` resets it. */
  setCursor(cursor: string): void;
  onPointer(cb: (ev: PointerEvent) => void): void;
  /** Detach everything this adapter added; MUST NOT destroy the host map. */
  destroy(): void;
}
