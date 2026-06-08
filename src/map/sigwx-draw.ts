/**
 * `SigwxDraw` — headless SIGWX charting grafted onto a host map via a
 * {@link MapAdapter}. It owns a COLLECTION of chart features plus a selection,
 * and supports two interaction models per phenomenon:
 *  - `drop`  — a default geometry is dropped at the centre (points: TC, volcano…);
 *  - `draw`  — the forecaster lays a path/area by clicking (jet, CB, turbulence…).
 *
 * Beyond shape vertices it manages two more handle classes — **sliders** (jet
 * break points that glide along the smoothed curve, carrying per-segment data)
 * and **call-out boxes** (draggable to pin them) — plus a screen-space
 * anti-collision pass that places every feature's call-out boxes and draws their
 * leader lines, re-run on pan/zoom.
 */
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

import {
  catmullRom,
  catmullRomClosed,
  clampInRing,
  coordsOf,
  isSimpleRing,
  radialSortRing,
  defaultMetadata,
  defaultRegistry,
  DEFAULT_CB_COVERAGE,
  DEFAULT_TURBULENCE_SYMBOLS,
  fromFeatureCollection,
  frameK,
  makeCb,
  makeTurbulence,
  interactionOf,
  isVisible,
  mergePhenomenonStyle,
  PhenomenonRegistry,
  pointAtFraction,
  projectToFraction,
  simplify,
  toFeatureCollection,
  toLonLat,
  toPlanar,
  validate,
} from "../core/index.js";
import type {
  CbCoverage,
  CbStyle,
  FieldSchema,
  FlMode,
  InteractionSpec,
  JetStyle,
  ListField,
  Metadata,
  PhenomenonDef,
  PhenomenonStyle,
  Pt,
  RenderFeature,
  SigwxFeature,
  TurbulenceStyle,
} from "../core/index.js";
import type { MapAdapter, PointerEvent, SnapshotOptions, SymbolSprites, ToolbarItem, ToolbarOptions } from "./adapter.js";
import { ANNOTATION_BUCKET, OVERLAY_IDS } from "./layers.js";
import { placeAnnotations } from "./placement.js";
import type { AnnReq, Pin } from "./placement.js";
import { DEFAULT_STYLE, mergeStyle } from "./style.js";
import type { SigwxStyle, SigwxStyleInput } from "./style.js";
import { decorate } from "./style-features.js";
import { DEFAULT_SPRITES } from "./symbols.js";

/** A schema field with its `visibleWhen` evaluated for the current metadata. */
export type ResolvedField = FieldSchema & { visible: boolean };

/** What the host needs to render the metadata form for the selection. */
export interface FormSpec {
  featureId: string;
  phenomenon: string;
  /** Global (non-list) fields. */
  fields: ResolvedField[];
  values: Metadata;
  errors: Record<string, string>;
  /** Present when the phenomenon has a list field (e.g. jet break points). */
  list?: {
    key: string;
    label: string;
    items: { index: number; label: string }[];
    selectedIndex: number | null;
    /** Schema of the selected item (visibleWhen evaluated against the item). */
    itemFields?: ResolvedField[];
    itemValues?: Metadata;
  };
}

/**
 * Per-phenomenon configuration, keyed by phenomenon type. Groups everything that
 * customises one phenomenon. Each phenomenon names its own bounds directly (no
 * `limits` wrapper):
 * - `speed`: the jet wind-speed dial range.
 * - `flightLevel`: the chart FL range (turbulence/CB) — the on-map gauge clamps
 *   here, and a top/base beyond it shows the off-chart "XXX" sentinel.
 * - `style`: overrides the phenomenon's own visual tokens (shape ink, FL text,
 *   severity glyph…), merged onto its `def.style`.
 */
/** Numeric range for an on-map control (jet speed dial, turbulence FL gauge). */
export interface NumRange {
  min?: number;
  max?: number;
}

/** Per-phenomenon FL config: chart bounds, default value(s) and off-chart behaviour.
 *  `D` = the default's shape: `number` for the jet (core FL), `[number, number]` for an
 *  area (`[base, top]`). `beyond` is per bound `[below-min, above-max]` — `"clamp"` hard-stops,
 *  `"xxx"` lets it off-chart and renders the "XXX" sentinel. */
export interface FlightLevelConfig<D = number | [number, number]> {
  min?: number;
  max?: number;
  default?: D;
  beyond?: [FlMode, FlMode];
}

/** Generic (any-phenomenon) config — used as the fallback for unknown phenomenon types. */
export interface PhenomenonConfig {
  speed?: NumRange;
  flightLevel?: FlightLevelConfig;
  style?: Partial<PhenomenonStyle>;
  /** CB: lightning-bolt leader (default true) vs a plain straight leader. */
  leaderThunderbolt?: boolean;
  /** CB: extra coverage amounts appended to the OCNL/FRQ carousel (strings or full {@link CbCoverage}). */
  extraCoverages?: (string | CbCoverage)[];
}

/**
 * The `phenomena` option, typed PER PHENOMENON so the compiler accepts only each one's
 * OWN style (jet → arrow/text, turbulence → mod/sev/edge/area/text, CB → edge/area/text)
 * and its own on-map controls. Unknown types fall back to the generic {@link PhenomenonConfig}.
 */
export interface PhenomenaConfig {
  jetStream?: { speed?: NumRange; flightLevel?: FlightLevelConfig<number>; style?: Partial<JetStyle> };
  turbulence?: { flightLevel?: FlightLevelConfig<[number, number]>; style?: Partial<TurbulenceStyle> };
  cb?: { flightLevel?: FlightLevelConfig<[number, number]>; style?: Partial<CbStyle>; leaderThunderbolt?: boolean; extraCoverages?: (string | CbCoverage)[] };
  [type: string]: PhenomenonConfig | undefined;
}

/**
 * A turbulence symbol/type added to the catalogue: a `code` (stored in the feature's
 * `symbol` metadata AND used as the sprite id), a `label`, and the inline `svg` glyph
 * (use `currentColor` to keep it tintable). These COMPLETE the default MOD/SEV set.
 */
export interface TurbulenceType {
  code: string;
  label: string;
  svg: string;
}

export interface SigwxDrawOptions {
  adapter: MapAdapter;
  registry?: PhenomenonRegistry;
  /** Global chrome only (selection, handles, slider, control handles, tooltip). */
  style?: SigwxStyleInput;
  toolbar?: boolean | ToolbarOptions;
  symbolSprite?: SymbolSprites;
  /** Per-phenomenon config (typed per phenomenon), e.g. `{ jetStream: { speed, style }, turbulence: { flightLevel, style } }`. */
  phenomena?: PhenomenaConfig;
  /** Extra turbulence symbols/types, added to the default MOD/SEV catalogue. */
  turbulenceTypes?: TurbulenceType[];
}

const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
/** "Clear all" toolbar icon (a ✕) — `ToolbarItem` is svg-only since draw-adapter 0.2.x. */
const CLEAR_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** Fine "sync" glyph (two inverted curved arrows) drawn ON the central handle of a scalloped
 *  phenomenon (CB): drag it to move the call-out, TAP it to flip the bumps in/out. Data-URI so
 *  the adapter rasterises it straight onto the handle (per-feature handle icon). */
const SYNC_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1f2328" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
)}`;
/** Editing-chrome overlays hidden during a snapshot, so the PNG shows the clean chart
 *  (no selection highlight / edit + control handles). The chart decoration stays. */
const SNAPSHOT_HIDE = ["selection", "handles", "controls"];

/** Is keyboard focus in an editable element (input/textarea/select/contenteditable),
 *  traversing open shadow roots (e.g. the metadata-form web component)? Used so the
 *  window-level Backspace/Delete handler never steals a keystroke from text entry. */
function isEditableTarget(): boolean {
  if (typeof document === "undefined") return false;
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable;
}
/** On-map speed dial (speedometer): fixed radius + angular sweep (deg, screen y-down). */
const SPEED_R = 52;
const SPEED_A0 = 150; // min-speed angle (down-left)
const SPEED_SWEEP = 240; // sweep to max-speed (over the top, gap at the bottom)
/** Speed → dial angle (deg). */
const angleForSpeed = (sp: number, min: number, max: number): number => SPEED_A0 + (max > min ? (sp - min) / (max - min) : 0) * SPEED_SWEEP;
/** Cursor angle (deg, 0–360, screen y-down) → speed, clamping the bottom gap to the nearer end. */
const speedForAngle = (deg: number, min: number, max: number): number => {
  const d = ((deg % 360) + 360) % 360;
  let f: number;
  if (d >= SPEED_A0) f = (d - SPEED_A0) / SPEED_SWEEP;
  else if (d <= SPEED_A0 + SPEED_SWEEP - 360) f = (d + 360 - SPEED_A0) / SPEED_SWEEP;
  else f = d < 90 ? 1 : 0; // bottom gap → snap to max / min
  return min + Math.max(0, Math.min(1, f)) * (max - min);
};
/** Vertical FL gauge: reference level (gauge centre) and screen pixels per FL. */
const FL_REF = 350;
const FL_PX = 0.6;

/** A break point sitting at a jet extremity (t≈0 / t≈1): its speed is fixed at the floor. */
const isEndItem = (it: Metadata): boolean => {
  const t = Number(it["t"] ?? 0.5);
  return t <= 0.001 || t >= 0.999;
};

function listFieldOf(def: PhenomenonDef): ListField | undefined {
  return def.schema.find((f): f is ListField => f.type === "list");
}

export class SigwxDraw {
  private readonly adapter: MapAdapter;
  private readonly registry: PhenomenonRegistry;
  private readonly phenomena: Record<string, PhenomenonConfig | undefined> = {};
  /** Host-added turbulence symbols/types (beyond the default MOD/SEV), by code. */
  private turbTypes: TurbulenceType[] = [];
  /** Host-added CB coverage amounts (beyond the default OCNL/FRQ). */
  private cbCoverages: CbCoverage[] = [];
  private readonly readyPromise: Promise<void>;
  private readonly doc = new Map<string, SigwxFeature>();
  private order: string[] = [];
  private selectedId: string | null = null;
  private selectedSub: number | null = null;
  private mode: "idle" | "drawing" | "editing" = "idle";
  private drawing: { type: string; coords: Position[] } | null = null;
  private drawCursor: Position | null = null;
  private stroking = false;
  private dragTarget:
    | { kind: "vertex"; featureId: string; index: number }
    | { kind: "slider"; featureId: string; index: number }
    | { kind: "speed"; featureId: string; index: number }
    | { kind: "level"; featureId: string; index: number; field: "fl" | "top" | "base" }
    | { kind: "metaLevel"; featureId: string; field: string }
    | { kind: "toggle"; featureId: string; field: string; options: string[] }
    | { kind: "callout"; featureId: string; labelId: string; grab: [number, number]; toggle?: { field: string; options: string[] } }
    | { kind: "anchor"; featureId: string }
    | { kind: "translate"; featureId: string; lastPx: [number, number] }
    | null = null;
  private didDrag = false;
  /** FL the vertical gauge is centred on (the selected point's FL at selection time),
   *  so its core-FL handle starts level with the point. */
  private flRef = FL_REF;
  /** While dragging a slider off the line: its free cursor position + delete arming. */
  private dragFree: Position | null = null;
  private willDelete = false;
  private style: SigwxStyle;
  private readonly resolved = new Map<string, PhenomenonStyle>();
  private readonly pins = new Map<string, Pin>();
  /** User-moved leader anchor (arrow tip), lon/lat per feature — re-clamped into the ring each render. */
  private readonly anchorPins = new Map<string, [number, number]>();
  /** Where each feature's call-out box was last placed (lon/lat) — so the area FL gauge follows it. */
  private readonly placedAt = new Map<string, [number, number]>();
  private lastAnnReqs: AnnReq[] = [];
  private idSeq = 0;
  private destroyed = false;
  private renderScheduled = false;
  private keyHandler: ((e: KeyboardEvent) => void) | undefined;

  private readonly changeListeners = new Set<(fc: FeatureCollection) => void>();
  private readonly selectListeners = new Set<(spec: FormSpec | null) => void>();
  private readonly metadataListeners = new Set<(spec: FormSpec) => void>();

  constructor(opts: SigwxDrawOptions) {
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? defaultRegistry();
    this.phenomena = opts.phenomena ?? {};
    this.style = mergeStyle(DEFAULT_STYLE, opts.style);

    this.readyPromise = this.adapter.ready().then(async () => {
      // The generic adapter does NOT auto-register sprites — register the SIGWX
      // defaults (MOD/SEV turbulence glyphs); the host's overrides win.
      await this.adapter.registerSymbols({ ...DEFAULT_SPRITES, ...(opts.symbolSprite ?? {}) });
      if (opts.turbulenceTypes?.length) {
        this.turbTypes = [...opts.turbulenceTypes];
        await this.applyTurbulenceCatalog();
      }
      const extraCov = this.phenomena["cb"]?.extraCoverages;
      if (extraCov?.length) {
        this.cbCoverages = extraCov.map((c) => (typeof c === "string" ? { code: c, label: c } : c));
        this.applyCbCatalog();
      }
      this.adapter.onPointer((ev) => this.onPointer(ev));
      // Re-render on pan/zoom so screen-sized decorations (wind barbs) and the
      // call-out placement both refresh.
      this.adapter.onViewChange(() => this.scheduleRender());
      if (typeof window !== "undefined") {
        this.keyHandler = (e) => this.onKey(e);
        window.addEventListener("keydown", this.keyHandler);
      }
      if (opts.toolbar) this.buildToolbar(opts.toolbar === true ? {} : opts.toolbar);
      this.renderAll();
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Enter drawing for a phenomenon. In `draw` mode (the default) the map starts
   * drawing and the feature is created on finalize (returns `""`; listen to
   * `select`/`change`). In `drop` mode a default geometry is created and selected
   * immediately (returns its id).
   */
  draw(type: string): string {
    const def = this.registry.get(type);
    const it = interactionOf(def);
    if (it.mode === "drop") return this.dropFeature(def);
    this.cancelDrawing();
    this.select(null);
    this.mode = "drawing";
    this.drawing = { type, coords: [] };
    this.drawCursor = null;
    this.stroking = false;
    this.syncDblClickZoom();
    this.adapter.setCursor("crosshair");
    this.renderAll();
    return "";
  }

  select(id: string | null): void {
    this.selectedId = id != null && this.doc.has(id) ? id : null;
    this.selectedSub = null;
    // Centre the FL gauge of an AREA on its top/base midpoint (so the slider sits
    // level with the call-out, not hanging below).
    const f = this.selectedId ? this.doc.get(this.selectedId) : undefined;
    const m = f?.properties.metadata;
    if (m && typeof m["topFL"] === "number" && typeof m["baseFL"] === "number") {
      this.flRef = ((m["topFL"] as number) + (m["baseFL"] as number)) / 2;
    }
    this.syncDblClickZoom();
    this.renderAll();
    this.emitSelect();
  }

  /** Map double-click-zoom is disabled while drawing or editing (double-click is
   *  then our gesture: finish / add / remove / split); enabled when idle. */
  private syncDblClickZoom(): void {
    this.adapter.setDoubleClickZoom(this.mode !== "drawing" && this.selectedId == null);
  }

  /** Select a sub-element (list item index, e.g. a jet break point), or clear it. */
  selectSubItem(index: number | null): void {
    this.selectedSub = index;
    // Centre the FL gauge on the point's current FL → its handle starts level with it.
    if (index != null && this.selectedId) {
      const f = this.doc.get(this.selectedId);
      const def = f ? this.registry.get(f.properties.phenomenon) : undefined;
      const lf = def ? listFieldOf(def) : undefined;
      const item = lf && f ? (f.properties.metadata[lf.key] as Metadata[] | undefined)?.[index] : undefined;
      if (item && typeof item["fl"] === "number") this.flRef = item["fl"] as number;
    }
    this.renderAll();
    this.emitSelect();
  }

  updateMetadata(id: string, patch: Partial<Metadata>): void {
    const f = this.doc.get(id);
    if (!f) return;
    f.properties.metadata = { ...f.properties.metadata, ...patch };
    this.afterEdit(id);
  }

  updateListItem(id: string, listKey: string, index: number, patch: Partial<Metadata>): void {
    const f = this.doc.get(id);
    if (!f) return;
    const list = (f.properties.metadata[listKey] as Metadata[] | undefined) ?? [];
    if (!list[index]) return;
    list[index] = { ...list[index], ...patch };
    f.properties.metadata = { ...f.properties.metadata, [listKey]: list };
    this.afterEdit(id);
  }

  addListItem(id: string, listKey: string, item: Metadata): number {
    const f = this.doc.get(id);
    if (!f) return -1;
    const list = [...((f.properties.metadata[listKey] as Metadata[] | undefined) ?? []), item];
    f.properties.metadata = { ...f.properties.metadata, [listKey]: list };
    this.afterEdit(id);
    return list.length - 1;
  }

  /** Add a list item seeded from the item schema's defaults at the curve midpoint. */
  addDefaultListItem(id: string, listKey: string): number {
    const f = this.doc.get(id);
    if (!f) return -1;
    const lf = listFieldOf(this.registry.get(f.properties.phenomenon));
    if (!lf || lf.key !== listKey) return -1;
    const item: Metadata = { t: 0.5 };
    for (const s of lf.itemSchema) {
      if (s.type !== "list" && "default" in s && s.default !== undefined) item[s.key] = s.default;
      else if (s.type === "bool") item[s.key] = false;
    }
    return this.addListItem(id, listKey, item);
  }

  /** Remove a shape vertex (double-click), keeping ≥2 (line) / ≥3 (polygon). */
  private removeVertex(id: string, index: number): void {
    const f = this.doc.get(id);
    if (!f) return;
    const g = f.geometry;
    if (g.type === "LineString") {
      if (g.coordinates.length <= 2 || !g.coordinates[index]) return;
      g.coordinates.splice(index, 1);
    } else if (g.type === "Polygon") {
      const ring = g.coordinates[0];
      if (!ring) return;
      const uniq = ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring.slice();
      if (uniq.length <= 3 || !uniq[index]) return;
      uniq.splice(index, 1);
      uniq.push(uniq[0]!);
      g.coordinates[0] = uniq;
    } else {
      return;
    }
    this.afterEdit(id);
  }

  /**
   * Split a data point in two (double-click): the original is removed and two
   * copies (same speed/FL) are placed in the left part (toward the previous point
   * or the start) and the right part (toward the next point or the end).
   */
  private duplicateBreakPoint(id: string, index: number): void {
    const f = this.doc.get(id);
    if (!f) return;
    const lf = listFieldOf(this.registry.get(f.properties.phenomenon));
    if (!lf) return;
    const list = (f.properties.metadata[lf.key] as Metadata[] | undefined) ?? [];
    const p = list[index];
    if (!p) return;
    const tOf = (m: Metadata): number => (typeof m["t"] === "number" ? m["t"] : 0);
    const sorted = list.map((it, i) => ({ i, t: tOf(it) })).sort((a, b) => a.t - b.t);
    const pos = sorted.findIndex((s) => s.i === index);
    const prevT = pos > 0 ? sorted[pos - 1]!.t : 0;
    const nextT = pos < sorted.length - 1 ? sorted[pos + 1]!.t : 1;
    const pt = tOf(p);
    const others = list.filter((_, i) => i !== index);
    const left = { ...p, t: (prevT + pt) / 2 };
    const right = { ...p, t: (pt + nextT) / 2 };
    f.properties.metadata = { ...f.properties.metadata, [lf.key]: [...others, left, right] };
    this.selectedSub = null;
    this.afterEdit(id);
    this.emitSelect();
  }

  /** Insert a shape vertex on the nearest segment to `at` (double-click on line). */
  private insertVertexAt(id: string, at: Position): void {
    const f = this.doc.get(id);
    if (!f) return;
    const g = f.geometry;
    const verts = vertices(g);
    if (verts.length < 2) return;
    const k = frameK(verts as Pt[]);
    const planar = verts.map((c) => toPlanar(c as Pt, k));
    const cur = toPlanar([at[0]!, at[1]!], k);
    const cyclic = g.type === "Polygon";
    const segCount = cyclic ? planar.length : planar.length - 1;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < segCount; i++) {
      const d = segDist(cur, planar[i]!, planar[(i + 1) % planar.length]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (g.type === "LineString") {
      g.coordinates.splice(best + 1, 0, at);
    } else if (g.type === "Polygon") {
      const uniq = verts.slice();
      uniq.splice(best + 1, 0, at);
      uniq.push(uniq[0]!);
      g.coordinates[0] = uniq;
    }
    if (this.selectedId !== id) this.select(id);
    else this.afterEdit(id);
  }

  removeListItem(id: string, listKey: string, index: number): void {
    const f = this.doc.get(id);
    if (!f) return;
    const list = ((f.properties.metadata[listKey] as Metadata[] | undefined) ?? []).filter((_, i) => i !== index);
    f.properties.metadata = { ...f.properties.metadata, [listKey]: list };
    // Keep the selected sub-item pointing at the SAME entry: clear it if it was removed,
    // shift it down if an earlier entry was removed (else it dangles past the new end).
    if (this.selectedSub != null && index <= this.selectedSub) {
      this.selectedSub = this.selectedSub === index ? null : this.selectedSub - 1;
    }
    this.afterEdit(id);
  }

  delete(id: string): void {
    if (!this.doc.delete(id)) return;
    this.order = this.order.filter((x) => x !== id);
    for (const k of [...this.pins.keys()]) if (k.startsWith(`${id}:`)) this.pins.delete(k);
    this.anchorPins.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
      this.selectedSub = null;
    }
    this.syncDblClickZoom();
    this.renderAll();
    this.emitChange();
    this.emitSelect();
  }

  clear(): void {
    this.doc.clear();
    this.order = [];
    this.pins.clear();
    this.selectedId = null;
    this.selectedSub = null;
    this.cancelDrawing();
    this.syncDblClickZoom();
    this.renderAll();
    this.emitChange();
    this.emitSelect();
  }

  bringToFront(id: string): void {
    if (!this.doc.has(id)) return;
    this.order = [...this.order.filter((x) => x !== id), id];
    this.renderAll();
  }

  sendToBack(id: string): void {
    if (!this.doc.has(id)) return;
    this.order = [id, ...this.order.filter((x) => x !== id)];
    this.renderAll();
  }

  save(): FeatureCollection {
    return toFeatureCollection(this.order.map((id) => this.doc.get(id)!));
  }

  load(fcIn: FeatureCollection): void {
    this.doc.clear();
    this.order = [];
    this.pins.clear();
    for (const f of fromFeatureCollection(fcIn, this.registry)) {
      const id = f.properties.id || `f${this.idSeq++}`;
      f.properties.id = id;
      this.doc.set(id, f);
      this.order.push(id);
    }
    this.selectedId = null;
    this.selectedSub = null;
    this.syncDblClickZoom();
    this.renderAll();
    this.emitChange();
    this.emitSelect();
  }

  setStyle(input: SigwxStyleInput): void {
    this.style = mergeStyle(this.style, input);
    this.resolved.clear();
    this.renderAll(); // re-decorates the handles with the new style (was adapter.setStyle)
  }

  /**
   * Restyle one phenomenon's own visual tokens live (shape ink, FL text, severity
   * glyph…) — the runtime counterpart of the `phenomena[type].style` option. The
   * passed style replaces that phenomenon's override (merged onto its `def.style`);
   * pass `{}` to revert to the default look.
   */
  setPhenomenonStyle(type: string, style: Partial<PhenomenonStyle>): void {
    this.phenomena[type] = { ...this.phenomena[type], style };
    this.resolved.delete(type);
    this.renderAll();
  }

  /**
   * Set a phenomenon's chart FL range live (the turbulence/CB gauge) — the runtime
   * counterpart of `phenomena[type].flightLevel`. The on-map cursors re-clamp and the
   * XXX threshold moves at once; pass `{}` to revert to the def defaults.
   */
  setPhenomenonFlightLevel(type: string, flightLevel: FlightLevelConfig): void {
    this.phenomena[type] = { ...this.phenomena[type], flightLevel };
    this.renderAll();
    if (this.selectedId && this.doc.get(this.selectedId)?.properties.phenomenon === type) this.emitSelect();
  }

  /** Capture the map as a PNG (the same as the toolbar's snapshot button). The editing
   *  chrome is hidden by default for a clean chart; pass `opts` to override (`hideOverlays`,
   *  `target: "download" | "clipboard" | "blob"`, `scale`, `filename`). The Blob is returned. */
  snapshot(opts?: SnapshotOptions): Promise<Blob> {
    return this.adapter.snapshot({ hideOverlays: SNAPSHOT_HIDE, ...opts });
  }

  /**
   * Add turbulence symbols/types to the catalogue (beyond the default MOD/SEV) —
   * each `{ code, label, svg }`. The glyph is registered as the sprite `code`; the
   * turbulence phenomenon's `symbol` enum gains the new options. Click the glyph on
   * the map to pick among them. Re-call to add more (merged by `code`).
   */
  async addTurbulenceTypes(types: TurbulenceType[]): Promise<void> {
    const byCode = new Map(this.turbTypes.map((t) => [t.code, t]));
    for (const t of types) byCode.set(t.code, t);
    this.turbTypes = [...byCode.values()];
    await this.applyTurbulenceCatalog();
    if (this.selectedId) this.emitSelect();
  }

  /** Register the added glyphs and rebuild the turbulence def for the full catalogue. */
  private async applyTurbulenceCatalog(): Promise<void> {
    const sprites: SymbolSprites = {};
    for (const t of this.turbTypes) sprites[t.code] = t.svg;
    if (Object.keys(sprites).length) await this.adapter.registerSymbols(sprites);
    const symbols = [...DEFAULT_TURBULENCE_SYMBOLS, ...this.turbTypes.map((t) => ({ code: t.code, label: t.label }))];
    this.registry.register(makeTurbulence(symbols));
    this.resolved.delete("turbulence");
    this.renderAll();
  }

  /**
   * Append CB coverage amounts (beyond the default OCNL / FRQ) to the catalogue — the call-out
   * box's coverage carousel cycles them. Re-call to add more (merged by `code`).
   */
  addCbCoverages(coverages: CbCoverage[]): void {
    const byCode = new Map(this.cbCoverages.map((c) => [c.code, c]));
    for (const c of coverages) byCode.set(c.code, c);
    this.cbCoverages = [...byCode.values()];
    this.applyCbCatalog();
    if (this.selectedId) this.emitSelect();
  }

  /** Rebuild the CB def so its `coverage` enum carries the default OCNL/FRQ plus host-added amounts. */
  private applyCbCatalog(): void {
    this.registry.register(makeCb([...DEFAULT_CB_COVERAGE, ...this.cbCoverages]));
    this.resolved.delete("cb");
    this.renderAll();
  }

  on(event: "change", cb: (fc: FeatureCollection) => void): void;
  on(event: "select", cb: (spec: FormSpec | null) => void): void;
  on(event: "metadata", cb: (spec: FormSpec) => void): void;
  on(event: "change" | "select" | "metadata", cb: (arg: never) => void): void {
    if (event === "change") this.changeListeners.add(cb as (fc: FeatureCollection) => void);
    else if (event === "select") this.selectListeners.add(cb as (s: FormSpec | null) => void);
    else this.metadataListeners.add(cb as (s: FormSpec) => void);
  }

  off(_event: "change" | "select" | "metadata", cb: (arg: never) => void): void {
    this.changeListeners.delete(cb as (fc: FeatureCollection) => void);
    this.selectListeners.delete(cb as (s: FormSpec | null) => void);
    this.metadataListeners.delete(cb as (s: FormSpec) => void);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.keyHandler && typeof window !== "undefined") window.removeEventListener("keydown", this.keyHandler);
    this.changeListeners.clear();
    this.selectListeners.clear();
    this.metadataListeners.clear();
    this.doc.clear();
    this.order = [];
    this.adapter.destroy();
  }

  // ── internals: feature lifecycle ─────────────────────────────────────────

  private dropFeature(def: PhenomenonDef): string {
    const id = `f${this.idSeq++}`;
    const center = this.adapter.getCenter();
    const span = this.adapter.getViewSpan();
    const geometry = def.draw.defaultGeometry
      ? def.draw.defaultGeometry(center, span)
      : ({ type: "Point", coordinates: [center.lon, center.lat] } as Geometry);
    this.doc.set(id, { type: "Feature", geometry, properties: { id, phenomenon: def.type, metadata: defaultMetadata(def) } });
    this.order.push(id);
    this.mode = "editing";
    this.select(id);
    this.emitChange();
    return id;
  }

  /** Commit a drawn geometry as a new feature, select it, leave drawing mode. */
  private commit(type: string, geometry: Geometry): void {
    const id = `f${this.idSeq++}`;
    const metadata = defaultMetadata(this.registry.get(type));
    this.applyFlDefault(type, metadata); // override FL defaults from `phenomena[type].flightLevel.default`
    this.doc.set(id, { type: "Feature", geometry, properties: { id, phenomenon: type, metadata } });
    this.order.push(id);
    this.drawing = null;
    this.drawCursor = null;
    this.stroking = false;
    this.mode = "editing";
    this.adapter.setCursor("");
    this.select(id); // selects → keeps double-click-zoom off while editing
    this.emitChange();
  }

  /** Finish a click-laid path/area (double-click / Enter / close polygon). */
  private finalizeDrawing(): void {
    const d = this.drawing;
    if (!d) return;
    const it = interactionOf(this.registry.get(d.type));
    // MapLibre fires click+click before dblclick → drop a duplicated trailing point.
    const span = this.adapter.getViewSpan();
    while (d.coords.length >= 2) {
      const a = d.coords[d.coords.length - 1]!;
      const b = d.coords[d.coords.length - 2]!;
      if (Math.abs(a[0]! - b[0]!) < span * 0.005 && Math.abs(a[1]! - b[1]!) < span * 0.005) d.coords.pop();
      else break;
    }
    const min = this.registry.get(d.type).draw.minVertices ?? (it.primitive === "polygon" ? 3 : 2);
    if (d.coords.length < min) return; // keep drawing until enough points
    const geometry: Geometry =
      it.primitive === "polygon"
        ? { type: "Polygon", coordinates: [[...d.coords, d.coords[0]!]] }
        : { type: "LineString", coordinates: d.coords };
    this.commit(d.type, geometry);
  }

  /** Finish a freehand stroke: simplify the captured points into anchors. */
  private finalizeFreehand(): void {
    const d = this.drawing;
    if (!d) return;
    this.stroking = false;
    this.adapter.setPanEnabled(true);
    const span = this.adapter.getViewSpan();
    let simplified = simplify(d.coords.map((c) => [c[0]!, c[1]!]), span * 0.012);
    const it = interactionOf(this.registry.get(d.type));
    const min = it.primitive === "polygon" ? 3 : 2;
    if (simplified.length < min) {
      this.cancelDrawing();
      this.renderAll();
      return;
    }
    // Keep a freehand AREA a SIMPLE polygon: untangle a self-crossing stroke by ordering
    // its vertices radially (a clean "balloon" is already radial, so it stays unchanged).
    if (it.primitive === "polygon" && !isSimpleRing(simplified)) simplified = radialSortRing(simplified);
    // A freehand AREA closes the stroke into a polygon (draw the outline like
    // "inflating a balloon"); a freehand line stays open.
    const geometry: Geometry =
      it.primitive === "polygon"
        ? { type: "Polygon", coordinates: [[...simplified, simplified[0]!]] }
        : { type: "LineString", coordinates: simplified };
    this.commit(d.type, geometry);
  }

  private cancelDrawing(): void {
    if (!this.drawing) return;
    this.drawing = null;
    this.drawCursor = null;
    this.stroking = false;
    this.mode = "idle";
    this.syncDblClickZoom();
    this.adapter.setCursor("");
  }

  private isFreehand(): boolean {
    return !!this.drawing && interactionOf(this.registry.get(this.drawing.type)).freehand === true;
  }

  private afterEdit(id: string): void {
    this.renderAll();
    this.emitChange();
    if (id === this.selectedId) this.emitMetadata();
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private styleOf(type: string): PhenomenonStyle {
    let s = this.resolved.get(type);
    if (!s) {
      s = mergePhenomenonStyle(this.registry.get(type).style, this.phenomena[type]?.style);
      this.resolved.set(type, s);
    }
    return s;
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    raf(() => {
      this.renderScheduled = false;
      if (!this.destroyed) this.renderAll();
    });
  }

  /** Degrees of latitude per screen pixel (for screen-sized decorations). */
  private resolution(): number {
    const a = this.adapter.unproject([0, 0]);
    const b = this.adapter.unproject([0, 40]);
    return a && b ? Math.abs(b.lat - a.lat) / 40 : 0;
  }

  private renderAll(): void {
    const buckets: Record<string, Feature[]> = {};
    for (const id of OVERLAY_IDS) buckets[id] = [];
    const annReqs: AnnReq[] = [];
    let selAnchor: [number, number] | null = null; // selected zone's arrow tip — drawn AFTER placement
    const resolution = this.resolution();

    for (const id of this.order) {
      const f = this.doc.get(id);
      if (!f) continue;
      const def = this.registry.get(f.properties.phenomenon);
      const features: RenderFeature[] = def.decorate({ geometry: f.geometry, metadata: f.properties.metadata, style: this.styleOf(f.properties.phenomenon), resolution, flightLevel: this.flResolved(f.properties.phenomenon), leaderThunderbolt: this.phenomena[f.properties.phenomenon]?.leaderThunderbolt });
      for (const feat of features) {
        feat.properties.featureId = id;
        if (feat.properties.layer === ANNOTATION_BUCKET) {
          const req = toAnnReq(id, feat);
          // The leader's arrow tip is user-movable, constrained INSIDE the zone (and
          // re-clamped each render so a reshape keeps it valid). The box stays put — only
          // the arrow re-aims. A draggable handle sits on the tip while the zone is selected.
          if (f.geometry.type === "Polygon" && req.leader) {
            const ring = coordsOf(f.geometry);
            const a = clampInRing(this.anchorPins.get(id) ?? [req.anchor.lon, req.anchor.lat], ring);
            req.arrowAnchor = { lon: a[0], lat: a[1] };
            if (id === this.selectedId) selAnchor = a; // handle drawn after placement (only if the leader shows)
          }
          // Push an area's call-out OUTSIDE the zone (unless the zone is very large).
          const r = this.areaAvoidRadius(f.geometry, req.anchor);
          if (r) req.avoidRadius = r;
          annReqs.push(req);
        } else (buckets[feat.properties.layer] ??= []).push(feat);
      }
    }

    if (this.mode === "drawing" && this.drawing) this.renderPreview(buckets);
    if (this.selectedId) this.renderSelection(buckets, resolution);

    this.lastAnnReqs = annReqs;
    const placed = placeAnnotations(annReqs, this.adapter, this.pins);
    buckets["text-boxes"]!.push(...placed.boxes);
    buckets["leaders"]!.push(...placed.leaders);
    buckets["symbols"]!.push(...placed.symbols);
    // Arrow-tip handle — only while its leader is VISIBLE, so it vanishes WITH the arrow
    // when the call-out sits over the tip (no lone handle without an arrow).
    if (selAnchor && placed.leaders.some((l) => l.properties["featureId"] === this.selectedId)) {
      // Scalloped phenomena (CB): the central handle wears a sync glyph — drag to move, TAP to
      // flip the bumps in/out. A white dot under the dark glyph makes it read as a button.
      const selF = this.doc.get(this.selectedId!);
      const scallop = !!selF && this.styleOf(selF.properties.phenomenon).edge?.decorator === "scallop";
      buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "anchor", ...(scallop ? { icon: SYNC_ICON, size: 0.8, fill: "#ffffff" } : {}) }, geometry: { type: "Point", coordinates: selAnchor } });
    }

    // Remember where each call-out box landed (lon/lat) so the area FL gauge can
    // sit right next to it (the slider "follows the logo + FL").
    this.placedAt.clear();
    for (const box of placed.boxes) {
      const id = box.properties.featureId;
      if (!id || box.geometry.type !== "Point") continue;
      this.placedAt.set(id, box.geometry.coordinates as [number, number]);
      // A liseré (thin rule) between the two FL lines of an area call-out (top/base).
      const def = this.registry.get(this.doc.get(id)!.properties.phenomenon);
      if (def.schema.some((s) => s.key === "topFL") && def.schema.some((s) => s.key === "baseFL")) {
        const c = this.adapter.project({ lon: box.geometry.coordinates[0]!, lat: box.geometry.coordinates[1]! });
        if (c) {
          const l1 = this.adapter.unproject([c[0] - 17, c[1]]);
          const l2 = this.adapter.unproject([c[0] + 17, c[1]]);
          if (l1 && l2) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", featureId: id, stroke: String(box.properties.textBorder ?? "#111"), strokeWidth: 1 }, geometry: { type: "LineString", coordinates: [[l1.lon, l1.lat], [l2.lon, l2.lat]] } });
        }
      }
    }
    if (this.selectedId) this.renderAreaGauge(buckets);

    // `decorate` bakes the resolved style into the `handles` props (the generic
    // adapter is dumb); every other overlay is passed through unchanged.
    for (const id of OVERLAY_IDS) this.adapter.setOverlay(id, decorate(id, fc(buckets[id]!), this.style));
  }

  /** FL gauge (top/base) for a selected AREA phenomenon (turbulence/CB), placed
   *  beside its call-out box — a connecting line between the two draggable levels. */
  private renderAreaGauge(buckets: Record<string, Feature[]>): void {
    const f = this.doc.get(this.selectedId!);
    if (!f) return;
    const def = this.registry.get(f.properties.phenomenon);
    if (listFieldOf(def)) return; // jet handles its own gauge
    if (!def.schema.some((s) => s.key === "topFL") || !def.schema.some((s) => s.key === "baseFL")) return;
    const at = this.placedAt.get(this.selectedId!);
    if (!at) return;
    const bc = this.adapter.project({ lon: at[0], lat: at[1] });
    if (!bc) return;
    const m = f.properties.metadata;
    const top = typeof m["topFL"] === "number" ? (m["topFL"] as number) : 350;
    const base = typeof m["baseFL"] === "number" ? (m["baseFL"] as number) : 200;
    const gx = bc[0] + 30; // just right of the call-out box
    const un = (x: number, y: number): Position | null => {
      const u = this.adapter.unproject([x, y]);
      return u ? [u.lon, u.lat] : null;
    };
    const yOf = (lvl: number): number => bc[1] - (lvl - this.flRef) * FL_PX;
    // Same look as the jet FL gauge: a thin axis + a translucent band between top/base.
    const aTop = un(gx, yOf(top) - 12);
    const aBot = un(gx, yOf(base) + 12);
    if (aTop && aBot) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", stroke: this.style.control.line.color, strokeWidth: this.style.control.line.width }, geometry: { type: "LineString", coordinates: [aTop, aBot] } });
    const bt = un(gx, yOf(top));
    const bb = un(gx, yOf(base));
    if (bt && bb) buckets["selection"]!.push({ type: "Feature", properties: { layer: "selection", stroke: this.style.control.line.color, strokeWidth: 9 }, geometry: { type: "LineString", coordinates: [bt, bb] } });
    const mk = (lvl: number, role: string, label: string): void => {
      const hp = un(gx, yOf(lvl));
      const lp = un(gx + 24, yOf(lvl));
      if (hp) buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role }, geometry: { type: "Point", coordinates: hp } });
      if (lp) buckets["text-boxes"]!.push({ type: "Feature", properties: { layer: "text-boxes", text: label, textColor: this.style.control.text.color, textSize: 12, textHalo: this.style.control.text.halo }, geometry: { type: "Point", coordinates: lp } });
    };
    // Off-chart bounds → "XXX" (per WAFC), matching the call-out box labels.
    const baseMin = this.numLimit(def, "baseFL").min;
    const topMax = this.numLimit(def, "topFL").max;
    const lbl = (v: number, off: boolean): string => (off ? "XXX" : String(Math.round(v)).padStart(3, "0"));
    mk(top, "mTop", lbl(top, top > topMax));
    mk(base, "mBase", lbl(base, base < baseMin));
  }

  /** Screen radius from a call-out anchor to the farthest polygon vertex (capped) so
   *  the box clears the zone; 0 for non-areas. Very large zones stay near (capped). */
  private areaAvoidRadius(geometry: Geometry, anchor: { lon: number; lat: number }): number {
    if (geometry.type !== "Polygon") return 0;
    const a = this.adapter.project(anchor);
    if (!a) return 0;
    let r = 0;
    for (const p of geometry.coordinates[0] ?? []) {
      const px = this.adapter.project({ lon: p[0]!, lat: p[1]! });
      if (px) r = Math.max(r, Math.hypot(px[0] - a[0], px[1] - a[1]));
    }
    return Math.min(r + 8, 130);
  }

  private renderPreview(buckets: Record<string, Feature[]>): void {
    const d = this.drawing!;
    const freehand = this.isFreehand();
    const pts = !freehand && this.drawCursor ? [...d.coords, this.drawCursor] : d.coords;
    if (pts.length >= 2) {
      buckets["edge"]!.push({
        type: "Feature",
        properties: { layer: "edge", stroke: this.style.selection.color, strokeWidth: 2, ...(freehand ? {} : { dash: [2, 2] }) },
        geometry: { type: "LineString", coordinates: pts },
      });
    }
    // Click-laid points get vertex dots; a freehand stroke is too dense to dot.
    if (!freehand) {
      d.coords.forEach((c, i) => {
        buckets["handles"]!.push({
          type: "Feature",
          properties: { layer: "handles", hClass: "vertex", role: `v${i}` },
          geometry: { type: "Point", coordinates: c },
        });
      });
    }
  }

  private renderSelection(buckets: Record<string, Feature[]>, resolution: number): void {
    const f = this.doc.get(this.selectedId!);
    if (!f) return;
    const def = this.registry.get(f.properties.phenomenon);
    const it = interactionOf(def);
    // The selection highlight hugs the SMOOTHED curve (not the raw control
    // polyline), so there's no stray straight "construction" line under a jet.
    const selGeom: Geometry =
      it.smooth && f.geometry.type === "LineString"
        ? { type: "LineString", coordinates: catmullRom(f.geometry.coordinates as Pt[], 16) }
        : it.smooth && f.geometry.type === "Polygon"
          ? { type: "LineString", coordinates: catmullRomClosed(f.geometry.coordinates[0] as Pt[], 16) }
          : outline(f.geometry);
    buckets["selection"]!.push({
      type: "Feature",
      properties: { layer: "selection", featureId: this.selectedId, stroke: this.style.selection.color, strokeWidth: this.style.selection.width, ...(this.style.selection.dash ? { dash: [...this.style.selection.dash] } : {}) },
      geometry: selGeom,
    });
    // On-map delete affordance: a red ✕ just off the feature's top-right corner. Click it
    // (or press Backspace/Delete) to remove the feature. `labelId:"__delete"` is the marker
    // the pointer handler intercepts (see onDown).
    const sx = coordsOf(f.geometry)
      .map((c) => this.adapter.project({ lon: c[0]!, lat: c[1]! }))
      .filter((p): p is [number, number] => !!p);
    if (sx.length) {
      const corner = this.adapter.unproject([Math.max(...sx.map((p) => p[0])) + 14, Math.min(...sx.map((p) => p[1])) - 14]);
      if (corner) {
        buckets["controls"]!.push({
          type: "Feature",
          properties: { layer: "controls", featureId: this.selectedId, text: "×", textColor: "#f85149", textSize: 20, textHalo: "#ffffff" },
          geometry: { type: "Point", coordinates: [corner.lon, corner.lat] },
        });
      }
    }
    vertices(f.geometry).forEach((v, i) => {
      buckets["handles"]!.push({
        type: "Feature",
        properties: { layer: "handles", hClass: "vertex", featureId: this.selectedId, role: `v${i}` },
        geometry: { type: "Point", coordinates: v },
      });
    });
    // Slider handles for the list field (jet break points), placed on the curve.
    const lf = listFieldOf(def);
    if (lf) {
      const items = (f.properties.metadata[lf.key] as Metadata[] | undefined) ?? [];
      const path = this.renderPath(f.geometry, it);
      const { planar, k } = path;
      const drag = this.dragTarget;
      items.forEach((item, i) => {
        const dragged = drag?.kind === "slider" && drag.featureId === this.selectedId && drag.index === i;
        let ll: Position;
        let danger = false;
        if (dragged && this.dragFree) {
          ll = this.dragFree;
          danger = this.willDelete;
        } else {
          ll = toLonLat(pointAtFraction(planar, Number(item["t"] ?? 0)).p, k);
        }
        buckets["handles"]!.push({
          type: "Feature",
          // Extremities behave differently (bare terminators) → styled as the inverse
          // of a shape vertex (hClass "end"); interior break points stay "slider".
          properties: { layer: "handles", hClass: isEndItem(item) ? "end" : "slider", featureId: this.selectedId, role: `s${i}`, selected: this.selectedSub === i, danger },
          geometry: { type: "Point", coordinates: ll },
        });
      });

      // Radial speed control on the selected break point: a ring + handle whose
      // distance from the point sets the wind speed (further out = more barbs).
      const sub = this.selectedSub;
      if (sub != null && items[sub]) {
        const ptLL = toLonLat(pointAtFraction(planar, Number(items[sub]!["t"] ?? 0)).p, k);
        const c = this.adapter.project({ lon: ptLL[0]!, lat: ptLL[1]! });
        if (c) {
          const item = items[sub]!;
          const speed = typeof item["speed"] === "number" ? (item["speed"] as number) : 0;
          const tt = Number(item["t"] ?? 0);
          const isEnd = tt <= 0.001 || tt >= 0.999;
          const { min: spMin, max: spMax } = this.numLimit(def, "speed");
          // Speedometer dial: the handle's ANGLE around a fixed ring sets the speed.
          // Skipped on an extremity — a jet starts/ends at the floor (§3.5.1 / fig 11),
          // so the end speed is fixed and only double-click (add a point) applies there.
          if (!isEnd) {
            const arc: Position[] = [];
            for (let a = 0; a <= 40; a++) {
              const deg = ((SPEED_A0 + (a / 40) * SPEED_SWEEP) * Math.PI) / 180;
              const u = this.adapter.unproject([c[0] + Math.cos(deg) * SPEED_R, c[1] + Math.sin(deg) * SPEED_R]);
              if (u) arc.push([u.lon, u.lat]);
            }
            if (arc.length) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", stroke: this.style.control.line.color, strokeWidth: this.style.control.line.width }, geometry: { type: "LineString", coordinates: arc } });
            const ha = (angleForSpeed(speed, spMin, spMax) * Math.PI) / 180;
            const h = this.adapter.unproject([c[0] + Math.cos(ha) * SPEED_R, c[1] + Math.sin(ha) * SPEED_R]);
            if (h) buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "speed" }, geometry: { type: "Point", coordinates: [h.lon, h.lat] } });
            // Live speed readout near the handle while dragging the dial.
            if (this.dragTarget?.kind === "speed") {
              const lbl = this.adapter.unproject([c[0] + Math.cos(ha) * (SPEED_R + 22), c[1] + Math.sin(ha) * (SPEED_R + 22)]);
              if (lbl) buckets["text-boxes"]!.push({ type: "Feature", properties: { layer: "text-boxes", text: `${Math.round(speed)}KT`, textColor: this.style.control.text.color, textSize: 13, textHalo: this.style.control.text.halo, textBackground: "#ffffff", textBorder: this.style.control.line.color }, geometry: { type: "Point", coordinates: [lbl.lon, lbl.lat] } });
            }
          }

          // Vertical FL gauge beside the point: a draggable core-FL handle, plus a
          // top/base extent band (≥120 kt). Screen y ↔ flight level. NOT on an
          // extremity — the spec examples never label FL at the start/end, so a bare
          // terminator has no FL to edit (only drag-reshape + double-click apply).
          if (!isEnd) {
          const flv = typeof item["fl"] === "number" ? item["fl"] : 300;
          const gx = c[0] + SPEED_R + 14; // just outside the speed dial
          const yOf = (lvl: number): number => c[1] - (lvl - this.flRef) * FL_PX;
          const un = (x: number, y: number): Position | null => {
            const u = this.adapter.unproject([x, y]);
            return u ? [u.lon, u.lat] : null;
          };
          // Extent handles appear at ≥120 kt; if top/base aren't set yet, seed
          // sensible defaults (fl ± 40) so they're draggable — the drag persists them.
          const showExt = speed >= 120;
          const topV = showExt ? (typeof item["top"] === "number" ? (item["top"] as number) : Math.min(600, flv + 40)) : null;
          const baseV = showExt ? (typeof item["base"] === "number" ? (item["base"] as number) : Math.max(0, flv - 40)) : null;
          // Axis connector.
          const ys = showExt ? [yOf(flv), yOf(topV!), yOf(baseV!)] : [yOf(flv)];
          const aTop = un(gx, Math.min(...ys) - 12);
          const aBot = un(gx, Math.max(...ys) + 12);
          if (aTop && aBot) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", stroke: this.style.control.line.color, strokeWidth: this.style.control.line.width }, geometry: { type: "LineString", coordinates: [aTop, aBot] } });
          // Extent band (translucent thick) between top and base.
          if (showExt) {
            const bt = un(gx, yOf(topV!));
            const bb = un(gx, yOf(baseV!));
            if (bt && bb) buckets["selection"]!.push({ type: "Feature", properties: { layer: "selection", stroke: this.style.control.line.color, strokeWidth: 9 }, geometry: { type: "LineString", coordinates: [bt, bb] } });
          }
          // Handles + value labels (orange control handles; role identifies the field).
          const lvlHandle = (lvl: number, field: string, label: string): void => {
            const hp = un(gx, yOf(lvl));
            const lp = un(gx + 28, yOf(lvl)); // value label clear to the right of the handle
            if (hp) buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: field }, geometry: { type: "Point", coordinates: hp } });
            if (lp) buckets["text-boxes"]!.push({ type: "Feature", properties: { layer: "text-boxes", text: label, textColor: this.style.control.text.color, textSize: 12, textHalo: this.style.control.text.halo }, geometry: { type: "Point", coordinates: lp } });
          };
          lvlHandle(flv, "fl", `FL${String(Math.round(flv)).padStart(3, "0")}`);
          if (showExt) {
            lvlHandle(topV!, "top", String(Math.round(topV!)).padStart(3, "0"));
            lvlHandle(baseV!, "base", String(Math.round(baseV!)).padStart(3, "0"));
          }
          }
        }
      }

      // Discreet pedagogical hints on each segment between meta points: the speed
      // transition, ordered by SCREEN position with a →/← arrow pointing in the
      // flow direction (so a right-to-left jet reads correctly). Editing aid only.
      const reversed = f.properties.metadata["reversed"] === true;
      const sorted = items
        .map((it) => ({ t: Number(it["t"] ?? 0), speed: typeof it["speed"] === "number" ? (it["speed"] as number) : 0 }))
        .sort((a, b) => a.t - b.t);
      for (let s = 0; s + 1 < sorted.length; s++) {
        const lo = sorted[s]!;
        const hi = sorted[s + 1]!;
        if (Math.round(lo.speed) === Math.round(hi.speed)) continue; // flat segment → no hint
        const st = pointAtFraction(planar, (lo.t + hi.t) / 2);
        // Upstream/downstream by flow (arrow at the high-t end unless reversed).
        const up = reversed ? hi : lo;
        const down = reversed ? lo : hi;
        const upLL = toLonLat(pointAtFraction(planar, up.t).p, k);
        const downLL = toLonLat(pointAtFraction(planar, down.t).p, k);
        const upPx = this.adapter.project({ lon: upLL[0]!, lat: upLL[1]! });
        const downPx = this.adapter.project({ lon: downLL[0]!, lat: downLL[1]! });
        const leftIsUp = upPx && downPx ? upPx[0] <= downPx[0] : true;
        const leftS = Math.round(leftIsUp ? up.speed : down.speed);
        const rightS = Math.round(leftIsUp ? down.speed : up.speed);
        const text = `${leftS} ${leftIsUp ? "→" : "←"} ${rightS}`;
        const off = resolution > 0 ? resolution * 13 : 0;
        const perpUp: Pt = [-st.dir[1], st.dir[0]];
        const anchor = toLonLat([st.p[0] + perpUp[0] * off, st.p[1] + perpUp[1] * off], k);
        let ang = (Math.atan2(-st.dir[1], st.dir[0]) * 180) / Math.PI;
        if (ang > 90) ang -= 180;
        else if (ang < -90) ang += 180;
        buckets["text-boxes"]!.push({
          type: "Feature",
          properties: { layer: "text-boxes", text, textColor: "#6b7280", textSize: 11, textHalo: "#ffffff", rotation: ang },
          geometry: { type: "Point", coordinates: anchor },
        });
      }
    }

  }

  /** The dense planar path (smoothed if needed) used for slider placement. */
  private renderPath(geometry: Geometry, it: InteractionSpec): { planar: Pt[]; k: number } {
    const coords = coordsOf(geometry);
    const k = frameK(coords);
    const dense = it.smooth ? catmullRom(coords, 16) : coords;
    return { planar: dense.map((c) => toPlanar(c as Pt, k)), k };
  }

  // ── pointer & keyboard ─────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (this.mode === "drawing") {
      if (e.key === "Enter") {
        e.preventDefault();
        this.finalizeDrawing();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancelDrawing();
        this.renderAll();
      }
      return;
    }
    // Delete the SELECTED feature with Backspace (the Mac "delete" key) or Delete — but
    // never while typing in a field (the listener is on window).
    if ((e.key === "Backspace" || e.key === "Delete") && this.selectedId && !isEditableTarget()) {
      e.preventDefault();
      this.delete(this.selectedId);
    }
  }

  private onPointer(ev: PointerEvent): void {
    if (this.destroyed) return;
    switch (ev.type) {
      case "down":
        return this.onDown(ev);
      case "move":
        return this.onMove(ev);
      case "up":
        return this.onUp();
      case "click":
        return this.onClick(ev);
      case "dblclick":
        return this.onDblclick(ev);
    }
  }

  private onDblclick(ev: PointerEvent): void {
    if (this.mode === "drawing") {
      this.finalizeDrawing();
      return;
    }
    const hit = ev.hit;
    const fid = hit?.props["featureId"];
    if (hit?.overlay === "handles" && typeof fid === "string") {
      const hClass = hit.props["hClass"];
      const index = Number(String(hit.props["role"] ?? "").slice(1));
      if (hClass === "vertex") this.removeVertex(fid, index); // dbl-click vertex → remove
      else if (hClass === "slider" || hClass === "end") this.duplicateBreakPoint(fid, index); // dbl-click break point → split
      return;
    }
    // Double-click on a feature's line → insert a shape vertex there.
    if (typeof fid === "string" && (hit?.overlay === "edge" || hit?.overlay === "decoration")) {
      this.insertVertexAt(fid, [ev.lngLat.lon, ev.lngLat.lat]);
    }
  }

  /** Screen offset between the grab point and the call-out box centre at mousedown, so a
   *  call-out drag keeps the grabbed spot under the cursor instead of snapping its centre. */
  private calloutGrab(featureId: string, at: { lon: number; lat: number }): [number, number] {
    const boxLL = this.placedAt.get(featureId);
    const boxPx = boxLL ? this.adapter.project({ lon: boxLL[0], lat: boxLL[1] }) : null;
    const cur = this.adapter.project(at);
    return boxPx && cur ? [cur[0] - boxPx[0], cur[1] - boxPx[1]] : [0, 0];
  }

  private onDown(ev: PointerEvent): void {
    if (this.mode === "drawing") {
      if (this.isFreehand() && this.drawing) {
        this.stroking = true;
        this.drawing.coords = [[ev.lngLat.lon, ev.lngLat.lat]];
        this.adapter.setPanEnabled(false);
        this.scheduleRender();
      }
      return;
    }
    const hit = ev.hit;
    if (!hit) return;
    const featureId = hit.props["featureId"];
    if (hit.overlay === "handles" && typeof featureId === "string") {
      const hClass = hit.props["hClass"];
      const role = String(hit.props["role"] ?? "");
      const index = Number(role.slice(1));
      if (hClass === "vertex") {
        this.dragTarget = { kind: "vertex", featureId, index };
      } else if (hClass === "slider" || hClass === "end") {
        this.dragTarget = { kind: "slider", featureId, index };
        if (featureId === this.selectedId) this.selectSubItem(index);
      } else if (hClass === "control" && role === "speed" && this.selectedSub != null) {
        this.dragTarget = { kind: "speed", featureId, index: this.selectedSub };
      } else if (hClass === "control" && (role === "fl" || role === "top" || role === "base") && this.selectedSub != null) {
        this.dragTarget = { kind: "level", featureId, index: this.selectedSub, field: role };
      } else if (hClass === "control" && (role === "mTop" || role === "mBase")) {
        this.dragTarget = { kind: "metaLevel", featureId, field: role === "mTop" ? "topFL" : "baseFL" };
      } else if (hClass === "control" && role === "anchor") {
        this.dragTarget = { kind: "anchor", featureId };
      } else if (hClass === "toggle") {
        const ef = this.registry.get(this.doc.get(featureId)!.properties.phenomenon).schema.find((s) => s.key === role);
        const options = ef && ef.type === "enum" ? ef.options.map((o) => String(o.value)) : [];
        this.dragTarget = { kind: "toggle", featureId, field: role, options };
      }
      // Only seize the pointer if a drag was actually armed — a control handle hit with
      // no selected sub-item arms nothing, and must NOT leave pan disabled (onUp returns
      // early on a null dragTarget, so pan would stay stuck off).
      if (this.dragTarget) {
        this.didDrag = false;
        this.adapter.setPanEnabled(false);
      }
    } else if (hit.overlay === "symbols" && typeof featureId === "string") {
      // The call-out glyph: DRAG it to reposition the call-out (the indicator —
      // the leader keeps pointing at the zone); CLICK it (no drag) to cycle its
      // symbol enum (e.g. MOD ↔ SEV).
      const f = this.doc.get(featureId);
      const ef = f && this.registry.get(f.properties.phenomenon).schema.find((s) => s.type === "enum");
      const toggle = ef && ef.type === "enum" ? { field: ef.key, options: ef.options.map((o) => String(o.value)) } : undefined;
      this.dragTarget = { kind: "callout", featureId, labelId: String(hit.props["labelId"] ?? "l"), grab: this.calloutGrab(featureId, ev.lngLat), ...(toggle ? { toggle } : {}) };
      this.didDrag = false;
      this.adapter.setPanEnabled(false);
    } else if (hit.overlay === "controls" && typeof featureId === "string") {
      // The ✕ delete control (see renderSelection) → remove the feature, don't arm a drag.
      this.delete(featureId);
      return;
    } else if (hit.overlay === "text-boxes" && typeof featureId === "string") {
      // The call-out box → DRAG to reposition; or (when it carries `cycleField`) TAP to cycle
      // that enum — e.g. CB coverage OCNL↔FRQ, whose value lives in the box text, not a glyph.
      const cf = hit.props["cycleField"];
      const ef = typeof cf === "string" ? this.registry.get(this.doc.get(featureId)!.properties.phenomenon).schema.find((s) => s.key === cf) : undefined;
      const toggle = ef && ef.type === "enum" ? { field: ef.key, options: ef.options.map((o) => String(o.value)) } : undefined;
      this.dragTarget = { kind: "callout", featureId, labelId: String(hit.props["labelId"] ?? "l"), grab: this.calloutGrab(featureId, ev.lngLat), ...(toggle ? { toggle } : {}) };
      this.didDrag = false;
      this.adapter.setPanEnabled(false);
    } else if ((hit.overlay === "edge" || hit.overlay === "decoration" || hit.overlay === "area-fill") && typeof featureId === "string") {
      // Grab the body of a feature (an area's edge/fill, OR a jet's axis/barbs) → move the
      // WHOLE feature. Vertices sit on top (handles overlay) so they still win for reshaping.
      const f = this.doc.get(featureId);
      if (f && (f.geometry.type === "Polygon" || f.geometry.type === "LineString")) {
        if (featureId !== this.selectedId) this.select(featureId);
        this.dragTarget = { kind: "translate", featureId, lastPx: this.adapter.project(ev.lngLat) ?? [0, 0] };
        this.didDrag = false;
        this.adapter.setPanEnabled(false);
      }
    }
  }

  private onMove(ev: PointerEvent): void {
    if (this.mode === "drawing") {
      this.adapter.setCursor("crosshair"); // re-assert over the adapter's hover cursor
      if (this.stroking && this.drawing) {
        const span = this.adapter.getViewSpan();
        const last = this.drawing.coords[this.drawing.coords.length - 1];
        if (!last || Math.abs(ev.lngLat.lon - last[0]!) > span * 0.0015 || Math.abs(ev.lngLat.lat - last[1]!) > span * 0.0015) {
          this.drawing.coords.push([ev.lngLat.lon, ev.lngLat.lat]);
          this.scheduleRender();
        }
        return;
      }
      this.drawCursor = [ev.lngLat.lon, ev.lngLat.lat];
      this.scheduleRender();
      return;
    }
    const t = this.dragTarget;
    if (!t) return;
    const f = this.doc.get(t.featureId);
    if (!f) return;
    if (t.kind === "vertex") {
      if (f.geometry.type === "Polygon") {
        // Constrain the zone to a SIMPLE polygon: apply the move, but undo it if it makes
        // an edge cross another (the vertex then "sticks" at the edge of validity).
        const v = f.geometry.coordinates[0]?.[t.index];
        const prev = v ? ([...v] as Position) : null;
        setVertex(f.geometry, t.index, [ev.lngLat.lon, ev.lngLat.lat]);
        if (prev && !isSimpleRing(coordsOf(f.geometry))) setVertex(f.geometry, t.index, prev);
      } else {
        setVertex(f.geometry, t.index, [ev.lngLat.lon, ev.lngLat.lat]);
      }
    } else if (t.kind === "slider") {
      const def = this.registry.get(f.properties.phenomenon);
      const lf = listFieldOf(def);
      if (lf) {
        const list = (f.properties.metadata[lf.key] as Metadata[]) ?? [];
        const tOf = list[t.index] ? Number(list[t.index]!["t"] ?? 0) : 0.5;
        // An end break point (t≈0 / t≈1) reshapes the curve endpoint instead of
        // sliding along it.
        if (list[t.index] && f.geometry.type === "LineString" && (tOf <= 0.001 || tOf >= 0.999)) {
          const coords = f.geometry.coordinates;
          coords[tOf <= 0.001 ? 0 : coords.length - 1] = [ev.lngLat.lon, ev.lngLat.lat];
          this.dragFree = null;
          this.willDelete = false;
          this.didDrag = true;
          this.scheduleRender();
          return;
        }
        const { planar, k } = this.renderPath(f.geometry, interactionOf(def));
        const tt = projectToFraction(planar, toPlanar([ev.lngLat.lon, ev.lngLat.lat], k));
        const onCurve = toLonLat(pointAtFraction(planar, tt).p, k);
        const a = this.adapter.project(ev.lngLat);
        const b = this.adapter.project({ lon: onCurve[0]!, lat: onCurve[1]! });
        const distPx = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
        if (distPx > 36) {
          // Pulled off the line → float at the cursor, armed for deletion.
          this.dragFree = [ev.lngLat.lon, ev.lngLat.lat];
          this.willDelete = true;
        } else {
          // Rides the line: update its position (t) live, but keep a gap from its
          // neighbours and from the extremities — so two points never coincide and an
          // interior point never lands on t=0/1 (which would flip it to a fixed end).
          this.dragFree = null;
          this.willDelete = false;
          if (list[t.index]) {
            const GAP = 0.04;
            const curT = Number(list[t.index]!["t"] ?? 0.5);
            let lo = GAP;
            let hi = 1 - GAP;
            list.forEach((it, idx) => {
              if (idx === t.index) return;
              const ot = Number(it["t"] ?? 0);
              if (ot <= curT) lo = Math.max(lo, ot + GAP);
              else hi = Math.min(hi, ot - GAP);
            });
            list[t.index] = { ...list[t.index], t: Math.max(lo, Math.min(hi, tt)) };
          }
        }
      }
    } else if (t.kind === "speed") {
      // Radial control: distance (px) from the break point → wind speed.
      const def = this.registry.get(f.properties.phenomenon);
      const lf = listFieldOf(def);
      if (lf) {
        const { planar, k } = this.renderPath(f.geometry, interactionOf(def));
        const list = (f.properties.metadata[lf.key] as Metadata[]) ?? [];
        const item = list[t.index];
        if (item) {
          const ptLL = toLonLat(pointAtFraction(planar, Number(item["t"] ?? 0)).p, k);
          const c = this.adapter.project({ lon: ptLL[0]!, lat: ptLL[1]! });
          const cur = this.adapter.project(ev.lngLat);
          if (c && cur) {
            // Speedometer: the cursor's ANGLE around the point maps to the speed
            // (configurable bounds, default 80–250 per WAFC §3.5.1), rounded to 5.
            const deg = (Math.atan2(cur[1] - c[1], cur[0] - c[0]) * 180) / Math.PI;
            const { min, max } = this.numLimit(def, "speed");
            const speed = Math.max(min, Math.min(max, Math.round(speedForAngle(deg, min, max) / 5) * 5));
            list[t.index] = { ...item, speed };
          }
        }
      }
    } else if (t.kind === "level") {
      // Vertical FL gauge: screen y relative to the break point → flight level.
      const def = this.registry.get(f.properties.phenomenon);
      const lf = listFieldOf(def);
      if (lf) {
        const { planar, k } = this.renderPath(f.geometry, interactionOf(def));
        const list = (f.properties.metadata[lf.key] as Metadata[]) ?? [];
        const item = list[t.index];
        if (item) {
          const ptLL = toLonLat(pointAtFraction(planar, Number(item["t"] ?? 0)).p, k);
          const c = this.adapter.project({ lon: ptLL[0]!, lat: ptLL[1]! });
          const cur = this.adapter.project(ev.lngLat);
          if (c && cur) {
            const { lo, hi } = this.flGaugeRange(f.properties.phenomenon, t.field);
            let level = Math.max(lo, Math.min(hi, Math.round((this.flRef + (c[1] - cur[1]) / FL_PX) / 5) * 5));
            // The core FL is always inside the ≥80 layer → keep top ≥ FL ≥ base.
            const flCore = typeof item["fl"] === "number" ? (item["fl"] as number) : 300;
            if (t.field === "fl") {
              if (typeof item["base"] === "number") level = Math.max(item["base"] as number, level);
              if (typeof item["top"] === "number") level = Math.min(item["top"] as number, level);
            } else if (t.field === "top") {
              level = Math.max(flCore, level); // top at or above the core
            } else if (t.field === "base") {
              level = Math.min(flCore, level); // base at or below the core
            }
            list[t.index] = { ...item, [t.field]: level };
          }
        }
      }
    } else if (t.kind === "metaLevel") {
      // Area FL gauge sits at the call-out → map screen y relative to that box.
      const at = this.placedAt.get(t.featureId);
      const bc = at ? this.adapter.project({ lon: at[0], lat: at[1] }) : null;
      const cur = this.adapter.project(ev.lngLat);
      if (bc && cur) {
        // Clamp to the field's chart bounds; a 5-FL "XXX" notch past a bound is allowed only
        // when that side's `beyond` is "xxx" (areas default to xxx, so base→min−5, top→max+5).
        const { lo, hi } = this.flGaugeRange(f.properties.phenomenon, t.field);
        let level = Math.max(lo, Math.min(hi, Math.round((this.flRef + (bc[1] - cur[1]) / FL_PX) / 5) * 5));
        const m = f.properties.metadata;
        if (t.field === "topFL") level = Math.max(level, typeof m["baseFL"] === "number" ? (m["baseFL"] as number) : lo);
        else level = Math.min(level, typeof m["topFL"] === "number" ? (m["topFL"] as number) : hi);
        m[t.field] = level;
      }
    } else if (t.kind === "callout") {
      const req = this.lastAnnReqs.find((r) => r.featureId === t.featureId && r.labelId === t.labelId);
      const anchorPx = req ? this.adapter.project(req.anchor) : null;
      const cursorPx = this.adapter.project(ev.lngLat);
      // Place the box centre at (cursor − grab) so the grabbed spot stays under the cursor
      // (no first-move jump), then express that as the pin offset from the anchor.
      if (anchorPx && cursorPx) this.pins.set(`${t.featureId}:${t.labelId}`, { dx: cursorPx[0] - t.grab[0] - anchorPx[0], dy: cursorPx[1] - t.grab[1] - anchorPx[1] });
    } else if (t.kind === "anchor") {
      // Move the leader's anchor (the arrow tip), kept inside the zone (clamped to the ring).
      this.anchorPins.set(t.featureId, clampInRing([ev.lngLat.lon, ev.lngLat.lat], coordsOf(f.geometry)));
    } else if (t.kind === "translate") {
      // Move every vertex by the cursor's SCREEN delta (project → +px → unproject)
      // so the shape stays rigid on screen — in mercator AND globe (a lon/lat delta
      // would distort it under the globe's curvature). Call-out + FL gauge re-place
      // from the new geometry, so they follow along.
      const cur = this.adapter.project(ev.lngLat);
      if (cur) {
        this.translateScreen(f.geometry, cur[0] - t.lastPx[0], cur[1] - t.lastPx[1]);
        t.lastPx = cur;
      }
    }
    this.didDrag = true;
    this.scheduleRender();
  }

  private onUp(): void {
    if (this.stroking) {
      // A freehand drag emits no trailing "click", so don't swallow the next one.
      this.finalizeFreehand();
      return;
    }
    const t = this.dragTarget;
    if (!t) return;
    this.dragTarget = null;
    this.adapter.setPanEnabled(true);
    // Reset the drag flag on EVERY release (a trailing "click" isn't guaranteed — e.g.
    // the pointer leaving the map, or a future adapter — else the next click is swallowed).
    const dragged = this.didDrag;
    this.didDrag = false;
    // A data point dragged off the line and released is deleted.
    if (t.kind === "slider" && this.willDelete) {
      const f = this.doc.get(t.featureId);
      const lf = f ? listFieldOf(this.registry.get(f.properties.phenomenon)) : undefined;
      this.dragFree = null;
      this.willDelete = false;
      if (lf) {
        this.removeListItem(t.featureId, lf.key, t.index);
        return;
      }
    }
    this.dragFree = null;
    this.willDelete = false;
    // A glyph clicked (not dragged) cycles its enum value (e.g. MOD ↔ SEV). The
    // symbol arms a `callout` (drag = reposition the call-out) that carries the
    // toggle for the click case; a handle "toggle" carries it directly.
    const toggle = t.kind === "toggle" ? { field: t.field, options: t.options } : t.kind === "callout" ? t.toggle : undefined;
    if (toggle && !dragged && toggle.options.length) {
      const f = this.doc.get(t.featureId);
      if (f) {
        const cur = String(f.properties.metadata[toggle.field] ?? toggle.options[0]);
        const i = toggle.options.indexOf(cur);
        f.properties.metadata[toggle.field] = toggle.options[(i + 1) % toggle.options.length]!;
        this.renderAll();
        this.emitChange();
        if (this.selectedId) this.emitMetadata();
        return;
      }
    }
    // Tap (no drag) the central handle of a scalloped phenomenon (CB) → flip the bump direction.
    if (t.kind === "anchor" && !dragged) {
      const f = this.doc.get(t.featureId);
      const st = f ? this.styleOf(f.properties.phenomenon) : undefined;
      if (f && st?.edge?.decorator === "scallop") {
        const cur = f.properties.metadata["scallopInvert"];
        const eff = cur != null ? Boolean(cur) : st.edge?.scallopSide === "in";
        f.properties.metadata["scallopInvert"] = !eff;
        this.renderAll();
        this.emitChange();
        if (this.selectedId) this.emitMetadata();
        return;
      }
    }
    if (dragged) {
      this.renderAll();
      this.emitChange();
      if (this.selectedId) this.emitMetadata();
    }
  }

  /** Shift every vertex by a SCREEN delta (project → +px → unproject) — rigid on screen. */
  private translateScreen(geom: Geometry, dx: number, dy: number): void {
    const shift = (p: Position): void => {
      const px = this.adapter.project({ lon: p[0]!, lat: p[1]! });
      if (!px) return;
      const ll = this.adapter.unproject([px[0] + dx, px[1] + dy]);
      if (ll) {
        p[0] = ll.lon;
        p[1] = ll.lat;
      }
    };
    if (geom.type === "Point") shift(geom.coordinates);
    else if (geom.type === "LineString") geom.coordinates.forEach(shift);
    else if (geom.type === "Polygon") {
      for (const ring of geom.coordinates) {
        // A closed ring repeats its first vertex as the last (often the SAME array
        // reference) — shift each unique vertex once, then re-close, so the closing
        // point isn't double-shifted (which made one vertex drift chaotically).
        const n = ring.length;
        const closed = n > 1 && samePoint(ring[0]!, ring[n - 1]!);
        const count = closed ? n - 1 : n;
        for (let i = 0; i < count; i++) shift(ring[i]!);
        if (closed) ring[n - 1] = [ring[0]![0]!, ring[0]![1]!];
      }
    }
  }

  private onClick(ev: PointerEvent): void {
    if (this.mode === "drawing" && this.drawing) {
      if (this.isFreehand()) return; // freehand finishes on pointer up
      const span = this.adapter.getViewSpan();
      // Click near the first point closes a polygon (alt. to double-click/Enter).
      const first = this.drawing.coords[0];
      if (first && this.drawing.coords.length >= 3) {
        const it = interactionOf(this.registry.get(this.drawing.type));
        if (it.primitive === "polygon" && Math.abs(ev.lngLat.lon - first[0]!) < span * 0.01 && Math.abs(ev.lngLat.lat - first[1]!) < span * 0.01) {
          this.finalizeDrawing();
          return;
        }
      }
      this.drawing.coords.push([ev.lngLat.lon, ev.lngLat.lat]);
      this.scheduleRender();
      return;
    }
    if (this.didDrag) {
      this.didDrag = false;
      return;
    }
    const fid = ev.hit?.props["featureId"];
    if (ev.hit && typeof fid === "string" && ev.hit.overlay !== "handles") {
      if (fid !== this.selectedId) this.select(fid);
    } else if (!ev.hit) {
      if (this.selectedId) this.select(null);
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  /** Apply per-phenomenon limit overrides to a schema's number fields (recurses into lists). */
  private withLimits(type: string, schema: FieldSchema[]): FieldSchema[] {
    const cfg = this.phenomena[type];
    if (!cfg) return schema;
    return schema.map((s) => {
      // `flightLevel` bounds every FL field (turbulence top+base share one range);
      // `speed` bounds the wind-speed field. Both flat on the config — no wrapper.
      const o = s.type === "fl" ? cfg.flightLevel : s.key === "speed" ? cfg.speed : undefined;
      if (o) {
        return { ...s, ...(o.min != null ? { min: o.min } : {}), ...(o.max != null ? { max: o.max } : {}) };
      }
      if (s.type === "list") return { ...s, itemSchema: this.withLimits(type, s.itemSchema) };
      return s;
    });
  }

  /** Effective numeric bounds for a field key (top-level or list item), config-overridden. */
  private numLimit(def: PhenomenonDef, key: string): { min: number; max: number } {
    for (const s of this.withLimits(def.type, def.schema)) {
      const f = s.key === key ? s : s.type === "list" ? s.itemSchema.find((x) => x.key === key) : undefined;
      if (f && f.type === "number") return { min: f.min ?? 80, max: f.max ?? 250 };
      if (f && f.type === "fl") return { min: f.min ?? 250, max: f.max ?? 600 };
    }
    return { min: 80, max: 250 };
  }

  /** Off-chart behaviour for a phenomenon's FL bound (config beyond overrides the def default). */
  private flBeyond(type: string, side: 0 | 1): FlMode {
    const c = this.phenomena[type]?.flightLevel?.beyond;
    if (c) return c[side];
    return this.registry.get(type).flBeyond?.[side] ?? "clamp";
  }

  /** Effective FL config handed to a phenomenon's decorate (chart bounds + resolved beyond). */
  private flResolved(type: string): { min?: number; max?: number; beyond: [FlMode, FlMode] } {
    const c = this.phenomena[type]?.flightLevel;
    return {
      ...(c?.min != null ? { min: c.min } : {}),
      ...(c?.max != null ? { max: c.max } : {}),
      beyond: [this.flBeyond(type, 0), this.flBeyond(type, 1)],
    };
  }

  /** FL gauge clamp range for a field: its bounds, widened by a 5-FL "XXX" notch on a side
   *  whose `beyond` is "xxx" (a `base` field uses below-min, a `top` field above-max). */
  private flGaugeRange(type: string, field: string): { lo: number; hi: number } {
    const lim = this.numLimit(this.registry.get(type), field);
    const lo = /base/i.test(field) && this.flBeyond(type, 0) === "xxx" ? lim.min - 5 : lim.min;
    const hi = /top/i.test(field) && this.flBeyond(type, 1) === "xxx" ? lim.max + 5 : lim.max;
    return { lo, hi };
  }

  /** Apply `flightLevel.default` to a freshly-built metadata: by order onto the top-level FL
   *  fields (`[base, top]`), or onto every break point's core FL for a list-based jet. */
  private applyFlDefault(type: string, metadata: Metadata): void {
    const d = this.phenomena[type]?.flightLevel?.default;
    if (d == null) return;
    const arr = Array.isArray(d) ? d : [d];
    let i = 0;
    for (const s of this.registry.get(type).schema) {
      if (s.type === "fl" && arr[i] != null) metadata[s.key] = arr[i++]!;
      else if (s.type === "list") {
        const core = s.itemSchema.find((x) => x.type === "fl");
        const items = metadata[s.key];
        if (core && arr[0] != null && Array.isArray(items)) for (const it of items) (it as Metadata)[core.key] = arr[0];
      }
    }
  }

  private buildFormSpec(id: string): FormSpec | null {
    const f = this.doc.get(id);
    if (!f) return null;
    const def = this.registry.get(f.properties.phenomenon);
    const m = f.properties.metadata;
    const schema = this.withLimits(def.type, def.schema);
    const fields: ResolvedField[] = schema
      .filter((s) => s.type !== "list")
      .map((s) => ({ ...s, visible: isVisible(s, m) }));
    const spec: FormSpec = { featureId: id, phenomenon: f.properties.phenomenon, fields, values: m, errors: validate({ ...def, schema }, m) };

    const lf = schema.find((s): s is ListField => s.type === "list");
    if (lf) {
      const items = (m[lf.key] as Metadata[] | undefined) ?? [];
      const sel = this.selectedSub != null && items[this.selectedSub] ? this.selectedSub : null;
      spec.list = {
        key: lf.key,
        label: lf.label,
        items: items.map((it, i) => ({ index: i, label: lf.itemLabel ? lf.itemLabel(it, i) : `#${i + 1}` })),
        selectedIndex: sel,
        ...(sel != null
          ? {
              // An extremity is a bare terminator (spec examples show no speed/FL at
              // the start/end) → no editable fields; only double-click (add a point).
              itemFields: lf.itemSchema
                .filter((s) => !(isEndItem(items[sel]!) && (s.key === "speed" || s.key === "fl")))
                .map((s) => ({ ...s, visible: isVisible(s, items[sel]!) })),
              itemValues: items[sel]!,
            }
          : {}),
      };
    }
    return spec;
  }

  private emitChange(): void {
    const snapshot = this.save();
    for (const cb of this.changeListeners) cb(snapshot);
  }

  private emitSelect(): void {
    const spec = this.selectedId ? this.buildFormSpec(this.selectedId) : null;
    for (const cb of this.selectListeners) cb(spec);
  }

  private emitMetadata(): void {
    if (!this.selectedId) return;
    const spec = this.buildFormSpec(this.selectedId);
    if (spec) for (const cb of this.metadataListeners) cb(spec);
  }

  // ── toolbar ──────────────────────────────────────────────────────────────

  private buildToolbar(options: ToolbarOptions): void {
    // `tools` picks which phenomena (and their order); defaults to all registered.
    const all = this.registry.all();
    const defs = options.tools
      ? options.tools.map((t) => all.find((d) => d.type === t)).filter((d): d is PhenomenonDef => !!d)
      : all;
    const items: ToolbarItem[] = defs.map((def) => ({
      id: def.type,
      title: def.label,
      ...(def.icon ? { svg: def.icon } : {}),
      toggle: true,
      onClick: () => this.draw(def.type),
    }));
    if (options.clear !== false) {
      items.push({ id: "clear", title: "Clear all", svg: CLEAR_ICON, onClick: () => this.clear() });
    }
    // `items` are ALREADY filtered/ordered by `options.tools` above — don't let the adapter
    // re-apply that filter (it would also drop the clear + snapshot chrome buttons, whose
    // ids aren't in `tools`). Pass the toolbar options WITHOUT `tools`.
    const adapterOpts: ToolbarOptions = { ...options };
    delete adapterOpts.tools;
    // Hide the editing chrome for a clean capture, unless the host's own `snapshot` object
    // already sets `hideOverlays` (theirs wins). Skip when the button is hidden.
    const snap = adapterOpts.snapshot;
    if (snap !== "none" && snap !== false && snap !== null) {
      adapterOpts.snapshot = { hideOverlays: SNAPSHOT_HIDE, ...(typeof snap === "object" ? snap : {}) };
    }
    this.adapter.addToolbar(items, adapterOpts);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const raf =
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      };

function toAnnReq(featureId: string, feat: RenderFeature): AnnReq {
  const p = feat.properties;
  const c = (feat.geometry.type === "Point" ? feat.geometry.coordinates : [0, 0]) as Position;
  return {
    featureId,
    labelId: p.labelId ?? "l",
    anchor: { lon: c[0]!, lat: c[1]! },
    content: p.content ?? p.text ?? "",
    leader: p.leader !== false,
    ...(p.arrow ? { arrow: true } : {}),
    ...(p.cycleField ? { cycleField: p.cycleField } : {}),
    ...(p.leaderStyle ? { leaderStyle: p.leaderStyle } : {}),
    ...(p.symbol ? { symbol: p.symbol } : {}),
    ...(p.symbolColor ? { symbolColor: p.symbolColor } : {}),
    textColor: p.textColor ?? "#111",
    textSize: p.textSize ?? 13,
    textHalo: p.textHalo ?? "#fff",
    textBackground: p.textBackground ?? "#fff",
    textBorder: p.textBorder ?? "#111",
  };
}

function vertices(geom: Geometry): Position[] {
  if (geom.type === "LineString") return geom.coordinates;
  if (geom.type === "Point") return [geom.coordinates];
  if (geom.type === "Polygon") {
    const ring = geom.coordinates[0] ?? [];
    return ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring;
  }
  return [];
}

function outline(geom: Geometry): Geometry {
  if (geom.type === "Polygon") return { type: "LineString", coordinates: geom.coordinates[0] ?? [] };
  return geom;
}

function setVertex(geom: Geometry, i: number, p: Position): void {
  if (geom.type === "Point") {
    geom.coordinates = p;
  } else if (geom.type === "LineString") {
    if (geom.coordinates[i]) geom.coordinates[i] = p;
  } else if (geom.type === "Polygon") {
    const ring = geom.coordinates[0];
    if (!ring || !ring[i]) return;
    ring[i] = p;
    if (i === 0 && ring.length > 1) ring[ring.length - 1] = p;
  }
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Squared distance from point `p` to segment a–b (planar). */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby || 1;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + abx * t;
  const qy = a[1] + aby * t;
  return (qx - p[0]) ** 2 + (qy - p[1]) ** 2;
}
