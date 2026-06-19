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

import * as polyclip from "polyclip-ts";

import { ringCentroid, fl as flLabel } from "../core/phenomena/util.js";
import { MOTION_ARROW_PX } from "../core/extensions/front-symbols.js";

import {
  DEFAULT_CB_COVERAGE,
  DEFAULT_TURBULENCE_SYMBOLS,
  PhenomenonRegistry,
  defFromDescriptor,
  mergeDescriptor,
  registerExtensions,
  resolveGlyph,
  resolveObjectSpec,
  areaRings,
  catmullRom,
  catmullRomClosed,
  clampInArea,
  coordsOf,
  defaultMetadata,
  defaultRegistry,
  frameK,
  fromFeatureCollection,
  interactionOf,
  isSimpleRing,
  isVisible,
  makeCb,
  makeTurbulence,
  mergePhenomenonStyle,
  outerRings,
  pointAtFraction,
  pointInRing,
  projectToFraction,
  radialSortRing,
  simplify,
  toFeatureCollection,
  toLonLat,
  toPlanar,
  validate,
} from "../core/index.js";
import type {
  CbCoverage,
  CbStyle,
  EnumField,
  FieldSchema,
  FlMode,
  IcingStyle,
  InteractionSpec,
  JetStyle,
  ListField,
  Metadata,
  ObjectSpec,
  PhenomenonDef,
  PhenomenonStyle,
  Pt,
  RenderFeature,
  SigwxFeature,
  ToolSpec,
  TropopauseStyle,
  MarkerStyle,
  TurbulenceStyle,
} from "../core/index.js";
import type { KeyEvent, MapAdapter, MarkerWidget, PointerEvent, SnapshotOptions, SymbolSprites, ToolbarItem, ToolbarOptions, WidgetNode } from "./adapter.js";
import { ANNOTATION_BUCKET, OVERLAY_IDS } from "./layers.js";
import { placeAnnotations, estimateBox, nudgeClear, type Rect } from "./placement.js";
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
  schemaVersion?: 1;
  /** Chart-type id — tagged onto `save()`'s FeatureCollection (foreign member `profile`). */
  id: string;
  /** The tool palette offered to the forecaster (toolbar order). An entry is a
   *  phenomenon type OR a named GROUP (split-button submenu:
   *  `{ "group": "Markers", "items": ["volcano", …] }`). When the list is FLAT
   *  strings, the point markers are auto-grouped (legacy). `toolbar.tools` wins. */
  tools?: ToolSpec[];
  /** The chart's OBJECTS — the §2b composition rule, ONE entry each: a stock
   *  descriptor name (`"cb"`), a stock reference + deep-merge PATCH
   *  (`{ "extends": "cb", "style": { "color": "…" } }` — patch wins; keyed-array
   *  patches address fields/options/satellites by id), or a FULL inline
   *  descriptor (host-defined). Compiled by the interpreter at construction and
   *  registered over the built-ins. Omitted ⇒ the stock registry as-is. */
  objects?: ObjectSpec[];
  /** Inline glyph-atlas additions (merged over the built-ins BEFORE the objects
   *  compile, so an inline descriptor can reference `atlas:` names shipped here). */
  glyphs?: Record<string, string>;
  /** Chart-level chrome-declutter threshold (the option `callouts` wins). */
  callouts?: { minZoneFraction?: number };
  /** Per-phenomenon catalogues / bounds / styles for this chart type. `phenomena` wins
   *  per type. TRANSITIONAL: converges into `objects` patches (descriptor spec §2b). */
  phenomena?: PhenomenaConfig;
  /** The chart's vertical reference: bounds + display unit — `"fl"` renders `FL310`
   *  (flight levels / 1013) and `"hft-amsl"` TEMSI France's hundreds of feet AMSL
   *  (`065`). A declarative token (NOT a callback) so a profile stays plain JSON —
   *  storable, servable, host-editable. THE FL-bounds fallback: a phenomenon without
   *  its own `flightLevel` config clamps to these; the unit plumbs into rendering later. */
  vertical?: { min: number; max: number; unit?: "fl" | "hft-amsl" };
  /** Fixed ICAO chart areas (WAFS SWH A…M, TEMSI EUROC/FRANCE) — the cartouche frame.
   *  Declarative (no code): the host drives the map from these via the adapter
   *  (`viewArea(extent)` to frame, `setProjection(projection)` — Mercator-only engines
   *  ignore non-mercator — and `highlightArea(extent)` for the dashed frame). */
  areas?: ChartArea[];
}

/** Map projection of a {@link ChartArea}. `stereographic` carries an SRS `code` + its
 *  proj4 `def` so the adapter can register it (OpenLayers); Mercator-only engines keep
 *  Mercator. Plain data — no code — so a profile stays JSON. */
export type AreaProjection =
  | { kind: "mercator" }
  | { kind: "stereographic"; pole: "north" | "south"; code: string; def: string };

/** A fixed ICAO chart area: id + label + lon/lat bbox + projection. */
export interface ChartArea {
  /** ICAO area id, e.g. `"A"`, `"B1"`, `"H"`. */
  id: string;
  /** Human label / geographic coverage — shown in the cartouche. */
  name: string;
  /** lon/lat bbox `[west, south, east, north]`; `west > east` ⇒ crosses the antimeridian. */
  extent: [number, number, number, number];
  projection: AreaProjection;
  /** `false` ⇒ `extent` is provisional (exact corners live in ICAO Annex 3, App. 8 figures). */
  verified?: boolean;
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

/** Editing-chrome overlays hidden during a snapshot, so the PNG shows the clean chart
 *  (no selection highlight / edit + control handles). The chart decoration stays. */
const SNAPSHOT_HIDE = ["selection", "handles", "controls"];
/** A freehand stroke whose on-screen extent (bbox diagonal) is below this collapses to a
 *  POINT instead of a line (`pointWhenShort`) — ≈ 1.5× the "FLxxx" label box, so a contour
 *  must be visibly longer than its own label to count as a line (tropopause spot vs contour). */
const POINT_MAX_PX = 60;

/** The platform "command" modifier for the eraser: ⌘ on macOS, Ctrl elsewhere. macOS reserves
 *  Ctrl+click for the secondary (context-menu) click, so using Ctrl there is unreliable — we use
 *  ⌘ on Mac and Ctrl on Windows/Linux (the usual `platformModifierKeyOnly` convention). */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const eraserMod = (ev: { ctrlKey?: boolean; metaKey?: boolean }): boolean => (IS_MAC ? !!ev.metaKey : !!ev.ctrlKey);

/** A break point sitting at a jet extremity (t≈0 / t≈1): its speed is fixed at the floor. */
const isEndItem = (it: Metadata): boolean => {
  const t = Number(it["t"] ?? 0.5);
  return t <= 0.001 || t >= 0.999;
};

function listFieldOf(def: PhenomenonDef): ListField | undefined {
  return def.schema.find((f): f is ListField => f.type === "list");
}


/** A point marker (TC / volcano / radioactive): its widget IS the whole rendering — so it's
 *  grouped under the toolbar submenu and shows no vertex handle (the card covers the point).
 *  CB also produces a widget (a transient `+` control panel) but is an AREA → NOT a marker. */
function isPointMarker(def: PhenomenonDef): boolean {
  return !!def.widget && def.primitives.length === 1 && def.primitives[0] === "point";
}

export class SigwxDraw {
  private readonly adapter: MapAdapter;
  private registry: PhenomenonRegistry; // reassigned by setProfile (re-ingestion)
  private readonly phenomena: Record<string, PhenomenonConfig | undefined> = {};
  /** The construction options — kept so `setProfile` can re-ingest with the same
   *  injected registry / explicit `phenomena` / toolbar config. */
  private readonly opts: SigwxDrawOptions;
  /** Host-added turbulence symbols/types (beyond the default MOD/SEV), by code. */
  private turbTypes: TurbulenceType[] = [];
  /** Host-added CB coverage amounts (beyond the default OCNL/FRQ). */
  private cbCoverages: CbCoverage[] = [];
  private readonly readyPromise: Promise<void>;
  private readonly doc = new Map<string, SigwxFeature>();
  private order: string[] = [];
  private selectedId: string | null = null;
  private selectedSub: number | null = null;
  /** The zone-level composite (the non-convective cloud's `"icing"`/`"turb"`) currently in FOCUS:
   *  its glued card is the editable one and the zone card goes selected-but-not-editable (its gauge
   *  hides). `null` = the zone itself is editable. Reset on any (re)selection. */
  private focusedComposite: string | null = null;
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
    | { kind: "labelslide"; featureId: string }
    | { kind: "callout"; featureId: string; labelId: string; grab: [number, number] }
    | { kind: "anchor"; featureId: string; area: number }
    | { kind: "frontMotion"; featureId: string }
    | { kind: "frontMotionRoot"; featureId: string }
    | { kind: "translate"; featureId: string; lastPx: [number, number] }
    | null = null;
  private didDrag = false;
  /** FL the vertical gauge is centred on (the selected point's FL at selection time),
   *  so its core-FL handle starts level with the point. */
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
  /** Pin key (`featureId:labelId`) of the call-out frozen ON SELECTION (captured once, like `flRef`),
   *  so editing the selected feature — adding cloud layers WIDENS its cartouche — does NOT re-place
   *  the box (which would slide the gauge+card sideways). Released on re-select; PROMOTED to a sticky
   *  manual pin if the user drags the box. Null when no auto-freeze is active. */
  private autoPinKey: string | null = null;
  private lastAnnReqs: AnnReq[] = [];
  /** Merged sprite catalogue (defaults + host overrides + turbulence extensions) — the
   *  widget builders resolve their glyph carousel options from it. */
  private readonly spriteCatalog: SymbolSprites = {};
  /** ERASER mode (the card's `−` button): rubbing gnaws the feature LIVE — each pointer
   *  step subtracts a brush capsule. `r` (px) is sized to the area at rub start; `lastPx`
   *  null = armed, not rubbing. Exited via Escape / deselection. */
  private erasing: { featureId: string; r: number; lastPx: [number, number] | null; cursorPx?: [number, number]; viaCtrl?: boolean } | null = null;
  /** FL reference captured at selection time — pins the gauge cards (stable during drags). */
  private flRef: number | null = null;
  /** Chart-type id from the profile — tagged onto `save()`'s FeatureCollection. */
  private profileId: string | undefined;
  /** Profile tool palette — the toolbar default when `toolbar.tools` is not given. */
  private profileTools: ToolSpec[] | undefined;
  /** Chart vertical reference (profile) — the FL-bounds fallback of `flResolved`. */
  private vertical: { min: number; max: number } | undefined;
  /** Fixed ICAO chart areas from the profile — looked up by `setArea`. */
  private profileAreas: ChartArea[] | undefined;
  /** The area `setArea` last applied (null = none / cleared). */
  private activeAreaId: string | null = null;
  /** Call-out declutter threshold (fraction of the view span; 0 = never hide). */
  private calloutFraction = 0.15;
  /** Last visibility per feature (the ±10% hysteresis needs the previous state). */
  private readonly calloutShown = new Map<string, boolean>();
  private idSeq = 0;
  private destroyed = false;
  private renderScheduled = false;

  private readonly changeListeners = new Set<(fc: FeatureCollection) => void>();
  private readonly selectListeners = new Set<(spec: FormSpec | null) => void>();
  private readonly metadataListeners = new Set<(spec: FormSpec) => void>();

  constructor(opts: SigwxDrawOptions) {
    this.opts = opts;
    this.adapter = opts.adapter;
    this.registry = opts.registry ?? defaultRegistry();
    this.style = mergeStyle(DEFAULT_STYLE, opts.style);

    this.readyPromise = this.adapter.ready().then(async () => {
      // Resolve the profile FIRST. No profile given ⇒ the WAFS SWH preset — the raw
      // JSON FILE itself — is imported DYNAMICALLY: the core never bundles it (it is a
      // code-split chunk, fetched only on this fallback path; an app shipping its own
      // profile never loads it). It is plain JSON, not a JS module: the source of truth
      // for chart-specific numbers is always a profile, never scattered hard-coded values.
      const profile =
        opts.profile ??
        ((await import("../profiles/wafs.json", { with: { type: "json" } })).default as unknown as SigwxProfile);
      this.applyProfile(profile, opts);
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
      this.adapter.onWidgetEdit((e) => {
        const fid = widgetFeatureId(e.id);
        const f = this.doc.get(fid);
        if (!f) return;
        const key = e.name ?? "name";
        const def = this.registry.get(f.properties.phenomenon);
        // COMPOSITE-scoped control (the non-convective cloud's icing/turb): the glued card's id is
        // `${fid}#<key>` (its gauge `${fid}#<key>#gauge`). Route the edit into the `metadata[key]`
        // sub-object, FL-clamped against the chart bounds + paired base ≤ top (5-FL steps).
        const compKey = e.id.split("#")[1];
        const compSpec = compKey ? def.composites?.find((c) => c.key === compKey) : undefined;
        if (compSpec) {
          const sub = f.properties.metadata[compSpec.key] as Metadata | undefined;
          if (!sub) return;
          const refField = this.registry.get(compSpec.ref).schema.find((s) => s.key === key);
          let v: unknown = e.value;
          if (refField?.type === "fl") {
            const { lo, hi } = this.flGaugeRange(f.properties.phenomenon, key);
            let n = Math.max(lo, Math.min(hi, Math.round(Number(e.value) / 5) * 5));
            if (/top/i.test(key) && typeof sub["baseFL"] === "number") n = Math.max(n, sub["baseFL"] as number);
            else if (/base/i.test(key) && typeof sub["topFL"] === "number") n = Math.min(n, sub["topFL"] as number);
            v = n;
          } else if (refField?.type === "number") v = Number(e.value);
          this.updateMetadata(fid, { [compSpec.key]: { ...sub, [key]: v } });
          return;
        }
        // LIST-scoped control (`points.2.speed` — a jet break point's dial/gauge): coerce,
        // clamp and pair like the old canvas controls, then update the list item.
        const lm = /^(\w+)\.(\d+)\.(\w+)$/.exec(key);
        if (lm) {
          const lf = def.schema.find((s): s is ListField => s.type === "list" && s.key === lm[1]);
          const idx = Number(lm[2]);
          const fieldKey = lm[3]!;
          const item = lf ? ((f.properties.metadata[lf.key] as Metadata[] | undefined) ?? [])[idx] : undefined;
          if (!lf || !item) return;
          // Multi-layer cloud area: touching ANY layer's gauge band makes it the active (edited)
          // layer, so the panel pickers (amount/type/FL) sync to the band being dragged. No-op for
          // jet break points, whose satellite controls are already scoped to the selected sub-item.
          if (def.repeat?.listField === lf.key && this.selectedSub !== idx) {
            this.selectedSub = idx;
          }
          const fld = lf.itemSchema.find((s) => s.key === fieldKey);
          if (fld?.type === "number") {
            // The speed dial: clamp to the configured range, rounded to 5 kt.
            const { min, max } = this.numLimit(def, fieldKey);
            const v = Math.max(min, Math.min(max, Math.round(Number(e.value) / 5) * 5));
            this.updateListItem(fid, lf.key, idx, { [fieldKey]: v });
          } else if (fld?.type === "fl") {
            // The break-point / layer FL gauge: chart clamp, then keep the item's FLs ordered.
            // A jet break point has a CORE `fl` flanked by `base`/`top` extents; a cloud layer has
            // just a `baseFL`/`topFL` pair (no core). Detect the role by name and pair against the
            // sibling FL (the core when present, else the opposite bound).
            const { lo, hi } = this.flGaugeRange(f.properties.phenomenon, fieldKey);
            let v = Math.max(lo, Math.min(hi, Math.round(Number(e.value) / 5) * 5));
            const coreV = typeof item["fl"] === "number" ? (item["fl"] as number) : undefined;
            const baseSib = typeof item["base"] === "number" ? (item["base"] as number) : typeof item["baseFL"] === "number" ? (item["baseFL"] as number) : undefined;
            const topSib = typeof item["top"] === "number" ? (item["top"] as number) : typeof item["topFL"] === "number" ? (item["topFL"] as number) : undefined;
            const isCore = fieldKey === "fl";
            if (isCore) {
              if (baseSib !== undefined) v = Math.max(baseSib, v);
              if (topSib !== undefined) v = Math.min(topSib, v);
            } else if (/top/i.test(fieldKey)) {
              const floor = coreV ?? baseSib; // top stays above the core (jet) / the base (layer)
              if (floor !== undefined) v = Math.max(floor, v);
            } else if (/base/i.test(fieldKey)) {
              const ceil = coreV ?? topSib; // base stays below the core (jet) / the top (layer)
              if (ceil !== undefined) v = Math.min(ceil, v);
            }
            this.updateListItem(fid, lf.key, idx, { [fieldKey]: v });
          } else {
            this.updateListItem(fid, lf.key, idx, { [fieldKey]: e.value });
            // Item-scoped conditional-options dependents (`optionsBy`): a list field whose option
            // SET depends on `fieldKey` (a cloud layer's `amount` by its `type`) — reset if invalid.
            for (const s of lf.itemSchema) {
              if (s.type === "enum" && s.optionsBy?.field === fieldKey) {
                const opts = s.optionsBy.map[String(e.value)] ?? s.optionsBy.map["*"] ?? s.options;
                if (!opts.some((o) => o.value === item[s.key])) {
                  this.updateListItem(fid, lf.key, idx, { [s.key]: opts[0]?.value ?? "" });
                }
              }
            }
          }
          return;
        }
        const field = def.schema.find((s) => s.key === key);
        if (field?.type === "fl") {
          // FL gauge cursor: same semantics as the old canvas gauge — 5-FL steps, clamped to
          // the chart bounds (one 5-FL "XXX" notch past a bound when `beyond` allows), and
          // base/top kept paired (base ≤ top).
          const { lo, hi } = this.flGaugeRange(f.properties.phenomenon, key);
          let v = Math.max(lo, Math.min(hi, Math.round(Number(e.value) / 5) * 5));
          const m = f.properties.metadata;
          if (key === "topFL" && typeof m["baseFL"] === "number") v = Math.max(v, m["baseFL"] as number);
          else if (key === "baseFL" && typeof m["topFL"] === "number") v = Math.min(v, m["topFL"] as number);
          this.updateMetadata(fid, { [key]: v });
        } else if (field?.type === "number") {
          this.updateMetadata(fid, { [key]: Number(e.value) });
        } else {
          this.updateMetadata(fid, { [key]: e.value });
          // Conditional-options dependents (`optionsBy`): a field whose option SET depends on
          // `key` (e.g. cloud `amount` by `type`) — reset it if its value is no longer valid.
          for (const s of def.schema) {
            if (s.type === "enum" && s.optionsBy?.field === key) {
              const opts = s.optionsBy.map[String(e.value)] ?? s.optionsBy.map["*"] ?? s.options;
              if (!opts.some((o) => o.value === f.properties.metadata[s.key])) {
                this.updateMetadata(fid, { [s.key]: opts[0]?.value ?? "" });
              }
            }
          }
        }
      });
      this.adapter.setCoordFormat((ll) => `${Math.abs(ll.lat).toFixed(1)}${ll.lat >= 0 ? "N" : "S"} ${Math.abs(ll.lon).toFixed(1)}${ll.lon >= 0 ? "E" : "W"}`);
      // The card's delete ✕ (the input swallows Delete/Backspace) → same routing as the
      // Delete key: an area-narrowed selection drops THAT area, else the whole feature.
      this.adapter.onWidgetDelete((e) => {
        const fid = widgetFeatureId(e.id);
        const f = this.doc.get(fid);
        if (f?.geometry.type === "MultiPolygon" && fid === this.selectedId && this.selectedAreas.length) this.removeAreas(fid, this.selectedAreas);
        else this.delete(fid);
      });
      // The card's edge "+" button ("draw-more") → draw an EXTRA AREA appended to THIS
      // feature (one CB, several zones, one box, one arrow per zone).
      this.adapter.onWidgetAction((e) => {
        const fid = widgetFeatureId(e.id);
        const f = this.doc.get(fid);
        if (e.event === "draw-more" && f) {
          this.drawMore(fid);
        } else if (e.event === "erase" && f) {
          // ERASER: rub over the area — it gnaws LIVE (a hole inside, a reshaped border on
          // a bite, a split on a cut-through). Escape exits.
          this.erasing = { featureId: fid, r: this.brushRadiusPx(fid), lastPx: null };
          this.adapter.setCursor("crosshair");
        } else if (e.event === "addLayer" && f) {
          // Layer STACK (the TEMSI cloud-layer area): a generic add — stacks a layer ABOVE the
          // highest band (programmatic / fallback; the gauge's primary add is `addLayerAt:<fl>`).
          this.addLayerTo(fid, "top");
        } else if (e.event.startsWith("addLayerAt:") && f) {
          // Gauge HOVER-`+`: the adapter offers an "add here" `+` over an empty axis span and emits
          // `addLayerAt:<fl>`; insert a layer whose band is CENTRED on that FL.
          const v = Number(e.event.slice("addLayerAt:".length));
          if (Number.isFinite(v)) this.addLayerAt(fid, v);
        } else if (e.event.startsWith("selectLayer:") && f) {
          const i = Number(e.event.slice("selectLayer:".length));
          if (Number.isFinite(i)) this.selectSubItem(i);
        } else if (e.event.startsWith("removeLayer:") && f) {
          const i = Number(e.event.slice("removeLayer:".length));
          if (Number.isFinite(i)) this.removeLayerFrom(fid, i);
        } else if (e.event.startsWith("removeRange:") && f) {
          // GAUGES editor: a layer band flung sideways off the axis (adapter gesture) emits
          // `removeRange:<index>[:<rangeId>]` — drops layer i (min-1 guarded, remaining bands keep
          // their FL: no re-slice). parseInt takes the leading index, tolerating the optional
          // `:<id>` suffix the adapter appends when a range carries an id. See GAUGE-AXIS-BUTTON-SPEC.
          const i = Number.parseInt(e.event.slice("removeRange:".length), 10);
          if (Number.isFinite(i)) this.removeLayerFrom(fid, i);
        } else if (e.event.startsWith("composite:") && f) {
          // Zone-level composite (the non-convective cloud's icing/turb): create the sub-object
          // (if absent) and FOCUS its glued card — the zone keeps its card but loses its FL gauge.
          this.focusComposite(fid, e.event.slice("composite:".length));
        } else if (e.event.startsWith("removeComposite:") && f) {
          // The composite card's ✕: drop the sub-object and return focus to the zone.
          this.removeComposite(fid, e.event.slice("removeComposite:".length));
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
    this.setActiveTool(type); // highlight the armed tool's button WHILE drawing (cleared on commit/cancel)
    this.drawCursor = null;
    this.stroking = false;
    this.syncDblClickZoom();
    this.adapter.setCursor("crosshair");
    this.renderAll();
    return "";
  }

  /** The erasable feature under a hover hit, else null — a Polygon/MultiPolygon area whose
   *  phenomenon opts into the eraser (`interaction.erasable`). Only body overlays count
   *  (edge / fill / decoration); handles & widgets are ignored. */
  private erasableFeatureAt(hit: PointerEvent["hit"]): string | null {
    if (!hit || (hit.overlay !== "edge" && hit.overlay !== "area-fill" && hit.overlay !== "decoration")) return null;
    const fid = hit.props["featureId"];
    if (typeof fid !== "string") return null;
    const f = this.doc.get(fid);
    if (!f || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) return null;
    const def = this.registry.get(f.properties.phenomenon);
    return def && interactionOf(def).erasable ? fid : null;
  }

  /** Drop the (Ctrl-armed) eraser: clear the brush, reset the cursor, repaint. */
  private disarmEraser(): void {
    this.erasing = null;
    this.adapter.setCursor("");
    this.scheduleRender();
  }

  /** Brush radius (px) for the eraser — proportional to the area's on-screen extent
   *  ("la taille de la patate"), captured at rub start, clamped to a sane range. */
  private brushRadiusPx(featureId: string): number {
    const f = this.doc.get(featureId);
    if (!f) return 14;
    const ring = coordsOf(f.geometry);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of ring) {
      const px = this.adapter.project({ lon: c[0]!, lat: c[1]! });
      if (!px) continue;
      minX = Math.min(minX, px[0]); maxX = Math.max(maxX, px[0]);
      minY = Math.min(minY, px[1]); maxY = Math.max(maxY, px[1]);
    }
    return Math.max(8, Math.min(28, 0.06 * Math.hypot(maxX - minX, maxY - minY)));
  }

  /** One LIVE eraser step: subtract a brush CAPSULE (the stadium swept from `a` to `b`,
   *  in px) from the feature — true boolean difference. A hole inside, a reshaped border
   *  on a bite, a SPLIT (MultiPolygon) on a cut-through; gnawing it all deletes the
   *  feature. The capsule is analytic (two arcs + straight flanks): no spikes, ever. */
  private eraseStep(a: [number, number], b: [number, number]): void {
    const er = this.erasing;
    if (!er) return;
    const f = this.doc.get(er.featureId);
    if (!f || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) return;
    const r = er.r;
    const capsulePx: [number, number][] = [];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ARC = 8; // segments per half-circle
    if (d < 0.5) {
      for (let i = 0; i < ARC * 2; i++) {
        const t = (i / (ARC * 2)) * 2 * Math.PI;
        capsulePx.push([a[0] + Math.cos(t) * r, a[1] + Math.sin(t) * r]);
      }
    } else {
      const ux = (b[0] - a[0]) / d;
      const uy = (b[1] - a[1]) / d;
      const base = Math.atan2(uy, ux);
      for (let i = 0; i <= ARC; i++) {
        const t = base - Math.PI / 2 + (i / ARC) * Math.PI; // half-circle around b (leading)
        capsulePx.push([b[0] + Math.cos(t) * r, b[1] + Math.sin(t) * r]);
      }
      for (let i = 0; i <= ARC; i++) {
        const t = base + Math.PI / 2 + (i / ARC) * Math.PI; // half-circle around a (trailing)
        capsulePx.push([a[0] + Math.cos(t) * r, a[1] + Math.sin(t) * r]);
      }
    }
    const capsule: Position[] = [];
    for (const p of capsulePx) {
      const u = this.adapter.unproject(p);
      if (u) capsule.push([u.lon, u.lat]);
    }
    if (capsule.length < 4) return;
    capsule.push(capsule[0]!);
    const subject = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as polyclip.Geom;
    let result: polyclip.Geom;
    try {
      result = polyclip.difference(subject, [[capsule]] as polyclip.Geom);
    } catch {
      return; // a degenerate step must never corrupt the chart — skip it
    }
    // The capsule arcs leave DENSE vertex chains — simplify every ring (a light, px-scale
    // tolerance) so the geometry stays lean and the vertex handles stay a readable set.
    const span = this.adapter.getViewSpan();
    const lean = (rg: number[][]): number[][] => {
      const open = rg.length > 1 && rg[0]![0] === rg[rg.length - 1]![0] && rg[0]![1] === rg[rg.length - 1]![1] ? rg.slice(0, -1) : rg.slice();
      const s = simplify(open as Pt[], span * 0.004);
      if (s.length < 3) return rg;
      s.push(s[0]!);
      return s;
    };
    const polys = (result as unknown as number[][][][])
      .map((poly) => poly.filter((rg) => rg.length >= 4).map(lean))
      .filter((poly) => poly.length > 0 && poly[0]!.length >= 4);
    if (!polys.length) {
      // Gnawed it all out — restore the navigation lever onUp won't reach (erasing is null now).
      if (er.viaCtrl) this.adapter.setInteractive(true);
      else this.adapter.setPanEnabled(true);
      this.erasing = null;
      this.adapter.setCursor("");
      this.delete(er.featureId);
      return;
    }
    f.geometry = polys.length === 1
      ? { type: "Polygon", coordinates: polys[0]! as Position[][] }
      : { type: "MultiPolygon", coordinates: polys as Position[][][] };
    this.anchorPins.delete(er.featureId); // areas may shift/split — tips re-derive
    this.selectedAreas = [];
    this.scheduleRender(); // LIVE gnawing; the change event fires once, on pointer-up
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
    if (this.erasing && id !== this.erasing.featureId) {
      this.erasing = null; // leaving the erased feature exits the eraser
      this.adapter.setCursor("");
    }
    // Release the previous selection's AUTO-frozen call-out pin (a manual drag promoted it to a
    // sticky pin by clearing autoPinKey, so we never drop a user-moved box here).
    if (this.autoPinKey) {
      this.pins.delete(this.autoPinKey);
      this.autoPinKey = null;
    }
    this.selectedId = id != null && this.doc.has(id) ? id : null;
    this.selectedSub = null;
    this.focusedComposite = null; // (re)selecting the zone returns focus to the zone card
    this.selectedAreas = []; // whole-feature selection; an AREA click then narrows it
    // Gauge reference: captured ONCE at selection so the card pinning is drag-stable.
    const f = this.selectedId ? this.doc.get(this.selectedId) : undefined;
    const def = f ? this.registry.get(f.properties.phenomenon) : undefined;
    // A layer-stack area keeps its list altitude-sorted; re-sort once at selection (the order is
    // then frozen during a layer's FL drag — it only re-sorts on add/remove/select-layer).
    if (this.selectedId && def?.repeat) this.resortLayers(this.selectedId);
    const m = f?.properties.metadata;
    // A stack area pins its FL gauge to the ACTIVE (top, index 0) layer; a simple area to its own FL.
    if (def?.repeat && m) {
      const lf = listFieldOf(def);
      const layer = lf ? (m[lf.key] as Metadata[] | undefined)?.[0] : undefined;
      this.flRef = layer ? this.layerFlRef(layer) : null;
    } else if (m && typeof m["fl"] === "number") this.flRef = m["fl"] as number;
    else if (m && typeof m["topFL"] === "number" && typeof m["baseFL"] === "number") this.flRef = ((m["topFL"] as number) + (m["baseFL"] as number)) / 2;
    else this.flRef = null;
    this.syncDblClickZoom();
    this.renderAll();
    this.emitSelect();
  }

  /** Map double-click-zoom is disabled while drawing or editing (double-click is
   *  then our gesture: finish / add / remove / split); enabled when idle. */
  private syncDblClickZoom(): void {
    this.adapter.setDoubleClickZoom(this.mode !== "drawing" && this.selectedId == null);
  }

  /** The FL a card pins to for one list item: a jet break point's `fl`, or a cloud layer's
   *  mid-extent (`topFL`/`baseFL`). Null when the item carries no flight level. */
  private layerFlRef(item: Metadata): number | null {
    if (typeof item["fl"] === "number") return item["fl"] as number;
    if (typeof item["topFL"] === "number" && typeof item["baseFL"] === "number") return ((item["topFL"] as number) + (item["baseFL"] as number)) / 2;
    if (typeof item["topFL"] === "number") return item["topFL"] as number;
    if (typeof item["baseFL"] === "number") return item["baseFL"] as number;
    return null;
  }

  /** Select a sub-element (list item index, e.g. a jet break point or a cloud layer), or clear it. */
  selectSubItem(index: number | null): void {
    this.selectedSub = index;
    // Re-pin the gauge on the newly active item's CURRENT FL (drag-stable reference).
    if (index != null && this.selectedId) {
      const f = this.doc.get(this.selectedId);
      const def = f ? this.registry.get(f.properties.phenomenon) : undefined;
      const lf = def ? listFieldOf(def) : undefined;
      const item = lf && f ? (f.properties.metadata[lf.key] as Metadata[] | undefined)?.[index] : undefined;
      if (item) {
        const r = this.layerFlRef(item);
        if (r != null) this.flRef = r;
      }
    }
    this.renderAll();
    this.emitSelect();
  }

  /** Default metadata for a composite, read from its referenced phenomenon's schema (so the
   *  icing/turb sub-object starts MOD at the stock default FLs — no data duplication). */
  private compositeDefaults(refType: string): Metadata {
    const def = this.registry.get(refType);
    const m: Metadata = {};
    for (const s of def.schema) {
      if (s.type !== "list" && "default" in s && s.default !== undefined) m[s.key] = s.default;
      else if (s.type === "enum") m[s.key] = s.options[0]?.value ?? "";
    }
    return m;
  }

  /** Create (if absent) and FOCUS a zone-level composite (the non-convective cloud's icing/turb):
   *  its glued card becomes the editable one; the zone card goes selected-but-not-editable. */
  private focusComposite(fid: string, key: string): void {
    const f = this.doc.get(fid);
    if (!f) return;
    const spec = this.registry.get(f.properties.phenomenon).composites?.find((c) => c.key === key);
    if (!spec) return;
    let changed = false;
    if (!f.properties.metadata[key]) {
      f.properties.metadata = { ...f.properties.metadata, [key]: this.compositeDefaults(spec.ref) };
      changed = true;
    }
    this.focusedComposite = key;
    const r = this.layerFlRef(f.properties.metadata[key] as Metadata);
    if (r != null) this.flRef = r;
    this.renderAll();
    this.emitSelect();
    if (changed) this.emitChange();
  }

  /** Return FOCUS to the zone card (leaving a composite): re-pin the FL gauge on the active layer. */
  private focusZone(fid: string): void {
    this.focusedComposite = null;
    const f = this.doc.get(fid);
    const def = f ? this.registry.get(f.properties.phenomenon) : undefined;
    const m = f?.properties.metadata;
    if (def?.repeat && m) {
      const lf = listFieldOf(def);
      const layer = lf ? (m[lf.key] as Metadata[] | undefined)?.[this.selectedSub ?? 0] : undefined;
      this.flRef = layer ? this.layerFlRef(layer) : null;
    }
    this.renderAll();
    this.emitSelect();
  }

  /** Remove a zone-level composite (its card's ✕) and return focus to the zone. */
  private removeComposite(fid: string, key: string): void {
    const f = this.doc.get(fid);
    if (!f || f.properties.metadata[key] == null) return;
    const m = { ...f.properties.metadata };
    delete m[key];
    f.properties.metadata = m;
    this.emitChange();
    this.focusZone(fid);
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
    } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      // Flat index → ring (outer OR hole) + local, same walk as vertices().
      //  • a HOLE at its 3-vertex minimum disappears entirely (delete its vertices one by
      //    one — the erased clear zone closes back up);
      //  • a MultiPolygon OUTER at the minimum loses the whole AREA (a single remaining
      //    area demotes back to a simple Polygon);
      //  • a simple Polygon's outer keeps ≥ 3 (can't delete the zone vertex-by-vertex).
      const hit = ringOfFlat(g, index);
      if (!hit) return;
      const uniq = openRing(hit.ring).slice();
      if (uniq.length <= 3) {
        if (hit.ringIndex > 0) {
          hit.poly.splice(hit.ringIndex, 1); // the hole closes up
        } else if (g.type === "MultiPolygon") {
          g.coordinates.splice(hit.area, 1);
          this.anchorPins.get(id)?.splice(hit.area, 1); // keep the other areas' moved tips aligned
          if (g.coordinates.length === 1) f.geometry = { type: "Polygon", coordinates: g.coordinates[0]! };
          this.selectedAreas = [];
        } else {
          return;
        }
      } else {
        if (!uniq[hit.local]) return;
        uniq.splice(hit.local, 1);
        uniq.push(uniq[0]!);
        hit.poly[hit.ringIndex] = uniq;
      }
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
      const poly = (g.type === "MultiPolygon" ? g.coordinates[a] : g.coordinates) as Position[][] | undefined;
      if (!poly) return;
      // The clicked area's NEAREST ring wins — a dbl-click on a hole's edge adds a vertex
      // to the hole, exactly like the outer boundary.
      let bestRing = 0;
      let bestSeg = 0;
      let bestD = Infinity;
      poly.forEach((ring, ri) => {
        const uniq = openRing(ring);
        if (uniq.length < 2) return;
        const k = frameK(uniq as Pt[]);
        const planar = uniq.map((c) => toPlanar(c as Pt, k));
        const cur = toPlanar([at[0]!, at[1]!], k);
        for (let i = 0; i < planar.length; i++) {
          const d = segDist(cur, planar[i]!, planar[(i + 1) % planar.length]!);
          if (d < bestD) {
            bestD = d;
            bestRing = ri;
            bestSeg = i;
          }
        }
      });
      if (bestD === Infinity) return;
      const uniq = openRing(poly[bestRing]!).slice();
      uniq.splice(bestSeg + 1, 0, at);
      uniq.push(uniq[0]!);
      poly[bestRing] = uniq;
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

  // ── layer stack (the TEMSI cloud-layer significant-weather area) ─────────────
  // A `repeat` descriptor stacks a LIST field as layer cards kept altitude-sorted
  // (highest on top). The order is recomputed only on discrete actions (select /
  // add / remove) — NOT during a single layer's FL drag (the pinned editor would
  // otherwise jump under the cursor), hence resortLayers() is called from select()
  // and the add/remove helpers, never from updateListItem().

  /** A layer's sort key: its top FL, else its base FL, else 0 (un-set layers sink). */
  private layerAltitude(item: Metadata): number {
    const top = typeof item["topFL"] === "number" ? (item["topFL"] as number) : undefined;
    const base = typeof item["baseFL"] === "number" ? (item["baseFL"] as number) : undefined;
    return top ?? base ?? 0;
  }

  /** Re-sort a layer-stack feature's list highest-on-top, keeping the selected layer selected. */
  private resortLayers(id: string): void {
    const f = this.doc.get(id);
    if (!f) return;
    const rep = this.registry.get(f.properties.phenomenon).repeat;
    if (!rep) return;
    const list = (f.properties.metadata[rep.listField] as Metadata[] | undefined) ?? [];
    if (list.length < 2) return;
    const selected = this.selectedSub != null ? list[this.selectedSub] : undefined;
    const sorted = [...list].sort((a, b) => this.layerAltitude(b) - this.layerAltitude(a));
    if (sorted.every((it, i) => it === list[i])) return; // already ordered — no churn
    f.properties.metadata = { ...f.properties.metadata, [rep.listField]: sorted };
    if (selected) {
      const ni = sorted.indexOf(selected);
      if (ni >= 0) this.selectedSub = ni;
    }
  }

  /** Seed a new layer's FL bounds from the cloud TYPE's per-type defaults (carried as the
   *  driver enum option's `meta:{baseFL,topFL}` — JSON-declared, surfaced through EnumOption),
   *  each coerced into the profile's FL range (`flGaugeRange`, one XXX notch past a bound). */
  private applyLayerTypeDefaults(type: string, lf: ListField, item: Metadata): void {
    const amount = lf.itemSchema.find((s): s is EnumField => s.type === "enum" && !!s.optionsBy);
    const driverKey = amount?.optionsBy?.field ?? "type";
    const driver = lf.itemSchema.find((s): s is EnumField => s.type === "enum" && s.key === driverKey);
    const opt = driver?.options.find((o) => o.value === item[driverKey]);
    const meta = opt?.meta;
    if (!meta) return;
    for (const s of lf.itemSchema) {
      if (s.type === "fl" && typeof meta[s.key] === "number") {
        const { lo, hi } = this.flGaugeRange(type, s.key);
        item[s.key] = Math.max(lo, Math.min(hi, meta[s.key] as number));
      }
    }
  }

  /** The bottom/top FL field keys of a stack layer (the `base`/`top` naming convention shared with
   *  {@link flGaugeRange}): the list item's two FL fields, base = the one matching /base/, top /top/
   *  (falling back to schema order). `null` when the item has fewer than two FL fields. */
  private layerFlKeys(lf: ListField): [string, string] | null {
    const fls = lf.itemSchema.filter((s) => s.type === "fl");
    if (fls.length < 2) return null;
    const base = fls.find((s) => /base/i.test(s.key)) ?? fls[0]!;
    const top = fls.find((s) => /top/i.test(s.key)) ?? fls[1]!;
    return base.key === top.key ? null : [base.key, top.key];
  }

  /** The FL band a stack layer at `index` should occupy by default in the GAUGES editor: the
   *  `index`-th of `repeat.max` equal slices of the resolved FL range (5-FL snapped), so the FIRST
   *  layer takes the bottom 1/max and leaves the rest of the axis free instead of spanning it all.
   *  `null` unless the phenomenon has a `repeat` (multi-layer) with a usable FL range. */
  private layerSlice(type: string, index: number): { base: number; top: number } | null {
    const rep = this.registry.get(type).repeat;
    if (!rep) return null;
    const { min, max } = this.flResolved(type);
    if (min == null || max == null || max <= min) return null;
    const n = Math.max(1, rep.max);
    const h = Math.round((max - min) / n / 5) * 5;
    if (h <= 0) return null;
    const k = Math.max(0, Math.min(n - 1, index));
    const base = min + k * h;
    return { base, top: k === n - 1 ? max : Math.min(max, base + h) };
  }

  /** The FL band a NEW layer should take when added on the `side` clicked (gauges editor): a 1/max
   *  slice butting against the current stack — ABOVE its highest top (`"top"`) or BELOW its lowest
   *  base (`"bottom"`), clamped into the resolved FL range. `null` for a non-gauges repeat / no FL
   *  range / no FL fields. (Visibility of each side's `+` is gated on there being room — see the
   *  interpreter — so this only runs when the clicked side actually has space.) */
  private adjacentLayerBand(type: string, list: Metadata[], side: "top" | "bottom"): { base: number; top: number } | null {
    const def = this.registry.get(type);
    const rep = def.repeat;
    if (!rep) return null;
    const { min, max } = this.flResolved(type);
    if (min == null || max == null || max <= min) return null;
    const lf = def.schema.find((s): s is ListField => s.type === "list" && s.key === rep.listField);
    const keys = lf && this.layerFlKeys(lf);
    if (!keys) return null;
    const [bk, tk] = keys;
    const n = Math.max(1, rep.max);
    const h = Math.max(5, Math.round((max - min) / n / 5) * 5);
    const numOf = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
    if (!list.length) return { base: min, top: Math.min(max, min + h) };
    if (side === "top") {
      const base = Math.min(max - 5, Math.max(...list.map((l) => numOf(l[tk], max))));
      return { base, top: Math.min(max, base + h) };
    }
    const top = Math.max(min + 5, Math.min(...list.map((l) => numOf(l[bk], min))));
    return { base: Math.max(min, top - h), top };
  }

  /** A single layer's default FL band CENTRED on the resolved range: one 1/max-tall slice around the
   *  mid-altitude, so BOTH the top and bottom `+` have room from the start. `null` for a non-gauges
   *  repeat / no usable range. */
  private centeredLayerSlice(type: string): { base: number; top: number } | null {
    const rep = this.registry.get(type).repeat;
    if (!rep) return null;
    const { min, max } = this.flResolved(type);
    if (min == null || max == null || max <= min) return null;
    const n = Math.max(1, rep.max);
    const h = Math.max(5, Math.round((max - min) / n / 5) * 5);
    const base = Math.max(min, Math.min(max - h, Math.round(((min + max) / 2 - h / 2) / 5) * 5));
    return { base, top: base + h };
  }

  /** Lay a freshly-built stack's default layer(s) into their gauges-editor FL bands: a lone layer
   *  sits CENTRED on the range ({@link centeredLayerSlice}) — leaving room above AND below so either
   *  `+` works straight away; a multi-layer default falls back to a bottom-up partition
   *  ({@link layerSlice}). No-op for a non-gauges repeat or without FL fields. */
  private applyLayerSlices(type: string, metadata: Metadata): void {
    const def = this.registry.get(type);
    const rep = def.repeat;
    if (!rep) return;
    const lf = def.schema.find((s): s is ListField => s.type === "list" && s.key === rep.listField);
    if (!lf) return;
    const keys = this.layerFlKeys(lf);
    const list = metadata[lf.key];
    if (!keys || !Array.isArray(list) || !list.length) return;
    const place = (it: Metadata, band: { base: number; top: number } | null): void => {
      if (band) {
        it[keys[0]] = band.base;
        it[keys[1]] = band.top;
      }
    };
    if (list.length === 1) {
      place(list[0] as Metadata, this.centeredLayerSlice(type));
      return;
    }
    list.forEach((it, i) => place(it as Metadata, this.layerSlice(type, i)));
  }

  /** Insert a new layer (item-schema defaults + per-type FL defaults) with its FL band from `bandFor`,
   *  re-sorted highest-on-top and selected. No-op past `repeat.max`. Returns its new index (or -1). */
  private insertLayer(id: string, bandFor: (type: string, list: Metadata[]) => { base: number; top: number } | null): number {
    const f = this.doc.get(id);
    if (!f) return -1;
    const def = this.registry.get(f.properties.phenomenon);
    const rep = def.repeat;
    if (!rep) return -1;
    const lf = def.schema.find((s): s is ListField => s.type === "list" && s.key === rep.listField);
    if (!lf) return -1;
    const list = (f.properties.metadata[lf.key] as Metadata[] | undefined) ?? [];
    if (list.length >= rep.max) return -1;
    const item: Metadata = {};
    for (const s of lf.itemSchema) {
      if (s.type !== "list" && "default" in s && s.default !== undefined) item[s.key] = s.default;
      else if (s.type === "bool") item[s.key] = false;
    }
    this.applyLayerTypeDefaults(def.type, lf, item);
    const band = bandFor(def.type, list);
    const flKeys = this.layerFlKeys(lf);
    if (band && flKeys) {
      item[flKeys[0]] = band.base;
      item[flKeys[1]] = band.top;
    }
    const next = [...list, item].sort((a, b) => this.layerAltitude(b) - this.layerAltitude(a));
    f.properties.metadata = { ...f.properties.metadata, [lf.key]: next };
    this.selectedSub = next.indexOf(item);
    this.afterEdit(id);
    return this.selectedSub;
  }

  /** Add a layer to a stack feature. `side` butts the new FL band against one end — `"top"` stacks
   *  ABOVE the highest layer, `"bottom"` slides one in BELOW the lowest (see {@link adjacentLayerBand}). */
  addLayerTo(id: string, side: "top" | "bottom" = "top"): number {
    return this.insertLayer(id, (type, list) => this.adjacentLayerBand(type, list, side));
  }

  /** Add a layer whose FL band is CENTRED on `fl` — the gauge HOVER-`+` ("add here" over an empty
   *  axis span, `addLayerAt:<fl>`). The band is a default-height slice around `fl` (see
   *  {@link bandAround}); re-sorted + selected; no-op past `repeat.max`. */
  addLayerAt(id: string, fl: number): number {
    return this.insertLayer(id, (type) => this.bandAround(type, fl));
  }

  /** A default-height (1/`max`) FL band CENTRED on `fl`, 5-FL snapped and clamped to the resolved
   *  range (shifted wholly inside if `fl` sits near a bound). `null` for a non-multi-layer phenomenon
   *  / no usable range. */
  private bandAround(type: string, fl: number): { base: number; top: number } | null {
    const rep = this.registry.get(type).repeat;
    if (!rep) return null;
    const { min, max } = this.flResolved(type);
    if (min == null || max == null || max <= min) return null;
    const n = Math.max(1, rep.max);
    const h = Math.min(max - min, Math.max(5, Math.round((max - min) / n / 5) * 5));
    const c = Math.round(Math.max(min, Math.min(max, fl)) / 5) * 5;
    let base = Math.round((c - h / 2) / 5) * 5;
    if (base < min) base = min;
    if (base + h > max) base = max - h;
    return { base, top: base + h };
  }

  /** Remove a layer from a stack feature, keeping ≥ `repeat.min`. */
  removeLayerFrom(id: string, index: number): void {
    const f = this.doc.get(id);
    if (!f) return;
    const rep = this.registry.get(f.properties.phenomenon).repeat;
    if (!rep) return;
    const list = (f.properties.metadata[rep.listField] as Metadata[] | undefined) ?? [];
    if (list.length <= rep.min) return;
    this.removeListItem(id, rep.listField, index);
  }

  delete(id: string): void {
    if (!this.doc.delete(id)) return;
    this.order = this.order.filter((x) => x !== id);
    for (const k of [...this.pins.keys()]) if (k.startsWith(`${id}:`)) this.pins.delete(k);
    if (this.autoPinKey?.startsWith(`${id}:`)) this.autoPinKey = null;
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
    this.autoPinKey = null;
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
    this.autoPinKey = null;
    for (const f of fromFeatureCollection(fcIn, this.registry)) {
      const id = f.properties.id || `f${this.idSeq++}`;
      f.properties.id = id;
      this.doc.set(id, f);
      this.order.push(id);
    }
    // Advance the id counter PAST every loaded `fN` id — otherwise a feature that came WITH an
    // id (the `||` above didn't bump the counter) lets a later draw reuse `f0`/`f1`/… and
    // OVERWRITE a loaded feature. Bites when the same collection is re-hydrated into a fresh
    // controller (e.g. the demo switching engines): draw → `f0` → clobbers the first feature.
    for (const id of this.doc.keys()) {
      const m = /^f(\d+)$/.exec(id);
      if (m) this.idSeq = Math.max(this.idSeq, Number(m[1]) + 1);
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
    const metadata = defaultMetadata(def);
    this.clampFlDefaults(def.type, metadata); // keep defaults on-chart (profile `vertical`)
    this.applyLayerSlices(def.type, metadata); // gauges editor: first layer = bottom 1/max slice
    this.doc.set(id, { type: "Feature", geometry, properties: { id, phenomenon: def.type, metadata } });
    this.order.push(id);
    this.mode = "editing";
    this.select(id);
    this.emitChange();
    return id;
  }

  /** "draw-more": draw an EXTRA AREA appended to feature `fid` (one phenomenon, several zones,
   *  one box, one arrow per zone). Fired by the arrow-tip badge tap (and the test harness). */
  private drawMore(fid: string): void {
    const f = this.doc.get(fid);
    if (!f) return;
    this.draw(f.properties.phenomenon);
    this.appendTo = fid; // set AFTER draw() — it resets stale state via cancelDrawing
  }

  /** Commit a drawn geometry as a new feature, select it, leave drawing mode. */
  /** Mirror the drawing state onto the toolbar: highlight the armed tool's button while a draw
   *  is in progress, clear it on commit / cancel / Escape. The adapter owns the toolbar DOM and
   *  does the actual highlight (its appearance is set via the toolbar's `activeStyle`). */
  private setActiveTool(id: string | null): void {
    this.adapter.setActiveTool(id);
  }

  private commit(type: string, geometry: Geometry): void {
    // `+` append mode: the freshly drawn polygon joins the TARGET feature's geometry as an
    // extra area (Polygon → MultiPolygon) — one logical phenomenon (one box, one metadata
    // set, one arrow per area), NOT a new feature.
    this.setActiveTool(null); // drawing succeeded → the tool button is no longer armed
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
    this.clampFlDefaults(type, metadata); // then keep them on-chart (profile `vertical`)
    this.applyLayerSlices(type, metadata); // gauges editor: first layer = bottom 1/max slice
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
        // A spot is laid by a CLICK, which the browser follows with a trailing `click` event —
        // swallow it (didDrag) so it doesn't land on the map background and deselect the spot
        // we just placed + selected (markers use `dropFeature`, no trailing map click).
        this.didDrag = true;
        this.commit(d.type, { type: "Point", coordinates: [at[0]!, at[1]!] });
        return;
      }
      this.cancelDrawing();
      this.renderAll();
      return;
    }
    // An accidental tap/jitter must NOT commit a micro-polygon — especially in `+` append
    // mode, where a near-invisible extra area grows a GHOST second leader/arrow (the
    // "double arrow" bug). Under ~24 px of screen extent it's noise: cancel the stroke.
    if (it.primitive === "polygon" && this.strokeExtentPx(d.coords) < 24) {
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
    this.setActiveTool(null); // leaving drawing (Escape / abort / re-arm) un-highlights the button
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
      const features: RenderFeature[] = def.decorate({ geometry: f.geometry, metadata: f.properties.metadata, style: this.styleOf(f.properties.phenomenon), resolution, flightLevel: this.flResolved(f.properties.phenomenon), leaderThunderbolt: this.phenomena[f.properties.phenomenon]?.leaderThunderbolt, editing: id === this.selectedId });
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
            req.arrowAnchors = areaRings(f.geometry)
              .filter((ar) => ar.outer.length >= 3)
              .map((ar, k) => {
                // Hole-aware: the tip must point at CLOUD — never into an erased clear zone.
                const a = clampInArea(tips?.[k] ?? ringMean(ar.outer), ar);
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
    // ERASER brush preview: the brush footprint follows the pointer on the map.
    if (this.erasing?.cursorPx) {
      const [bx, by] = this.erasing.cursorPx;
      const ring: Position[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = (i / 24) * 2 * Math.PI;
        const u = this.adapter.unproject([bx + Math.cos(t) * this.erasing.r, by + Math.sin(t) * this.erasing.r]);
        if (u) ring.push([u.lon, u.lat]);
      }
      if (ring.length > 2) {
        buckets["selection"]!.push({ type: "Feature", properties: { layer: "selection", stroke: this.style.selection.color, strokeWidth: 1.5, dash: [4, 3] }, geometry: { type: "LineString", coordinates: ring } });
      }
    }

    this.lastAnnReqs = annReqs;
    // The call-out being ACTIVELY dragged owns the cursor: it's placed first so the OTHERS (even
    // pinned) yield/flee it — anti-collision independent of creation/drag order.
    const activeFid = this.dragTarget?.kind === "callout" ? this.dragTarget.featureId : undefined;
    const placed = placeAnnotations(annReqs, this.adapter, this.pins, this.markerObstacleRects(), activeFid);
    buckets["leaders"]!.push(...placed.leaders);
    // placed.symbols are pushed AFTER the widgets are known — a replaced call-out's glyph
    // lives in its card (the severity carousel), not on the canvas.
    // Arrow-tip handle — only while its leader is VISIBLE, so it vanishes WITH the arrow
    // when the call-out sits over the tip (no lone handle without an arrow).
    const leaderVisible = selAnchors.length > 0 && placed.leaders.some((l) => l.properties["featureId"] === this.selectedId);
    if (leaderVisible) {
      // One arrow-tip handle PER AREA (`area` index) — each drags its own tip. (The old
      // scallop-flip tap is gone: bump direction is a geometric fact now — holes invert.)
      selAnchors.forEach((a, k) => {
        buckets["handles"]!.push({ type: "Feature", properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "anchor", area: k }, geometry: { type: "Point", coordinates: a } });
      });
    }

    // Remember where each call-out box landed (lon/lat) so the area FL gauge can
    // sit right next to it (the slider "follows the logo + FL").
    this.placedAt.clear();
    for (const box of placed.boxes) {
      const id = box.properties.featureId;
      if (id && box.geometry.type === "Point") this.placedAt.set(id, box.geometry.coordinates as [number, number]);
    }
    // Freeze the SELECTED call-out's offset once (so it stops auto-placing while edited): a
    // multi-layer area's cartouche grows a line per cloud layer, widening the box → its centre
    // (where the gauge/card pin) would slide right on every add. Capturing the current offset as a
    // pin makes later placements width-independent (`cx = anchor + pin.dx`). No-op for features
    // whose content doesn't change; released/re-promoted in select() and the call-out drag.
    if (this.selectedId) {
      const sel = this.selectedId;
      const req = this.lastAnnReqs.find((r) => r.featureId === sel);
      const box = this.placedAt.get(sel);
      const k = req ? `${req.featureId}:${req.labelId}` : null;
      if (req && box && k && !this.pins.has(k)) {
        const a = this.adapter.project(req.anchor);
        const b = this.adapter.project({ lon: box[0], lat: box[1] });
        if (a && b) {
          this.pins.set(k, { dx: b[0] - a[0], dy: b[1] - a[1] });
          this.autoPinKey = k;
        }
      }
    }
    // Widgets are built AFTER placement so one can ride its feature's placed call-out:
    // such a widget REPLACES that call-out box (selected CB → the DOM card carries the same
    // content + the `+` edge buttons; the leader still points at the card).
    const widgets = this.collectWidgets();
    // The "draw-more" button used to straddle the card edge; it now rides the SELECTED area's
    // arrow tip (where the old scallop-flip tap was), CENTERED on the tip. It is NOT a widget
    // button — those swallow the pointer and would block the tip's re-aim drag they sit on.
    // It's a sizable GLYPH badge that the controller treats as the anchor control itself:
    // a DRAG re-aims the tip (onDown → kind "anchor", area 0) and a plain TAP enters
    // append-draw (onUp). One badge per feature, same visibility gate as the handle.
    if (leaderVisible && this.selectedId) {
      const selDef = this.registry.get(this.doc.get(this.selectedId)!.properties.phenomenon);
      if (selDef.anchorButton) {
        const tip = selAnchors[0]!;
        widgets.push({
          id: `${this.selectedId}#draw`,
          anchor: { lon: tip[0], lat: tip[1] },
          origin: "center",
          // Framed like the card's own edge buttons (white disc, hairline ink border, black
          // glyph) so it reads clearly on any map — orange was invisible. It is still a glyph
          // (not a widget button): the controller drives the drag (re-aim) + tap (draw-more).
          bg: "#ffffff",
          border: "#1f2328",
          radius: "round",
          padding: "small",
          child: { dir: "v", items: [{ kind: "glyph", svg: selDef.anchorButton.svg, size: 16, color: "#1f2328" }] },
        });
      }
    }
    const replaced = new Set(widgets.map((w) => w.id));
    // READ-ONLY UNIFICATION: every remaining (unselected) call-out box becomes a static SPRITE rather
    // than a canvas text-box — ONE read-only render path that bypasses the engine label layer. id ==
    // featureId ⇒ the canvas box + its symbol are suppressed just below; the leader stays.
    for (const box of placed.boxes) {
      const fid = box.properties.featureId;
      if (typeof fid !== "string" || box.geometry.type !== "Point" || replaced.has(fid)) continue;
      const sprite = this.calloutSprite(box, placed.symbols);
      if (sprite) { widgets.push(sprite); replaced.add(fid); }
    }
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

    // Spot / line LABELS (tropopause spot+contour, isotherms) are DIRECT text-boxes, not placed
    // call-outs: each is PINNED to its own anchor — the box IS the object, so it NEVER moves with the
    // anti-collision (unlike a cartouche). Still render it as a static SPRITE when unselected, so the
    // read-only path is unified — anchored on its own point (NO `placeAnnotations`), so it stays put.
    // Skip the selected one (it stays an editable canvas box) and rotated labels (jet speed — no tilt).
    const keptBoxes: Feature[] = [];
    for (const box of buckets["text-boxes"]!) {
      const props = box.properties ?? {};
      const fid = props["featureId"];
      if (typeof fid === "string" && fid !== this.selectedId && !replaced.has(fid) && box.geometry.type === "Point" && props["rotation"] === undefined) {
        const sprite = this.calloutSprite(box as RenderFeature, placed.symbols);
        if (sprite) { widgets.push(sprite); replaced.add(fid); continue; }
      }
      keptBoxes.push(box);
    }
    buckets["text-boxes"] = keptBoxes;

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
      const isSel = id === this.selectedId;
      // Existing zone-level composites (the non-convective cloud's icing/turb sub-objects).
      const comps = isSel ? (def.composites ?? []).filter((c) => f.properties.metadata[c.key]) : [];
      const zoneFocused = this.focusedComposite == null;
      // ZONE card: stays a (clickable) panel whenever selected — even when a composite holds the
      // focus — so a tap on it brings the focus back. Only the FOCUSED element shows its FL gauge
      // (never two gauges); when a composite exists, the zone card is top-anchored so an icing card
      // (bottom-anchored) glues exactly above it (no overlap), edge-to-edge.
      const w = def.widget({
        id,
        geometry: f.geometry,
        metadata: f.properties.metadata,
        editable: isSel,
        style: this.styleOf(f.properties.phenomenon),
        ...(at && req ? { callout: { at, content: req.content } } : {}),
        sprite: (sid: string) => this.spriteCatalog[sid],
        flightLevel: this.flResolved(f.properties.phenomenon),
        ...(isSel && zoneFocused && this.selectedSub != null ? { sub: this.selectedSub } : {}),
        ...(isSel && zoneFocused && this.flRef != null ? { flRef: this.flRef } : {}),
        chrome: this.style.control,
        limit: (key: string) => this.numLimit(def, key),
      });
      // A builder may return null (no widget for this state) or SEVERAL cards (jet / zone+gauge).
      let zoneCards = Array.isArray(w) ? w : w ? [w] : [];
      if (comps.length && zoneCards[0]) {
        // The zone card stays at its normal anchor; composites attach to its MEASURED edges via
        // `anchorTo` (icing above / turb below) — a clean 3-card stack, no overlap (see below).
        // Drop the ADD button of any composite that ALREADY exists — its delete ✕ takes that exact
        // spot, but on the composite card (which draws on top, so the button stays clickable).
        const existing = new Set(comps.map((c) => `composite:${c.key}`));
        if (zoneCards[0].buttons) zoneCards[0].buttons = zoneCards[0].buttons.filter((b) => !existing.has(b.event));
        // SELECTION EMPHASIS: in a composite stack the FOCUSED card wears a bold (2px `large`) border
        // and the others a hairline (0.5px `small`), so it’s obvious which card a tap edits. The zone
        // is focused when no composite holds focus.
        zoneCards[0].borderWidth = zoneFocused ? "large" : "small";
        if (!zoneFocused) zoneCards = zoneCards.slice(0, 1); // not focused ⇒ panel only (no gauge)
      }
      out.push(...zoneCards);
      // COMPOSITE cards (the non-convective cloud's icing/turb): one per existing composite, glued
      // to the zone card (icing above / turb below) by REUSING the referenced phenomenon's widget
      // builder; editable, with a delete ✕ (top-right). The FL gauge renders only on the focused one.
      for (const spec of comps) {
        const refDef = this.registry.get(spec.ref);
        if (!refDef.widget || !at || !req) continue;
        const focused = this.focusedComposite === spec.key;
        const cw = refDef.widget({
          id: `${id}#${spec.key}`,
          geometry: f.geometry,
          metadata: f.properties.metadata[spec.key] as Metadata,
          editable: true,
          style: this.styleOf(spec.ref),
          callout: { at, content: "" },
          sprite: (sid: string) => this.spriteCatalog[sid],
          flightLevel: this.flResolved(f.properties.phenomenon),
          ...(focused && this.flRef != null ? { flRef: this.flRef } : {}),
          chrome: this.style.control,
          limit: (key: string) => this.numLimit(refDef, key),
        });
        let cards = Array.isArray(cw) ? cw : cw ? [cw] : [];
        if (cards[0]) {
          // SIDECAR look: a glued composite card is ALWAYS a framed box — same bg / border / radius /
          // padding as a framed panel (icing gets these from its `framed` card; turbulence, which is
          // `framed:false`, would otherwise miss them → mismatched padding/corners). Match `large`
          // padding (the panel default, `card.pad ?? "large"`) so all cards line up.
          cards[0].bg = cards[0].bg ?? "#ffffff";
          cards[0].border = cards[0].border ?? "#1f2328";
          cards[0].radius = cards[0].radius ?? "small";
          cards[0].padding = cards[0].padding ?? "large";
          // SELECTION EMPHASIS (see zone card): bold border on the FOCUSED composite, hairline else.
          cards[0].borderWidth = focused ? "large" : "small";
          // Glue to the zone card's MEASURED edge (icing above / turb below) via anchorTo — a clean
          // stack, no overlap. The cross axis (horizontal) keeps the card centred on the call-out.
          cards[0].anchorTo = { id, side: spec.place };
          // The delete ✕ sits on the edge facing the zone (where the add button was), on top.
          const frontier = spec.place === "top" ? "bottom" : "top";
          cards[0].buttons = [
            ...(cards[0].buttons ?? []),
            { event: `removeComposite:${spec.key}`, place: frontier, svg: COMPOSITE_DELETE_SVG, bordered: true, title: "Delete" },
          ];
        }
        if (!focused) cards = cards.slice(0, 1); // not focused ⇒ panel only (no gauge)
        out.push(...cards);
      }
      // UNSELECTED cloud with composites: a compact read-only summary cartouche, replacing the canvas
      // call-out (keeps the leader). Single-layer ⇒ inverted-L; multi-layer ⇒ a row-per-cloud grid
      // (AMOUNT TYPE | FL) with the composites listed below, FLs aligned. Declutter-gated.
      if (!isSel && at && (this.calloutShown.get(id) ?? true)) {
        const existing = (def.composites ?? []).filter((c) => f.properties.metadata[c.key]);
        if (existing.length && req) {
          const summary = this.compositeSummaryCard(id, f, existing, at, req);
          if (summary) out.push(summary);
        }
      }
    }
    return out;
  }

  /** Convert a placed (unselected) call-out BOX + its severity glyph into a READ-ONLY static SPRITE —
   *  the unified read-only render (no canvas text-box, so it bypasses the engine label layer). The
   *  sprite replaces the canvas box (id == featureId ⇒ suppressed) and keeps the leader. Boxed
   *  call-outs (CB/icing/cloud carry `textBackground`) get a framed white box; an UNBOXED one
   *  (turbulence) gets a soft white backing (halo-like) so its text stays legible on the map. */
  private calloutSprite(box: RenderFeature, symbols: RenderFeature[]): MarkerWidget | null {
    if (box.geometry.type !== "Point") return null;
    const p = box.properties;
    const fid = p.featureId;
    if (typeof fid !== "string") return null;
    const labelId = String(p.labelId ?? "l");
    const lines = String(p.text ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const sym = symbols.find((s) => s.properties.featureId === fid && s.properties.labelId === labelId);
    const items: WidgetNode[] = [];
    if (sym) {
      const svg = this.spriteCatalog[String(sym.properties.symbol ?? "")];
      // Glyph size follows the symbol's OWN scale (turbulence 1.1, icing 0.82…) ⇒ data-driven, not a
      // flat size: a phenomenon with a bigger symbol (CAT) reads bigger, icing stays normal.
      if (svg) items.push({ kind: "glyph", svg, size: Math.round((Number(sym.properties.size) || 1) * 26), color: String(sym.properties.symbolColor ?? p.textColor ?? "#111") });
    }
    const size = Number(p.textSize ?? 13);
    const color = String(p.textColor ?? "#111");
    for (const v of lines) items.push({ kind: "text", value: v, size, color });
    if (!items.length) return null;
    const [lon, lat] = box.geometry.coordinates as [number, number];
    // BOXED call-outs (CB/icing/cloud carry `textBackground`) get an opaque framed box. An UNBOXED one
    // (turbulence) stays BARE — NO bg, NO border — exactly like its canvas call-out (just text + glyph).
    const boxed = p.textBackground !== undefined;
    return {
      id: fid,
      labelId,
      static: true,
      anchor: { lon, lat },
      origin: "center",
      ...(boxed ? { bg: String(p.textBackground), border: String(p.textBorder ?? "#1f2328"), radius: "small" as const } : {}),
      padding: "small",
      child: { dir: "v", align: "center", gap: 2, items },
    };
  }

  /** Unselected composite summary (single-layer non-convective cloud): ONE read-only card that
   *  REPLACES the zone's canvas call-out box — left column = the zone summary (amount/type/top/base
   *  FL, the box content), right column = one row per composite (severity glyph + top/base FL). A
   *  single block, no follow-lag. `null` when no composite to show. */
  private compositeSummaryCard(
    zoneId: string,
    f: SigwxFeature,
    comps: { key: string; ref: string; place: "top" | "bottom" }[],
    at: [number, number],
    req: AnnReq,
  ): MarkerWidget | null {
    const resolution = this.resolution();
    // Collect each EXISTING composite once: its severity glyph (+ ink) and base/top FL.
    type CompInfo = { svg: string | undefined; color: string; top: string; base: string; baseFL: unknown; topFL: unknown };
    const compInfo: CompInfo[] = [];
    for (const c of comps) {
      const meta = f.properties.metadata[c.key] as Metadata | undefined;
      if (!meta) continue;
      const refDef = this.registry.get(c.ref);
      // Reuse the composite's OWN call-out decoration for the formatted FL (the `flx` filter) and the
      // severity ink — no formatting duplicated. An `inside` glyph pads with blanks, so keep non-empty.
      const ann = refDef
        .decorate({ geometry: f.geometry, metadata: meta, style: this.styleOf(c.ref), resolution, flightLevel: this.flResolved(c.ref) })
        .find((ft) => ft.properties.layer === ANNOTATION_BUCKET);
      const lines = String(ann?.properties.content ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      compInfo.push({
        svg: this.spriteCatalog[String(meta["symbol"] ?? "")],
        color: (ann?.properties.symbolColor as string | undefined) ?? "#1f2328",
        top: lines[0] ?? "", base: lines[1] ?? "",
        baseFL: meta["baseFL"], topFL: meta["topFL"],
      });
    }
    if (!compInfo.length) return null;

    // Common chrome + placement. The card REPLACES the canvas call-out box (id == feature id ⇒ the
    // placement pass drops the box, keeps its leader) and renders READ-ONLY as a rasterized SPRITE
    // (native zoom/collision; its hit surfaces as `text-boxes`+featureId ⇒ drag/click reuse the
    // call-out path, no select-on-DOWN). Pin the LEFT edge where the box's left edge was.
    const FRAME = "#1f2328";
    const a = this.adapter.project({ lon: at[0], lat: at[1] });
    if (!a) return null;
    const { w } = estimateBox(req.content, req.textSize);
    const left = this.adapter.unproject([a[0] - w / 2, a[1]]);
    if (!left) return null;
    const chrome = { id: zoneId, static: true as const, labelId: req.labelId ?? "l", anchor: left, origin: "left" as const };
    const txt = (value: string): WidgetNode => ({ kind: "text", value, size: 13, color: "#1f2328" });
    // `flLabel` zero-pads to 3 digits (FL000, FL050…) — same format as the `flx` filter.
    const flRange = (b: unknown, t: unknown): string => `${flLabel(b)}/${flLabel(t)}`;

    const layers = (f.properties.metadata["layers"] as Metadata[] | undefined) ?? [];
    if (layers.length >= 2) {
      // MULTI-LAYER ⇒ a 2-column grid. LEFT = "AMOUNT TYPE" per cloud, then the severity glyphs
      // (centred in that column). RIGHT = the matching "FLbase/FLtop", clouds then composites — so
      // each composite FL lines up UNDER the cloud FLs. One row per cloud / per composite.
      const leftItems: WidgetNode[] = [];
      const rightItems: WidgetNode[] = [];
      for (const l of layers) {
        leftItems.push(txt(`${String(l["amount"])} ${String(l["type"])}`));
        rightItems.push(txt(flRange(l["baseFL"], l["topFL"])));
      }
      for (const c of compInfo) {
        leftItems.push(c.svg ? { kind: "glyph", svg: c.svg, size: 18, color: c.color } : txt(""));
        rightItems.push(txt(flRange(c.baseFL, c.topFL)));
      }
      return {
        ...chrome,
        bg: "#ffffff", border: FRAME, borderWidth: "medium", radius: "small", padding: "small",
        child: { dir: "h", align: "start", gap: 10, items: [
          { dir: "v", align: "center", gap: 4, items: leftItems },
          { dir: "v", align: "start", gap: 4, items: rightItems },
        ] },
      };
    }

    // SINGLE-LAYER ⇒ the inverted-L: a full-framed cloud box (left) + a TOP/RIGHT/BOTTOM-framed
    // composites box (right, sharing the cloud's right edge). One composite ⇒ the right box is
    // shorter ⇒ bottom-right empty ⇒ inverted L; two ⇒ a clean two-column rectangle.
    const zoneLines = req.content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const chips: WidgetNode[] = compInfo.map((c) => ({
      dir: "h", align: "center", gap: 5, items: [
        ...(c.svg ? [{ kind: "glyph" as const, svg: c.svg, size: 22, color: c.color }] : []),
        { dir: "v", align: "start", items: [txt(c.top), txt(c.base)] },
      ],
    }));
    return {
      ...chrome,
      // No OUTER frame: each inner column carries its own border/bg so the cartouche traces the CONTENT.
      child: { dir: "h", align: "start", gap: 0, items: [
        { dir: "v", align: "center", gap: 2, bg: "#ffffff", border: FRAME, borderWidth: "medium", padding: "small",
          items: zoneLines.map((value) => txt(value)) },
        { dir: "v", align: "start", gap: 6, bg: "#ffffff", border: { top: FRAME, right: FRAME, bottom: FRAME }, borderWidth: "medium", padding: "small",
          items: chips },
      ] },
    };
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
    // Every ring (outer + HOLES) with its running FLAT offset — holes highlight and edit
    // exactly like outer boundaries.
    let flatOff = 0;
    const ringsWithOff = flatRings(f.geometry).map((fr) => {
      const e = { ...fr, off: flatOff };
      flatOff += openRing(fr.ring).length;
      return e;
    });
    const selRings =
      f.geometry.type === "MultiPolygon" && this.selectedAreas.length
        ? ringsWithOff.filter((fr) => this.selectedAreas.includes(fr.area) && fr.ring.length >= 3)
        : undefined;
    const selGeom: Geometry = selRings
      ? { type: "MultiLineString", coordinates: selRings.map((fr) => (it.smooth ? catmullRomClosed(fr.ring as Pt[], 16) : fr.ring)) }
      : it.smooth && f.geometry.type === "LineString"
        ? { type: "LineString", coordinates: catmullRom(f.geometry.coordinates as Pt[], 16) }
        : it.smooth && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
          ? { type: "MultiLineString", coordinates: ringsWithOff.filter((fr) => fr.ring.length >= 3).map((fr) => catmullRomClosed(fr.ring as Pt[], 16)) }
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
    // A lone-POINT spot (a tropopause spot) has no editable shape: its one "vertex" handle only
    // moved it AND sat ON the FL box, hiding the value during a gauge drag. Drop it — the box IS
    // the spot now: drag the box to move the point (see onDown).
    // Area-narrowed selection ⇒ handles for THOSE rings only, roles kept in FLAT indexing
    // (`v${flatStart+i}`) so setVertex/removeVertex address the right vertex.
    if (!isPointMarker(def) && f.geometry.type !== "Point") {
      const groups = selRings
        ? selRings.map((fr) => ({ off: fr.off, verts: openRing(fr.ring) }))
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
    // Slider handles for a list whose items live ON the geometry (jet break points, parameterized
    // by `t`). A `repeat`/stack list is the OPPOSITE: its items are FL cloud LAYERS, edited on the
    // card/gauge — they carry no `t`, so this would plant a stray slider at the path start (vertex 0).
    const lf = !def.repeat ? listFieldOf(def) : undefined;
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

    // Movable line label (0°C isotherm): a control handle sits on the label so it can be
    // slid ALONG the line (its position rides metadata.labelT).
    if (def.movableLabel && f.geometry.type === "LineString") {
      // Handle stays ON the line at labelT — which is the BASE of the lifted label box, so
      // grabbing it never covers the value.
      const { planar, k } = this.renderPath(f.geometry, it);
      const t = typeof f.properties.metadata["labelT"] === "number" ? (f.properties.metadata["labelT"] as number) : 0.5;
      const ll = toLonLat(pointAtFraction(planar, t).p, k);
      buckets["handles"]!.push({
        type: "Feature",
        properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "label" },
        geometry: { type: "Point", coordinates: ll },
      });
    }

    // Front MOVEMENT arrow handles. The arrow roots at fraction `motionT` along the line.
    if (def.motionArrow && f.geometry.type === "LineString") {
      const { planar, k } = this.renderPath(f.geometry, it);
      const motionT = typeof f.properties.metadata["motionT"] === "number" ? (f.properties.metadata["motionT"] as number) : 0.5;
      const root = pointAtFraction(planar, motionT).p;
      // BASE handle, ON the line at the root: drag along the front to place the arrow (→ motionT).
      // Always shown while selected (even at speed 0) — it carries the vertical speed slider's 0 and
      // lets the arrow be positioned before the speed is raised.
      buckets["handles"]!.push({
        type: "Feature",
        properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "motionRoot" },
        geometry: { type: "Point", coordinates: toLonLat(root, k) },
      });
      // TIP handle on the arrowhead — only when the arrow is visible (speed > 0). Same root +
      // `MOTION_ARROW_PX` length as the decorator, so it lands on the tip; drag re-aims motionDir.
      if ((Number(f.properties.metadata["motionSpeed"]) || 0) > 0) {
        const dirDeg = typeof f.properties.metadata["motionDir"] === "number" ? (f.properties.metadata["motionDir"] as number) : 0;
        const rad = (dirDeg * Math.PI) / 180; // compass bearing (0° = north, clockwise)
        const len = resolution > 0 ? resolution * MOTION_ARROW_PX : 0;
        const tip = toLonLat([root[0] + Math.sin(rad) * len, root[1] + Math.cos(rad) * len], k);
        buckets["handles"]!.push({
          type: "Feature",
          properties: { layer: "handles", hClass: "control", featureId: this.selectedId, role: "motion" },
          geometry: { type: "Point", coordinates: tip },
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
    if (ev.key === "Escape" && this.erasing) {
      ev.preventDefault();
      this.erasing = null;
      this.adapter.setCursor("");
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

  /** Fixed obstacle rects (screen px) for the call-out placement: point markers (volcano/TC/
   *  radioactive) own their dropped spot — cartouches must NEVER cover them, so they're seeded as
   *  immovable obstacles (auto cartouches route around; a dropped one is nudged clear, see below). */
  private markerObstacleRects(): Rect[] {
    const out: Rect[] = [];
    for (const id of this.order) {
      const f = this.doc.get(id);
      if (!f || f.geometry.type !== "Point" || !isPointMarker(this.registry.get(f.properties.phenomenon))) continue;
      const px = this.adapter.project({ lon: f.geometry.coordinates[0]!, lat: f.geometry.coordinates[1]! });
      if (!px) continue;
      const name = String(f.properties.metadata["name"] ?? "");
      const w = Math.max(64, name.length * 8 + 20);
      out.push({ x: px[0] - w / 2, y: px[1] - 32, w, h: 64 });
    }
    return out;
  }

  /** A cartouche just DROPPED (drag-release) YIELDS to fixed elements: if its dropped box covers a
   *  point marker OR another pinned cartouche, bump its pin to the nearest free slot so the fixed one
   *  stays visible. (Auto-placed cartouches already flee from this — now pinned — one next pass; only
   *  the fixed ones it must not cover.) */
  private nudgePinClear(featureId: string, labelId: string): void {
    const req = this.lastAnnReqs.find((r) => r.featureId === featureId && r.labelId === labelId)
      ?? this.lastAnnReqs.find((r) => r.featureId === featureId);
    if (!req) return;
    const pk = `${req.featureId}:${req.labelId}`;
    const pin = this.pins.get(pk);
    const anchorPx = this.adapter.project(req.anchor);
    if (!pin || !anchorPx) return;
    const { w, h } = estimateBox(req.content, req.textSize);
    const boxPx: [number, number] = [anchorPx[0] + pin.dx, anchorPx[1] + pin.dy];
    const fixed = this.markerObstacleRects();
    // Every OTHER pinned cartouche is fixed too (placed by hand before this drop) ⇒ don't cover it.
    for (const [k, p] of this.pins) {
      if (k === pk) continue;
      const r = this.lastAnnReqs.find((x) => `${x.featureId}:${x.labelId}` === k);
      const a = r ? this.adapter.project(r.anchor) : null;
      if (!r || !a) continue;
      const bs = estimateBox(r.content, r.textSize);
      fixed.push({ x: a[0] + p.dx - bs.w / 2, y: a[1] + p.dy - bs.h / 2, w: bs.w, h: bs.h });
    }
    const clear = nudgeClear(boxPx, w, h, fixed);
    if (clear[0] !== boxPx[0] || clear[1] !== boxPx[1]) {
      this.pins.set(pk, { dx: clear[0] - anchorPx[0], dy: clear[1] - anchorPx[1] });
    }
  }

  private onDown(ev: PointerEvent): void {
    // Ctrl/⌘ + click on an erasable area digs even if the hover arm never caught (or caught a
    // different feature) — resolve the target from the click itself. Robust to engines that
    // flicker the fill hit-test (OpenLayers): the click is the source of truth.
    if (eraserMod(ev)) {
      const fid = this.erasableFeatureAt(ev.hit);
      if (fid && this.erasing?.featureId !== fid)
        this.erasing = { featureId: fid, r: this.brushRadiusPx(fid), lastPx: null, viaCtrl: true };
    }
    if (this.erasing) {
      const px = this.adapter.project(ev.lngLat);
      if (px) {
        this.erasing.lastPx = px;
        // Modifier-armed: lock ALL navigation (a modified drag would otherwise rotate the map);
        // button-armed: pan-off is enough. Restored on release (onUp).
        if (this.erasing.viaCtrl) this.adapter.setInteractive(false);
        else this.adapter.setPanEnabled(false);
        this.eraseStep(px, px); // a tap punches a round hole right away
      }
      return;
    }
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
      } else if (hClass === "control" && role === "anchor") {
        this.dragTarget = { kind: "anchor", featureId, area: Number(hit.props["area"] ?? 0) };
      } else if (hClass === "control" && role === "label") {
        this.dragTarget = { kind: "labelslide", featureId };
      } else if (hClass === "control" && role === "motion") {
        this.dragTarget = { kind: "frontMotion", featureId };
      } else if (hClass === "control" && role === "motionRoot") {
        this.dragTarget = { kind: "frontMotionRoot", featureId };
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
      const cf = this.doc.get(featureId);
      if (cf?.geometry.type === "Point") {
        // A SPOT's box IS the spot (it sits centered on the point; the vertex handle is gone):
        // dragging the box MOVES the point itself. A plain tap still just selects (onClick).
        if (featureId !== this.selectedId) this.select(featureId);
        this.dragTarget = { kind: "translate", featureId, lastPx: this.adapter.project(ev.lngLat) ?? [0, 0] };
      } else {
        this.dragTarget = { kind: "callout", featureId, labelId: String(hit.props["labelId"] ?? "l"), grab: this.calloutGrab(featureId, ev.lngLat) };
      }
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
      const wid = hit.props["id"] as string;
      const fid = widgetFeatureId(wid);
      // The arrow-tip "draw" badge IS the anchor control: a DRAG re-aims the tip (area 0,
      // same as grabbing the orange handle it covers), a plain TAP (onUp) enters append-draw.
      // So the centered badge never blocks the very re-aim it sits on.
      if (wid.endsWith("#draw")) {
        if (fid !== this.selectedId) this.select(fid);
        this.dragTarget = { kind: "anchor", featureId: fid, area: 0 };
        this.didDrag = false;
        this.adapter.setPanEnabled(false);
        return;
      }
      const f = this.doc.get(fid);
      if (f) {
        const def = this.registry.get(f.properties.phenomenon);
        if (isPointMarker(def)) {
          if (fid !== this.selectedId) this.select(fid); // point marker: select on DOWN, then move the point
          this.dragTarget = { kind: "translate", featureId: fid, lastPx: this.adapter.project(ev.lngLat) ?? [0, 0] };
        } else {
          // An area card that REPLACES the call-out (selected CB, or an UNSELECTED cloud's composite
          // summary): mirror the canvas call-out box — a DRAG repositions the box, a plain TAP selects
          // (onClick). Do NOT select on DOWN here: for an unselected card that re-renders the widget
          // mid-gesture (summary → edit card), the drag is lost and the gesture misfires as a click.
          const req = this.lastAnnReqs.find((r) => r.featureId === fid);
          this.dragTarget = { kind: "callout", featureId: fid, labelId: req?.labelId ?? "l", grab: this.calloutGrab(fid, ev.lngLat) };
        }
        this.didDrag = false;
        this.adapter.setPanEnabled(false);
      }
    }
  }

  private onMove(ev: PointerEvent): void {
    // Platform modifier (⌘ on Mac / Ctrl on Win-Linux) + hover over an erasable area ARMS the
    // eraser brush (no `−` button); press-drag-release then digs/rubs (onDown/onMove/onUp). The
    // arm is STICKY while the modifier is held and only drops when it's RELEASED — we must NOT
    // disarm just because a hover frame has no erasable hit (OpenLayers flickers the fill hit-test
    // over the interior, which would drop the arm right before the click). (Re)target on any
    // erasable feature hovered; the dig re-resolves from the click and self-corrects off-feature.
    if (this.mode !== "drawing" && !this.erasing?.lastPx) {
      const mod = eraserMod(ev);
      if (!mod) {
        if (this.erasing?.viaCtrl) this.disarmEraser(); // modifier released → exit eraser mode
      } else {
        const fid = this.erasableFeatureAt(ev.hit);
        if (fid && this.erasing?.featureId !== fid)
          this.erasing = { featureId: fid, r: this.brushRadiusPx(fid), lastPx: null, viaCtrl: true };
        // hit-less frame while the modifier is held → keep the current arm (no disarm)
      }
    }
    if (this.erasing) {
      this.adapter.setCursor("crosshair");
      // Track the pointer: the brush footprint is PROJECTED on the map (renderAll), so the
      // forecaster sees exactly what a rub will gnaw.
      const cpx = this.adapter.project(ev.lngLat);
      if (cpx) {
        this.erasing.cursorPx = cpx;
        this.scheduleRender();
      }
      if (this.erasing.lastPx) {
        const cur = this.adapter.project(ev.lngLat);
        // Gnaw LIVE: one brush capsule per decimated step (≥ r/3 px of travel).
        if (cur && Math.hypot(cur[0] - this.erasing.lastPx[0], cur[1] - this.erasing.lastPx[1]) > this.erasing.r / 3) {
          this.eraseStep(this.erasing.lastPx, cur);
          this.erasing.lastPx = cur;
        }
      }
      return;
    }
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
    if (t.kind === "labelslide") {
      // Slide the placed label ALONG the line: project the cursor onto the curve → labelT.
      if (f.geometry.type !== "LineString") return;
      const { planar, k } = this.renderPath(f.geometry, interactionOf(this.registry.get(f.properties.phenomenon)));
      const tt = projectToFraction(planar, toPlanar([ev.lngLat.lon, ev.lngLat.lat], k));
      f.properties.metadata["labelT"] = Math.min(0.98, Math.max(0.02, tt));
      this.didDrag = true;
      this.scheduleRender();
      return;
    }
    if (t.kind === "frontMotionRoot") {
      // Slide the arrow's ROOT along the front: project the cursor onto the curve → motionT.
      if (f.geometry.type !== "LineString") return;
      const { planar, k } = this.renderPath(f.geometry, interactionOf(this.registry.get(f.properties.phenomenon)));
      const tt = projectToFraction(planar, toPlanar([ev.lngLat.lon, ev.lngLat.lat], k));
      f.properties.metadata["motionT"] = Math.min(0.98, Math.max(0.02, tt));
      this.didDrag = true;
      this.scheduleRender();
      return;
    }
    if (t.kind === "frontMotion") {
      // Re-aim the front's movement arrow: COMPASS bearing from the ROOT (`motionT`) to the cursor
      // (0° = due north, clockwise) — atan2(east, north) in the planar frame (x = east, y = north).
      if (f.geometry.type !== "LineString") return;
      const { planar, k } = this.renderPath(f.geometry, interactionOf(this.registry.get(f.properties.phenomenon)));
      const motionT = typeof f.properties.metadata["motionT"] === "number" ? (f.properties.metadata["motionT"] as number) : 0.5;
      const root = pointAtFraction(planar, motionT).p;
      const cur = toPlanar([ev.lngLat.lon, ev.lngLat.lat], k);
      const deg = (Math.atan2(cur[0] - root[0], cur[1] - root[1]) * 180) / Math.PI;
      f.properties.metadata["motionDir"] = (Math.round(deg) + 360) % 360;
      this.didDrag = true;
      this.scheduleRender();
      return;
    }
    if (t.kind === "vertex") {
      if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
        // Constrain the zone to a SIMPLE polygon: apply the move, but undo it if it makes
        // an edge cross another (the vertex then "sticks" at the edge of validity).
        // Multi-area: the guard checks the ring the dragged FLAT index belongs to.
        const g = f.geometry;
        const hit = ringOfFlat(g, t.index); // the precise ring — outer OR hole
        const v = hit?.ring[hit.local];
        const prev = v ? ([...v] as Position) : null;
        setVertex(g, t.index, [ev.lngLat.lon, ev.lngLat.lat]);
        if (prev && hit && !isSimpleRing(hit.ring as Pt[])) setVertex(g, t.index, prev);
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
    } else if (t.kind === "callout") {
      // Match the annReq by featureId+labelId, FALLING BACK to featureId only: a sprite call-out's hit
      // may report a default labelId ("l") that differs from the call-out's ("cb"/"turb"). KEY the pin
      // by the FOUND req's own id (not `t.labelId`), else `placeAnnotations` (which looks up
      // `featureId:labelId`) never finds the pin → a dead pin → the drag has no effect.
      const req = this.lastAnnReqs.find((r) => r.featureId === t.featureId && r.labelId === t.labelId)
        ?? this.lastAnnReqs.find((r) => r.featureId === t.featureId);
      const anchorPx = req ? this.adapter.project(req.anchor) : null;
      const cursorPx = this.adapter.project(ev.lngLat);
      // Place the box centre at (cursor − grab) so the grabbed spot stays under the cursor
      // (no first-move jump), then express that as the pin offset from the anchor.
      if (req && anchorPx && cursorPx) {
        const pk = `${req.featureId}:${req.labelId}`;
        this.pins.set(pk, { dx: cursorPx[0] - t.grab[0] - anchorPx[0], dy: cursorPx[1] - t.grab[1] - anchorPx[1] });
        if (this.autoPinKey === pk) this.autoPinKey = null; // user took over → keep this pin sticky
      }
    } else if (t.kind === "anchor") {
      // Move ONE leader anchor (this area's arrow tip) — kept inside ITS zone AND outside
      // its erased holes (the tip must always point at cloud).
      const areas = areaRings(f.geometry).filter((ar) => ar.outer.length >= 3);
      const area = areas[t.area] ?? areas[0];
      if (area) {
        const tips = this.anchorPins.get(t.featureId) ?? [];
        tips[t.area] = clampInArea([ev.lngLat.lon, ev.lngLat.lat], area);
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
    if (this.erasing?.lastPx) {
      this.erasing.lastPx = null; // stay in eraser mode (Escape exits) — rub again for gruyère
      if (this.erasing.viaCtrl) this.adapter.setInteractive(true);
      else this.adapter.setPanEnabled(true);
      if (this.doc.has(this.erasing.featureId)) {
        this.emitChange(); // ONE change event per rub (the gnawing itself was live)
        this.emitMetadata();
      }
      return;
    }
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
    // A cartouche dropped on top of a FIXED element (marker / another pinned cartouche) yields:
    // bump its pin clear before the repaint so it never covers the fixed one.
    if (dragged && t.kind === "callout") this.nudgePinClear(t.featureId, t.labelId);
    // (The old tap-a-glyph/box enum cycle is gone — enums are edited on the SELECTED
    // card's carousel control; a plain tap just selects, via onClick.)
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
    // A plain TAP on the arrow-tip "draw" badge → enter append-draw (a DRAG re-aimed the tip
    // instead, and already returned at the didDrag guard above).
    if (ev.hit?.overlay === "widget" && String(ev.hit.props["id"] ?? "").endsWith("#draw")) {
      this.drawMore(widgetFeatureId(String(ev.hit.props["id"])));
      return;
    }
    // A tap on a card whose feature is ALREADY selected switches the FOCUS between the zone card and
    // a composite card (the non-convective cloud's icing/turb) — so you move from one to the other.
    if (ev.hit?.overlay === "widget") {
      const wid = String(ev.hit.props["id"] ?? "");
      const wfid = widgetFeatureId(wid);
      const wf = wfid === this.selectedId ? this.doc.get(wfid) : undefined;
      if (wf) {
        const part = wid.split("#")[1];
        const isComposite = part != null && (this.registry.get(wf.properties.phenomenon).composites ?? []).some((c) => c.key === part);
        if (isComposite) {
          if (this.focusedComposite !== part) this.focusComposite(wfid, part!);
          return;
        }
        if (this.focusedComposite != null) {
          this.focusZone(wfid);
          return;
        }
      }
    }
    // A widget card hit carries its feature id as `id`; every other overlay uses `featureId`.
    const fid = ev.hit?.overlay === "widget" ? widgetFeatureId(String(ev.hit.props["id"] ?? "")) : ev.hit?.props["featureId"];
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
      // FL bounds: schema (profile-injected via `withLimits`) → chart `vertical` →
      // the WAFS engine fallback — the same chain as `flResolved`.
      if (f && f.type === "fl") return { min: f.min ?? this.vertical?.min ?? 250, max: f.max ?? this.vertical?.max ?? 600 };
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
    // Per-phenomenon bounds win; the chart `vertical` (profile) is the fallback — THE
    // FL-bounds source of the descriptor model (a descriptor never carries chart bounds).
    const c = this.phenomena[type]?.flightLevel;
    const min = c?.min ?? this.vertical?.min;
    const max = c?.max ?? this.vertical?.max;
    return {
      ...(min != null ? { min } : {}),
      ...(max != null ? { max } : {}),
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
  /** Pull every FL default into the profile's FL range so a placement never starts BEYOND the
   *  chart (one XXX notch past a bound is allowed — it IS the on-chart way to mark "off the top",
   *  e.g. a CB whose default top is XXX). A stock descriptor carries WAFS-scale defaults (base
   *  250 / top 400); a low-level profile (TEMSI France, ceiling FL150) needs them clamped via
   *  `flGaugeRange` (per-field, XXX-notch-aware). No-op when no `vertical` is set, or when the
   *  descriptor defaults already fit (the JSON is the source — coherent defaults bypass this). */
  private clampFlDefaults(type: string, metadata: Metadata): void {
    if (!this.vertical) return;
    const cl = (key: string, x: unknown): unknown => {
      if (typeof x !== "number") return x;
      const { lo, hi } = this.flGaugeRange(type, key);
      return Math.max(lo, Math.min(hi, x));
    };
    for (const s of this.registry.get(type).schema) {
      if (s.type === "fl") metadata[s.key] = cl(s.key, metadata[s.key]);
      else if (s.type === "list" && Array.isArray(metadata[s.key])) {
        for (const it of metadata[s.key] as Metadata[])
          for (const x of s.itemSchema) if (x.type === "fl") it[x.key] = cl(x.key, it[x.key]);
      }
    }
  }

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

  /** Unfold a chart profile onto the instance — the EXPLICIT options winning (per
   *  phenomenon for `phenomena`, wholesale for `callouts`). Then the profile
   *  INGESTION (the single-unit model, descriptor spec §2b): the inline atlas glyphs
   *  merge FIRST (an inline descriptor may reference `atlas:` names shipped in the
   *  same file), then every `objects` entry — stock name / `extends` patch / full
   *  inline descriptor — compiles through the interpreter and registers over the
   *  built-ins. A profile is pure JSON: behaviour arrives by NAME only. */
  private applyProfile(profile: SigwxProfile, opts: SigwxDrawOptions): void {
    this.profileId = profile.id;
    this.profileTools = profile.tools;
    this.vertical = profile.vertical;
    this.profileAreas = profile.areas;
    // RE-ENTRANT (setProfile calls this again): rebuild the registry so a REMOVED object
    // disappears. A profile WITH `objects` defines the FULL palette — start empty, it
    // fills it (the profile is self-sufficient). No `objects` ⇒ the legacy built-in
    // registry. An injected `opts.registry` always wins.
    this.registry = opts.registry ?? (profile.objects?.length ? new PhenomenonRegistry() : defaultRegistry());
    for (const k of Object.keys(this.phenomena)) delete this.phenomena[k];
    Object.assign(this.phenomena, profile.phenomena, opts.phenomena);
    this.calloutFraction = opts.callouts?.minZoneFraction ?? profile.callouts?.minZoneFraction ?? 0.15;
    if (profile.glyphs) registerExtensions({ glyphs: profile.glyphs });
    for (const spec of profile.objects ?? []) {
      this.registry.register(defFromDescriptor(resolveObjectSpec(spec, mergeDescriptor)));
    }
  }

  /**
   * Re-ingest a (modified) profile LIVE — recompiles its descriptors / glyphs / tools /
   * bounds and re-renders, KEEPING the drawn document. This is the single modification
   * path: the profile is the source of truth, so to change anything (a colour, an FL, a
   * leader…) you edit the profile object and re-inject it — no second, granular API.
   *
   * Features whose phenomenon the new profile no longer defines are DROPPED (with a
   * console warning) so the document stays consistent; everything else is re-decorated
   * with the new descriptors. The map view and the (still-valid) selection are preserved.
   */
  /** The fixed chart areas declared by the active profile (empty for a non-area profile). */
  get areas(): ChartArea[] {
    return this.profileAreas ?? [];
  }

  /** The area `setArea` last applied (`null` = none). */
  get area(): string | null {
    return this.activeAreaId;
  }

  /**
   * Frame the map on a fixed ICAO chart area and switch to its projection, drawing a dashed
   * frame around it. Accepts either:
   *  - a **string** id → resolved against the profile's `areas`;
   *  - a full **{@link ChartArea}** object → used as-is (an ad-hoc area NOT in the profile, with
   *    its own `extent` + `projection`);
   *  - **`null`** (or an unknown id, or a profile with no `areas`) → clears the frame and resets
   *    to Mercator.
   *
   * Non-mercator projections apply ONLY on adapters that can reproject (OpenLayers); MapLibre
   * and Leaflet stay Mercator (the adapter no-ops a `proj4` spec there with one warning).
   */
  setArea(area: string | ChartArea | null): void {
    const resolved: ChartArea | null =
      area == null ? null : typeof area === "string" ? this.profileAreas?.find((x) => x.id === area) ?? null : area;
    this.activeAreaId = resolved?.id ?? null;
    if (!resolved) {
      this.adapter.setProjection("mercator");
      this.adapter.highlightArea(null);
      return;
    }
    const p = resolved.projection;
    this.adapter.setProjection(p.kind === "mercator" ? "mercator" : { kind: "proj4", code: p.code, def: p.def });
    this.adapter.viewArea(resolved.extent);
    this.adapter.highlightArea(resolved.extent);
  }

  setProfile(profile: SigwxProfile): void {
    this.applyProfile(profile, this.opts);
    // Drop orphans (a type the new profile removed) — else the renderer can't decorate them.
    const orphanIds = [...this.doc.entries()]
      .filter(([, f]) => !this.registry.has(f.properties.phenomenon))
      .map(([id]) => id);
    if (orphanIds.length) {
      const types = [...new Set(orphanIds.map((id) => this.doc.get(id)!.properties.phenomenon))];
      console.warn(`[sigwx] setProfile dropped ${orphanIds.length} feature(s) of removed type(s): ${types.join(", ")}`);
      for (const id of orphanIds) this.doc.delete(id);
      this.order = this.order.filter((id) => !orphanIds.includes(id));
      if (this.selectedId && !this.doc.has(this.selectedId)) this.selectedId = null;
    }
    this.resolved.clear(); // styles re-resolve from the new descriptors
    if (this.opts.toolbar) this.buildToolbar(this.opts.toolbar === true ? {} : this.opts.toolbar);
    this.renderAll();
    this.emitSelect(); // refresh the selected card (new bounds/style/options)
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
    const toolSpecs: ToolSpec[] | undefined = options.tools ?? this.profileTools; // explicit > profile > every registered def
    const defOf = (t: string): PhenomenonDef | undefined => all.find((d) => d.type === t);
    const drawItem = (def: PhenomenonDef, top: boolean): ToolbarItem => ({
      id: def.type,
      title: def.label,
      ...(def.icon ? { svg: def.icon } : {}),
      ...(top ? { toggle: true } : {}),
      onClick: () => this.draw(def.type),
    });
    const items: ToolbarItem[] = [];
    if (toolSpecs?.some((t) => typeof t !== "string")) {
      // DECLARATIVE palette (profile v2, spec §2d): a string is a draw button; a `{ group,
      // items }` entry is a submenu, and its `items` may themselves be groups → NESTED
      // submenus (any depth). No auto-grouping here — the profile says exactly what it wants.
      const dress = (icon: string): string =>
        !/\bwidth=/.test(icon) ? icon.replace("<svg", "<svg width='22' height='22'") : icon;
      const buildSpec = (t: ToolSpec, top: boolean): ToolbarItem | null => {
        if (typeof t === "string") {
          const def = defOf(t);
          return def ? drawItem(def, top) : null;
        }
        const children = t.items.map((it) => buildSpec(it, false)).filter((i): i is ToolbarItem => !!i);
        if (!children.length) return null;
        const icon = t.icon ? resolveGlyph(t.icon) : children[0]?.svg; // explicit, else first child's
        return {
          id: t.group.toLowerCase().replace(/\s+/g, "-"),
          title: t.group,
          ...(icon ? { svg: dress(icon) } : {}),
          toggle: t.toggle ?? true,
          children,
        };
      };
      for (const t of toolSpecs) {
        const item = buildSpec(t, true);
        if (item) items.push(item);
      }
    } else {
      const flat = toolSpecs as string[] | undefined;
      const defs = flat ? flat.map(defOf).filter((d): d is PhenomenonDef => !!d) : all;
      // FLAT (legacy) list: the point markers (TC / volcano / radioactive — less common)
      // are auto-grouped into ONE split-button submenu (toggle): hover reveals the set,
      // the trigger mirrors the last-picked marker and re-draws it on click; picking a
      // child adopts it. Everything else stays a flat toggle button, in order.
      const markerDefs = defs.filter(isPointMarker);
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

/** A widget id back to its FEATURE id (multi-card builders suffix `featureId#part`). */
const widgetFeatureId = (id: string): string => id.split("#")[0]!;

/** The ✕ glyph for a composite card's delete button (top-right corner). `currentColor`. */
const COMPOSITE_DELETE_SVG =
  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round'><path d='M7 7 L17 17 M17 7 L7 17'/></svg>";

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

/** Every editable RING of a polygonal geometry — outer + HOLES (eraser clear zones),
 *  area by area. The FLAT vertex indexing (vertices()/setVertex/removeVertex/`v${i}`
 *  roles) walks them ALL, so hole vertices edit exactly like outer ones. */
function flatRings(geom: Geometry): { area: number; poly: Position[][]; ringIndex: number; ring: Position[] }[] {
  if (geom.type === "Polygon") return geom.coordinates.map((ring, ringIndex) => ({ area: 0, poly: geom.coordinates, ringIndex, ring }));
  if (geom.type === "MultiPolygon") return geom.coordinates.flatMap((poly, area) => poly.map((ring, ringIndex) => ({ area, poly, ringIndex, ring })));
  return [];
}


/** Resolve a FLAT vertex index to its ring — outer or hole — plus the local index. */
function ringOfFlat(geom: Geometry, i: number): { area: number; poly: Position[][]; ringIndex: number; ring: Position[]; local: number } | null {
  let off = i;
  for (const fr of flatRings(geom)) {
    const n = openRing(fr.ring).length;
    if (off < n) return { ...fr, local: off };
    off -= n;
  }
  return null;
}

/** Editable vertices, FLAT across areas AND their holes (`v${i}` roles, setVertex/
 *  removeVertex share the same flat indexing). */
function vertices(geom: Geometry): Position[] {
  if (geom.type === "LineString") return geom.coordinates;
  if (geom.type === "Point") return [geom.coordinates];
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") return flatRings(geom).flatMap((fr) => openRing(fr.ring));
  return [];
}

function outline(geom: Geometry): Geometry {
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") return { type: "MultiLineString", coordinates: flatRings(geom).map((fr) => fr.ring) };
  return geom;
}

function setVertex(geom: Geometry, i: number, p: Position): void {
  if (geom.type === "Point") {
    geom.coordinates = p;
  } else if (geom.type === "LineString") {
    if (geom.coordinates[i]) geom.coordinates[i] = p;
  } else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    const hit = ringOfFlat(geom, i); // flat index → ring (outer OR hole) + local
    if (!hit || !hit.ring[hit.local]) return;
    hit.ring[hit.local] = p;
    if (hit.local === 0 && hit.ring.length > 1) hit.ring[hit.ring.length - 1] = p;
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
