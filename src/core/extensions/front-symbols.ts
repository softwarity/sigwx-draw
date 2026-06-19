/**
 * `front-symbols` — the named decorator for TEMSI fronts (TEMSI family B):
 * a smooth line with the WMO front pips placed at a constant SCREEN interval along it,
 * on the warm side. Classic surface fronts:
 *   • `cold`       — filled triangles (blue), pointing to the warm side;
 *   • `warm`       — filled semicircles (red), bulging to the warm side;
 *   • `occluded`   — triangles AND semicircles alternating (purple);
 *   • `stationary` — triangles on the warm side, semicircles on the cold side, alternating
 *                    (blue triangles + red semicircles).
 * `"dashed": true` keeps the SAME pips but breaks the base line — the WMO "above surface"
 * (upper / aloft) front variant: identical symbols, discontinuous line.
 * TEMSI line phenomena (same machinery — a line carrying a periodic WMO symbol):
 *   • `convergence` — solid line + open chevrons pointing along it (convergence line);
 *   • `itcz`        — double parallel line + periodic crossing ticks (ITCZ);
 *   • `squall`      — dashed line + periodic "^" carets (severe squall line, red).
 *
 * Registered as a built-in through the SAME mechanism a host would use; the front
 * descriptors register it EXPLICITLY (never a bare side-effect import — `sideEffects:false`).
 * A descriptor mounts it with `"decorations": [{ "use": "front-symbols", "frontType": "cold" }]`.
 */
import {
  add,
  catmullRom,
  coordsOf,
  frameK,
  lineFeature,
  perpLeft,
  pointAtFraction,
  polygonFeature,
  polylineLength,
  scale,
  toLonLat,
  toPlanar,
  unit,
} from "../decorate/index.js";
import type { Pt } from "../decorate/index.js";
import type { DecorationInput, RenderFeature } from "../phenomenon.js";
import type { PhenomenonStyle } from "../style.js";

type FrontType = "cold" | "warm" | "occluded" | "stationary";
type LineType = "convergence" | "itcz" | "squall";

/** WMO front colours (the ink drives the line + the pips). */
const FRONT_INK: Record<FrontType, { warm: string; cold: string }> = {
  cold: { warm: "#2c5fb3", cold: "#2c5fb3" }, // blue
  warm: { warm: "#d1242f", cold: "#d1242f" }, // red
  occluded: { warm: "#8250df", cold: "#8250df" }, // purple
  stationary: { warm: "#d1242f", cold: "#2c5fb3" }, // red pips warm side, blue pips cold side
};

/** Default ink for the TEMSI line phenomena (overridable via `style.color`). */
const LINE_INK: Record<LineType, string> = {
  convergence: "#1f2328", // neutral dark
  itcz: "#1f2328",
  squall: "#d1242f", // convective ⇒ red
};

/** A filled triangle (cold-front pip): base on the line, apex on the `sideSign` side. */
function triangle(p: Pt, tan: Pt, sideSign: number, half: number, size: number, k: ReturnType<typeof frameK>, ink: string): RenderFeature {
  const along = scale(unit(tan), half);
  const perp = scale(perpLeft(tan), sideSign * size);
  const a = toLonLat([p[0] - along[0], p[1] - along[1]], k);
  const b = toLonLat([p[0] + along[0], p[1] + along[1]], k);
  const apex = toLonLat(add(p, perp), k);
  return polygonFeature([a, apex, b, a], { layer: "decoration", fillColor: ink, fillOpacity: 1, stroke: ink, strokeWidth: 1 });
}

/** A filled semicircle (warm-front pip): base on the line, bulging on the `sideSign` side. */
function semicircle(p: Pt, tan: Pt, sideSign: number, r: number, k: ReturnType<typeof frameK>, ink: string): RenderFeature {
  const t = unit(tan);
  const n = perpLeft(t); // left normal
  const ring: Pt[] = [];
  const STEPS = 10;
  for (let i = 0; i <= STEPS; i++) {
    const ang = (i / STEPS) * Math.PI; // 0..π along the arc
    // base axis = tangent (±r), bulge axis = normal (× sideSign)
    const cx = p[0] + t[0] * r * Math.cos(ang) + n[0] * sideSign * r * Math.sin(ang);
    const cy = p[1] + t[1] * r * Math.cos(ang) + n[1] * sideSign * r * Math.sin(ang);
    ring.push([cx, cy]);
  }
  ring.push(ring[0]!);
  return polygonFeature(ring.map((c) => toLonLat(c, k)), { layer: "decoration", fillColor: ink, fillOpacity: 1, stroke: ink, strokeWidth: 1 });
}

/** An open polyline glyph (chevron ">" / caret "^") sitting on the line. */
function strokeGlyph(pts: Pt[], k: ReturnType<typeof frameK>, ink: string, width: number): RenderFeature {
  return lineFeature(pts.map((c) => toLonLat(c, k)), { layer: "decoration", stroke: ink, strokeWidth: width });
}

/** The 3 TEMSI line phenomena: one ink, a typed base line + a periodic stroke glyph. */
function lineSymbols(
  type: LineType,
  dense: Pt[],
  planar: Pt[],
  total: number,
  k: ReturnType<typeof frameK>,
  px: number,
  style: PhenomenonStyle,
): RenderFeature[] {
  const ink = style.edge?.color ?? style.color ?? LINE_INK[type];
  const width = style.edge?.width ?? 2.4;
  const out: RenderFeature[] = [];

  // Squall line (WMO severe-squall-line): a DASHED base line carrying open "Λ" teeth that
  // point to one side — feet ON the line, apex off it ⇒ "—Λ—Λ—". The line meets each tooth
  // on its slanted SIDES (the Λ has no horizontal base), never bisecting it.
  if (type === "squall") {
    out.push(lineFeature(dense, { layer: "edge", stroke: ink, strokeWidth: width, dash: [10, 6] })); // FIXED screen-constant dash (see aloft note) — never px*N, else solid on a real map
    const spacing = px * 38;
    const half = px * 7; // half the foot span
    const up = px * 5; // apex pokes this far ABOVE the line
    const down = px * 10; // feet hang this far BELOW the line ⇒ the Λ straddles (crosses) the line
    for (let d = spacing; d < total - spacing * 0.3; d += spacing) {
      const st = pointAtFraction(planar, d / total);
      const p = st.p as Pt;
      const t = unit(st.dir as Pt);
      const n = perpLeft(t);
      const apex = add(p, scale(n, up));
      const footL = add(add(p, scale(n, -down)), scale(t, -half));
      const footR = add(add(p, scale(n, -down)), scale(t, half));
      out.push(strokeGlyph([footL, apex, footR], k, ink, width));
    }
    return out;
  }

  if (type === "itcz") {
    // double parallel line: offset every vertex by ±normal·off (per-vertex tangent)
    const off = px * 4;
    const offset = (sign: number): Pt[] =>
      planar.map((p, i) => {
        const a = planar[Math.max(0, i - 1)]!;
        const b = planar[Math.min(planar.length - 1, i + 1)]!;
        const t = unit([b[0] - a[0], b[1] - a[1]] as Pt);
        const n = perpLeft(t);
        return add(p, scale(n, off * sign));
      });
    out.push(lineFeature(offset(+1).map((c) => toLonLat(c, k)), { layer: "edge", stroke: ink, strokeWidth: width }));
    out.push(lineFeature(offset(-1).map((c) => toLonLat(c, k)), { layer: "edge", stroke: ink, strokeWidth: width }));
  } else {
    // convergence: a solid base line
    out.push(lineFeature(dense, { layer: "edge", stroke: ink, strokeWidth: width }));
  }

  const spacing = px * 40;
  const size = px * 7;
  for (let d = spacing; d < total - spacing * 0.3; d += spacing) {
    const st = pointAtFraction(planar, d / total);
    const p = st.p as Pt;
    const t = unit(st.dir as Pt);
    const n = perpLeft(t);
    if (type === "convergence") {
      // ">" pointing along travel: arms at p±n·size, apex ahead at p+t·size
      const apex = add(p, scale(t, size));
      const armA = add(p, scale(n, size));
      const armB = add(p, scale(n, -size));
      out.push(strokeGlyph([armA, apex, armB], k, ink, width));
    } else {
      // itcz: a short tick crossing both lines (−normal..+normal)
      const a = add(p, scale(n, px * 5));
      const b = add(p, scale(n, -px * 5));
      out.push(strokeGlyph([a, b], k, ink, width));
    }
  }
  return out;
}

export function frontSymbols(input: DecorationInput, params: Record<string, unknown>): RenderFeature[] {
  const { geometry, style, resolution } = input;
  const type = (typeof params["frontType"] === "string" ? params["frontType"] : "cold") as FrontType | LineType;
  const coords = coordsOf(geometry);
  if (coords.length < 2) return [];

  const k = frameK(coords);
  const dense = catmullRom(coords as Pt[], 16);
  const planar = dense.map((c) => toPlanar(c, k));
  const total = polylineLength(planar);
  if (total <= 0) return [];

  // Constant SCREEN sizing (no resolution = headless: a sensible fraction of the line).
  const px = resolution && resolution > 0 ? resolution : total / 600;

  if (type === "convergence" || type === "itcz" || type === "squall") {
    return lineSymbols(type, dense, planar, total, k, px, style);
  }

  const ink = FRONT_INK[type] ?? FRONT_INK.cold;
  const out: RenderFeature[] = [];
  const w = style.edge?.width ?? 2.5;
  const PIP_GAP = 34; // distance between pips, in SCREEN px (pip spacing below = px*PIP_GAP)
  // The base line carries the warm-side ink (occluded purple, stationary defaults to red).
  // `dashed` ⇒ "above surface" (aloft) front: same pips, broken line. The dash MUST be a FIXED
  // pattern (line-width units, screen-constant) — NOT scaled by `px=resolution`, which on a real map
  // balloons the array so the single "on" run swallows the whole line ⇒ it looks solid (the "dashes
  // vanish on commit" bug). MapLibre `line-dasharray` is in WIDTH units, so divide by `w`; we MATCH the
  // dash PERIOD to the pip spacing (PIP_GAP screen px) so every gap lands BETWEEN decorations, not
  // under one (else the dash beats against the pips and a gap creeps under each symbol = "see nothing").
  const dashed = params["dashed"] === true;
  const period = PIP_GAP / w; // width-units → one full dash per pip interval
  out.push(
    lineFeature(dense, {
      layer: "edge",
      stroke: ink.warm,
      strokeWidth: w,
      ...(dashed ? { dash: [period * 0.6, period * 0.4] } : {}),
    }),
  );

  const spacing = px * PIP_GAP; // distance between pips
  const size = px * 8; // pip height / radius
  const half = px * 6; // triangle half-base

  // Warm side = left of travel by default (a host can flip via metadata later). Stationary
  // alternates the side; occluded alternates the shape.
  let i = 0;
  for (let d = spacing; d < total - spacing * 0.3; d += spacing) {
    const st = pointAtFraction(planar, d / total);
    const tan = st.dir as Pt;
    if (type === "cold") {
      out.push(triangle(st.p as Pt, tan, +1, half, size, k, ink.warm));
    } else if (type === "warm") {
      out.push(semicircle(st.p as Pt, tan, +1, size, k, ink.warm));
    } else if (type === "occluded") {
      out.push(i % 2 === 0 ? triangle(st.p as Pt, tan, +1, half, size, k, ink.warm) : semicircle(st.p as Pt, tan, +1, size, k, ink.warm));
    } else {
      // stationary: blue triangle on the cold side, red semicircle on the warm side, alternating
      out.push(i % 2 === 0 ? triangle(st.p as Pt, tan, -1, half, size, k, ink.cold) : semicircle(st.p as Pt, tan, +1, size, k, ink.warm));
    }
    i++;
  }
  return out;
}
