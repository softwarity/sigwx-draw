/**
 * `defFromDescriptor` — the INTERPRETER. Compiles a pure-JSON
 * {@link PhenomenonDescriptor} into a {@link PhenomenonDef} registered like any
 * hand-written def: the engine (controller, placement, declutter, multi-area,
 * selection) never knows the difference. Anything behavioural resolves through
 * the named-extension registries at COMPILE time, so unknown names fail fast
 * with the available ones listed.
 */
import type { BoxShape, MarkerWidget, WidgetNode } from "@softwarity/draw-adapter";
import type { Geometry } from "geojson";

import {
  add,
  areaRings,
  catmullRom,
  catmullRomClosed,
  coordsOf,
  frameK,
  inwardTicks,
  lineFeature,
  perpLeft,
  pointAtFraction,
  pointFeature,
  polygonFeature,
  polylineLength,
  scale,
  scallopRing,
  toLonLat,
  toPlanar,
  unit,
} from "../decorate/index.js";
import type { Pt } from "../decorate/index.js";
import type {
  DecorateFn,
  DecorationInput,
  DrawSpec,
  FieldSchema,
  GeometryPrimitive,
  InteractionSpec,
  Metadata,
  PhenomenonDef,
  RenderFeature,
  WidgetInput,
} from "../phenomenon.js";
import { flBandNode, flGaugeNode, flRangesNode, num, ringCentroid } from "../phenomena/util.js";
import type { PhenomenonStyle } from "../style.js";
import { compileCondition, getAction, getDecorator, getGenerator, resolveGlyph } from "./extensions.js";
import type { FormatContext } from "./extensions.js";
import { evalTemplate } from "./template.js";
import type {
  CardSpec,
  DescriptorField,
  EnumFieldDescriptor,
  EnumOptionDescriptor,
  GestureSpec,
  GlyphSpec,
  InkSpec,
  LabelSpec,
  ListFieldDescriptor,
  NumberFieldDescriptor,
  PhenomenonDescriptor,
  RenderByGeometry,
  RenderSpec,
  SatelliteSpec,
} from "./types.js";

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Engine fallback FL bounds — used ONLY when neither the profile's per-phenomenon
 *  `flightLevel` nor the chart `vertical` resolves (a registry used without any
 *  profile). The numbers are the WAFS SWH chart's, the lib's historical default. */
const FALLBACK_FL = { min: 250, max: 600 };

// ── Glyphs ────────────────────────────────────────────────────────────────────

/** Resolve a glyph spec for a feature state (hemisphere variants need the latitude). */
function glyphFor(spec: GlyphSpec, lat: number): string {
  if (typeof spec === "string") return resolveGlyph(spec);
  if (spec.byHemisphere) return resolveGlyph(lat >= 0 ? spec.byHemisphere.n : spec.byHemisphere.s);
  throw new Error(`Unsupported glyph spec: ${JSON.stringify(spec)}`);
}

/** Pre-validate a glyph spec (compile-time: unknown atlas names fail at load, not render). */
function checkGlyph(spec: GlyphSpec): void {
  if (typeof spec === "string") resolveGlyph(spec);
  else if (spec.byHemisphere) {
    resolveGlyph(spec.byHemisphere.n);
    resolveGlyph(spec.byHemisphere.s);
  }
}

/** Dress a normalized atlas entry for the TOOLBAR slot (~22 px). */
function toolbarIcon(svg: string): string {
  return /\bwidth=/.test(svg) ? svg : svg.replace("<svg", "<svg width='22' height='22'");
}

/** An enum field's LIVE options — honours `optionsBy` (options that depend on another field's
 *  value, e.g. a cloud layer's `amount` set depends on its `type`). Resolved against `metadata`. */
function liveOptions(field: EnumFieldDescriptor, metadata: Metadata): EnumOptionDescriptor[] {
  const ob = field.optionsBy;
  if (!ob) return field.options;
  return ob.map[String(metadata[ob.field] ?? "")] ?? ob.map["*"] ?? field.options;
}

// ── Fields ────────────────────────────────────────────────────────────────────

function compileField(f: DescriptorField): FieldSchema {
  const label = f.label ?? f.key;
  const when = f.when ? { visibleWhen: compileCondition(f.when) } : {};
  const required = f.required ? { required: true } : {};
  switch (f.kind) {
    case "number":
      return {
        type: "number", key: f.key, label, ...when, ...required,
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
        ...(f.step !== undefined ? { step: f.step } : {}),
        ...(f.unit !== undefined ? { unit: f.unit } : {}),
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
    case "fl":
      return {
        type: "fl", key: f.key, label, ...when, ...required,
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
    case "enum": {
      const opt = (o: EnumOptionDescriptor): { value: string; label: string; meta?: Record<string, unknown> } => ({
        value: o.value,
        label: o.label ?? o.value,
        ...(o.meta ? { meta: o.meta } : {}),
      });
      return {
        type: "enum", key: f.key, label, ...when, ...required,
        options: f.options.map(opt),
        ...(f.optionsBy ? { optionsBy: { field: f.optionsBy.field, map: Object.fromEntries(Object.entries(f.optionsBy.map).map(([k, v]) => [k, v.map(opt)])) } } : {}),
        ...(f.default !== undefined ? { default: f.default } : { default: f.options[0]?.value ?? "" }),
      };
    }
    case "bool":
      return {
        type: "bool", key: f.key, label, ...when, ...required,
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
    case "text":
      return {
        type: "text", key: f.key, label, ...when, ...required,
        ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
        ...(f.default !== undefined ? { default: f.default } : {}),
      };
    case "list": {
      const itemLabel = f.itemLabel;
      return {
        type: "list", key: f.key, label, ...when, ...required,
        itemSchema: f.item.map(compileField),
        ...(itemLabel !== undefined
          ? { itemLabel: (it: Metadata, i: number) => evalTemplate(itemLabel, it, { metadata: it }, { "#": i + 1 }) }
          : {}),
        ...(f.default !== undefined ? { default: f.default as Metadata[] } : {}),
      };
    }
  }
}

// ── Gesture → primitives + draw spec ──────────────────────────────────────────

function primitivesOf(g: GestureSpec): GeometryPrimitive[] {
  // `lasso-or-spot`: a too-short stroke commits a POINT (the def must allow both).
  return g.draw === "lasso-or-spot" ? [g.primitive, "point"] : [g.primitive];
}

function compileDraw(g: GestureSpec): DrawSpec {
  const interaction: InteractionSpec = {
    primitive: g.primitive,
    mode: g.draw === "drop" ? "drop" : "draw",
    ...(g.smooth ? { smooth: true } : {}),
    ...(g.directional ? { directional: true } : {}),
    ...(g.draw === "lasso" || g.draw === "lasso-or-spot" ? { freehand: true } : {}),
    ...(g.draw === "lasso-or-spot" ? { pointWhenShort: true } : {}),
    ...(g.erasable ? { erasable: true } : {}),
  };
  const generator = g.default ? getGenerator(g.default) : undefined;
  const defaultGeometry =
    generator ??
    (g.primitive === "point" || g.draw === "lasso-or-spot"
      ? (c: { lon: number; lat: number }): Geometry => ({ type: "Point", coordinates: [c.lon, c.lat] })
      : undefined);
  return {
    ...(g.primitive === "polygon" ? { closed: true } : {}),
    ...(g.minVertices !== undefined
      ? { minVertices: g.minVertices }
      : g.primitive === "polygon"
        ? { minVertices: 3 }
        : g.primitive === "polyline"
          ? { minVertices: 2 }
          : {}),
    interaction,
    ...(defaultGeometry ? { defaultGeometry } : {}),
  };
}

// ── Anchor strategies ─────────────────────────────────────────────────────────

/** `geometry-mid`: a spot point itself / a contour's arc-length middle (on the
 *  SMOOTHED path when the gesture smooths). */
function geometryMid(geometry: Geometry, smooth: boolean): Pt | null {
  if (geometry.type === "Point") return geometry.coordinates as Pt;
  if (geometry.type === "LineString" && geometry.coordinates.length >= 2) {
    const coords = geometry.coordinates as Pt[];
    const dense = smooth ? catmullRom(coords, 16) : coords;
    const k = frameK(dense);
    return toLonLat(pointAtFraction(dense.map((c) => toPlanar(c, k)), 0.5).p, k);
  }
  return null;
}

// ── Render compilation ────────────────────────────────────────────────────────

/** The resolved chart FL bounds, as both decorate and widget inputs carry them. */
interface FlInput {
  flightLevel?: { min?: number; max?: number; beyond?: [string, string] } | undefined;
}

/** Resolved chart FL bounds for the format context / gauges. */
const flCtx = (input: FlInput): { min?: number; max?: number; beyond?: [string, string] } | undefined =>
  input.flightLevel;

/** Format context with the engine fallback bounds — so the `flx` sentinel works even
 *  when no profile resolves bounds (decorate called map-free, e.g. in tests). */
const flCtxWithFallback = (input: FlInput): { min: number; max: number; beyond?: [string, string] } => {
  const fl = flCtx(input);
  return {
    min: fl?.min ?? FALLBACK_FL.min,
    max: fl?.max ?? FALLBACK_FL.max,
    ...(fl?.beyond ? { beyond: fl.beyond } : {}),
  };
};

/** Per-state ink: a field's value picks a STYLE SUBKEY (`mod`/`sev`); `"*"` is the
 *  wildcard row. Falls back to `style.color`. */
function compileInk(spec: InkSpec | undefined): (style: PhenomenonStyle, metadata: Metadata) => string {
  if (!spec) return (style) => style.color;
  return (style, metadata) => {
    const sub = spec.map[str(metadata[spec.byField])] ?? spec.map["*"];
    const c = sub ? (style as unknown as Record<string, { color?: string } | undefined>)[sub]?.color : undefined;
    return c ?? style.color;
  };
}

/** The plain placed label (tropopause): boxed spot FL / bare contour mid-label. */
/** A line's label/gauge frame at `metadata.labelT` (fraction, default 0.5): the planar
 *  point on the (smoothed) curve + its tangent + the projection frame. Null for non-lines. */
function lineLabelFrame(geometry: Geometry, metadata: Metadata, smooth: boolean): { k: ReturnType<typeof frameK>; p: Pt; dir: Pt } | null {
  if (geometry.type !== "LineString") return null;
  const coords = geometry.coordinates as Pt[];
  if (coords.length < 2) return null;
  const k = frameK(coords);
  const planar = (smooth ? catmullRom(coords, 16) : coords).map((c) => toPlanar(c, k));
  const t = typeof metadata["labelT"] === "number" ? (metadata["labelT"] as number) : 0.5;
  const st = pointAtFraction(planar, t);
  return { k, p: st.p as Pt, dir: st.dir as Pt };
}

function labelFeatures(spec: LabelSpec, input: DecorationInput, smooth: boolean): RenderFeature[] {
  const { geometry, metadata, style } = input;
  let at = geometryMid(geometry, smooth);
  // A movable line label rides `metadata.labelT` and is LIFTED off the line (its base sits on
  // the line, where the drag handle is) so the handle never covers the value.
  if (spec.movable) {
    const fr = lineLabelFrame(geometry, metadata, smooth);
    if (fr) {
      let p = fr.p;
      const res = input.resolution;
      if (res && res > 0) {
        let n = perpLeft(unit(fr.dir)); // perpendicular; flip to the upper (north/+y) side
        if (n[1] < 0) n = [-n[0], -n[1]];
        p = add(p, scale(n, res * 13)); // ≈ half the box height above the line
      }
      at = toLonLat(p, fr.k);
    }
  }
  if (!at) return [];
  const ink = style.edge?.color ?? style.color;
  const text = spec.content.map((t) => evalTemplate(t, metadata, { metadata, flightLevel: flCtx(input) })).join("\n");
  return [
    pointFeature(at, {
      layer: "text-boxes",
      text,
      textColor: style.text?.color ?? ink,
      textSize: style.text?.size ?? 13,
      textHalo: style.text?.halo ?? "#ffffff",
      // Boxed: a small white rectangle + border; bare: the halo punches the gap.
      ...(spec.box ? { textBackground: style.text?.background ?? "#ffffff", textBorder: ink, ...(spec.borderWidth ? { textBorderWidth: spec.borderWidth } : {}) } : {}),
    }),
  ];
}

/** Compile one render branch for LINE geometry (dashed/plain stroked path + label). */
function compileLineRender(spec: RenderSpec, smooth: boolean): DecorateFn {
  const edge = spec.edge;
  return (input) => {
    const { geometry, style } = input;
    if (geometry.type !== "LineString") return [];
    const coords = geometry.coordinates as Pt[];
    if (coords.length < 2) return [];
    const out: RenderFeature[] = [];
    if (edge && edge.treatment !== "none") {
      const dense = smooth ? catmullRom(coords, 16) : coords;
      const ink = style.edge?.color ?? style.color;
      const dash = style.edge?.dash ?? edge.dash;
      out.push(
        lineFeature(dense, {
          layer: "edge",
          stroke: ink,
          strokeWidth: style.edge?.width ?? edge.width ?? 2,
          ...(edge.treatment === "dash" && dash ? { dash } : {}),
        }),
      );
    }
    if (spec.label) out.push(...labelFeatures(spec.label, input, smooth));
    return out;
  };
}

/** Compile one render branch for POINT geometry (a placed label only). */
function compilePointRender(spec: RenderSpec, smooth: boolean): DecorateFn {
  return (input) => {
    if (input.geometry.type !== "Point") return [];
    return spec.label ? labelFeatures(spec.label, input, smooth) : [];
  };
}

/** Compile the AREA render: per-ring edge treatment (a hole's treatment inverts
 *  geometrically), holed fill, ONE call-out at the largest area's centroid (the
 *  controller aims one leader/arrow at EACH area). */
function compileAreaRender(d: PhenomenonDescriptor, spec: RenderSpec): DecorateFn {
  const treatment = spec.edge?.treatment ?? "plain";
  const inkOf = compileInk(spec.ink);
  const co = spec.callout;
  const labelId = co?.id ?? d.type;
  const fillDefault = spec.fill === false ? undefined : spec.fill?.opacity;

  return (input) => {
    const { geometry, metadata, style, leaderThunderbolt } = input;
    const areas = areaRings(geometry).filter((a) => a.outer.length >= 3);
    if (!areas.length) return [];
    const out: RenderFeature[] = [];
    const ink = inkOf(style, metadata);
    const edgeInk = style.edge?.color ?? ink;
    const edgeW = style.edge?.width ?? spec.edge?.width ?? 2;
    const wantFill = spec.fill !== false && !!style.area;
    const fillProps = (outer: Pt[], holes: Pt[][]): RenderFeature =>
      polygonFeature(outer, { layer: "area-fill", fillColor: style.area?.color ?? ink, fillOpacity: style.area?.opacity ?? fillDefault ?? 0.15 }, holes);

    if (treatment === "scallop") {
      // ONE bump size for the whole feature (from its MAIN outer ring) — a small hole
      // must NOT get miniature bumps: the wavelength is a chart convention, not a ratio.
      const mainRing = coordsOf(geometry);
      const mk = frameK(mainRing);
      const wavelength = Math.max(0.05, polylineLength(mainRing.map((c) => toPlanar(c, mk))) / 36);
      // `scallopRing` lays AT LEAST one bump per edge — an eraser-produced ring is dense
      // in tiny capsule arcs, which would multiply the bumps. Decimate vertices closer
      // than ~0.8 wavelength first (hand-drawn rings, long-edged, pass unchanged).
      const decimate = (ring: Pt[]): Pt[] => {
        const k = frameK(ring);
        const minEdge = wavelength * 0.8;
        const kept: Pt[] = [];
        for (const c of ring) {
          const last = kept[kept.length - 1];
          if (!last) {
            kept.push(c);
            continue;
          }
          const a = toPlanar(last, k);
          const b = toPlanar(c, k);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= minEdge) kept.push(c);
        }
        return kept.length >= 3 ? kept : ring;
      };
      const scallop = (ring: Pt[], invert: boolean): Pt[] =>
        scallopRing(decimate(ring), { wavelength, amplitude: wavelength * 0.6, invert }) as Pt[];
      for (const area of areas) {
        // Outer bumps point OUTWARD (away from the fill); hole bumps INTO the hole.
        const outer = scallop(area.outer, false);
        const holes = area.holes.filter((h) => h.length >= 3).map((h) => scallop(h, true));
        if (wantFill) out.push(fillProps(outer, holes));
        out.push(lineFeature(outer, { layer: "edge", stroke: edgeInk, strokeWidth: edgeW }));
        for (const h of holes) out.push(lineFeature(h, { layer: "edge", stroke: edgeInk, strokeWidth: edgeW }));
      }
    } else {
      const dash = style.edge?.dash ?? spec.edge?.dash;
      // ONE tick rhythm for the whole feature (from its MAIN outer ring) — a hole's
      // ticks keep the chart-wide spacing, never a miniature one.
      let spacing = 0;
      if (treatment === "ticks") {
        const mainRing = coordsOf(geometry);
        const mfk = frameK(mainRing);
        spacing = Math.max(0.05, polylineLength(mainRing.map((c) => toPlanar(c, mfk))) / 44);
      }
      const ringOut = (ring: Pt[], invert: boolean): void => {
        out.push(lineFeature(ring, { layer: "edge", stroke: edgeInk, strokeWidth: edgeW, ...(treatment !== "plain" && dash ? { dash } : {}) }));
        if (treatment === "ticks") {
          // Small INWARD ticks; a HOLE's ticks point the other way — into the
          // surrounding fill, not into the clear zone.
          const ticks = inwardTicks(ring, { spacing, length: spacing * 0.26, invert });
          if (ticks.length) {
            out.push({ type: "Feature", properties: { layer: "edge", stroke: edgeInk, strokeWidth: edgeW }, geometry: { type: "MultiLineString", coordinates: ticks } });
          }
        }
      };
      for (const area of areas) {
        const smooth = catmullRomClosed(area.outer, 16) as Pt[]; // soft "balloon" outline
        const holes = area.holes.filter((h) => h.length >= 3).map((h) => catmullRomClosed(h, 16) as Pt[]);
        if (wantFill) out.push(fillProps(smooth, holes));
        ringOut(smooth, false);
        for (const h of holes) ringOut(h, true);
      }
    }

    if (co) {
      const fmt: FormatContext = { metadata, flightLevel: flCtxWithFallback(input) };
      // A repeated (layer-stack) area builds the cartouche by stacking ONE content block per
      // layer (in the stored altitude order) — the "rest" view of the stack: `qty type top/base`
      // per cloud layer. With a SINGLE layer, the compact stacked line gives way to the "normal"
      // centered column (`contentSingle`, e.g. amount / type / top / base). A plain area evaluates
      // `content` once over the feature metadata.
      const repeatKey = d.repeat?.listField;
      let content: string;
      if (repeatKey) {
        const layers = Array.isArray(metadata[repeatKey]) ? (metadata[repeatKey] as Metadata[]) : [];
        const tmplOf = (it: Metadata, lines: string[]) =>
          lines.map((t) => evalTemplate(t, it, { metadata: it, flightLevel: flCtxWithFallback(input) })).join("\n");
        content = layers.length === 1 && co.contentSingle
          ? tmplOf(layers[0]!, co.contentSingle)
          : layers.map((it) => tmplOf(it, co.content)).join("\n");
      } else {
        content = co.content.map((t) => evalTemplate(t, metadata, fmt)).join("\n");
      }
      const boxed = co.box !== false;
      // B&W panel: text/box/leader = `style.text.color` (black); bare call-out: the ink.
      const calloutInk = boxed ? (style.text?.color ?? "#1f2328") : ink;
      // A per-layer area has no single feature-level symbol over the box.
      const symbol = co.symbol && !repeatKey ? str(metadata[co.symbol.byField]) : undefined;
      // An inside glyph reserves its room with leading blank lines (engine convention).
      if (symbol !== undefined && co.symbol?.inside) content = ` \n \n${content}`;
      out.push(
        pointFeature(ringCentroid(coordsOf(geometry)), {
          layer: "annotations",
          labelId,
          content,
          ...(co.leader !== "none" ? { leader: true } : {}),
          ...(co.arrow !== false ? { arrow: true } : {}),
          // Lightning-bolt leader (convective); `leaderThunderbolt:false` → plain straight.
          ...(co.leader === "lightning" && leaderThunderbolt !== false ? { leaderStyle: "lightning" } : {}),
          ...(symbol !== undefined
            ? {
                symbol, // the code IS the sprite id
                symbolColor: boxed ? calloutInk : (style.symbol?.color ?? ink),
                ...(co.symbol?.inside ? { symbolInside: true } : {}),
              }
            : {}),
          textColor: calloutInk,
          textSize: style.text?.size ?? 13,
          textHalo: style.text?.halo ?? "#ffffff",
          ...(boxed
            ? { textBackground: style.text?.background ?? "#ffffff", textBorder: calloutInk }
            : { textBorder: ink }), // unboxed: only tints the leader/arrow
        }),
      );
    }
    return out;
  };
}

function compileDecorate(d: PhenomenonDescriptor): DecorateFn {
  const r = d.render;
  if (!r) return () => [];
  const smooth = d.gesture.smooth === true;
  if ("point" in r || "line" in r) {
    const branches = r as RenderByGeometry;
    const pointFn = branches.point ? compilePointRender(branches.point, smooth) : undefined;
    const lineFn = branches.line ? compileLineRender(branches.line, smooth) : undefined;
    return (input) => {
      if (input.geometry.type === "Point") return pointFn?.(input) ?? [];
      if (input.geometry.type === "LineString") return lineFn?.(input) ?? [];
      return [];
    };
  }
  if (d.gesture.primitive === "polygon") return compileAreaRender(d, r as RenderSpec);
  // Decorated polylines (the jet): the rendering IS the named decorator extension(s),
  // resolved at COMPILE time (an unknown name fails listing the available ones).
  const spec = r as RenderSpec;
  if (spec.decorations?.length) {
    const decorators = spec.decorations.map((dec) => {
      const { use, ...params } = dec;
      return { fn: getDecorator(use), params: params as Record<string, unknown> };
    });
    return (input) => decorators.flatMap(({ fn, params }) => fn(input, params));
  }
  fail(d.type, "a polyline render spec needs `decorations` (named decorator extensions)");
}

// ── Satellites (floating control cards) ───────────────────────────────────────

/** `side: "right"` origin policy per anchor strategy (the engine's screen layouts):
 *  beside a placed call-out (−1.0), beside a geometry label (−0.5), clear of a
 *  break-point dial ring (−1.6). The offset is in units of the SATELLITE's own width
 *  (the adapter shifts it `−x×100%` of its box) — a wide parent card needs a larger one. */
const SIDE_X: Record<SatelliteSpec["anchor"], number> = {
  callout: -1.0,
  "geometry-mid": -0.85, // just clear of the geometry label box (−0.5 looked astride, −1.1 too far)
  "break-point": -1.6,
};
/** Per-layer accent palette for the multi-range FL editor (the multi-layer cloud area): each
 *  cloud layer's band + handles take the next colour so overlapping ranges read apart. A lib
 *  fallback (engine-chrome-style, not phenomenon data); a profile may override later. */
const LAYER_GAUGE_COLORS = ["#d1242f", "#0969da", "#1a7f37", "#bf8700", "#8250df", "#bf3989"];
/** The active cloud layer's accent (band/handle colour AND the panel frame — they match). */
const layerColor = (i: number): string => LAYER_GAUGE_COLORS[i % LAYER_GAUGE_COLORS.length]!;
/** Mix a `#rrggbb` toward white by `t` (0 = unchanged, 1 = white): the very-light card tint. */
function lighten(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * t);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function compileSatellites(d: PhenomenonDescriptor): ((input: WidgetInput) => MarkerWidget[]) | undefined {
  const sats = d.satellites;
  if (!sats?.length) return undefined;
  const smooth = d.gesture.smooth === true;
  // Break-point satellites ride the schema's LIST field (the jet's `points`).
  const listField = (d.fields ?? []).find((f) => f.kind === "list");
  // A stack (repeat) area scopes its callout gauge to the ACTIVE cloud layer (`layers.<i>.…`).
  const repeatList = d.repeat
    ? (d.fields ?? []).find((f): f is ListFieldDescriptor => f.kind === "list" && f.key === d.repeat!.listField)
    : undefined;
  const repeatMax = d.repeat?.max ?? 1;
  const itemField = (key: string) => listField?.kind === "list" ? listField.item.find((f) => f.key === key) : undefined;
  const pad3 = (v: number): string => String(Math.round(v)).padStart(3, "0");
  const chromeProps = (chrome: WidgetInput["chrome"], knobs: boolean): Record<string, string> => ({
    ...(chrome?.line?.color ? { color: chrome.line.color } : {}),
    ...(chrome?.text?.color ? { labelColor: chrome.text.color } : {}),
    ...(chrome?.text?.halo ? { labelHalo: chrome.text.halo } : {}),
    ...(knobs && chrome?.handle?.fill ? { knobFill: chrome.handle.fill } : {}),
    ...(knobs && chrome?.handle?.stroke ? { knobStroke: chrome.handle.stroke } : {}),
  });

  return (input: WidgetInput): MarkerWidget[] => {
    const { id, geometry, metadata, flightLevel, chrome, sub, limit } = input;
    const cards: MarkerWidget[] = [];
    // The selected break-point item (break-point anchors): ON the smoothed curve. A bare
    // terminator (t≈0/1) has nothing to edit — jets start/end at the floor (§3.5.1).
    let breakAt: Pt | null = null;
    let item: Metadata | undefined;
    if (sats.some((s) => s.anchor === "break-point") && sub != null && geometry.type === "LineString" && listField) {
      const items = (metadata[listField.key] as Metadata[] | undefined) ?? [];
      item = items[sub];
      const t = num(item?.["t"], 0);
      if (item && t > 0.001 && t < 0.999) {
        const dense = catmullRom(geometry.coordinates as Pt[], 16);
        const k = frameK(dense);
        breakAt = toLonLat(pointAtFraction(dense.map((c) => toPlanar(c, k)), t).p, k);
      }
    }
    for (const sat of sats) {
      let at: Pt | null = null;
      if (sat.anchor === "geometry-mid") {
        // Track a movable point ALONG the line: the front's movement-arrow ROOT (`motionT`) or a
        // movable line label (`labelT`); else the arc middle. So the speed slider rides the root.
        const frac = typeof metadata["motionT"] === "number" ? (metadata["motionT"] as number)
          : typeof metadata["labelT"] === "number" ? (metadata["labelT"] as number) : null;
        if (geometry.type === "LineString" && frac !== null) {
          const coords = geometry.coordinates as Pt[];
          const kk = frameK(coords);
          const planar = (smooth ? catmullRom(coords, 16) : coords).map((c) => toPlanar(c, kk));
          at = toLonLat(pointAtFraction(planar, frac).p as Pt, kk);
        } else {
          at = geometryMid(geometry, smooth);
        }
      } else if (sat.anchor === "callout" && input.callout) at = input.callout.at;
      else if (sat.anchor === "break-point") at = breakAt;
      if (!at) continue;
      const scope = sat.anchor === "break-point" && listField ? `${listField.key}.${sub}.` : "";
      const items: WidgetNode[] = [];
      let yPin: number | undefined;
      const pin = (min: number, max: number, _fallback: number): void => {
        if (sat.pin !== "flRef") return;
        // Align the MIDDLE of the gauge range with the anchor (the call-out box) so the slider
        // straddles the box symmetrically — drag-stable (a constant, independent of the live FL).
        const ref = (min + max) / 2;
        yPin = 1 - (ref - min) / (max - min); // = 0.5
      };
      for (const it of sat.items) {
        if (it.gauge && repeatList) {
          // Multi-layer cloud area: ONE multi-range FL gauge — N overlapping [base,top] bands on a SHARED
          // axis (the adapter's `WidgetGauge.ranges` mode), one DISTINCT colour per layer. Cursor
          // names are list-scoped (`layers.<i>.baseFL/topFL`) so a knob/band drag routes through
          // `updateListItem`; the controller flips the active layer to the touched one so the
          // panel pickers follow. `active` = the current layer (rendered on top when knobs
          // coincide). The `+` to add a layer hangs off this card (place: top).
          const keys = it.gauge.cursors;
          if (keys.length !== 2) continue; // multi-range = base/top only
          const arr = (metadata[repeatList.key] as Metadata[] | undefined) ?? [];
          const activeIdx = sub != null && sub >= 0 && sub < arr.length ? sub : 0;
          const rangeChrome = { ...(chrome?.text ? { text: chrome.text } : {}), handle: { stroke: "#ffffff" } };
          const gauge = flRangesNode(
            arr,
            repeatList.key,
            flightLevel,
            FALLBACK_FL.min,
            FALLBACK_FL.max,
            [keys[0]!, keys[1]!],
            layerColor,
            activeIdx,
            rangeChrome,
          );
          // `canAdd` (lib gate, read by the adapter): another layer is allowed below `repeat.max`.
          // The adapter's hover-`+` (add a layer in an empty axis span) is suppressed when false.
          gauge.canAdd = arr.length < repeatMax;
          items.push(gauge);
          pin(gauge.min, gauge.max, (gauge.min + gauge.max) / 2);
        } else if (it.gauge && !scope && (d.fields ?? []).some((ff) => ff.kind === "number" && ff.key === it.gauge!.cursors[0])) {
          // Feature-level NUMBER slider (a front's movement speed): a compact VERTICAL mini-gauge —
          // a track + thumb you push up/down, visually unmistakable next to the round 360° direction
          // handle on the map (a rotary dial read too much like that handle). Bottom-pinned (`yPin = 1`)
          // so its 0 sits AT the arrow-root base handle. Routes through the generic number path.
          const key = it.gauge.cursors[0]!;
          const nf = (d.fields ?? []).find((ff): ff is NumberFieldDescriptor => ff.kind === "number" && ff.key === key)!;
          const min = nf.min ?? 0;
          const max = nf.max ?? 100;
          const value = num(metadata[key], min);
          const unit = nf.unit ?? "";
          items.push({ kind: "gauge", min, max, step: nf.step ?? 1, length: 96, cursors: [{ name: key, value, label: `${Math.round(value)}${unit}` }], ...chromeProps(chrome, true) } as WidgetNode);
          yPin = 1; // 0 (gauge bottom) aligns with the root base handle
        } else if (it.gauge && !scope) {
          // Feature-level FL gauge. A base/top pair (CB, icing, turbulence) → a DRAGGABLE 1-band
          // `ranges` gauge (grab the middle, base+top move together), inked in the phenomenon's
          // identity colour (visible/grab-able). A lone cursor (single FL — tropopause, isotherm)
          // stays a plain 1-cursor gauge: a point has no band.
          const keys = it.gauge.cursors;
          if (keys.length === 2) {
            const bandColor = input.style?.color ?? chrome?.line?.color ?? chrome?.handle?.fill ?? "#1f2328";
            const gauge = flBandNode(metadata, flightLevel, FALLBACK_FL.min, FALLBACK_FL.max, [keys[0]!, keys[1]!], bandColor);
            items.push(gauge);
            pin(gauge.min, gauge.max, (gauge.min + gauge.max) / 2);
          } else {
            const gauge = flGaugeNode(metadata, flightLevel, FALLBACK_FL.min, FALLBACK_FL.max, [keys[0]!], chrome);
            items.push(gauge);
            pin(gauge.min, gauge.max, num(metadata[keys[0]!], (gauge.min + gauge.max) / 2));
          }
        } else if (it.gauge && scope && item) {
          // Break-point gauge: list-scoped cursor names (`points.N.fl` — engine-routed
          // through `updateListItem`), core cursor + conditional EXTENT cursors.
          const core = it.gauge.cursors[0]!;
          const flMin = num(flightLevel?.min, FALLBACK_FL.min);
          const flMax = num(flightLevel?.max, FALLBACK_FL.max);
          const coreDef = itemField(core);
          const flv = num(item[core], coreDef?.kind === "fl" ? (coreDef.default ?? 300) : 300);
          const cursors: { name: string; value: number; label: string }[] = [{ name: `${scope}${core}`, value: flv, label: `FL${pad3(flv)}` }];
          if (it.gauge.extent) {
            const [below, above] = it.gauge.extent;
            const visible = (key: string): boolean => {
              const f = itemField(key);
              return f?.when ? compileCondition(f.when)(item as Metadata) : true;
            };
            // Extent cursors appear with their fields; unset values seed at core ∓ 40 —
            // a drag persists them (the depiction default until the forecaster sets it).
            if (visible(below)) {
              const v = num(item[below], Math.max(flMin, flv - 40));
              cursors.unshift({ name: `${scope}${below}`, value: v, label: pad3(v) });
            }
            if (visible(above)) {
              const v = num(item[above], Math.min(flMax, flv + 40));
              cursors.push({ name: `${scope}${above}`, value: v, label: pad3(v) });
            }
          }
          items.push({ kind: "gauge", min: flMin, max: flMax, step: 5, length: Math.round((flMax - flMin) * 0.5), cursors, ...chromeProps(chrome, true) } as WidgetNode);
          pin(flMin, flMax, flv);
        } else if (it.dial && scope && item) {
          // Break-point dial (the wind speed): bounds from the field's resolved limits;
          // the label rides the knob (adapter).
          const field = it.dial.field;
          const f = itemField(field);
          const lim = limit?.(field) ?? (f?.kind === "number" ? { min: f.min ?? 0, max: f.max ?? 100 } : { min: 0, max: 100 });
          const value = num(item[field], lim.min);
          const unit = f?.kind === "number" && f.unit ? f.unit.toUpperCase() : "";
          items.push({ kind: "dial", name: `${scope}${field}`, min: lim.min, max: lim.max, value, label: `${Math.round(value)}${unit}`, step: f?.kind === "number" ? (f.step ?? 5) : 5, ...chromeProps(chrome, false) } as WidgetNode);
        } else if ((it.picker ?? it.carousel) && !scope) {
          // A feature-level enum picker beside the label (the isotherm temperature). A satellite
          // renders for BOTH a spot and a contour, so the picker works in either mode; its edit
          // routes through the generic `onWidgetEdit` → `updateMetadata` path.
          const pick = (it.picker ?? it.carousel)!;
          const field = (d.fields ?? []).find((f): f is EnumFieldDescriptor => f.kind === "enum" && f.key === pick.field);
          if (field) {
            const live = liveOptions(field, metadata);
            const value = live.some((o) => o.value === metadata[pick.field]) ? str(metadata[pick.field]) : (live[0]?.value ?? "");
            const options = live.map((o) => {
              if (pick.label !== undefined) {
                const label = evalTemplate(pick.label, metadata, { metadata }, { value: o.value });
                return { value: o.value, label, ...(o.label && o.label !== label ? { title: o.label } : {}) };
              }
              return o.label && o.label !== o.value ? { value: o.value, label: o.value, title: o.label } : { value: o.value, label: o.value };
            });
            items.push({ kind: "text", value, control: "picker", ...(pick.mode ? { mode: pick.mode } : {}), name: pick.field, options, ...(chrome?.handle?.fill ? { color: chrome.handle.fill } : {}) });
          }
        }
      }
      if (!items.length) continue;
      // The gauge sits a hair's gap beside its anchor card. A multi-layer area's panel is now the same
      // flat card as a simple area (the wide layer-stack is gone), so it uses the SAME offset.
      const sideX = sat.side === "center" ? undefined : SIDE_X[sat.anchor];
      // A CALL-OUT satellite (the FL gauge beside an area/composite panel) glues to that panel's
      // MEASURED right edge via `anchorTo` (exact hair-gap, re-snapped on resize) — keeping its
      // FL-pinned vertical position on the cross axis (`origin.y`). Other satellites (the jet's
      // break-point dial/gauge, geometry-mid labels) keep the legacy self-relative origin offset.
      const anchorTo = sat.anchor === "callout" && sideX !== undefined ? { id, side: "right" as const, gap: 2 } : undefined;
      // Adding a layer is the adapter's HOVER-`+`: hovering an empty span of the axis offers an
      // "add here" `+` that emits `addLayerAt:<fl>` (gated by the gauge's `canAdd`). No fixed
      // axis-end buttons here anymore.
      cards.push({
        id: `${id}#${sat.part}`,
        anchor: { lon: at[0]!, lat: at[1]! },
        ...(anchorTo
          ? { anchorTo, origin: { x: 0.5, y: yPin ?? 0.5 } }
          : sideX !== undefined
            ? { origin: { x: sideX, y: yPin ?? 0.5 } }
            : {}),
        child: { dir: "v", items },
      });
    }
    return cards;
  };
}

// ── The PANEL card (replaces an area's placed call-out while selected) ────────

function compilePanelWidget(d: PhenomenonDescriptor, satellites: ((input: WidgetInput) => MarkerWidget[]) | undefined): (input: WidgetInput) => MarkerWidget[] | null {
  const card = d.card as CardSpec;
  const r = d.render as RenderSpec | undefined;
  const inkOf = compileInk(r?.ink);
  const framed = card.framed !== false;
  // `place: "anchor"` buttons live OFF the card (relocated to the arrow-tip by the
  // controller via `def.anchorButton`); only card-edge buttons stay here.
  const buttons = (card.buttons ?? [])
    .filter((b) => b.place !== "anchor")
    .map((b) => ({
      event: getAction(b.action),
      place: b.place as "left" | "right" | "h-edges" | "top" | "bottom",
      svg: resolveGlyph(b.svg ?? (b.action === "erase" ? "atlas:minus" : "atlas:plus")),
      bordered: true,
      ...(b.title !== undefined ? { title: b.title } : {}),
    }));
  // Carousels read their enum field's options (the descriptor's single source).
  const enumOf = (key: string): EnumFieldDescriptor | undefined =>
    (d.fields ?? []).find((f): f is EnumFieldDescriptor => f.kind === "enum" && f.key === key);

  return (input: WidgetInput): MarkerWidget[] | null => {
    const { id, metadata, editable, style, callout, sprite, flightLevel, chrome } = input;
    if (!editable || !callout) return null;
    // Framed panel: black & white like the printed call-out; bare: the per-state ink.
    const ink = framed ? (style.text?.color ?? "#1f2328") : inkOf(style, metadata);
    const fontPx = style.text?.size ?? 13;
    const fmt: FormatContext = { metadata, flightLevel: flCtxWithFallback(input) };
    const items: WidgetNode[] = [];
    let textLines = 0;
    let hasGlyphCarousel = false;
    for (const it of card.items) {
      const pick = it.picker ?? it.carousel; // `carousel` = deprecated alias of `picker`
      if (pick) {
        const field = enumOf(pick.field);
        if (!field) continue;
        const live = liveOptions(field, metadata); // honours `optionsBy` (e.g. amount-by-type)
        const value = live.some((o) => o.value === metadata[pick.field]) ? str(metadata[pick.field]) : (live[0]?.value ?? "");
        const labelTpl = pick.label;
        const options = live.map((o) => {
          // The descriptor option's `label` is the full human name (e.g. "Cirrus" for "CI") —
          // surface it as the picker `title` (tooltip) whenever it isn't the visible text. No
          // explicit name ⇒ no tooltip (the adapter never falls back to value/label).
          const tip = (o.label && o.label !== o.value) ? { title: o.label } : {};
          if (labelTpl !== undefined) {
            const label = evalTemplate(labelTpl, metadata, fmt, { value: o.value });
            return { value: o.value, label, ...(o.label && o.label !== label ? { title: o.label } : {}) };
          }
          // No label template ⇒ GLYPH options, resolved from the live sprite catalogue
          // (the code IS the sprite id — host extensions included).
          const svg = sprite?.(o.value);
          return svg ? { value: o.value, svg, ...tip } : { value: o.value, label: o.value, ...tip };
        });
        if (labelTpl === undefined) hasGlyphCarousel = true;
        // The adapter `picker` control (carousel ≤5 / flower 6–10 / grid >10, auto-degrading).
        // Its text is tinted with the control HANDLE colour (like the gauge/dial knobs) so the
        // clickable value reads as a control — customisable via `style.control.handle`. `it.size`
        // enlarges the trigger glyph while selected (e.g. the icing ICE_MOD/SEV symbol).
        items.push({ kind: "text", value, control: "picker", ...(pick.mode ? { mode: pick.mode } : {}), name: pick.field, options, ...(it.size ? { size: it.size } : {}), ...(chrome?.handle?.fill ? { color: chrome.handle.fill } : {}) });
      } else if (it.gauge) {
        // FL gauge INLINE in the card (1–2 cursors over the metadata, XXX notches per side) —
        // same control as the satellite gauge, but stacked in the panel under the pickers.
        const keys = it.gauge.cursors;
        items.push(flGaugeNode(metadata, flightLevel, FALLBACK_FL.min, FALLBACK_FL.max, keys.length === 2 ? [keys[0]!, keys[1]!] : [keys[0]!], chrome));
      } else if (it.text !== undefined) {
        items.push({ kind: "text", value: evalTemplate(it.text, metadata, fmt) });
        textLines++;
      }
    }
    // An UNFRAMED panel stacking a glyph carousel over its text mirrors the canvas
    // call-out (glyph ABOVE the anchored text block): pin the card at its TEXT block's
    // centre so select/unselect don't jump. Framed panels sit plain on the anchor.
    const textH = textLines * fontPx * 1.3;
    const glyphH = 32; // sprite intrinsic px (the carousel renders it 1:1)
    const panel: MarkerWidget = {
      id,
      anchor: { lon: callout.at[0]!, lat: callout.at[1]! },
      ...(framed
        ? { bg: style.text?.background ?? "#ffffff", border: ink, radius: "small" }
        : hasGlyphCarousel
          ? { origin: { x: 0.5, y: (glyphH + textH / 2) / (glyphH + textH) } }
          : {}),
      // Inner padding is a SPACING token, independent of the frame: a framed card always pads
      // (b&w box), an UNFRAMED card pads too when it carries edge buttons (+/−) so they clear the
      // bare content. (The adapter currently only honours padding when framed — see the spec.)
      ...(framed || buttons.length ? { padding: card.pad ?? "large" } : {}),
      font: { color: ink, size: fontPx },
      child: { dir: "v", align: "center", gap: card.gap ?? 0, items },
      ...(buttons.length ? { buttons } : {}),
    };
    return [panel, ...(satellites ? satellites(input) : [])];
  };
}

// ── The STACK panel (a repeated list: the TEMSI cloud-layer area) ─────────────

/** Build ONE layer's editor body from the card items (pickers + FL gauge), with every control
 *  list-scoped (`<listField>.<i>.<field>`) so the controller routes the edit to that item via
 *  `updateListItem` — the same path as a jet break point. */
function compileLayerBody(
  d: PhenomenonDescriptor,
  listField: ListFieldDescriptor,
  item: Metadata,
  i: number,
  input: WidgetInput,
): WidgetNode {
  const card = d.card as CardSpec;
  const scope = `${listField.key}.${i}.`;
  const fmt: FormatContext = { metadata: item, flightLevel: flCtxWithFallback(input) };
  const itemEnum = (key: string): EnumFieldDescriptor | undefined =>
    listField.item.find((f): f is EnumFieldDescriptor => f.kind === "enum" && f.key === key);
  const items: WidgetNode[] = [];
  for (const it of card.items) {
    const pick = it.picker ?? it.carousel; // `carousel` = deprecated alias of `picker`
    if (pick) {
      const field = itemEnum(pick.field);
      if (!field) continue;
      const live = liveOptions(field, item); // honours `optionsBy` (amount-by-type), resolved per ITEM
      const value = live.some((o) => o.value === item[pick.field]) ? str(item[pick.field]) : (live[0]?.value ?? "");
      const labelTpl = pick.label;
      const options = live.map((o) => {
        const tip = (o.label && o.label !== o.value) ? { title: o.label } : {};
        if (labelTpl !== undefined) {
          const label = evalTemplate(labelTpl, item, fmt, { value: o.value });
          return { value: o.value, label, ...(o.label && o.label !== label ? { title: o.label } : {}) };
        }
        const svg = input.sprite?.(o.value);
        return svg ? { value: o.value, svg, ...tip } : { value: o.value, label: o.value, ...tip };
      });
      items.push({ kind: "text", value, control: "picker", ...(pick.mode ? { mode: pick.mode } : {}), name: `${scope}${pick.field}`, options, ...(input.chrome?.handle?.fill ? { color: input.chrome.handle.fill } : {}) });
    } else if (it.gauge) {
      // List-scoped FL gauge: feed `flGaugeNode` a scoped-metadata bag so its cursor NAMES
      // become `<listField>.<i>.<key>` (`layers.2.baseFL`) — routed through `updateListItem`.
      const keys = it.gauge.cursors;
      const scopedKeys = keys.map((k) => `${scope}${k}`);
      const scopedMeta: Metadata = {};
      for (const k of keys) scopedMeta[`${scope}${k}`] = item[k];
      items.push(
        flGaugeNode(
          scopedMeta,
          input.flightLevel,
          FALLBACK_FL.min,
          FALLBACK_FL.max,
          scopedKeys.length === 2 ? [scopedKeys[0]!, scopedKeys[1]!] : [scopedKeys[0]!],
          input.chrome,
        ),
      );
    } else if (it.text !== undefined) {
      items.push({ kind: "text", value: evalTemplate(it.text, item, fmt) });
    }
  }
  return { dir: "v", align: "center", gap: card.gap ?? 2, items };
}

/** Compile a multi-layer area's selected PANEL: the ACTIVE layer's flat card (pickers + FL text),
 *  framed in that layer's accent and anchored at the placed call-out. The per-layer FL bands + the
 *  add/remove all live on the side satellite (the multi-range gauge); the controller routes those
 *  events and keeps the list altitude-sorted. */
function compileLayerPanel(
  d: PhenomenonDescriptor,
  satellites: ((input: WidgetInput) => MarkerWidget[]) | undefined,
): (input: WidgetInput) => MarkerWidget[] | null {
  const card = d.card as CardSpec;
  const repeat = d.repeat!;
  const listField = (d.fields ?? []).find((f): f is ListFieldDescriptor => f.kind === "list" && f.key === repeat.listField);
  if (!listField) fail(d.type, `repeat.listField "${repeat.listField}" is not a list field`);
  const r = d.render as RenderSpec | undefined;
  const inkOf = compileInk(r?.ink);
  const framed = card.framed !== false;
  // Card-edge buttons (everything but the `place:"anchor"` draw, which the controller relocates
  // to the arrow-tip): the layer panel carries them too — e.g. the non-convective cloud's
  // icing(top)/turbulence(bottom) composite buttons.
  const buttons = (card.buttons ?? [])
    .filter((b) => b.place !== "anchor")
    .map((b) => ({
      event: getAction(b.action),
      place: b.place as "left" | "right" | "h-edges" | "top" | "bottom",
      svg: resolveGlyph(b.svg ?? (b.action === "erase" ? "atlas:minus" : "atlas:plus")),
      bordered: true,
      ...(b.title !== undefined ? { title: b.title } : {}),
    }));

  return (input: WidgetInput): MarkerWidget[] | null => {
    const { id, metadata, editable, style, callout } = input;
    if (!editable || !callout) return null;
    const ink = framed ? (style.text?.color ?? "#1f2328") : inkOf(style, metadata);
    const fontPx = style.text?.size ?? 13;
    const layers = Array.isArray(metadata[listField.key]) ? (metadata[listField.key] as Metadata[]) : [];
    // The PANEL is ALWAYS just the ACTIVE layer's flat card (1 or N layers look identical) — the
    // per-layer FL bands + the `+` live on the side satellite (the multi-range gauge), never in the
    // panel. The active (edited) layer = the selected sub-item, else the top of the stack.
    const idx = input.sub != null && input.sub >= 0 && input.sub < layers.length ? input.sub : 0;
    const layer = layers[idx] ?? layers[0]!;
    // The body MIRRORS the deselected single cartouche (`callout.contentSingle` — amount / type /
    // top / base, each on its OWN line), with the enum lines (amount/type) swapped for pickers and
    // the FL lines kept as plain text (the side gauge edits them). Falls back to the compact
    // `repeat.preview` line if no contentSingle.
    const fmt: FormatContext = { metadata: layer, flightLevel: flCtxWithFallback(input) };
    const pickerFields = new Set(card.items.map((it) => (it.picker ?? it.carousel)?.field).filter((f): f is string => !!f));
    const flTmpls = (r?.callout?.contentSingle ?? []).filter((t) => ![...pickerFields].some((f) => t.includes(`{${f}`)));
    const flItems: WidgetNode[] = (flTmpls.length ? flTmpls.map((t) => evalTemplate(t, layer, fmt)) : [evalTemplate(repeat.preview, layer, fmt)])
      .map((value) => ({ kind: "text", value }));
    // The editing card takes the ACTIVE layer's accent — frame in that colour (so the card visually
    // belongs to the band being edited) over a very-light tint of it. The frame colour matches the
    // active range's band/handles exactly (same `layerColor`).
    const accent = layerColor(idx);
    const frame = { bg: lighten(accent, 0.9), border: accent, borderWidth: "medium" as const, radius: "small" as const };
    const flat: MarkerWidget = {
      id,
      anchor: { lon: callout.at[0]!, lat: callout.at[1]! },
      ...(framed ? frame : {}),
      ...(framed ? { padding: card.pad ?? "small" } : {}),
      font: { color: ink, size: fontPx },
      child: { dir: "v", align: "center", gap: card.gap ?? 2, items: [compileLayerBody(d, listField, layer, idx, input), ...flItems] },
      ...(buttons.length ? { buttons } : {}),
    };
    return [flat, ...(satellites ? satellites(input) : [])];
  };
}

// ── The MARKER card (a point whose widget IS the whole rendering) ─────────────

/** A marker descriptor: a point gesture with a permanent card and no `render`. */
function isMarker(d: PhenomenonDescriptor): boolean {
  return d.gesture.primitive === "point" && !d.render && !!d.card;
}

/** Resolve a glyph ref WITHOUT throwing (returns undefined if the atlas name is absent). */
function tryGlyph(ref: string): string | undefined {
  try {
    return resolveGlyph(ref);
  } catch {
    return undefined;
  }
}

function compileMarkerWidget(d: PhenomenonDescriptor): (input: WidgetInput) => MarkerWidget {
  const card = d.card as CardSpec;
  for (const it of card.items) if (it.glyph) checkGlyph(it.glyph);
  // The "named" state reads the FIRST input item's bound field (when-named framing).
  const nameField = card.items.find((i) => i.input)?.input?.field;
  // A picker reads its enum field's options (the descriptor's single source).
  const enumOf = (key: string): EnumFieldDescriptor | undefined =>
    (d.fields ?? []).find((f): f is EnumFieldDescriptor => f.kind === "enum" && f.key === key);

  return (input: WidgetInput): MarkerWidget => {
    const { id, geometry, metadata, editable, style, sprite, chrome } = input;
    const [lon, lat] = geometry.type === "Point" ? (geometry.coordinates as [number, number]) : [0, 0];
    const ink = style.color; // glyph + card frame
    const textInk = style.text?.color ?? ink; // name/coord may deviate, else follow the ink
    const name = nameField ? str(metadata[nameField], "") : "";
    // Box + coord show only while editing (selected) or once named; else just the glyph.
    const framed = card.framed === true || (card.framed === "when-named" && (editable || name !== ""));
    // The glyph for an enum option (its `glyph`, else the live sprite, else `atlas:{value}`).
    const optGlyph = (o: { value: string; glyph?: GlyphSpec }): string | undefined =>
      (typeof o.glyph === "string" ? tryGlyph(o.glyph) : undefined) ?? sprite?.(o.value) ?? tryGlyph(`atlas:${o.value}`);
    const items: WidgetNode[] = [];
    for (const it of card.items) {
      const pick = it.picker ?? it.carousel; // `carousel` = deprecated alias
      if (pick) {
        const field = enumOf(pick.field);
        if (!field) continue;
        const live = liveOptions(field, metadata); // honours `optionsBy`
        const value = live.some((o) => o.value === metadata[pick.field]) ? str(metadata[pick.field]) : (live[0]?.value ?? "");
        if (editable) {
          // Interactive picker (adapter: carousel/flower/grid by option count, auto-degrading).
          const options = live.map((o) => {
            const svg = optGlyph(o);
            // Tooltip = the full human name when the glyph (or terse value) hides it (not for templates).
            if (svg) return { value: o.value, svg, ...(o.label && o.label !== o.value && !o.label.includes("{") ? { title: o.label } : {}) };
            // Option labels MAY be templates (e.g. the tropopause `kind` shows the FL: "{fl}" / "H\n{fl}").
            return { value: o.value, label: evalTemplate(o.label ?? o.value, metadata, { metadata }) };
          });
          // `size` also constrains the picker TRIGGER glyph while selected (the adapter maps it to
          // the control font-size, which sizes the glyph) — so selected matches the collapsed marker.
          items.push({ kind: "text", value, control: "picker", ...(pick.mode ? { mode: pick.mode } : {}), name: pick.field, options, ...(it.size ? { size: it.size } : {}), ...(chrome?.handle?.fill ? { color: chrome.handle.fill } : {}) });
        } else {
          // Collapsed (not selected): the chosen symbol's glyph; or, for a TEXT picker, its
          // (template-evaluated) label — so a shaped FL box (tropopause) stays visible unselected.
          const svg = optGlyph({ value });
          if (svg) items.push({ kind: "glyph", svg, size: it.size ?? 26, color: ink });
          else {
            const cur = live.find((o) => o.value === value);
            items.push({ kind: "text", value: evalTemplate(cur?.label ?? value, metadata, { metadata }) });
          }
        }
      } else if (it.glyph) {
        items.push({ kind: "glyph", svg: glyphFor(it.glyph, lat), size: it.size ?? 26, color: ink });
      } else if (it.input) {
        if (editable) items.push({ kind: "text", value: name, editable: true, control: "input", name: it.input.field, autofocus: true });
        else if (name !== "") items.push({ kind: "text", value: name });
      } else if (it.coord) {
        if (framed) items.push({ kind: "coord" });
      } else if (it.text !== undefined) {
        items.push({ kind: "text", value: evalTemplate(it.text, metadata, { metadata }) });
      }
    }
    // Frame outline driven by an enum field (the tropopause spot: rect / pentagon-up / -down).
    const shapeBy = card.boxShapeBy;
    const boxShape = shapeBy ? (shapeBy.map[str(metadata[shapeBy.field])] as BoxShape | undefined) : undefined;
    // Read-only unification: a NON-selected marker/card (volcano / TC / radioactive / pressure centre /
    // tropopause-spot / WMO point) renders as a static SPRITE, like every other unselected annotation —
    // only the SELECTED one stays a live DOM card (input / picker / delete). Its hit surfaces as
    // `text-boxes`+featureId on a Point feature, which the controller already routes to select +
    // drag-to-move-the-point, so interaction is unchanged. The adapter sprite rasterizer now replicates
    // a non-rect `boxShape` (the tropopause high/low PENTAGON), so no exception is needed — it sprites too.
    return {
      id,
      ...(editable ? {} : { static: true as const }),
      anchor: { lon, lat },
      origin: card.origin ?? "center",
      // A delete ✕ when selected — the name <input> swallows Delete/Backspace, so the
      // keyboard delete can't reach the controller; the card button fires `onWidgetDelete`.
      deletable: card.deletable === true && editable,
      ...(framed ? { bg: "#ffffff", border: ink, radius: "small", padding: "small" } : {}),
      ...(boxShape ? { boxShape } : {}),
      font: { color: textInk, size: style.text?.size ?? 13, ...(card.lineHeight != null ? { lineHeight: card.lineHeight } : {}) },
      child: { dir: "v", align: "center", gap: 2, items },
    };
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function fail(type: string, msg: string): never {
  throw new Error(`Invalid phenomenon descriptor "${type}": ${msg}`);
}

/** Structural validation (compile-time). Name resolution (glyphs, generators,
 *  formats, actions) happens in the compile steps themselves — every unknown
 *  name throws listing the available ones. */
export function validateDescriptor(d: PhenomenonDescriptor): void {
  if (d.schemaVersion !== 1) fail(d.type ?? "?", `unsupported schemaVersion ${String(d.schemaVersion)} (expected 1)`);
  if (!d.type) fail("?", "missing type");
  if (!d.label) fail(d.type, "missing label");
  if (!d.gesture?.primitive) fail(d.type, "missing gesture.primitive");
  if (!d.style?.color) fail(d.type, "missing style.color");
  for (const f of d.fields ?? []) {
    if (!f.key) fail(d.type, "a field is missing its key");
    if (f.kind === "enum" && !f.options?.length) fail(d.type, `enum field "${f.key}" has no options`);
  }
  for (const it of d.card?.items ?? []) {
    const keys = (["text", "glyph", "input", "coord", "picker", "carousel", "gauge", "dial"] as const).filter((k) => it[k] !== undefined);
    if (keys.length !== 1) fail(d.type, `a card item must set exactly ONE of text/glyph/input/coord/picker/gauge/dial (got ${keys.join("+") || "none"})`);
  }
  for (const sat of d.satellites ?? []) {
    if (!sat.part) fail(d.type, "a satellite is missing its part id");
    if (!sat.items?.length) fail(d.type, `satellite "${sat.part}" has no items`);
  }
}

// ── The interpreter ───────────────────────────────────────────────────────────

/** Compile a pure-JSON descriptor into a {@link PhenomenonDef}. */
export function defFromDescriptor(d: PhenomenonDescriptor): PhenomenonDef {
  validateDescriptor(d);

  const icon = toolbarIcon(resolveGlyph(d.icon ?? `atlas:${d.type}`));
  const schema = (d.fields ?? []).map(compileField);
  const summary = d.summary;

  const base: PhenomenonDef = {
    type: d.type,
    label: d.label,
    icon,
    primitives: primitivesOf(d.gesture),
    draw: compileDraw(d.gesture),
    schema,
    decorate: () => [],
    style: d.style,
    ...(summary !== undefined
      ? { summary: (m: Metadata) => evalTemplate(summary, m, { metadata: m }) }
      : {}),
    ...(d.flBeyond ? { flBeyond: d.flBeyond } : {}),
  };

  if (isMarker(d)) {
    return { ...base, widget: compileMarkerWidget(d) };
  }

  const decorate = compileDecorate(d);
  const satellites = compileSatellites(d);
  // A LINE label flagged `movable` slides along the line (controller adds a drag handle).
  const rr = d.render as (RenderSpec & RenderByGeometry) | undefined;
  const movableLabel = !!(rr?.line?.label?.movable ?? (rr?.label && (rr as RenderSpec).label?.movable));
  // A decorated line whose decorator carries `"motion": true` (the fronts) grows a movement
  // arrow: the controller paints a 360° direction handle on its tip (drag → `metadata.motionDir`).
  const motionArrow = (rr?.decorations ?? []).some((dec) => (dec as Record<string, unknown>)["motion"] === true);
  // A by-geometry render (line/point) WITH a card = a line-or-spot phenomenon whose SPOT is an
  // always-shown card (e.g. the tropopause `kind` carousel: rect / pentagon-up / -down), while
  // the CONTOUR keeps its decorated label. An area card (RenderSpec) still replaces its call-out.
  const byGeomRender = !!(d.render && ("line" in d.render || "point" in d.render));
  const markerCard = d.card && byGeomRender ? compileMarkerWidget(d) : undefined;
  const widget = d.card
    ? (markerCard
        ? (input: WidgetInput): MarkerWidget[] | null => {
            if (input.geometry.type === "Point") {
              const sats = satellites && input.editable ? satellites(input) : [];
              return [markerCard(input), ...sats];
            }
            return satellites && input.editable ? (satellites(input).length ? satellites(input) : null) : null;
          }
        : d.repeat
          ? compileLayerPanel(d, satellites) // the multi-layer panel (the TEMSI cloud-layer area)
          : compilePanelWidget(d, satellites)) // the panel replaces the placed call-out (areas)
    : satellites
      ? (input: WidgetInput): MarkerWidget[] | null => {
          if (!input.editable) return null;
          const cards = satellites(input);
          return cards.length ? cards : null;
        }
      : undefined;
  // The controller reads `repeat` to route the layers' add/remove/select + keep the list sorted.
  const repeat = d.repeat
    ? { listField: d.repeat.listField, min: d.repeat.min, max: d.repeat.max }
    : undefined;
  // A card button with `place: "anchor"` is relocated OFF the card to the feature's arrow-tip
  // (the controller paints it there as a floating badge). Resolve its glyph once at compile time.
  const anchorBtnSpec = ((d.card as CardSpec | undefined)?.buttons ?? []).find((b) => b.place === "anchor");
  const anchorButton = anchorBtnSpec
    ? { event: getAction(anchorBtnSpec.action), svg: resolveGlyph(anchorBtnSpec.svg ?? "atlas:plus"), ...(anchorBtnSpec.title !== undefined ? { title: anchorBtnSpec.title } : {}) }
    : undefined;
  return { ...base, decorate, ...(widget ? { widget } : {}), ...(movableLabel ? { movableLabel } : {}), ...(motionArrow ? { motionArrow: true } : {}), ...(repeat ? { repeat } : {}), ...(anchorButton ? { anchorButton } : {}), ...(d.composites ? { composites: d.composites } : {}) };
}
