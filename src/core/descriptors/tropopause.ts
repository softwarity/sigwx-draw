/**
 * Tropopause descriptor — the height of the tropopause as a SINGLE flight level,
 * WAFC post-2025 representation (ICAO SIGWX guide §3.9), in PURE JSON. Two forms,
 * distinguished ONLY by the drawn geometry (the primitive IS the kind):
 *   • a SPOT height → a Point, the FL in a small rectangle (Annex 3);
 *   • a CONTOUR     → a LineString, a thin blue DOTTED iso-line, its FL at the middle.
 * One metadata field (`fl`); the FL shows EXPLICITLY even off-chart (no `flBeyond`).
 * The H/L maximum/minimum markers are deliberately NOT modelled (§3.9.1).
 */
import type { PhenomenonDescriptor } from "../descriptor/types.js";

export const TROPOPAUSE_DESCRIPTOR: PhenomenonDescriptor = {
  schemaVersion: 1,
  type: "tropopause",
  label: "Tropopause",
  gesture: { primitive: "polyline", draw: "lasso-or-spot", smooth: true, minVertices: 2 },
  fields: [{ key: "fl", kind: "fl", label: "Flight level", default: 380 }],
  render: {
    // A real drag draws the CONTOUR: thin dotted iso-line + the FL at the arc-length
    // middle, un-boxed (the white halo punches a clean gap in the dotted line).
    line: {
      edge: { treatment: "dash", width: 2, dash: [6, 3] },
      label: { anchor: "geometry-mid", content: ["{fl|fl}"] },
    },
    // A click (or a too-short stroke) drops the SPOT height: the FL in a small white
    // rectangle (the box is the ONLY visual difference from the contour label).
    point: {
      label: { anchor: "geometry-mid", content: ["{fl|fl}"], box: true },
    },
  },
  // When SELECTED, a small satellite card (the 1-cursor FL gauge) floats beside the FL
  // label — the canvas box/label itself stays rendered (no panel replaces it).
  satellites: [
    { part: "gauge", anchor: "geometry-mid", pin: "flRef", side: "right", items: [{ gauge: { cursors: ["fl"] } }] },
  ],
  // A thin blue dotted iso-line; the FL label is the same blue (boxed only for a spot).
  // Dashes: the solid run is 2× the gap — `[on, off]`, on = 2 × off.
  style: {
    color: "#0b6bcb",
    edge: { color: "#0b6bcb", width: 2, dash: [6, 3] },
    text: { color: "#0b6bcb", halo: "#ffffff", size: 13, background: "#ffffff" },
  },
  summary: "Tropopause {fl|fl}",
};
