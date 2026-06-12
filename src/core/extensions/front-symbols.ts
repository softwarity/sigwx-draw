/**
 * `front-symbols` — the named decorator for TEMSI fronts (OBJECTS-ROADMAP.md family B):
 * a smooth line with the WMO front pips placed at a constant SCREEN interval along it,
 * on the warm side. Four `type`s:
 *   • `cold`       — filled triangles (blue), pointing to the warm side;
 *   • `warm`       — filled semicircles (red), bulging to the warm side;
 *   • `occluded`   — triangles AND semicircles alternating (purple);
 *   • `stationary` — triangles on the warm side, semicircles on the cold side, alternating
 *                    (blue triangles + red semicircles).
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

type FrontType = "cold" | "warm" | "occluded" | "stationary";

/** WMO front colours (the ink drives the line + the pips). */
const FRONT_INK: Record<FrontType, { warm: string; cold: string }> = {
  cold: { warm: "#2c5fb3", cold: "#2c5fb3" }, // blue
  warm: { warm: "#d1242f", cold: "#d1242f" }, // red
  occluded: { warm: "#8250df", cold: "#8250df" }, // purple
  stationary: { warm: "#d1242f", cold: "#2c5fb3" }, // red pips warm side, blue pips cold side
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

export function frontSymbols(input: DecorationInput, params: Record<string, unknown>): RenderFeature[] {
  const { geometry, style, resolution } = input;
  const type = (typeof params["frontType"] === "string" ? params["frontType"] : "cold") as FrontType;
  const coords = coordsOf(geometry);
  if (coords.length < 2) return [];

  const k = frameK(coords);
  const dense = catmullRom(coords as Pt[], 16);
  const planar = dense.map((c) => toPlanar(c, k));
  const total = polylineLength(planar);
  if (total <= 0) return [];

  const ink = FRONT_INK[type] ?? FRONT_INK.cold;
  const out: RenderFeature[] = [];
  // The base line carries the warm-side ink (occluded purple, stationary defaults to red).
  out.push(lineFeature(dense, { layer: "edge", stroke: ink.warm, strokeWidth: style.edge?.width ?? 2.5 }));

  // Constant SCREEN sizing (no resolution = headless: a sensible fraction of the line).
  const px = resolution && resolution > 0 ? resolution : total / 600;
  const spacing = px * 34; // distance between pips
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
