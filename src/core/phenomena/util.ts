/** Shared helpers for the built-in phenomenon defs. */
import type { WidgetCursor, WidgetGauge, WidgetRange } from "@softwarity/draw-adapter";

import type { Geometry, Position } from "geojson";

import type { LatLng } from "../coord.js";
import type { Metadata } from "../phenomenon.js";
import type { PhenomenonStyle } from "../style.js";

/** A `−` glyph for the card's ERASER button ("erase" — rub a clear hole into the area). */
export const MINUS_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12 H18"/></svg>';

/** A `+` glyph for a selected area card's transient edge action buttons ("draw-more"). */
export const PLUS_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 6 V18 M6 12 H18"/></svg>';

/** Fixed track length (px) of the multi-range stack gauge — ~3× the gauges-editor card (~76px), held
 *  STABLE so the slider never resizes with the chart's FL extent (that variation lands on the ticks). */
export const GAUGE_STACK_LENGTH = 230;

export const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
export const fl = (v: unknown): string => `FL${String(Math.round(num(v))).padStart(3, "0")}`;

/** Average of a coordinate ring/line — a cheap label anchor. */
export function centroid(coords: Position[]): Position {
  if (!coords.length) return [0, 0];
  let x = 0;
  let y = 0;
  for (const c of coords) {
    x += c[0]!;
    y += c[1]!;
  }
  return [x / coords.length, y / coords.length];
}

/**
 * Area-weighted polygon centroid (shoelace) — the TRUE geometric centre of a
 * ring, robust to uneven vertex spacing (unlike {@link centroid}, the vertex
 * mean, which a freehand outline's clustered points skew badly). Drops a closing
 * duplicate vertex; falls back to the mean for a degenerate (zero-area) ring.
 */
export function ringCentroid(ring: Position[]): Position {
  const closed =
    ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const n = pts.length;
  if (n < 3) return centroid(ring);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % n]!;
    const f = x0! * y1! - x1! * y0!;
    a += f;
    cx += (x0! + x1!) * f;
    cy += (y0! + y1!) * f;
  }
  if (Math.abs(a) < 1e-9) return centroid(ring);
  return [cx / (3 * a), cy / (3 * a)];
}

/** Concrete text-box paint props from a phenomenon style. */
export function textBoxProps(style: PhenomenonStyle): {
  textColor: string;
  textSize: number;
  textHalo: string;
  textBackground: string;
  textBorder: string;
} {
  return {
    textColor: style.text?.color ?? "#111111",
    textSize: style.text?.size ?? 13,
    textHalo: style.text?.halo ?? "#ffffff",
    textBackground: style.text?.background ?? "#ffffff",
    textBorder: style.color, // leader/box ink — decorates override with the resolved ink
  };
}

/** A regular polygon (closed ring) of `n` points around a centre. */
export function regularPolygon(c: LatLng, span: number, n = 5): Geometry {
  const rx = span * 0.18;
  const ry = span * 0.18;
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    ring.push([c.lon + rx * Math.cos(ang), c.lat + ry * Math.sin(ang)]);
  }
  ring.push(ring[0]!); // close
  return { type: "Polygon", coordinates: [ring] };
}

/** Card FL gauge (1–2 cursors), the widget sibling of the old canvas gauge: 5-FL steps,
 *  chart bounds from the resolved `flightLevel` (falling back to the def's own range),
 *  an off-chart "XXX" notch per `beyond` side, labels following the call-out convention. */
export function flGaugeNode(
  metadata: Metadata,
  flightLevel: { min?: number; max?: number; beyond?: [string, string] } | undefined,
  defMin: number,
  defMax: number,
  keys: [string] | [string, string],
  chrome?: { line?: { color?: string }; handle?: { fill?: string; stroke?: string }; text?: { color?: string; halo?: string } },
): WidgetGauge {
  const min = num(flightLevel?.min, defMin);
  const max = num(flightLevel?.max, defMax);
  const xxx = (i: 0 | 1): boolean => (flightLevel?.beyond?.[i] ?? "clamp") === "xxx";
  const lbl = (v: number): string => (v < min || v > max ? "XXX" : String(Math.round(v)).padStart(3, "0"));
  const cursor = (key: string, fallback: number): WidgetCursor => {
    const v = num(metadata[key], fallback);
    return { name: key, value: v, label: lbl(v) };
  };
  return {
    kind: "gauge",
    min,
    max,
    step: 5,
    // ≈ 0.5 px/FL — the old canvas density, consistent across every gauge card.
    length: Math.min(200, Math.max(110, Math.round((max - min) * 0.5))),
    beyond: { below: xxx(0), above: xxx(1) },
    cursors: keys.length === 2 ? [cursor(keys[0], min), cursor(keys[1]!, max)] : [cursor(keys[0], Math.round((min + max) / 2))],
    // The editing-chrome styles, like the old canvas controls: track = line ink, labels =
    // control text colour + halo, knobs = the control-handle fill/stroke.
    ...(chrome?.line?.color ? { color: chrome.line.color } : {}),
    ...(chrome?.text?.color ? { labelColor: chrome.text.color } : {}),
    ...(chrome?.text?.halo ? { labelHalo: chrome.text.halo } : {}),
    ...(chrome?.handle?.fill ? { knobFill: chrome.handle.fill } : {}),
    ...(chrome?.handle?.stroke ? { knobStroke: chrome.handle.stroke } : {}),
  };
}

/** Multi-range FL gauge (the multi-layer cloud-area editor): N overlapping `[base, top]` bands on ONE
 *  shared axis, one colour per layer (the adapter's `WidgetGauge.ranges` mode). Cursor names are
 *  list-scoped (`<listKey>.<i>.<baseKey|topKey>`) so a knob/band drag routes through
 *  `updateListItem`; `active` is the index rendered on top when knobs coincide. Same axis bounds
 *  / step / XXX notches / labels as {@link flGaugeNode}. */
export function flRangesNode(
  layers: Metadata[],
  listKey: string,
  flightLevel: { min?: number; max?: number; beyond?: [string, string] } | undefined,
  defMin: number,
  defMax: number,
  keys: [string, string],
  colorOf: (i: number) => string,
  activeIndex: number,
  chrome?: { text?: { color?: string; halo?: string }; handle?: { stroke?: string } },
): WidgetGauge {
  const min = num(flightLevel?.min, defMin);
  const max = num(flightLevel?.max, defMax);
  const xxx = (i: 0 | 1): boolean => (flightLevel?.beyond?.[i] ?? "clamp") === "xxx";
  const lbl = (v: number): string => (v < min || v > max ? "XXX" : String(Math.round(v)).padStart(3, "0"));
  const [bKey, tKey] = keys;
  const ranges: WidgetRange[] = layers.map((layer, i) => {
    const bv = num(layer[bKey], min);
    const tv = num(layer[tKey], max);
    return {
      id: String(i),
      base: { name: `${listKey}.${i}.${bKey}`, value: bv, label: lbl(bv) },
      top: { name: `${listKey}.${i}.${tKey}`, value: tv, label: lbl(tv) },
      color: colorOf(i),
    };
  });
  return {
    kind: "gauge",
    min,
    max,
    step: 5,
    // STABLE track length — the multi-range slider must NOT grow with the FL extent (a wider chart
    // would otherwise stretch the slider and shove the card sideways). Pinned at ~3× the editor
    // card (~76px tall → ~230px), and the card is constant (gauges editor shows only the ACTIVE
    // layer's pickers). The FL extent is absorbed by the TICKS instead: the adapter maps [min,max]
    // onto this fixed length, so a wider range just packs the step-5 notches tighter.
    length: GAUGE_STACK_LENGTH,
    beyond: { below: xxx(0), above: xxx(1) },
    ranges,
    active: activeIndex,
    ...(chrome?.text?.color ? { labelColor: chrome.text.color } : {}),
    ...(chrome?.text?.halo ? { labelHalo: chrome.text.halo } : {}),
    ...(chrome?.handle?.stroke ? { knobStroke: chrome.handle.stroke } : {}),
  };
}

/** Single feature-level FL band — the draggable `ranges` 1-band used by the base/top AREAS (CB, icing,
 *  turbulence/CAT) in place of the old 2-cursor gauge. Same axis / 5-FL step / XXX notches / labels as
 *  {@link flGaugeNode}, but rendered as ONE band whose MIDDLE is grabbable (base+top move together) —
 *  consistent with the multi-layer zone. `color` inks the band + knobs + labels in the phenomenon's
 *  identity colour (so the band stays VISIBLE/grab-able). Cursor names are feature-level (`baseKey`/
 *  `topKey`) so a knob/band drag routes through `onWidgetEdit` exactly like the gauge it replaces. Keeps
 *  the per-extent length (a single area's gauge size is unchanged), NOT the stack's fixed length. */
export function flBandNode(
  metadata: Metadata,
  flightLevel: { min?: number; max?: number; beyond?: [string, string] } | undefined,
  defMin: number,
  defMax: number,
  keys: [string, string],
  color: string,
): WidgetGauge {
  const min = num(flightLevel?.min, defMin);
  const max = num(flightLevel?.max, defMax);
  const xxx = (i: 0 | 1): boolean => (flightLevel?.beyond?.[i] ?? "clamp") === "xxx";
  const lbl = (v: number): string => (v < min || v > max ? "XXX" : String(Math.round(v)).padStart(3, "0"));
  const [bKey, tKey] = keys;
  const bv = num(metadata[bKey], min);
  const tv = num(metadata[tKey], max);
  const range: WidgetRange = {
    id: "0",
    base: { name: bKey, value: bv, label: lbl(bv) },
    top: { name: tKey, value: tv, label: lbl(tv) },
    color,
  };
  return {
    kind: "gauge",
    min,
    max,
    step: 5,
    length: Math.min(200, Math.max(110, Math.round((max - min) * 0.5))),
    beyond: { below: xxx(0), above: xxx(1) },
    ranges: [range],
    active: 0,
  };
}
