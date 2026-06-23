/**
 * The central SIGWX abstraction: a **data-driven phenomenon registry**.
 *
 * Each phenomenon is declared once as a {@link PhenomenonDef} — its geometry
 * primitive + draw constraints, its metadata {@link FieldSchema}, its
 * {@link DecorateFn} (the heart: base geometry + metadata → derived render
 * features) and its {@link PhenomenonStyle}. The controller, the form layer and
 * the render pipeline all read from the def, so adding a phenomenon never touches
 * the controller — you just `registry.register(def)`.
 *
 * This module is PURE (no DOM/map): everything here is unit-testable map-free.
 */
import type { MarkerWidget } from "@softwarity/draw-adapter";
import type { Feature, Geometry } from "geojson";

import type { LatLng } from "./coord.js";
import type { PhenomenonStyle } from "./style.js";

/** The geometry the forecaster draws for a phenomenon. */
export type GeometryPrimitive = "point" | "polyline" | "polygon";

/**
 * The render overlays a {@link DecorateFn} can target, tagged on each emitted
 * feature via `properties.layer`. The controller batches features by this tag
 * into one overlay per layer. Drawn bottom→top in this order.
 */
export type RenderLayer =
  | "area-fill" // polygon fills (CB / turbulence area)
  | "edge" // the outline stroke (scalloped ring drawn solid; turbulence dashed)
  | "decoration" // derived strokes: wind barbs, arrowheads, change bars, front symbols
  | "symbols" // glyphs (turbulence/icing intensity, volcano, TC, H/L)
  | "annotations" // call-out requests (anchor + content); the controller places them
  | "text-boxes" // placed call-out boxes (output of the placement pass)
  | "leaders"; // leader lines from a placed box back to its anchor

/**
 * Property conventions on a decoration feature (all optional; the adapters read
 * whichever apply to the feature's `layer`). Concrete paint values are baked in
 * by the decorate fn from the {@link PhenomenonStyle}, so the adapters stay dumb.
 */
export interface RenderProps {
  layer: RenderLayer;
  /** Owning chart feature id (set by the controller, used for hit-testing/selection). */
  featureId?: string;
  // area-fill
  fillColor?: string;
  fillOpacity?: number;
  /** Declutter staging: `"late"` chrome (a jet's arrowhead — it carries the DIRECTION)
   *  survives down to HALF the hide threshold, outliving the barbs/labels. */
  declutter?: "late";
  /** A `decoration` feature flagged as an anti-collision OBSTACLE (the jet's barbs + arrowhead) so
   *  auto-placed call-outs route around it (a gabarit estimate — its projected bounding box). */
  obstacle?: boolean;
  // edge / decoration (line)
  stroke?: string;
  strokeWidth?: number;
  /** Present ⇒ draw dashed (turbulence). Absent ⇒ solid. */
  dash?: number[];
  // symbols
  symbol?: string;
  rotation?: number;
  size?: number;
  symbolColor?: string;
  /** Place the call-out glyph INSIDE the box (top), not above it (icing). The content must
   *  carry leading blank lines to reserve its space. */
  symbolInside?: boolean;
  // text-boxes / annotations
  text?: string;
  textColor?: string;
  textSize?: number;
  textHalo?: string;
  textBackground?: string;
  textBorder?: string;
  /** Border width preset for the label box (`small` ≈ 0.8px … default `medium` ≈ 1.4px). */
  textBorderWidth?: "small" | "medium" | "large";
  // annotations (call-out requests): a stable label id per owner, multi-line
  // content, and whether a leader line is drawn back to the anchor.
  labelId?: string;
  content?: string;
  leader?: boolean;
  /** Draw an arrowhead at the anchor end of the call-out leader. */
  arrow?: boolean;
  /** Leader style: "lightning" → a zigzag bolt attaching under the box (convective/CB). */
  leaderStyle?: string;
  kind?: string;
}

export type RenderFeature = Feature<Geometry, RenderProps>;

/** Free-form, schema-validated metadata bag attached to a chart feature. */
export type Metadata = Record<string, unknown>;

/** Input to a {@link DecorateFn}. */
export interface DecorationInput {
  /** The editable base geometry, in lon/lat. */
  geometry: Geometry;
  /** Validated metadata for this feature. */
  metadata: Metadata;
  /** Resolved style for this phenomenon (baked into the emitted features). */
  style: PhenomenonStyle;
  /** Optional map units/px hint for adaptive densification (omitted in tests). */
  resolution?: number;
  /** Effective chart FL range (`phenomena[type].flightLevel`). `beyond[below-min, above-max]`
   *  decides per bound whether an off-chart value renders as "XXX" or is clamped. */
  flightLevel?: { min?: number; max?: number; beyond?: [FlMode, FlMode] } | undefined;
  /** CB-only: `false` → a plain straight leader; `true`/undefined → the lightning-bolt leader. */
  leaderThunderbolt?: boolean | undefined;
  /** True when this feature is the SELECTED one (being edited) — lets a decorator show editing
   *  feedback instead of the final glyph (the front movement arrow labels its DIRECTION in degrees
   *  while selected, its SPEED otherwise). */
  editing?: boolean | undefined;
}

/**
 * Turn base geometry + metadata into derived render features. PURE and
 * engine-agnostic — emits plain GeoJSON tagged via {@link RenderProps}.
 */
export type DecorateFn = (input: DecorationInput) => RenderFeature[];

/** Input to a {@link PhenomenonDef.widget} builder — a point phenomenon whose whole visual is
 *  an inline-editable marker card (TC / volcano / radioactive), not derived render features. */
export interface WidgetInput {
  /** Owning feature id — echoed into the widget's `id`. */
  id: string;
  /** The editable base geometry (a Point), in lon/lat. */
  geometry: Geometry;
  metadata: Metadata;
  /** Selected ⇒ its text becomes an inline `<input>`; else a read-only label. */
  editable: boolean;
  style: PhenomenonStyle;
  /** The feature's placed call-out box (area phenomena with an annotation): its placed
   *  anchor (lon/lat) + the rendered text. Controller-provided AFTER the placement pass —
   *  lets a widget REPLACE the call-out while selected (e.g. CB's `+` control card).
   *  Absent for point markers and before the first placement. */
  callout?: { at: [number, number]; content: string };
  /** Resolve a registered sprite id to its inline SVG (the controller's merged catalogue,
   *  host extensions included) — lets a widget build GLYPH carousel options (the
   *  turbulence/icing severity pickers). */
  sprite?: (id: string) => string | undefined;
  /** Resolved chart FL bounds + off-chart behaviour (same shape the decorate receives) —
   *  feeds the card's FL gauge (min/max, the "XXX" beyond notches, cursor labels). */
  flightLevel?: { min?: number; max?: number; beyond?: [string, string] };
  /** Selected SUB-ITEM index of the feature's list field (a jet break point) — lets the
   *  builder raise the per-point editor card. Absent ⇒ no sub-selection. */
  sub?: number;
  /** Resolved numeric bounds of a schema field (config over schema, e.g. the jet speed
   *  dial range) — the controller's `numLimit`. */
  limit?: (key: string) => { min: number; max: number };
  /** FL the gauge is centred on, captured at SELECTION time (stable during drags) — pins
   *  the gauge card so the reference level sits at the anchor's screen height. */
  flRef?: number;
  /** The editing-chrome styles (`SigwxStyle.control`) — gauges/dials wear them: `line.color`
   *  = track/arc ink, `text` = label colour + halo, `handle` = knob fill/stroke. */
  chrome?: { line?: { color?: string }; handle?: { fill?: string; stroke?: string }; text?: { color?: string; halo?: string } };
}

// ── Metadata schema ────────────────────────────────────────────────────────

interface FieldBase {
  key: string;
  label: string;
  /** Hidden (and skipped by validation) unless this predicate passes. */
  visibleWhen?: (m: Metadata) => boolean;
  required?: boolean;
}
export interface NumberField extends FieldBase {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default?: number;
}
/** What happens when an FL is dragged past a chart bound: hard-stop (`clamp`), or allow
 *  it off-chart and render the "XXX" sentinel. Used per bound as `[below-min, above-max]`. */
export type FlMode = "clamp" | "xxx";

/** A flight level (FLnnn), stored as an integer number of hundreds of feet. */
export interface FlightLevelField extends FieldBase {
  type: "fl";
  default?: number;
  /** FL gauge bounds — the on-map cursor clamps here (e.g. the SWH chart's FL250–600).
   *  Overridable per phenomenon via `phenomena[type].flightLevel.{min,max}`. */
  min?: number;
  max?: number;
}

/**
 * An ordered list of sub-records placed ALONG the geometry — e.g. a jet's break
 * points, each at a parametric `t` (0..1) on the curve plus its own fields. The
 * controller renders/edits these via sub-selection.
 */
export interface ListField extends FieldBase {
  type: "list";
  /** Schema for each item (its own fields, e.g. speed/fl/top/base). */
  itemSchema: FieldSchema[];
  /** One-line label for an item in the list UI. */
  itemLabel?: (item: Metadata, index: number) => string;
  default?: Metadata[];
}
/** A compiled enum option: the value + display label, plus opaque `meta` carried from the
 *  descriptor (e.g. a cloud `type`'s per-type FL defaults seeded when a layer is added). */
export interface EnumOption {
  value: string;
  label: string;
  meta?: Record<string, unknown>;
}
export interface EnumField extends FieldBase {
  type: "enum";
  options: EnumOption[];
  default?: string;
  /** Conditional option set: live options depend on another field's value (resolved at render). */
  optionsBy?: { field: string; map: Record<string, EnumOption[]> };
}
export interface BoolField extends FieldBase {
  type: "bool";
  default?: boolean;
}
export interface TextField extends FieldBase {
  type: "text";
  maxLength?: number;
  default?: string;
}

export type FieldSchema =
  | NumberField
  | FlightLevelField
  | EnumField
  | BoolField
  | TextField
  | ListField;

// ── Phenomenon definition ────────────────────────────────────────────────────

/** How the forecaster lays down the geometry. */
export interface InteractionSpec {
  primitive: GeometryPrimitive;
  /** Render the path as a smoothed Catmull-Rom curve (jet). */
  smooth?: boolean;
  /** The path has a direction (arrow at the downstream end). */
  directional?: boolean;
  /**
   * Freehand drawing: press, drag to draw a continuous stroke, release to finish
   * (the stroke is simplified to anchor points). Otherwise the path is laid by
   * clicking points (double-click / Enter to finish).
   */
  freehand?: boolean;
  /** Freehand only: when the finished stroke's on-screen extent is too short to read as a
   *  line (< ~1.5× the FL label box), commit a POINT instead of a path — so a click (or a
   *  tiny drag) drops a spot height and a real drag draws a contour (tropopause). Needs the
   *  def to allow a `"point"` primitive too. */
  pointWhenShort?: boolean;
  /** `"draw"` = a drawn path/area; `"drop"` = a default geometry at the centre. */
  mode: "draw" | "drop";
  /** The area can be "dug" with the eraser (Ctrl/⌘ + hover → brush, click → hole). */
  erasable?: boolean;
}

export interface DrawSpec {
  minVertices?: number;
  maxVertices?: number;
  /** Polygon (closed ring) vs open polyline. Ignored for points. */
  closed?: boolean;
  /** Interaction model. Defaults are derived from `primitives[0]` if omitted. */
  interaction?: InteractionSpec;
  /** Geometry dropped at the view centre (drop mode, or as a draw-mode fallback).
   *  `viewSpan` is a rough lon/lat span of the current view for sizing. */
  defaultGeometry?: (center: LatLng, viewSpan: number) => Geometry;
}

export interface PhenomenonDef {
  type: string;
  label: string;
  /** Optional inline SVG for the toolbar button (falls back to a short text label). */
  icon?: string;
  /** Allowed draw primitive(s); the first is the default. */
  primitives: GeometryPrimitive[];
  draw: DrawSpec;
  /** Ordered → drives the form field order. */
  schema: FieldSchema[];
  /** geometry + metadata → derived decoration features. The heart of SIGWX. */
  decorate: DecorateFn;
  /** Build the feature's DOM card(s) — a point marker (TC / volcano / radioactive), a
   *  transient control panel (CB's `+` card), or SEVERAL cards (the jet's dial + gauge —
   *  ids suffixed `featureId#part`; every widget event strips the suffix back to the
   *  feature). Return `null` to emit nothing for the current state (e.g. unselected). */
  widget?: (input: WidgetInput) => MarkerWidget | MarkerWidget[] | null;
  /** Picker fields flagged `open` (quick-pick): editing one DESELECTS the feature — the WMO symbol
   *  stamp (pick the symbol and you're done). The controller deselects in `onWidgetEdit`. */
  closeOnPick?: ReadonlySet<string>;
  /** Default per-phenomenon style (host can override via the aggregate style). */
  style: PhenomenonStyle;
  /** Optional one-line human summary (label/tooltip). */
  summary?: (m: Metadata) => string;
  /** Default off-chart behaviour for this phenomenon's FL bounds `[below-min, above-max]`
   *  (areas → `["xxx","xxx"]`; the jet → `["clamp","clamp"]`). Overridable via config. */
  flBeyond?: [FlMode, FlMode];
  /** LINE phenomena: the placed label can be slid ALONG the line (a drag handle shows while
   *  selected). Position rides `metadata.labelT` (fraction 0–1). Set from `render.line.label.movable`. */
  movableLabel?: boolean;
  /** LINE phenomena (the fronts): a movement arrow rooted at the line midpoint, aimed by
   *  `metadata.motionDir` (planar bearing, degrees) and sized by `metadata.motionSpeed` (kt — hidden
   *  at 0). While selected the controller paints a 360° drag handle on the arrow tip (role "motion")
   *  that writes `motionDir`; the speed rides a feature-level dial. Set from a `front-symbols`
   *  decoration flagged `"motion": true`. */
  motionArrow?: boolean;
  /** Multi-layer cloud-area editor (the TEMSI cloud-layer area): the named LIST field is edited as
   *  the active layer's flat card + a side multi-range FL gauge (one band per layer). The controller
   *  reads `listField`/`min`/`max` to route add/remove/select and keep the list altitude-sorted.
   *  Set from the descriptor `repeat`. */
  repeat?: { listField: string; min: number; max: number };
  /** A card action button RELOCATED to the feature's arrow-tip anchor (a floating DOM badge
   *  on the map) instead of a card edge — set from a descriptor card button with `place: "anchor"`.
   *  The controller emits it at the selected area's primary arrow tip (where the leader points),
   *  firing `event` via `onWidgetAction`. `draw_and_link` → re-enter draw to append another area. */
  anchorButton?: { event: string; svg: string; title?: string };
  /** Zone-level composites (the non-convective cloud's icing/turbulence): each `{ key, ref, place }`
   *  stores a `{ symbol, baseFL, topFL }` sub-object at `metadata[key]`, edited on its own card
   *  (glued above/below the zone card) reusing the `ref` phenomenon's def. Set from descriptor
   *  `composites`. */
  composites?: { key: string; ref: string; place: "top" | "bottom" }[];
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class PhenomenonRegistry {
  private readonly defs = new Map<string, PhenomenonDef>();

  constructor(defs: PhenomenonDef[] = []) {
    for (const d of defs) this.register(d);
  }

  register(def: PhenomenonDef): void {
    this.defs.set(def.type, def);
  }

  get(type: string): PhenomenonDef {
    const def = this.defs.get(type);
    if (!def) throw new Error(`Unknown SIGWX phenomenon: "${type}"`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  all(): PhenomenonDef[] {
    return [...this.defs.values()];
  }
}

// ── Schema helpers (used by the controller + form) ───────────────────────────

/** The effective interaction model for a phenomenon (explicit, or derived). */
export function interactionOf(def: PhenomenonDef): InteractionSpec {
  if (def.draw.interaction) return def.draw.interaction;
  const primitive = def.primitives[0] ?? "polygon";
  return { primitive, mode: primitive === "point" ? "drop" : "draw" };
}

/** Default metadata for a phenomenon, from its schema's `default`s. */
export function defaultMetadata(def: PhenomenonDef): Metadata {
  const m: Metadata = {};
  for (const f of def.schema) {
    if (f.type === "list") m[f.key] = f.default ? f.default.map((it) => ({ ...it })) : [];
    else if ("default" in f && f.default !== undefined) m[f.key] = f.default;
    else if (f.type === "bool") m[f.key] = false;
  }
  return m;
}

/** Is a field currently visible given the metadata (evaluates `visibleWhen`)? */
export function isVisible(field: FieldSchema, m: Metadata): boolean {
  return field.visibleWhen ? field.visibleWhen(m) : true;
}

/** Validate metadata against a schema. Returns `{ key: message }` for errors
 *  (empty object = valid). Hidden fields (`visibleWhen` false) are skipped. */
export function validate(def: PhenomenonDef, m: Metadata): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of def.schema) {
    if (!isVisible(f, m)) continue;
    const v = m[f.key];
    const missing = v === undefined || v === null || v === "";
    if (f.required && missing) {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (missing) continue;
    if ((f.type === "number" || f.type === "fl") && typeof v === "number") {
      if (f.type === "number" && f.min !== undefined && v < f.min) errors[f.key] = `${f.label} ≥ ${f.min}`;
      if (f.type === "number" && f.max !== undefined && v > f.max) errors[f.key] = `${f.label} ≤ ${f.max}`;
    }
    if (f.type === "enum" && !f.options.some((o) => o.value === v)) {
      errors[f.key] = `Invalid ${f.label}`;
    }
  }
  return errors;
}
