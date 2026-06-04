/**
 * OpenLayers adapter — grafts onto a host-owned `ol/Map`. Per-overlay style
 * functions read the same feature properties as the MapLibre adapter, so the two
 * engines render identically. Glyphs use `Icon` (SVG data URL); text boxes use
 * OL's native `backgroundFill`/`backgroundStroke` (a real box).
 */
import type { FeatureCollection } from "geojson";
import type { FeatureLike } from "ol/Feature";
import type { EventsKey } from "ol/events";
import { getHeight, getWidth } from "ol/extent";
import GeoJSON from "ol/format/GeoJSON";
import DragPan from "ol/interaction/DragPan";
import DoubleClickZoom from "ol/interaction/DoubleClickZoom";
import type BaseLayer from "ol/layer/Base";
import VectorLayer from "ol/layer/Vector";
import OlMap from "ol/Map";
import { unByKey } from "ol/Observable";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import TileLayer from "ol/layer/Tile";
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from "ol/style";
import type { StyleLike } from "ol/style/Style";
import View from "ol/View";

import type { LatLng } from "../core/index.js";
import { rgba } from "../core/index.js";
import type { MapAdapter, PointerEvent, SymbolSprites, ToolbarItem, ToolbarOptions } from "./adapter.js";
import { HIT_OVERLAYS, SIGWX_LAYERS } from "./layers.js";
import { DEFAULT_STYLE } from "./style.js";
import type { SigwxStyle } from "./style.js";
import { DEFAULT_SPRITES, svgToDataUrl } from "./symbols.js";
import { populateToolbar } from "./toolbar.js";
import { applyTooltipStyle } from "./tooltip.js";

const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function createOpenLayersMap(opts: { container: HTMLElement | string; center: [number, number]; zoom: number }): OlMap {
  return new OlMap({
    target: opts.container,
    layers: [new TileLayer({ source: new OSM() })],
    view: new View({ center: fromLonLat(opts.center), zoom: opts.zoom }),
  });
}

export class OpenLayersAdapter implements MapAdapter {
  private readonly map: OlMap;
  private readonly sources = new Map<string, VectorSource>();
  private readonly layers = new Map<string, VectorLayer>();
  private readonly layerOverlay = new Map<unknown, string>();
  private readonly format = new GeoJSON();
  private readonly iconCache = new Map<string, Icon>();
  private sprites: Record<string, string> = {}; // sprite id → data URL
  private dragPan: DragPan | undefined;
  private dblClickZoom: DoubleClickZoom | undefined;
  private readyPromise: Promise<void> | undefined;
  private style: SigwxStyle = DEFAULT_STYLE;
  private olKeys: EventsKey[] = [];
  private domPointerUp: ((e: globalThis.PointerEvent) => void) | undefined;
  private viewportPointerDown: ((e: globalThis.PointerEvent) => void) | undefined;
  private toolbarEl: HTMLElement | undefined;
  private tooltipEl: HTMLElement | undefined;
  private dragging = false;

  constructor(opts: { map: OlMap; style?: SigwxStyle }) {
    this.map = opts.map;
    if (opts.style) this.style = opts.style;
  }

  setStyle(style: SigwxStyle): void {
    this.style = style;
    for (const [id, layer] of this.layers) layer.setStyle(this.styleFor(id));
    if (this.tooltipEl) applyTooltipStyle(this.tooltipEl, style.tooltip);
  }

  registerSymbols(sprites: SymbolSprites): Promise<void> {
    for (const [id, svg] of Object.entries(sprites)) {
      this.sprites[id] = svgToDataUrl(svg);
      this.iconCache.delete(id);
    }
    this.layers.get("symbols")?.changed();
    return Promise.resolve();
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      for (const spec of SIGWX_LAYERS) {
        const source = new VectorSource();
        this.sources.set(spec.id, source);
        const layer = new VectorLayer({ source, style: this.styleFor(spec.id) });
        this.layers.set(spec.id, layer);
        this.layerOverlay.set(layer, spec.id);
        this.map.addLayer(layer);
      }
      const interactions = this.map.getInteractions().getArray();
      this.dragPan = interactions.find((i): i is DragPan => i instanceof DragPan);
      this.dblClickZoom = interactions.find((i): i is DoubleClickZoom => i instanceof DoubleClickZoom);
      this.sprites = Object.fromEntries(Object.entries(DEFAULT_SPRITES).map(([id, svg]) => [id, svgToDataUrl(svg)]));
      this.readyPromise = Promise.resolve();
    }
    return this.readyPromise;
  }

  setOverlay(id: string, data: FeatureCollection): void {
    const source = this.sources.get(id);
    if (!source) return;
    source.clear();
    if (data.features.length) {
      source.addFeatures(this.format.readFeatures(data, { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }));
    }
  }

  addToolbar(items: ToolbarItem[], options?: ToolbarOptions): HTMLElement {
    if (this.toolbarEl) return this.toolbarEl;
    const el = document.createElement("div");
    el.className = "ol-control sigwx-toolbar";
    populateToolbar(el, items, options);
    this.map.getTargetElement()?.appendChild(el);
    this.toolbarEl = el;
    return el;
  }

  getCenter(): LatLng {
    const c = this.map.getView().getCenter();
    if (!c) return { lat: 0, lon: 0 };
    const [lon, lat] = toLonLat(c);
    return { lat: lat!, lon: lon! };
  }

  getViewSpan(): number {
    const size = this.map.getSize();
    if (!size) return 10;
    const extent = transformExtent(this.map.getView().calculateExtent(size), "EPSG:3857", "EPSG:4326");
    return Math.max(getWidth(extent), getHeight(extent)) || 10;
  }

  project(p: LatLng): [number, number] | null {
    const px = this.map.getPixelFromCoordinate(fromLonLat([p.lon, p.lat]));
    return px ? [px[0]!, px[1]!] : null;
  }

  unproject(px: [number, number]): LatLng | null {
    const coord = this.map.getCoordinateFromPixel(px);
    if (!coord) return null;
    const [lon, lat] = toLonLat(coord);
    return { lat: lat!, lon: lon! };
  }

  onViewChange(cb: () => void): void {
    this.olKeys.push(this.map.on("moveend", cb));
  }

  setPanEnabled(enabled: boolean): void {
    this.dragPan?.setActive(enabled);
  }

  setDoubleClickZoom(enabled: boolean): void {
    this.dblClickZoom?.setActive(enabled);
  }

  setCursor(cursor: string): void {
    const el = this.map.getTargetElement();
    if (el) el.style.cursor = cursor;
  }

  setTooltip(t: string | null, at: LatLng): void {
    if (t == null) {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
      return;
    }
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement("div");
      this.tooltipEl.className = "sigwx-tooltip";
      applyTooltipStyle(this.tooltipEl, this.style.tooltip);
      this.map.getTargetElement()?.appendChild(this.tooltipEl);
    }
    const px = this.map.getPixelFromCoordinate(fromLonLat([at.lon, at.lat]));
    if (!px) return;
    this.tooltipEl.textContent = t;
    this.tooltipEl.style.display = "block";
    this.tooltipEl.style.left = `${px[0]}px`;
    this.tooltipEl.style.top = `${px[1]}px`;
  }

  onPointer(cb: (ev: PointerEvent) => void): void {
    if (this.domPointerUp) return;
    this.viewportPointerDown = (e: globalThis.PointerEvent) => {
      const coord = this.map.getEventCoordinate(e);
      if (!coord) return;
      this.dragging = true;
      const [lon, lat] = toLonLat(coord);
      const hit = this.hitAt(this.map.getEventPixel(e));
      cb({ type: "down", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
    };
    // "up" must fire even when the pointerup lands off the canvas (no coordinate),
    // so a drag (and its delete-on-release) always completes.
    this.domPointerUp = (): void => {
      this.dragging = false;
      cb({ type: "up", lngLat: { lat: 0, lon: 0 } });
    };
    this.map.getViewport().addEventListener("pointerdown", this.viewportPointerDown);
    document.addEventListener("pointerup", this.domPointerUp);

    this.olKeys.push(
      this.map.on("pointermove", (evt) => {
        const [lon, lat] = toLonLat(evt.coordinate);
        if (this.dragging) {
          cb({ type: "move", lngLat: { lat: lat!, lon: lon! } });
          return;
        }
        const hit = this.hitAt(evt.pixel);
        this.setCursor(hit ? "pointer" : "");
        cb({ type: "move", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
      this.map.on("singleclick", (evt) => {
        const hit = this.hitAt(evt.pixel);
        const [lon, lat] = toLonLat(evt.coordinate);
        cb({ type: "click", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
      this.map.on("dblclick", (evt) => {
        const hit = this.hitAt(evt.pixel);
        const [lon, lat] = toLonLat(evt.coordinate);
        cb({ type: "dblclick", lngLat: { lat: lat!, lon: lon! }, ...(hit ? { hit } : {}) });
      }),
    );
  }

  destroy(): void {
    this.layerOverlay.forEach((_, layer) => this.map.removeLayer(layer as BaseLayer));
    this.layerOverlay.clear();
    this.layers.clear();
    this.sources.clear();
    unByKey(this.olKeys);
    this.olKeys = [];
    if (this.viewportPointerDown) {
      this.map.getViewport().removeEventListener("pointerdown", this.viewportPointerDown);
      this.viewportPointerDown = undefined;
    }
    if (this.domPointerUp) {
      document.removeEventListener("pointerup", this.domPointerUp);
      this.domPointerUp = undefined;
    }
    this.toolbarEl?.remove();
    this.toolbarEl = undefined;
    this.tooltipEl?.remove();
    this.tooltipEl = undefined;
    this.readyPromise = undefined;
    this.dragPan?.setActive(true);
    this.setCursor("");
  }

  private hitAt(pixel: number[]): { overlay: string; props: Record<string, unknown> } | undefined {
    let result: { overlay: string; props: Record<string, unknown> } | undefined;
    this.map.forEachFeatureAtPixel(
      pixel,
      (feature: FeatureLike, layer: unknown) => {
        const overlay = this.layerOverlay.get(layer);
        if (overlay && HIT_OVERLAYS.has(overlay)) {
          const props = { ...feature.getProperties() };
          delete props["geometry"];
          result = { overlay, props };
          return true;
        }
        return false;
      },
      { hitTolerance: 5 },
    );
    return result;
  }

  private icon(spriteId: string, size: number): Icon | undefined {
    const src = this.sprites[spriteId];
    if (!src) return undefined;
    let icon = this.iconCache.get(spriteId);
    if (!icon) {
      icon = new Icon({ src, scale: size });
      this.iconCache.set(spriteId, icon);
    }
    return icon;
  }

  private styleFor(id: string): StyleLike {
    const s = this.style;
    const spec = SIGWX_LAYERS.find((l) => l.id === id)!;
    switch (spec.kind) {
      case "fill":
        return (f: FeatureLike): Style =>
          new Style({ fill: new Fill({ color: rgba(text(f.get("fillColor")) || "#888", num(f.get("fillOpacity"), 0.2)) }) });
      case "line":
        return (f: FeatureLike): Style => {
          const stroke = text(f.get("stroke")) || "#333";
          const width = num(f.get("strokeWidth"), 2);
          const dash = f.get("dash") as number[] | undefined;
          const color = id === "selection" ? rgba(stroke, 0.4) : stroke;
          const st = new Stroke({ color, width, ...(dash ? { lineDash: dash } : {}), lineCap: dash ? "butt" : "round", lineJoin: "round" });
          // Filled polygons (wind-barb saw teeth) in the decoration source.
          const isPolygon = f.getGeometry?.()?.getType() === "Polygon";
          if (isPolygon) return new Style({ stroke: st, fill: new Fill({ color: text(f.get("fillColor")) || stroke }) });
          return new Style({ stroke: st });
        };
      case "symbol":
        return (f: FeatureLike): Style => {
          const icon = this.icon(text(f.get("symbol")), num(f.get("size"), 1));
          return icon ? new Style({ image: icon }) : new Style({});
        };
      case "text":
        return (f: FeatureLike): Style => {
          const bg = text(f.get("textBackground"));
          const halo = text(f.get("textHalo"));
          return new Style({
            text: new Text({
              text: text(f.get("text")),
              font: `${num(f.get("textSize"), 13)}px sans-serif`,
              rotation: (num(f.get("rotation"), 0) * Math.PI) / 180,
              rotateWithView: false,
              fill: new Fill({ color: text(f.get("textColor")) || "#111" }),
              // Boxed call-out only when a background is given; otherwise a discreet
              // haloed label (e.g. the segment transition hints).
              ...(bg
                ? { backgroundFill: new Fill({ color: bg }), backgroundStroke: new Stroke({ color: text(f.get("textBorder")) || "#111", width: 1 }), padding: [2, 4, 2, 4] }
                : { stroke: new Stroke({ color: halo || "#fff", width: 3 }) }),
            }),
          });
        };
      case "circle": {
        const mk = (p: SigwxStyle["handle"]) =>
          new Style({ image: new CircleStyle({ radius: p.radius, fill: new Fill({ color: p.color }), stroke: new Stroke({ color: p.strokeColor, width: p.strokeWidth }) }) });
        const vertex = mk(s.handle);
        const slider = mk(s.slider);
        const control = mk(s.controlHandle);
        // "end" (jet extremity) = the vertex handle with fill/stroke colours swapped.
        const end = mk({ ...s.handle, color: s.handle.strokeColor, strokeColor: s.handle.color });
        const danger = mk({ ...s.slider, color: "#f85149" });
        return (f: FeatureLike): Style => {
          if (f.get("danger")) return danger;
          const hc = f.get("hClass");
          return hc === "slider" ? slider : hc === "control" ? control : hc === "end" ? end : vertex;
        };
      }
    }
  }
}
