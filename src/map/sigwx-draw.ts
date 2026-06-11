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

import { ringCentroid } from "../core/phenomena/util.js";
import { WAFS_SWH } from "../profiles/wafs-swh.js"; // the FILE, not the index — the core must not drag every preset

import {
  catmullRom,
  catmullRomClosed,
  clampInRing,
  coordsOf,
  outerRings,
  pointInRing,
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
  FlightLevelField,
  FlMode,
  IcingStyle,
  InteractionSpec,
  JetStyle,
  ListField,
  Metadata,
  PhenomenonDef,
  PhenomenonStyle,
  Pt,
  RenderFeature,
  SigwxFeature,
  TropopauseStyle,
  MarkerStyle,
  TurbulenceStyle,
} from "../core/index.js";
import type { KeyEvent, MapAdapter, MarkerWidget, PointerEvent, SnapshotOptions, SymbolSprites, ToolbarItem, ToolbarOptions } from "./adapter.js";
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
  icing?: { flightLevel?: FlightLevelConfig<[number, number]>; style?: Partial<IcingStyle>; leaderThunderbolt?: boolean };
  tropopause?: { flightLevel?: FlightLevelConfig<number>; style?: Partial<TropopauseStyle> };
  volcano?: { style?: Partial<MarkerStyle> };
  tropicalCyclone?: { style?: Partial<MarkerStyle> };
  radioactive?: { style?: Partial<MarkerStyle> };
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

/**
 * A chart PROFILE — a declarative preset for ONE chart type (WAFS SWH, TEMSI EUROC,
 * TEMSI France, or a host-defined one). Pure DATA: the engine, the phenomenon defs and
 * the controller stay profile-agnostic; `new SigwxDraw({ profile })` just unfolds the
 * bundle onto the existing options (explicit options always win). Presets ship as the
 * OPTIONAL `@softwarity/sigwx-draw/profiles` entry.
 */
export interface SigwxProfile {
  /** Chart-type id — tagged onto `save()`'s FeatureCollection (foreign member `profile`). */
  id: string;
  /** The tool palette offered to the forecaster (toolbar order). `toolbar.tools` wins. */
  tools?: string[];
  /** Per-phenomenon catalogues / bounds / styles for this chart type. `phenomena` wins per type. */
  phenomena?: PhenomenaConfig;
  /** The chart's vertical reference: bounds + display unit — `"fl"` renders `FL310`
   *  (flight levels / 1013) and `"hft-amsl"` TEMSI France's hundreds of feet AMSL
   *  (`065`). A declarative token (NOT a callback) so a profile stays plain JSON —
   *  storable, servable, host-editable. Informative for now: the per-phenomenon
   *  `flightLevel` carries the working bounds; the unit plumbs into rendering later. */
  vertical?: { min: number; max: number; unit?: "fl" | "hft-amsl" };
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
  /** Chrome decluttering. `minZoneFraction` (default 0.15): an UNSELECTED feature whose
   *  on-screen extent is smaller than this fraction of the view hides its CHROME —
   *  call-out box + leader + arrow + glyph, FL labels, and a jet's barbs/arrowhead.
   *  The shape itself (outline/fill) still marks it; zooming toward it (or selecting
   *  it) brings everything back. `0` ⇒ never hide. */
  callouts?: { minZoneFraction?: number };
  /** Chart-type preset (palette + catalogues + bounds) — see {@link SigwxProfile}. */
  profile?: SigwxProfile;
}

const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
/** "Clear all" toolbar icon (a ✕) — `ToolbarItem` is svg-only since draw-adapter 0.2.x. */
const CLEAR_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** Fine "sync" glyph (two inverted curved arrows) drawn ON the central handle of a scalloped
 *  phenomenon (CB): drag it to move the call-out, TAP it to flip the bumps in/out. Data-URI so
 *  the adapter rasterises it straight onto the handle (per-feature handle icon). */
const SYNC_ICON = `data:image/svg+xml,${encodeURIComponent(
  // Explicit width/height: an SVG data-URI WITHOUT intrinsic dimensions rasterizes at the
  // browser default 300×150 (OL `Icon` uses the intrinsic size × scale → a giant glyph).
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1f2328" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
)}`;
/** Editing-chrome overlays hidden during a snapshot, so the PNG shows the clean chart
 *  (no selection highlight / edit + control handles). The chart decoration stays. */
const SNAPSHOT_HIDE = ["selection", "handles", "controls"];
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
/** A freehand stroke whose on-screen extent (bbox diagonal) is below this collapses to a
 *  POINT instead of a line (`pointWhenShort`) — ≈ 1.5× the "FLxxx" label box, so a contour
 *  must be visibly longer than its own label to count as a line (tropopause spot vs contour). */
const POINT_MAX_PX = 60;

/** A break point sitting at a jet extremity (t≈0 / t≈1): its speed is fixed at the floor. */
const isEndItem = (it: Metadata): boolean => {
  const t = Number(it["t"] ?? 0.5);
  return t <= 0.001 || t >= 0.999;
};

function listFieldOf(def: PhenomenonDef): ListField | undefined {
  return def.schema.find((f): f is ListField => f.type === "list");
}

/** A phenomenon whose ONLY level is a single `fl` field (no list, no top/base) → the
 *  tropopause-style single-FL on-map gauge (vs the jet break gauge / area top-base gauge). */
function singleFlFieldOf(def: PhenomenonDef): FlightLevelField | undefined {
  if (listFieldOf(def)) return undefined;
  if (def.schema.some((s) => s.key === "topFL" || s.key === "baseFL")) return undefined;
  return def.schema.find((f): f is FlightLevelField => f.type === "fl" && f.key === "fl");
}

/** A point marker (TC / volcano / radioactive): its widget IS the whole rendering — so it's
 *  grouped under the toolbar submenu and shows no vertex handle (the card covers the point).
 *  CB also produces a widget (a transient `+` control panel) but is an AREA → NOT a marker. */
function isPointMarker(def: PhenomenonDef): boolean {
  return !!def.widget && def.primitives.length === 1 && def.primitives[0] === "point";
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
  /** Selected AREA(s) of a multi-area feature (CB MultiPolygon): clicking ONE area selects
   *  the feature (info box included) but narrows the outline/handles — and the drag and
   *  Delete actions — to those areas. SHIFT-click toggles an area in/out of the set.
   *  Empty = whole-feature selection (e.g. selected via its card). */
  private selectedAreas: number[] = [];
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
    | { kind: "callout"; featureId: string; labelId: string; grab: [number, number] }
    | { kind: "anchor"; featureId: string; area: number }
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
  /** User-moved leader anchors (arrow tips), lon/lat per feature — ONE per area (index-aligned
   *  with the geometry's polygons), each re-clamped into ITS ring every render. */
  private readonly anchorPins = new Map<string, [number, number][]>();
  /** Feature id the next drawn polygon is APPENDED to (the call-out's `+` button) — the new
   *  area joins that feature's geometry (Polygon → MultiPolygon) instead of creating a feature. */
  private appendTo: string | null = null;
  /** Where each feature's call-out box was last placed (lon/lat) — so the area FL gauge follows it. */
  private readonly placedAt = new Map<string, [number, number]>();
  private lastAnnReqs: AnnReq[] = [];
  /** Merged sprite catalogue (defaults + host overrides + turbulence extensions) — the
   *  widget builders resolve their glyph carousel options from it. */
  private readonly spriteCatalog: SymbolSprites = {};
  /** Chart-type id from the profile — tagged onto `save()`'s FeatureCollection. */
  private readonly profileId: string | undefined;
  /** Profile tool palette — the toolbar default when `toolbar.tools` is not given. */
  private readonly profileTools: string[] | undefined;
  /** Call-out declutter threshold (fraction of the view span; 0 = never hide). */
  private readonly calloutFraction: number;
  /** Last visibility per feature (the ±10% hysteresis needs the previous state). */
  private readonly calloutShown = new Map<string, boolean>();
  private idSeq = 0;
  private destroyed = false;
  private renderScheduled = false;

  private readonly changeListeners = new Set<(fc: FeatureCollection) => void>();
  private readonly selectListeners = new Set<(spec: FormSpec | null) => void>();
  private readonly metadataListeners = new Set<(spec: FormSpec) => void>();

  constructor(opts: SigwxDrawOptions) {
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? defaultRegistry();
    // A chart profile is pure declarative sugar: unfold it onto the options, the
    // EXPLICIT options winning (per phenomenon for `phenomena`, wholesale for tools).
    // No profile given ⇒ the fallback IS a profile (WAFS SWH) — the source of truth for
    // chart-specific numbers is always a profile, never scattered hard-coded values.
    const profile = opts.profile ?? WAFS_SWH;
    this.profileId = profile.id;
    this.profileTools = profile.tools;
    this.phenomena = { ...profile.phenomena, ...opts.phenomena };
    this.calloutFraction = opts.callouts?.minZoneFraction ?? 0.15;
    this.style = mergeStyle(DEFAULT_STYLE, opts.style);

    this.readyPromise = this.adapter.ready().then(async () => {
      // The generic adapter does NOT auto-register sprites — register the SIGWX
      // defaults (MOD/SEV turbulence glyphs); the host's overrides win. Keep the merged
      // catalogue: widget builders resolve their glyph carousel options from it.
      Object.assign(this.spriteCatalog, DEFAULT_SPRITES, opts.symbolSprite ?? {});
      await this.adapter.registerSymbols(this.spriteCatalog);
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
      // Keyboard via the adapter (draw-adapter 0.2.7+): scoped to the map container (so it's
      // multi-instance safe and the host app's own inputs elsewhere never reach us) and editable
      // targets are already skipped — no window-level listener / `isEditableTarget` shim needed.
      this.adapter.onKey((ev) => this.onKey(ev));
      // Widget edits → metadata. The control's `name` says WHICH field changed (the CB
      // coverage carousel emits name:"coverage"); a nameless control is the markers' name
      // input. The coord line is decimal degrees, lat then lon (e.g. "1.7N 127.9E").
      this.adapter.onWidgetEdit((e) => this.updateMetadata(e.id, { [e.name ?? "name"]: e.value }));
      this.adapter.setCoordFormat((ll) => `${Math.abs(ll.lat).toFixed(1)}${ll.lat >= 0 ? "N" : "S"} ${Math.abs(ll.lon).toFixed(1)}${ll.lon >= 0 ? "E" : "W"}`);
      // The card's delete ✕ (the input swallows Delete/Backspace) → same routing as the
      // Delete key: an area-narrowed selection drops THAT area, else the whole feature.
      this.adapter.onWidgetDelete((e) => {
        const f = this.doc.get(e.id);
        if (f?.geometry.type === "MultiPolygon" && e.id === this.selectedId && this.selectedAreas.length) this.removeAreas(e.id, this.selectedAreas);
        else this.delete(e.id);
      });
      // The card's edge "+" button ("draw-more") → draw an EXTRA AREA appended to THIS
      // feature (one CB, several zones, one box, one arrow per zone).
      this.adapter.onWidgetAction((e) => {
        const f = this.doc.get(e.id);
        if (e.event === "draw-more" && f) {
          this.draw(f.properties.phenomenon);
          this.appendTo = e.id; // set AFTER draw() — it resets stale state via cancelDrawing
        }
      });
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

  /** Remove the given AREAS of a multi-area feature. The feature — and its info box —
   *  survives while other areas remain; the last remaining area demotes back to a simple
   *  Polygon; removing EVERY area deletes the whole feature. */
  private removeAreas(id: string, areas: number[]): void {
    const f = this.doc.get(id);
    if (!f || f.geometry.type !== "MultiPolygon") return;
    const g = f.geometry;
    if (areas.length >= g.coordinates.length) {
      this.delete(id); // every area selected → the whole feature (info box included) goes
      return;
    }
    for (const a of [...areas].sort((x, y) => y - x)) {
      if (!g.coordinates[a]) continue;
      g.coordinates.splice(a, 1);
      this.anchorPins.get(id)?.splice(a, 1); // keep the other areas' moved arrow tips aligned
    }
    if (g.coordinates.length === 1) f.geometry = { type: "Polygon", coordinates: g.coordinates[0]! };
    this.selectedAreas = [];
    this.afterEdit(id);
  }

  /** Narrow (or widen, with `[]`) the selection to a set of areas of the selected feature. */
  private setSelectedAreas(areas: number[]): void {
    if (this.selectedAreas.length === areas.length && this.selectedAreas.every((a, i) => a === areas[i])) return;
    this.selectedAreas = areas;
    this.scheduleRender();
  }

  select(id: string | null): void {
    this.selectedId = id != null && this.doc.has(id) ? id : null;
    this.selectedSub = null;
    this.selectedAreas = []; // whole-feature selection; an AREA click then narrows it
    // Centre the FL gauge of an AREA on its top/base midpoint (so the slider sits
    // level with the call-out, not hanging below).
    const f = this.selectedId ? this.doc.get(this.selectedId) : undefined;
    const m = f?.properties.metadata;
    if (m && typeof m["topFL"] === "number" && typeof m["baseFL"] === "number") {
      this.flRef = ((m["topFL"] as number) + (m["baseFL"] as number)) / 2;
    } else if (m && typeof m["fl"] === "number") {
      this.flRef = m["fl"] as number; // single-FL phenomenon (tropopause) → centre the gauge on it
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
      if (!g.coordinates[index]) return;
      // A phenomenon that also allows a POINT (tropopause) collapses a 2-vertex contour to a
      // spot when one is removed — delete the contour's points one by one until a single spot
      // height remains. A polyline-only phenomenon (jet) keeps ≥ 2.
      if (g.coordinates.length <= 2) {
        const canPoint = this.registry.get(f.properties.phenomenon).primitives.includes("point");
        if (g.coordinates.length === 2 && canPoint) {
          const keep = g.coordinates[index === 0 ? 1 : 0]!;
          f.geometry = { type: "Point", coordinates: [keep[0]!, keep[1]!] };
        } else return;
      } else {
        g.coordinates.splice(index, 1);
      }
    } else if (g.type === "Polygon") {
      const ring = g.coordinates[0];
      if (!ring) return;
      const uniq = ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring.slice();
      if (uniq.length <= 3 || !uniq[index]) return;
      uniq.splice(index, 1);
      uniq.push(uniq[0]!);
      g.coordinates[0] = uniq;
    } else if (g.type === "MultiPolygon") {
      // Flat index → (area, local), same walk as vertices(). An area already at its
      // 3-vertex minimum loses the WHOLE area instead; a single remaining area demotes
      // the geometry back to a simple Polygon.
      let off = index;
      let done = false;
      for (let a = 0; a < g.coordinates.length && !done; a++) {
        const ring = g.coordinates[a]?.[0];
        if (!ring) continue;
        const uniq = ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring.slice();
        if (off >= uniq.length) {
          off -= uniq.length;
          continue;
        }
        if (uniq.length <= 3) {
          g.coordinates.splice(a, 1);
          this.anchorPins.get(id)?.splice(a, 1); // keep the other areas' moved tips aligned
          if (g.coordinates.length === 1) f.geometry = { type: "Polygon", coordinates: g.coordinates[0]! };
          this.selectedAreas = [];
        } else {
          uniq.splice(off, 1);
          uniq.push(uniq[0]!);
          g.coordinates[a]![0] = uniq;
        }
        done = true;
      }
      if (!done) return;
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
    // A MultiPolygon inserts into ONE area's ring — the clicked one (a flat segment search
    // would bridge areas). The same per-ring path serves the simple Polygon (area 0).
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const a = g.type === "MultiPolygon" ? nearestArea(g, at) : 0;
      const poly = g.type === "MultiPolygon" ? g.coordinates[a] : g.coordinates;
      const uniq = openRing(poly?.[0] ?? []).slice();
      if (uniq.length < 2) return;
      const k = frameK(uniq as Pt[]);
      const planar = uniq.map((c) => toPlanar(c as Pt, k));
      const cur = toPlanar([at[0]!, at[1]!], k);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < planar.length; i++) {
        const d = segDist(cur, planar[i]!, planar[(i + 1) % planar.length]!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      uniq.splice(best + 1, 0, at);
      uniq.push(uniq[0]!);
      poly![0] = uniq;
    } else if (g.type === "LineString") {
      const verts = vertices(g);
      if (verts.length < 2) return;
      const k = frameK(verts as Pt[]);
      const planar = verts.map((c) => toPlanar(c as Pt, k));
      const cur = toPlanar([at[0]!, at[1]!], k);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < planar.length - 1; i++) {
        const d = segDist(cur, planar[i]!, planar[i + 1]!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      g.coordinates.splice(best + 1, 0, at);
    } else {
      return;
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
    this.calloutShown.delete(id);
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
    const out = toFeatureCollection(this.order.map((id) => this.doc.get(id)!)) as FeatureCollection & { profile?: string };
    if (this.profileId) out.profile = this.profileId; // chart-type tag (GeoJSON foreign member)
    return out;
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
  async snapshot(opts?: SnapshotOptions): Promise<Blob> {
    // A selected marker shows an editable <input>; capture it in its un-selected (label) state, then restore.
    const sel = this.selectedId;
    const selF = sel ? this.doc.get(sel) : undefined;
    const widgetSelected = !!selF && !!this.registry.get(selF.properties.phenomenon).widget;
    if (widgetSelected) this.select(null);
    try {
      return await this.adapter.snapshot({ hideOverlays: SNAPSHOT_HIDE, ...opts });
    } finally {
      if (widgetSelected) this.select(sel!);
    }
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
    Object.assign(this.spriteCatalog, sprites); // widgets resolve glyph options from here too
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
    // `+` append mode: the freshly drawn polygon joins the TARGET feature's geometry as an
    // extra area (Polygon → MultiPolygon) — one logical phenomenon (one box, one metadata
    // set, one arrow per area), NOT a new feature.
    const target = this.appendTo ? this.doc.get(this.appendTo) : undefined;
    this.appendTo = null;
    if (target && geometry.type === "Polygon" && (target.geometry.type === "Polygon" || target.geometry.type === "MultiPolygon")) {
      if (target.geometry.type === "Polygon") target.geometry = { type: "MultiPolygon", coordinates: [target.geometry.coordinates, geometry.coordinates] };
      else target.geometry.coordinates.push(geometry.coordinates);
      this.drawing = null;
      this.drawCursor = null;
      this.stroking = false;
      this.mode = "editing";
      this.adapter.setCursor("");
      this.select(target.properties.id); // back on the SAME feature — its card returns
      this.setSelectedAreas([target.geometry.coordinates.length - 1]); // …narrowed to the area just drawn
      this.emitChange();
      return;
    }
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
    const it = interactionOf(this.registry.get(d.type));
    // A stroke too short on screen to read as a line (a click, or a tiny drag) collapses to a
    // spot-height POINT, not a contour (tropopause). Measured on the RAW coords BEFORE simplify
    // so a single-point click is caught. The point lands where the gesture began.
    if (it.pointWhenShort && this.strokeExtentPx(d.coords) < POINT_MAX_PX) {
      const at = d.coords[0];
      if (at) {
        this.commit(d.type, { type: "Point", coordinates: [at[0]!, at[1]!] });
        return;
      }
      this.cancelDrawing();
      this.renderAll();
      return;
    }
    const span = this.adapter.getViewSpan();
    let simplified = simplify(d.coords.map((c) => [c[0]!, c[1]!]), span * 0.012);
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
    this.appendTo = null; // an aborted `+` stroke must not capture the NEXT drawing
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

  /** On-screen extent (bbox diagonal, px) of a captured stroke — drives the point/line
   *  decision for a `pointWhenShort` phenomenon. 0 for an empty/unprojectable stroke. */
  private strokeExtentPx(coords: Position[]): number {
    const px = coords
      .map((c) => this.adapter.project({ lon: c[0]!, lat: c[1]! }))
      .filter((p): p is [number, number] => !!p);
    if (px.length < 2) return 0;
    const xs = px.map((p) => p[0]);
    const ys = px.map((p) => p[1]);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
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
    let selAnchors: [number, number][] = []; // selected zone's arrow tips (one per area) — drawn AFTER placement
    const resolution = this.resolution();
    const viewSpan = this.adapter.getViewSpan();

    for (const id of this.order) {
      const f = this.doc.get(id);
      if (!f) continue;
      const def = this.registry.get(f.properties.phenomenon);
      const features: RenderFeature[] = def.decorate({ geometry: f.geometry, metadata: f.properties.metadata, style: this.styleOf(f.properties.phenomenon), resolution, flightLevel: this.flResolved(f.properties.phenomenon), leaderThunderbolt: this.phenomena[f.properties.phenomenon]?.leaderThunderbolt });
      // Declutter: an UNSELECTED feature whose on-screen extent is INSIGNIFICANT vs the
      // current view drops its CHROME — call-out/leader/arrow, glyphs, FL labels, and the
      // jet's barbs/arrowhead (all screen-sized, they'd dwarf the shape). The shape itself
      // (edge/fill) still marks it; zooming toward it (or selecting it) brings it all back.
      // Points are always significant (a spot/marker box IS the object). ±10% hysteresis.
      let hideChrome = false;
      let hideLate = false; // "late" chrome (a jet's arrowhead) survives to HALF the threshold
      if (id !== this.selectedId && this.calloutFraction > 0 && f.geometry.type !== "Point") {
        const ratio = zoneSpanRatio(f.geometry, viewSpan);
        const was = this.calloutShown.get(id) ?? true;
        const show = ratio >= this.calloutFraction * (was ? 0.9 : 1.1);
        this.calloutShown.set(id, show);
        hideChrome = !show;
        hideLate = hideChrome && ratio < this.calloutFraction * 0.5;
      }
      for (const feat of features) {
        feat.properties.featureId = id;
        const layer = feat.properties.layer;
        if ((layer === ANNOTATION_BUCKET || layer === "decoration" || layer === "symbols" || layer === "text-boxes") && (feat.properties.declutter === "late" ? hideLate : hideChrome)) continue;
        if (layer === ANNOTATION_BUCKET) {
          const req = toAnnReq(id, feat);
          // The leader's arrow tip is user-movable, constrained INSIDE the zone (and
          // re-clamped each render so a reshape keeps it valid). The box stays put — only
          // the arrow re-aims. A draggable handle sits on the tip while the zone is selected.
          if ((f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") && req.leader) {
            // ONE arrow per AREA, each tip user-movable and clamped inside ITS ring (re-clamped
            // every render so a reshape keeps it valid). The box stays put — only the arrows re-aim.
            const tips = this.anchorPins.get(id);
            req.arrowAnchors = outerRings(f.geometry)
              .filter((r) => r.length >= 3)
              .map((ring, k) => {
                const a = clampInRing(tips?.[k] ?? ringMean(ring), ring);
                return { lon: a[0], lat: a[1] };
              });
            if (id === this.selectedId) selAnchors = req.arrowAnchors.map((p) => [p.lon, p.lat]);
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
    buckets["leaders"]!.push(...placed.leaders);
    // placed.symbols are pushed AFTER the widgets are known — a replaced call-out's glyph
    // lives in its card (the severity carousel), not on the canvas.
    // Arrow-tip handle — only while its leader is VISIBLE, so it vanishes WITH the arrow
    // when the call-out sits over the tip (no lone handle without an arrow).
    if (selAnchors.length && placed.leaders.some((l) => l.properties["featureId"] === this.selectedId)) {
      // Scalloped phenomena (CB): the central handle wears a sync glyph — drag to move, TAP to
      // flip the bumps in/out. A white dot under the dark glyph makes it read as a button.
      // One handle PER AREA (`area` index) — each drags its own arrow tip.
      const selF = this.doc.get(this.selectedId!);
      const scallop = !!selF && this.styleOf(selF.properties.phenomenon).edge?.decorator === "scallop";
      selAnchors.forEach((a, k) => {
        // The scallop-flip button doubles as a TAP target → pointer cursor (plain tips stay "grab").
        buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "anchor", area: k, ...(scallop ? { icon: SYNC_ICON, size: 0.8, fill: "#ffffff", cursor: "pointer" } : {}) }, geometry: { type: "Point", coordinates: a } });
      });
    }

    // Remember where each call-out box landed (lon/lat) so the area FL gauge can
    // sit right next to it (the slider "follows the logo + FL").
    this.placedAt.clear();
    for (const box of placed.boxes) {
      const id = box.properties.featureId;
      if (id && box.geometry.type === "Point") this.placedAt.set(id, box.geometry.coordinates as [number, number]);
    }
    // Widgets are built AFTER placement so one can ride its feature's placed call-out:
    // such a widget REPLACES that call-out box (selected CB → the DOM card carries the same
    // content + the `+` edge buttons; the leader still points at the card).
    const widgets = this.collectWidgets();
    const replaced = new Set(widgets.map((w) => w.id));
    buckets["symbols"]!.push(...placed.symbols.filter((s) => !replaced.has(String(s.properties.featureId ?? ""))));
    for (const box of placed.boxes) {
      const id = box.properties.featureId;
      if (id && box.geometry.type === "Point" && replaced.has(id)) continue; // the widget IS this box
      buckets["text-boxes"]!.push(box);
      if (!id || box.geometry.type !== "Point") continue;
      // A liseré (thin rule) between the two FL lines of an area call-out (top/base).
      const def = this.registry.get(this.doc.get(id)!.properties.phenomenon);
      if (def.schema.some((s) => s.key === "topFL") && def.schema.some((s) => s.key === "baseFL")) {
        const c = this.adapter.project({ lon: box.geometry.coordinates[0]!, lat: box.geometry.coordinates[1]! });
        if (c) {
          const l1 = this.adapter.unproject([c[0] - 17, c[1]]);
          const l2 = this.adapter.unproject([c[0] + 17, c[1]]);
          // Ink = the box border when boxed (CB/icing), else the text colour — so an UNBOXED
          // call-out (turbulence, which no longer carries `textBorder`) keeps its severity-tinted rule.
          if (l1 && l2) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", featureId: id, stroke: String(box.properties.textBorder ?? box.properties.textColor ?? "#111"), strokeWidth: 1 }, geometry: { type: "LineString", coordinates: [[l1.lon, l1.lat], [l2.lon, l2.lat]] } });
        }
      }
    }
    if (this.selectedId) this.renderAreaGauge(buckets);
    if (this.selectedId) this.renderSingleFlGauge(buckets);

    // `decorate` bakes the resolved style into the `handles` props (the generic
    // adapter is dumb); every other overlay is passed through unchanged.
    for (const id of OVERLAY_IDS) this.adapter.setOverlay(id, decorate(id, fc(buckets[id]!), this.style));
    // Marker phenomena (TC / volcano / radioactive) + transient control cards (CB) render as
    // DOM cards, not overlay features — the FULL current set (diffed by id, updated in place).
    this.adapter.setWidgets(widgets);
  }

  /** Build the widgets of widget-phenomena features (`editable` = the selected one). Runs
   *  AFTER the placement pass: an area phenomenon's builder gets its placed call-out
   *  (position + content) so its card can replace the box. */
  private collectWidgets(): MarkerWidget[] {
    const out: MarkerWidget[] = [];
    for (const id of this.order) {
      const f = this.doc.get(id);
      if (!f) continue;
      const def = this.registry.get(f.properties.phenomenon);
      if (!def.widget) continue;
      const at = this.placedAt.get(id);
      const req = at ? this.lastAnnReqs.find((r) => r.featureId === id) : undefined;
      const w = def.widget({
        id,
        geometry: f.geometry,
        metadata: f.properties.metadata,
        editable: id === this.selectedId,
        style: this.styleOf(f.properties.phenomenon),
        ...(at && req ? { callout: { at, content: req.content } } : {}),
        sprite: (sid: string) => this.spriteCatalog[sid],
      });
      if (w) out.push(w); // a builder may return null (no widget for this state, e.g. CB unselected)
    }
    return out;
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

  /** Single-FL gauge (tropopause) — a short vertical track + a draggable handle beside the
   *  spot point or the contour's midpoint. Sets `placedAt` so the `metaLevel` drag (field
   *  "fl") reads the same anchor. */
  private renderSingleFlGauge(buckets: Record<string, Feature[]>): void {
    const f = this.doc.get(this.selectedId!);
    if (!f) return;
    if (!singleFlFieldOf(this.registry.get(f.properties.phenomenon))) return;
    // Anchor: the spot point itself, or the contour's arc-length midpoint (where the FL sits).
    let anchor: Position | null = null;
    if (f.geometry.type === "Point") anchor = f.geometry.coordinates;
    else if (f.geometry.type === "LineString" && f.geometry.coordinates.length >= 2) {
      const dense = catmullRom(f.geometry.coordinates as Pt[], 16);
      const k = frameK(dense);
      anchor = toLonLat(pointAtFraction(dense.map((c) => toPlanar(c, k)), 0.5).p, k);
    }
    if (!anchor) return;
    this.placedAt.set(this.selectedId!, [anchor[0]!, anchor[1]!]); // the metaLevel drag reads this anchor
    const bc = this.adapter.project({ lon: anchor[0]!, lat: anchor[1]! });
    if (!bc) return;
    const lvl = typeof f.properties.metadata["fl"] === "number" ? (f.properties.metadata["fl"] as number) : this.flRef;
    const gx = bc[0] + 30; // just right of the label
    const un = (x: number, y: number): Position | null => {
      const u = this.adapter.unproject([x, y]);
      return u ? [u.lon, u.lat] : null;
    };
    const yOf = (l: number): number => bc[1] - (l - this.flRef) * FL_PX;
    // A short track around the level + the draggable handle + a value label (orange chrome).
    const aTop = un(gx, yOf(lvl) - 34);
    const aBot = un(gx, yOf(lvl) + 34);
    if (aTop && aBot) buckets["leaders"]!.push({ type: "Feature", properties: { layer: "leaders", stroke: this.style.control.line.color, strokeWidth: this.style.control.line.width }, geometry: { type: "LineString", coordinates: [aTop, aBot] } });
    const hp = un(gx, yOf(lvl));
    const lp = un(gx + 24, yOf(lvl));
    if (hp) buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "mFL" }, geometry: { type: "Point", coordinates: hp } });
    if (lp) buckets["text-boxes"]!.push({ type: "Feature", properties: { layer: "text-boxes", text: `FL${String(Math.round(lvl)).padStart(3, "0")}`, textColor: this.style.control.text.color, textSize: 12, textHalo: this.style.control.text.halo }, geometry: { type: "Point", coordinates: lp } });
  }

  /** Screen radius from a call-out anchor to the farthest polygon vertex (capped) so
   *  the box clears the zone; 0 for non-areas. Very large zones stay near (capped). */
  private areaAvoidRadius(geometry: Geometry, anchor: { lon: number; lat: number }): number {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return 0;
    const a = this.adapter.project(anchor);
    if (!a) return 0;
    let r = 0;
    // The anchor sits in the LARGEST area (`coordsOf`) — clear that ring's extent.
    for (const p of coordsOf(geometry)) {
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
    // An AREA-narrowed selection (areas of a MultiPolygon clicked / shift-toggled)
    // highlights THOSE rings only.
    const allRings = outerRings(f.geometry);
    const selRings =
      f.geometry.type === "MultiPolygon" && this.selectedAreas.length
        ? this.selectedAreas.map((a) => ({ a, ring: allRings[a] })).filter((x): x is { a: number; ring: Pt[] } => !!x.ring && x.ring.length >= 3)
        : undefined;
    const selGeom: Geometry = selRings
      ? { type: "MultiLineString", coordinates: selRings.map(({ ring }) => (it.smooth ? catmullRomClosed(ring, 16) : ring)) }
      : it.smooth && f.geometry.type === "LineString"
        ? { type: "LineString", coordinates: catmullRom(f.geometry.coordinates as Pt[], 16) }
        : it.smooth && f.geometry.type === "Polygon"
          ? { type: "LineString", coordinates: catmullRomClosed(f.geometry.coordinates[0] as Pt[], 16) }
          : it.smooth && f.geometry.type === "MultiPolygon"
            ? { type: "MultiLineString", coordinates: outerRings(f.geometry).filter((r) => r.length >= 3).map((r) => catmullRomClosed(r, 16)) }
            : outline(f.geometry);
    buckets["selection"]!.push({
      type: "Feature",
      properties: { layer: "selection", featureId: this.selectedId, stroke: this.style.selection.color, strokeWidth: this.style.selection.width, ...(this.style.selection.dash ? { dash: [...this.style.selection.dash] } : {}) },
      geometry: selGeom,
    });
    // Feature deletion is keyboard-only (Backspace/Delete on the selection, see onKey) —
    // no on-map ✕ control, by design.
    // Point markers are edited via their DOM card, which sits over the point — no vertex handle.
    // (CB has a widget too, but it's an area control — its polygon still needs its handles.)
    // Area-narrowed selection ⇒ handles for THOSE rings only, roles kept in FLAT indexing
    // (`v${flatStart+i}`) so setVertex/removeVertex address the right vertex.
    if (!isPointMarker(def)) {
      const groups = selRings
        ? selRings.map(({ a, ring }) => ({ off: flatStart(f.geometry, a), verts: openRing(ring) }))
        : [{ off: 0, verts: vertices(f.geometry) }];
      for (const { off, verts } of groups) {
        verts.forEach((v, i) => {
          buckets["handles"]!.push({
            type: "Feature",
            properties: { layer: "handles", hClass: "vertex", featureId: this.selectedId, role: `v${off + i}` },
            geometry: { type: "Point", coordinates: v },
          });
        });
      }
    }
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

  private onKey(ev: KeyEvent): void {
    if (this.mode === "drawing") {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.finalizeDrawing();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.cancelDrawing();
        this.renderAll();
      }
      return;
    }
    // Delete with Backspace (the Mac "delete" key) or Delete. An AREA-narrowed selection
    // (one area of a multi-area CB) removes THAT area — the feature and its info box live
    // on while other areas remain. Otherwise the whole selected feature goes.
    if ((ev.key === "Backspace" || ev.key === "Delete") && this.selectedId) {
      ev.preventDefault();
      const f = this.doc.get(this.selectedId);
      if (f?.geometry.type === "MultiPolygon" && this.selectedAreas.length) this.removeAreas(this.selectedId, this.selectedAreas);
      else this.delete(this.selectedId);
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
      } else if (hClass === "control" && role === "mFL") {
        this.dragTarget = { kind: "metaLevel", featureId, field: "fl" };
      } else if (hClass === "control" && role === "anchor") {
        this.dragTarget = { kind: "anchor", featureId, area: Number(hit.props["area"] ?? 0) };
      }
      // Only seize the pointer if a drag was actually armed — a control handle hit with
      // no selected sub-item arms nothing, and must NOT leave pan disabled (onUp returns
      // early on a null dragTarget, so pan would stay stuck off).
      if (this.dragTarget) {
        this.didDrag = false;
        this.adapter.setPanEnabled(false);
      }
    } else if ((hit.overlay === "symbols" || hit.overlay === "text-boxes") && typeof featureId === "string") {
      // The call-out (its glyph OR its box) → DRAG to reposition; a plain CLICK selects
      // (onClick). Editing the enum (coverage / severity) happens on the SELECTED card's
      // carousel — the old unselected tap-to-cycle was removed (selection-first editing,
      // consistent across engines and phenomena, and animated).
      this.dragTarget = { kind: "callout", featureId, labelId: String(hit.props["labelId"] ?? "l"), grab: this.calloutGrab(featureId, ev.lngLat) };
      this.didDrag = false;
      this.adapter.setPanEnabled(false);
    } else if ((hit.overlay === "edge" || hit.overlay === "decoration" || hit.overlay === "area-fill") && typeof featureId === "string") {
      // Grab the body of a feature (an area's edge/fill, OR a jet's axis/barbs) → move the
      // WHOLE feature. Vertices sit on top (handles overlay) so they still win for reshaping.
      const f = this.doc.get(featureId);
      if (f && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon" || f.geometry.type === "LineString")) {
        if (featureId !== this.selectedId) this.select(featureId);
        // Multi-area feature: a press on an area narrows the selection to THAT area
        // (outline/handles/drag/Delete scope) — the info box stays with the whole feature.
        // SHIFT-press toggles the area in/out of the selected set (multi-selection).
        let draggable = true;
        if (f.geometry.type === "MultiPolygon") {
          const a = nearestArea(f.geometry, [ev.lngLat.lon, ev.lngLat.lat]);
          if (ev.shiftKey && this.selectedAreas.length) {
            const cur = new Set(this.selectedAreas);
            if (cur.has(a)) cur.delete(a);
            else cur.add(a);
            this.setSelectedAreas([...cur].sort((x, y) => x - y));
            draggable = cur.has(a); // a press that just DE-selected an area doesn't drag
          } else if (!this.selectedAreas.includes(a)) {
            this.setSelectedAreas([a]);
          }
          // else: pressing an area ALREADY in the multi-set keeps the set — the drag moves
          // the whole set; a plain CLICK (no drag) narrows to that area in onClick.
        } else {
          this.setSelectedAreas([]);
        }
        if (draggable) {
          this.dragTarget = { kind: "translate", featureId, lastPx: this.adapter.project(ev.lngLat) ?? [0, 0] };
          this.didDrag = false;
          this.adapter.setPanEnabled(false);
        }
      }
    } else if (hit.overlay === "widget" && typeof hit.props["id"] === "string") {
      // A widget card. A point marker's card (TC/volcano/radioactive) moves the POINT on drag
      // (the input captures its own clicks/keys for editing, so this fires only off the body).
      // An area's control card (selected CB — it replaces the call-out) reuses the CALL-OUT
      // gestures: drag repositions the box, a tap cycles the carousel enum (coverage).
      const fid = hit.props["id"] as string;
      if (fid !== this.selectedId) this.select(fid);
      const f = this.doc.get(fid);
      if (f) {
        const def = this.registry.get(f.properties.phenomenon);
        if (isPointMarker(def)) {
          this.dragTarget = { kind: "translate", featureId: fid, lastPx: this.adapter.project(ev.lngLat) ?? [0, 0] };
        } else {
          // The card replaces the call-out: drag still repositions the box, but a body tap
          // no longer cycles — the coverage line is a real `"carousel"` control now.
          const req = this.lastAnnReqs.find((r) => r.featureId === fid);
          this.dragTarget = { kind: "callout", featureId: fid, labelId: req?.labelId ?? "l", grab: this.calloutGrab(fid, ev.lngLat) };
        }
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
      if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
        // Constrain the zone to a SIMPLE polygon: apply the move, but undo it if it makes
        // an edge cross another (the vertex then "sticks" at the edge of validity).
        // Multi-area: the guard checks the ring the dragged FLAT index belongs to.
        const g = f.geometry;
        const a = areaOfFlat(g, t.index);
        const ring = (g.type === "MultiPolygon" ? g.coordinates[a]?.[0] : g.coordinates[0]) as Position[] | undefined;
        const local = g.type === "MultiPolygon" ? t.index - flatStart(g, a) : t.index;
        const v = ring?.[local];
        const prev = v ? ([...v] as Position) : null;
        setVertex(g, t.index, [ev.lngLat.lon, ev.lngLat.lat]);
        if (prev && ring && !isSimpleRing(ring as Pt[])) setVertex(g, t.index, prev);
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
        else if (t.field === "baseFL") level = Math.min(level, typeof m["topFL"] === "number" ? (m["topFL"] as number) : hi);
        // else (a single `fl` field, tropopause): just the clamped level, no top/base pairing.
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
      // Move ONE leader anchor (this area's arrow tip), kept inside ITS zone (clamped to its ring).
      const rings = outerRings(f.geometry).filter((r) => r.length >= 3);
      const ring = rings[t.area] ?? rings[0];
      if (ring) {
        const tips = this.anchorPins.get(t.featureId) ?? [];
        tips[t.area] = clampInRing([ev.lngLat.lon, ev.lngLat.lat], ring);
        this.anchorPins.set(t.featureId, tips);
      }
    } else if (t.kind === "translate") {
      // Move every vertex by the cursor's SCREEN delta (project → +px → unproject)
      // so the shape stays rigid on screen — in mercator AND globe (a lon/lat delta
      // would distort it under the globe's curvature). Call-out + FL gauge re-place
      // from the new geometry, so they follow along.
      const cur = this.adapter.project(ev.lngLat);
      if (cur) {
        const dx = cur[0] - t.lastPx[0];
        const dy = cur[1] - t.lastPx[1];
        const g = f.geometry;
        const sel = this.selectedAreas;
        const shiftTip = (a: number): void => {
          const tip = this.anchorPins.get(t.featureId)?.[a];
          if (!tip) return;
          const px = this.adapter.project({ lon: tip[0], lat: tip[1] });
          const ll = px ? this.adapter.unproject([px[0] + dx, px[1] + dy]) : null;
          if (ll) {
            tip[0] = ll.lon;
            tip[1] = ll.lat;
          }
        };
        // Dragging area(s) must NOT drag the info box (symmetry: dragging the box never
        // drags the area) — but the box's placement anchor (the LARGEST ring's centroid)
        // may have just moved with the geometry. Pin the box at its current placed spot,
        // expressed as an offset from the POST-move anchor.
        const freezeBox = (): void => {
          const boxLL = this.placedAt.get(t.featureId);
          const req = this.lastAnnReqs.find((r) => r.featureId === t.featureId);
          if (!boxLL || !req) return;
          const anchor = ringCentroid(coordsOf(f.geometry));
          const anchorPx = this.adapter.project({ lon: anchor[0]!, lat: anchor[1]! });
          const boxPx = this.adapter.project({ lon: boxLL[0], lat: boxLL[1] });
          if (anchorPx && boxPx) this.pins.set(`${t.featureId}:${req.labelId}`, { dx: boxPx[0] - anchorPx[0], dy: boxPx[1] - anchorPx[1] });
        };
        if (g.type === "MultiPolygon" && sel.length && sel.length < g.coordinates.length) {
          // Area-narrowed drag: ONLY the selected areas move (their moved arrow tips ride
          // along); the other areas and the info box stay put.
          for (const a of sel) {
            if (!g.coordinates[a]) continue;
            this.translateScreen({ type: "Polygon", coordinates: g.coordinates[a]! }, dx, dy);
            shiftTip(a);
          }
          freezeBox();
        } else {
          // Whole-feature drag: all areas move. The info box rides along ONLY for the
          // explicit all-areas multi-selection (shift) — a single-area feature keeps its
          // box put, like any area drag.
          this.translateScreen(g, dx, dy);
          if (g.type === "MultiPolygon") g.coordinates.forEach((_, a) => shiftTip(a));
          else shiftTip(0);
          if (g.type === "Polygon") freezeBox();
        }
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
    // (The old tap-a-glyph/box enum cycle is gone — enums are edited on the SELECTED
    // card's carousel control; a plain tap just selects, via onClick.)
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
    // A closed ring repeats its first vertex as the last (often the SAME array
    // reference) — shift each unique vertex once, then re-close, so the closing
    // point isn't double-shifted (which made one vertex drift chaotically).
    const shiftRing = (ring: Position[]): void => {
      const n = ring.length;
      const closed = n > 1 && samePoint(ring[0]!, ring[n - 1]!);
      const count = closed ? n - 1 : n;
      for (let i = 0; i < count; i++) shift(ring[i]!);
      if (closed) ring[n - 1] = [ring[0]![0]!, ring[0]![1]!];
    };
    if (geom.type === "Point") shift(geom.coordinates);
    else if (geom.type === "LineString") geom.coordinates.forEach(shift);
    else if (geom.type === "Polygon") geom.coordinates.forEach(shiftRing);
    else if (geom.type === "MultiPolygon") for (const poly of geom.coordinates) poly.forEach(shiftRing);
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
    // A widget card hit carries its feature id as `id`; every other overlay uses `featureId`.
    const fid = ev.hit?.overlay === "widget" ? ev.hit.props["id"] : ev.hit?.props["featureId"];
    if (ev.hit && typeof fid === "string" && ev.hit.overlay !== "handles") {
      if (fid !== this.selectedId) this.select(fid);
      else if (!ev.shiftKey && (ev.hit.overlay === "edge" || ev.hit.overlay === "area-fill" || ev.hit.overlay === "decoration")) {
        // Plain CLICK (no drag — didDrag returned above) on an area of the already-selected
        // multi-area feature → narrow the selection to that area (a PRESS keeps the set).
        const f = this.doc.get(fid);
        if (f?.geometry.type === "MultiPolygon") this.setSelectedAreas([nearestArea(f.geometry, [ev.lngLat.lon, ev.lngLat.lat])]);
      }
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
    const toolIds = options.tools ?? this.profileTools; // explicit > profile > every registered def
    const defs = toolIds
      ? toolIds.map((t) => all.find((d) => d.type === t)).filter((d): d is PhenomenonDef => !!d)
      : all;
    const drawItem = (def: PhenomenonDef, top: boolean): ToolbarItem => ({
      id: def.type,
      title: def.label,
      ...(def.icon ? { svg: def.icon } : {}),
      ...(top ? { toggle: true } : {}),
      onClick: () => this.draw(def.type),
    });
    // Point markers (TC / volcano / radioactive — less common) are grouped into ONE split-button
    // submenu (toggle): hover reveals the set, the trigger mirrors the last-picked marker and re-draws
    // it on click; picking a child adopts it. Everything else stays a flat toggle button, in order.
    const markerDefs = defs.filter(isPointMarker);
    const items: ToolbarItem[] = [];
    let markersDone = false;
    for (const def of defs) {
      if (isPointMarker(def)) {
        if (!markersDone) {
          markersDone = true;
          items.push({
            id: "markers",
            title: "Point markers",
            ...(markerDefs[0]?.icon ? { svg: markerDefs[0]!.icon } : {}),
            toggle: true,
            children: markerDefs.map((d) => drawItem(d, false)),
          });
        }
        continue;
      }
      items.push(drawItem(def, true));
    }
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
    ...(p.leaderStyle ? { leaderStyle: p.leaderStyle } : {}),
    ...(p.symbol ? { symbol: p.symbol } : {}),
    ...(p.symbolColor ? { symbolColor: p.symbolColor } : {}),
    ...(p.symbolInside ? { symbolInside: true } : {}),
    textColor: p.textColor ?? "#111",
    textSize: p.textSize ?? 13,
    textHalo: p.textHalo ?? "#fff",
    // Only box when the decorate ASKED for it (CB/icing set textBackground). No default → a
    // call-out without textBackground (turbulence) is plain text + halo, NOT boxed.
    ...(p.textBackground !== undefined ? { textBackground: p.textBackground } : {}),
    textBorder: p.textBorder ?? "#111",
  };
}

/** A ring's UNIQUE vertices (drops the closing duplicate). */
function openRing(ring: Position[]): Position[] {
  return ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring;
}

/** Mean of a ring's unique vertices — the default arrow-tip target of an area. */
function ringMean(ring: Position[]): [number, number] {
  const u = openRing(ring);
  let x = 0;
  let y = 0;
  for (const p of u) {
    x += p[0]!;
    y += p[1]!;
  }
  return u.length ? [x / u.length, y / u.length] : [0, 0];
}

/** On-screen significance of an area vs the view: its LARGEST ring's bbox diagonal over the
 *  view span (both in degrees — a pure ratio, so no pixel API needed). Drives the call-out
 *  declutter threshold. */
function zoneSpanRatio(geom: Geometry, viewSpan: number): number {
  const ring = coordsOf(geom); // MultiPolygon → the largest ring (the box-anchor area)
  if (ring.length < 3 || !viewSpan) return 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0]! < minX) minX = p[0]!;
    if (p[0]! > maxX) maxX = p[0]!;
    if (p[1]! < minY) minY = p[1]!;
    if (p[1]! > maxY) maxY = p[1]!;
  }
  return Math.hypot(maxX - minX, maxY - minY) / viewSpan;
}

/** Which AREA of a (Multi)Polygon a lon/lat refers to: the ring it falls INSIDE, else the
 *  one with the nearest boundary — resolves an edge/fill/dblclick hit to an area index. */
function nearestArea(geom: Geometry, at: Position): number {
  const rings = outerRings(geom);
  let best = 0;
  let bestD = Infinity;
  rings.forEach((ring, a) => {
    if (ring.length < 2) return;
    if (ring.length >= 3 && pointInRing([at[0]!, at[1]!], ring)) {
      if (bestD > 0) {
        bestD = 0;
        best = a;
      }
      return;
    }
    const k = frameK(ring);
    const planar = ring.map((c) => toPlanar(c, k));
    const cur = toPlanar([at[0]!, at[1]!], k);
    for (let i = 0; i < planar.length - 1; i++) {
      const d = segDist(cur, planar[i]!, planar[i + 1]!);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
  });
  return best;
}

/** First FLAT vertex index of area `a` (the flat indexing of vertices()/setVertex/removeVertex). */
function flatStart(geom: Geometry, a: number): number {
  if (geom.type !== "MultiPolygon") return 0;
  let off = 0;
  for (let i = 0; i < a && i < geom.coordinates.length; i++) off += openRing(geom.coordinates[i]![0] ?? []).length;
  return off;
}

/** Which area a FLAT vertex index belongs to (Polygon → always 0). */
function areaOfFlat(geom: Geometry, i: number): number {
  if (geom.type !== "MultiPolygon") return 0;
  let off = i;
  for (let a = 0; a < geom.coordinates.length; a++) {
    const n = openRing(geom.coordinates[a]![0] ?? []).length;
    if (off < n) return a;
    off -= n;
  }
  return 0;
}

/** Editable vertices, FLAT across areas for a MultiPolygon (area 0 first — `v${i}` roles,
 *  setVertex/removeVertex share the same flat indexing). */
function vertices(geom: Geometry): Position[] {
  if (geom.type === "LineString") return geom.coordinates;
  if (geom.type === "Point") return [geom.coordinates];
  if (geom.type === "Polygon") return openRing(geom.coordinates[0] ?? []);
  if (geom.type === "MultiPolygon") return geom.coordinates.flatMap((poly) => openRing(poly[0] ?? []));
  return [];
}

function outline(geom: Geometry): Geometry {
  if (geom.type === "Polygon") return { type: "LineString", coordinates: geom.coordinates[0] ?? [] };
  if (geom.type === "MultiPolygon") return { type: "MultiLineString", coordinates: geom.coordinates.map((poly) => poly[0] ?? []) };
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
  } else if (geom.type === "MultiPolygon") {
    let off = i; // flat index → (area, local) — same walk as vertices()
    for (const poly of geom.coordinates) {
      const ring = poly[0];
      if (!ring) continue;
      const n = openRing(ring).length;
      if (off >= n) {
        off -= n;
        continue;
      }
      if (!ring[off]) return;
      ring[off] = p;
      if (off === 0 && ring.length > 1) ring[ring.length - 1] = p;
      return;
    }
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
