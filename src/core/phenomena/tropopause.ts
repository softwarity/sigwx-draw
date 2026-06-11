/**
 * Tropopause — the height of the tropopause as a SINGLE flight level, in the WAFC
 * post-2025 representation (ICAO SIGWX guide §3.9). Two forms, distinguished ONLY by
 * the drawn geometry (the primitive IS the kind — no type field):
 *   • a SPOT height → a Point, the FL in a small rectangle (Annex 3);
 *   • a CONTOUR     → a LineString, a thin blue DOTTED iso-line, its FL marked at
 *                     the middle (§3.9.2).
 * The only metadata is `fl` (no top/base, no enum — an iso-line carries one value
 * over its whole length). The H/L maximum/minimum markers are deliberately NOT
 * modelled — "no longer included" (§3.9.1).
 */
import type { MarkerWidget } from "@softwarity/draw-adapter";

import { catmullRom, frameK, lineFeature, pointAtFraction, pointFeature, toLonLat, toPlanar } from "../decorate/index.js";
import type { Pt } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature, WidgetInput } from "../phenomenon.js";
import { fl, flGaugeNode, num } from "./util.js";

/** Tropopause FL gauge clamp (FL250–600, the SWH chart range). The FL is shown
 *  EXPLICITLY even off-chart (Annex 3) — no "XXX" sentinel, hence no `flBeyond`. */
const FL_MIN = 250;
const FL_MAX = 600;

const decorate: DecorateFn = ({ geometry, metadata, style }) => {
  const ink = style.edge?.color ?? style.color;
  const tb = {
    textColor: style.text?.color ?? ink,
    textSize: style.text?.size ?? 13,
    textHalo: style.text?.halo ?? "#ffffff",
  };
  const label = fl(metadata["fl"]);

  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as Pt[];
    if (coords.length < 2) return [];
    const dense = catmullRom(coords, 16);
    // Thin blue DOTTED contour (§3.9.2).
    const out: RenderFeature[] = [
      lineFeature(dense, { layer: "edge", stroke: ink, strokeWidth: style.edge?.width ?? 2, dash: style.edge?.dash ?? [6, 3] }),
    ];
    // FL at the arc-length MIDDLE, un-boxed — the white halo punches a clean gap in
    // the dotted line behind the text (the WAFC contour label sits in a break).
    const k = frameK(dense);
    const mid = toLonLat(pointAtFraction(dense.map((c) => toPlanar(c, k)), 0.5).p, k);
    out.push(pointFeature(mid, { layer: "text-boxes", text: label, ...tb }));
    return out;
  }

  if (geometry.type === "Point") {
    // Spot height: the FL in a small white rectangle (Annex 3) — the box is the ONLY
    // visual difference from the contour label.
    return [
      pointFeature(geometry.coordinates, {
        layer: "text-boxes",
        text: label,
        ...tb,
        textBackground: style.text?.background ?? "#ffffff",
        textBorder: ink,
      }),
    ];
  }

  return [];
};

export const tropopause: PhenomenonDef = {
  type: "tropopause",
  label: "Tropopause",
  // Toolbar glyph: a wavy blue DOTTED contour with its FL below — the iconic
  // tropopause-height iso-line.
  icon:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 13 Q7 7 12 11 T22 8" stroke-dasharray="3.2 1.6"/>' +
    '<text x="12" y="21.5" font-size="6.2" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle" font-family="sans-serif">FL380</text>' +
    "</svg>",
  primitives: ["polyline", "point"],
  draw: {
    minVertices: 2,
    // Freehand: a press-drag stroke is a CONTOUR; a click (or a stroke too short on
    // screen to read as a line) collapses to a spot-height POINT (`pointWhenShort`).
    interaction: { primitive: "polyline", smooth: true, freehand: true, mode: "draw", pointWhenShort: true },
    defaultGeometry: (c) => ({ type: "Point", coordinates: [c.lon, c.lat] }),
  },
  schema: [{ type: "fl", key: "fl", label: "Flight level", default: 380, min: FL_MIN, max: FL_MAX }],
  decorate,
  // When SELECTED, a small SATELLITE card (just the 1-cursor FL gauge) floats beside the
  // FL label — the canvas box/label itself stays rendered (the card does not replace it).
  // The widget sibling of the old canvas single-FL gauge.
  widget: ({ id, geometry, metadata, editable, flightLevel, flRef, chrome }: WidgetInput): MarkerWidget | null => {
    if (!editable) return null;
    let at: Pt;
    if (geometry.type === "Point") {
      at = geometry.coordinates as Pt;
    } else if (geometry.type === "LineString" && geometry.coordinates.length >= 2) {
      // The contour's arc-length middle — where the FL label sits.
      const dense = catmullRom(geometry.coordinates as Pt[], 16);
      const k = frameK(dense);
      at = toLonLat(pointAtFraction(dense.map((c) => toPlanar(c, k)), 0.5).p, k);
    } else {
      return null;
    }
    const gauge = flGaugeNode(metadata, flightLevel, FL_MIN, FL_MAX, ["fl"], chrome);
    // Pin the card so the SELECTION-TIME level sits at the anchor's screen height (the
    // old canvas gauge's behaviour) — drag-stable since flRef is frozen at selection.
    const ref = typeof flRef === "number" ? flRef : num(metadata["fl"], (gauge.min + gauge.max) / 2);
    const yPin = 1 - (Math.max(gauge.min, Math.min(gauge.max, ref)) - gauge.min) / (gauge.max - gauge.min);
    return {
      id,
      anchor: { lon: at[0]!, lat: at[1]! },
      // x < 0 ⇒ the card floats just right of the label, clear of it.
      origin: { x: -0.5, y: yPin },
      child: { dir: "v", items: [gauge] },
    };
  },
  // A thin blue dotted iso-line; the FL label is the same blue (boxed only for a spot).
  style: {
    color: "#0b6bcb",
    // Dashes: the solid run is 2× the gap (per François) — `[on, off]`, on = 2 × off.
    edge: { color: "#0b6bcb", width: 2, dash: [6, 3] },
    text: { color: "#0b6bcb", halo: "#ffffff", size: 13, background: "#ffffff" },
  },
  summary: (m) => `Tropopause ${fl(m["fl"])}`,
};
