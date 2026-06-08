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
  // text-boxes / annotations
  text?: string;
  textColor?: string;
  textSize?: number;
  textHalo?: string;
  textBackground?: string;
  textBorder?: string;
  // annotations (call-out requests): a stable label id per owner, multi-line
  // content, and whether a leader line is drawn back to the anchor.
  labelId?: string;
  content?: string;
  leader?: boolean;
  /** Draw an arrowhead at the anchor end of the call-out leader. */
  arrow?: boolean;
  /** Schema enum key to cycle when the call-out BOX is tapped (on-map carousel) — used when
   *  the coverage/type lives in the box text itself (CB) rather than a separate glyph. */
  cycleField?: string;
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
}

/**
 * Turn base geometry + metadata into derived render features. PURE and
 * engine-agnostic — emits plain GeoJSON tagged via {@link RenderProps}.
 */
export type DecorateFn = (input: DecorationInput) => RenderFeature[];

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
export interface EnumField extends FieldBase {
  type: "enum";
  options: { value: string; label: string }[];
  default?: string;
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
  /** `"draw"` = a drawn path/area; `"drop"` = a default geometry at the centre. */
  mode: "draw" | "drop";
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
  /** Default per-phenomenon style (host can override via the aggregate style). */
  style: PhenomenonStyle;
  /** Optional one-line human summary (label/tooltip). */
  summary?: (m: Metadata) => string;
  /** Default off-chart behaviour for this phenomenon's FL bounds `[below-min, above-max]`
   *  (areas → `["xxx","xxx"]`; the jet → `["clamp","clamp"]`). Overridable via config. */
  flBeyond?: [FlMode, FlMode];
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
