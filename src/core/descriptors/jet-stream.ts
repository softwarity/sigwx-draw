/**
 * Jet stream descriptor — a smooth, directional curve whose per-segment data lives
 * in a LIST of break points (each at a parametric `t` on the curve, carrying
 * speed + FL, and top/base at the max-wind point ≥120 kt). The rendering (WAFC
 * guide §3.5 — axis, arrowhead, barb clusters, change bars, FL call-outs, depth
 * box) is the `jet-barbs` NAMED DECORATOR — the one extension the eight WAFS
 * phenomena need; everything else here is plain JSON.
 *
 * This is the proof that the architecture handles geometric points (the curve)
 * AND business points (the breaks) that follow the curve but are dissociated.
 */
import { registerExtensions } from "../descriptor/extensions.js";
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import { jetBarbs } from "../extensions/jet-barbs.js";

// EXPLICIT registration, before any compilation of this descriptor. (Never a bare
// side-effect import: the package is `sideEffects: false`, bundlers drop those —
// the named binding below is USED, so the module always ships and runs.)
registerExtensions({ decorators: { "jet-barbs": jetBarbs } });

export const JET_STREAM_DESCRIPTOR: PhenomenonDescriptor = {
  schemaVersion: 1,
  type: "jetStream",
  label: "Jet stream",
  gesture: { primitive: "polyline", draw: "lasso", smooth: true, directional: true, minVertices: 2 },
  fields: [
    {
      key: "points",
      kind: "list",
      label: "Break points",
      itemLabel: "#{#} · {speed|round}KT",
      // Default = start / centre / end all at the 80 KT floor → a bare jet with no
      // barbs. The forecaster raises points (path-bound sliders) to build the profile.
      default: [
        { t: 0, speed: 80, fl: 300 },
        { t: 0.5, speed: 80, fl: 300 },
        { t: 1, speed: 80, fl: 300 },
      ],
      item: [
        { key: "speed", kind: "number", label: "Speed", unit: "kt", min: 80, max: 250, step: 5, default: 100 },
        { key: "fl", kind: "fl", label: "Flight level", default: 300 },
        // The 80 kt-isotach depth shows from 120 kt (fig 9) — declarative conditions.
        { key: "top", kind: "fl", label: "Extent top", default: 340, when: { field: "speed", gte: 120 } },
        { key: "base", kind: "fl", label: "Extent base", default: 260, when: { field: "speed", gte: 120 } },
      ],
    },
  ],
  render: {
    decorations: [{ use: "jet-barbs", listField: "points", floor: 80, depthAt: 120 }],
  },
  // The SELECTED break point's editor: the DIAL (wind speed) ringed ON the point +
  // the FL gauge floating right of it (1→3 cursors past 120 kt, list-scoped names).
  satellites: [
    { part: "dial", anchor: "break-point", side: "center", items: [{ dial: { field: "speed" } }] },
    { part: "gauge", anchor: "break-point", pin: "flRef", side: "right", items: [{ gauge: { cursors: ["fl"], extent: ["base", "top"] } }] },
  ],
  // A jet is just an arrow (axis + feathers + pennants + arrowhead) and FL text.
  style: {
    color: "#1f2328",
    arrow: { color: "#1f2328", width: 3 },
    text: { color: "#1f2328", halo: "#ffffff", size: 13 },
  },
  summary: "Jet max {points|maxof:speed}KT",
  declutter: { chrome: true, late: ["arrowhead"] }, // the arrowhead carries the DIRECTION
};
