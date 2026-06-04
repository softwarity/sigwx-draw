/**
 * MapLibre GL v5 adapter — grafts onto a host-owned `maplibregl.Map`.
 * Builds one source + renderer per {@link SIGWX_LAYERS} entry, data-driven from
 * feature properties. Dashed lines use a parallel filtered layer (MapLibre can't
 * data-drive `line-dasharray`); scallops/barbs are real geometry, so they render
 * identically to OpenLayers.
 */
import type { FeatureCollection } from "geojson";
import { Map as MapLibreMap } from "maplibre-gl";

import type { LatLng } from "../core/index.js";
import type { MapAdapter, PointerEvent, Projection, SymbolSprites, ToolbarItem, ToolbarOptions } from "./adapter.js";
import { HIT_OVERLAYS, SIGWX_LAYERS } from "./layers.js";
import { DEFAULT_STYLE } from "./style.js";
import type { SigwxStyle } from "./style.js";
import { DEFAULT_SPRITES, loadSpriteImage } from "./symbols.js";
import { populateToolbar } from "./toolbar.js";
import { applyTooltipStyle } from "./tooltip.js";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const OVERLAY_IDS = SIGWX_LAYERS.map((l) => l.id);

type MlHandler = (e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => void;
interface PointerHandlers {
  mousedown: MlHandler;
  mousemove: MlHandler;
  mouseup: MlHandler;
  click: MlHandler;
  dblclick: MlHandler;
}

function handleCase(s: SigwxStyle, key: keyof SigwxStyle["handle"]): unknown {
  // "end" (jet extremity) = the vertex handle with its fill/stroke colours swapped.
  const end = key === "color" ? s.handle.strokeColor : key === "strokeColor" ? s.handle.color : s.handle[key];
  return [
    "case",
    ["==", ["get", "hClass"], "slider"], s.slider[key],
    ["==", ["get", "hClass"], "control"], s.controlHandle[key],
    ["==", ["get", "hClass"], "end"], end,
    s.handle[key],
  ];
}

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

export function createMapLibreMap(opts: {
  container: HTMLElement | string;
  center: [number, number];
  zoom: number;
  projection?: Projection;
}): MapLibreMap {
  const map = new MapLibreMap({ container: opts.container, style: OSM_STYLE, center: opts.center, zoom: opts.zoom });
  if (opts.projection === "globe") map.on("load", () => map.setProjection({ type: "globe" }));
  return map;
}

export class MapLibreAdapter implements MapAdapter {
  private readonly map: MapLibreMap;
  private readyPromise: Promise<void> | undefined;
  private style: SigwxStyle = DEFAULT_STYLE;
  /** rendered MapLibre layer id → overlay id (for hit-testing). */
  private readonly renderedToOverlay = new Map<string, string>();
  private readonly builtLayers: string[] = [];
  private pointerHandlers: PointerHandlers | undefined;
  private windowUp: ((e: MouseEvent) => void) | undefined;
  private viewHandler: (() => void) | undefined;
  private toolbarEl: HTMLElement | undefined;
  private tooltipEl: HTMLElement | undefined;
  private dragging = false;

  constructor(opts: { map: MapLibreMap; style?: SigwxStyle }) {
    this.map = opts.map;
    if (opts.style) this.style = opts.style;
  }

  setStyle(style: SigwxStyle): void {
    this.style = style;
    if (this.tooltipEl) applyTooltipStyle(this.tooltipEl, style.tooltip);
    if (this.map.getLayer("handles")) {
      this.map.setPaintProperty("handles", "circle-radius", handleCase(style, "radius") as number);
      this.map.setPaintProperty("handles", "circle-color", ["case", ["==", ["get", "danger"], true], "#f85149", handleCase(style, "color")] as unknown as string);
      this.map.setPaintProperty("handles", "circle-stroke-color", handleCase(style, "strokeColor") as string);
      this.map.setPaintProperty("handles", "circle-stroke-width", handleCase(style, "strokeWidth") as number);
    }
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        const go = () => {
          this.addOverlays();
          resolve();
        };
        if (this.map.isStyleLoaded()) go();
        else this.map.once("load", go);
      });
    }
    return this.readyPromise;
  }

  async registerSymbols(sprites: SymbolSprites): Promise<void> {
    await Promise.all(
      Object.entries(sprites).map(async ([id, svg]) => {
        if (this.map.hasImage(id)) this.map.removeImage(id);
        const img = await loadSpriteImage(svg);
        if (!this.map.hasImage(id)) this.map.addImage(id, img);
      }),
    );
  }

  setOverlay(id: string, data: FeatureCollection): void {
    (this.map.getSource(id) as { setData?: (d: FeatureCollection) => void } | undefined)?.setData?.(data);
  }

  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement {
    if (this.toolbarEl) return this.toolbarEl;
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group sigwx-toolbar";
    populateToolbar(el, items, options);
    this.map.getContainer().appendChild(el);
    this.toolbarEl = el;
    return el;
  }

  getCenter(): LatLng {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  getViewSpan(): number {
    const b = this.map.getBounds();
    return Math.max(Math.abs(b.getEast() - b.getWest()), Math.abs(b.getNorth() - b.getSouth())) || 10;
  }

  project(p: LatLng): [number, number] | null {
    const pt = this.map.project([p.lon, p.lat]);
    return [pt.x, pt.y];
  }

  unproject(px: [number, number]): LatLng | null {
    const c = this.map.unproject(px);
    return { lat: c.lat, lon: c.lng };
  }

  onViewChange(cb: () => void): void {
    this.viewHandler = cb;
    this.map.on("moveend", cb);
  }

  setPanEnabled(enabled: boolean): void {
    if (enabled) this.map.dragPan.enable();
    else this.map.dragPan.disable();
  }

  setDoubleClickZoom(enabled: boolean): void {
    if (enabled) this.map.doubleClickZoom.enable();
    else this.map.doubleClickZoom.disable();
  }

  setCursor(cursor: string): void {
    this.map.getCanvas().style.cursor = cursor;
  }

  setTooltip(text: string | null, at: LatLng): void {
    if (text == null) {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
      return;
    }
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement("div");
      this.tooltipEl.className = "sigwx-tooltip";
      applyTooltipStyle(this.tooltipEl, this.style.tooltip);
      this.map.getContainer().appendChild(this.tooltipEl);
    }
    const p = this.map.project([at.lon, at.lat]);
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${p.x}px`;
    this.tooltipEl.style.top = `${p.y}px`;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    if (this.pointerHandlers) return;
    const emit =
      (type: PointerEvent["type"]): MlHandler =>
      (e) => {
        if (type === "down") this.dragging = true;
        else if (type === "up") this.dragging = false;
        const needHit = type !== "up" && !(type === "move" && this.dragging);
        const hit = needHit ? this.hitAt(e.point) : undefined;
        if (type === "move" && !this.dragging) {
          this.setCursor(hit ? "pointer" : "");
        }
        cb({ type, lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng }, ...(hit ? { hit } : {}) });
      };
    const handlers: PointerHandlers = {
      mousedown: emit("down"),
      mousemove: emit("move"),
      mouseup: emit("up"),
      click: emit("click"),
      dblclick: emit("dblclick"),
    };
    this.map.on("mousedown", handlers.mousedown);
    this.map.on("mousemove", handlers.mousemove);
    this.map.on("mouseup", handlers.mouseup);
    this.map.on("click", handlers.click);
    this.map.on("dblclick", handlers.dblclick);
    this.pointerHandlers = handlers;
    if (typeof window !== "undefined") {
      const windowUp = (): void => {
        if (!this.dragging) return;
        this.dragging = false;
        cb({ type: "up", lngLat: { lat: 0, lon: 0 } });
      };
      window.addEventListener("mouseup", windowUp);
      this.windowUp = windowUp;
    }
  }

  destroy(): void {
    const h = this.pointerHandlers;
    if (h) {
      this.map.off("mousedown", h.mousedown);
      this.map.off("mousemove", h.mousemove);
      this.map.off("mouseup", h.mouseup);
      this.map.off("click", h.click);
      this.map.off("dblclick", h.dblclick);
      this.pointerHandlers = undefined;
    }
    if (this.windowUp && typeof window !== "undefined") {
      window.removeEventListener("mouseup", this.windowUp);
      this.windowUp = undefined;
    }
    if (this.viewHandler) {
      this.map.off("moveend", this.viewHandler);
      this.viewHandler = undefined;
    }
    for (const id of this.builtLayers) if (this.map.getLayer(id)) this.map.removeLayer(id);
    this.builtLayers.length = 0;
    this.renderedToOverlay.clear();
    for (const id of OVERLAY_IDS) if (this.map.getSource(id)) this.map.removeSource(id);
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.readyPromise = undefined;
    this.setCursor("");
    this.map.dragPan.enable();
  }

  private hitAt(point: { x: number; y: number }): { overlay: string; props: Record<string, unknown> } | undefined {
    const layers = this.builtLayers.filter((id) => this.map.getLayer(id));
    // Pad the query into a small box so thin lines (the jet axis) are easy to hit.
    const pad = 5;
    const box: [[number, number], [number, number]] = [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ];
    // Walk the stack top-first and return the first HITTABLE overlay (so a handle
    // sitting on the line wins, and a non-hittable top layer doesn't mask the line).
    for (const found of this.map.queryRenderedFeatures(box, { layers })) {
      const overlay = this.renderedToOverlay.get(found.layer.id);
      if (overlay && HIT_OVERLAYS.has(overlay)) return { overlay, props: (found.properties ?? {}) as Record<string, unknown> };
    }
    return undefined;
  }

  private track(layerId: string, overlay: string): void {
    this.builtLayers.push(layerId);
    this.renderedToOverlay.set(layerId, overlay);
  }

  private addOverlays(): void {
    for (const id of OVERLAY_IDS) {
      if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: EMPTY });
    }
    const s = this.style;
    for (const spec of SIGWX_LAYERS) {
      switch (spec.kind) {
        case "fill":
          this.map.addLayer({
            id: spec.id,
            type: "fill",
            source: spec.id,
            paint: { "fill-color": ["coalesce", ["get", "fillColor"], "#888"], "fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.2] },
          });
          this.track(spec.id, spec.id);
          break;
        case "line": {
          const opacity = spec.id === "selection" ? 0.4 : 1;
          // Filled polygons in the decoration source (wind-barb saw teeth).
          if (spec.id === "decoration") {
            this.map.addLayer({
              id: "decoration-fill",
              type: "fill",
              source: spec.id,
              filter: ["==", ["geometry-type"], "Polygon"],
              paint: { "fill-color": ["coalesce", ["get", "fillColor"], ["get", "stroke"], "#333"] },
            });
            this.track("decoration-fill", spec.id);
          }
          this.map.addLayer({
            id: spec.id,
            type: "line",
            source: spec.id,
            filter: ["!", ["has", "dash"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "stroke"], "#333"],
              "line-width": ["coalesce", ["get", "strokeWidth"], 2],
              "line-opacity": opacity,
            },
          });
          this.track(spec.id, spec.id);
          const dashId = `${spec.id}__dash`;
          this.map.addLayer({
            id: dashId,
            type: "line",
            source: spec.id,
            filter: ["has", "dash"],
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
              "line-color": ["coalesce", ["get", "stroke"], "#333"],
              "line-width": ["coalesce", ["get", "strokeWidth"], 2],
              "line-dasharray": [2, 1.5],
              "line-opacity": opacity,
            },
          });
          this.track(dashId, spec.id);
          break;
        }
        case "symbol":
          this.map.addLayer({
            id: spec.id,
            type: "symbol",
            source: spec.id,
            layout: {
              "icon-image": ["get", "symbol"],
              "icon-size": ["coalesce", ["get", "size"], 1],
              "icon-rotate": ["coalesce", ["get", "rotation"], 0],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
          this.track(spec.id, spec.id);
          break;
        case "text":
          this.map.addLayer({
            id: spec.id,
            type: "symbol",
            source: spec.id,
            layout: {
              "text-field": ["coalesce", ["get", "text"], ""],
              "text-size": ["coalesce", ["get", "textSize"], 13],
              "text-anchor": "center",
              "text-rotate": ["coalesce", ["get", "rotation"], 0],
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "text-color": ["coalesce", ["get", "textColor"], "#111"],
              "text-halo-color": ["coalesce", ["get", "textHalo"], "#fff"],
              "text-halo-width": 2.5,
            },
          });
          this.track(spec.id, spec.id);
          break;
        case "circle":
          this.map.addLayer({
            id: spec.id,
            type: "circle",
            source: spec.id,
            paint: {
              "circle-radius": handleCase(s, "radius") as number,
              // Armed-for-deletion handles turn red.
              "circle-color": ["case", ["==", ["get", "danger"], true], "#f85149", handleCase(s, "color")] as unknown as string,
              "circle-stroke-color": handleCase(s, "strokeColor") as string,
              "circle-stroke-width": handleCase(s, "strokeWidth") as number,
            },
          });
          this.track(spec.id, spec.id);
          break;
      }
    }
    void this.registerSymbols(DEFAULT_SPRITES);
  }
}
