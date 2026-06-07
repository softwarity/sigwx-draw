/**
 * Wind barbs/pennants for jet streams. The number and kind of feathers is a pure
 * function of the wind speed (the SIGWX rule: pennant = 50 kt, full feather =
 * 10 kt, half feather = 5 kt), so the decomposition is unit-testable map-free.
 */
import type { RenderFeature, RenderProps } from "../phenomenon.js";
import { polygonFeature } from "./feature.js";
import { add, clamp, perpLeft, pointAtFraction, polylineLength, scale, sub, toLonLat, unit } from "./geo.js";
import type { Pt } from "./geo.js";

export interface BarbCounts {
  /** 50-kt pennants (triangles). */
  pennants: number;
  /** 10-kt full feathers. */
  full: number;
  /** 5-kt half feathers. */
  half: number;
}

/**
 * Feather side per WAFC §3.5.4 (low-pressure side): northern hemisphere → left
 * of the flow (+1), southern hemisphere → right (−1).
 */
export function featherSide(lat: number): 1 | -1 {
  return lat >= 0 ? 1 : -1;
}

/** Decompose a wind speed (kt, rounded to the nearest 5) into barb feathers. */
export function barbCounts(speedKt: number): BarbCounts {
  let s = Math.max(0, Math.round(speedKt / 5) * 5);
  const pennants = Math.floor(s / 50);
  s -= pennants * 50;
  const full = Math.floor(s / 10);
  s -= full * 10;
  const half = Math.floor(s / 5);
  return { pennants, full, half };
}

export interface WindBarbOptions {
  /** The dense, smoothed jet curve in the planar frame. */
  planar: Pt[];
  /** The planar frame's cos(lat₀), for un-projecting back to lon/lat. */
  k: number;
  /** Fraction (0..1) of the data point the barb sits at. */
  startT: number;
  speedKt: number;
  /** Feather length (perpendicular), planar degrees. */
  featherLen: number;
  /** Spacing between feathers along the axis, planar degrees. */
  gap: number;
  /** Feather/quad full thickness (planar degrees). Default `featherLen * 0.1`. */
  thickness?: number;
  /** Feather side: +1 = left of the flow (NH), −1 = right (SH). Default +1. */
  side?: 1 | -1;
  /** +1 if the flow runs with increasing `t` (default), −1 if reversed. */
  flowSign?: 1 | -1;
  /** Keep this much arc free at the downstream tip (room for the arrowhead). */
  endMargin?: number;
  /** Render props applied to every feather (e.g. `{ layer, stroke, fillColor }`). */
  props: RenderProps;
}

/**
 * One wind barb rooted ON the curve, per the WAFC convention (figure 5):
 *  - 50 kt pennant → a FILLED triangle;
 *  - 10 kt feather → a straight line, full length;
 *  - 5 kt half feather → half length.
 * Every feather is rooted at its own point ALONG the curve and oriented to the
 * LOCAL tangent there, so on a bend the feathers fan out following the curvature
 * (like an opening orange). Pennants sit upstream, feathers progress downstream
 * toward the arrow; all share one feather direction (parallel to the pennant's
 * slope), leaning back toward the tail, on the low-pressure side. Pennants are
 * polygons (filled via `props.fillColor`); feathers are lines. Returns
 * `pennants + full + half` features. `[]` for calm.
 *
 * Everything is FILLED geometry in geographic degrees (no pixel stroke), so the
 * whole barb scales naturally with zoom. Feathers are thin filled quads whose
 * thickness is a fraction of the feather length (≈ pennantW/3, so spacing ≈
 * 1.5× thickness and a pennant's footprint ≈ 2 feathers).
 */
export function windBarbFeatures(opts: WindBarbOptions): RenderFeature[] {
  const { planar, k, startT, speedKt, featherLen, gap, props } = opts;
  if (planar.length < 2) return []; // no shaft → nothing to decorate (honours the "[] for calm" contract)
  const { pennants, full, half } = barbCounts(speedKt);
  const side = opts.side ?? 1;
  const flowSign = opts.flowSign ?? 1;
  const total = polylineLength(planar) || 1;
  const arc0 = startT * total;
  const ll = (p: Pt) => toLonLat(p, k);
  const out: RenderFeature[] = [];
  const pennantW = featherLen * 0.5;
  const halfThick = (opts.thickness ?? featherLen * 0.1) / 2; // feather quad half-thickness

  // The whole cluster keeps ONE arrangement (pennants then feathers, in the flow
  // direction, leaning to the tail). We work in flow-arc (increases downstream)
  // and clamp the cluster's start so it always fits on the curve — so an end-point
  // barb reads the same as a start-point one, just shifted inward (not mirrored).
  const clusterLen = pennants * pennantW + (pennants && full + half ? gap * 0.4 : 0) + (full + half) * gap;
  const faOf = (arc: number): number => (flowSign > 0 ? arc : total - arc);
  const arcOf = (fa: number): number => (flowSign > 0 ? fa : total - fa);
  const faBase = clamp(faOf(arc0), 0, Math.max(0, total - clusterLen - (opts.endMargin ?? 0)));
  const at = (faOffset: number): { p: Pt; flow: Pt } => {
    const st = pointAtFraction(planar, arcOf(faBase + faOffset) / total);
    return { p: st.p, flow: scale(st.dir, flowSign) };
  };
  // The pennant apex is straight out (perpendicular leading edge), so the
  // pennant's hypotenuse runs apex→(downstream base). Feathers are parallel to
  // that hypotenuse: out on the low-pressure side AND back upstream by `pennantW`.
  const apexVec = (flow: Pt): Pt => scale(perpLeft(flow), side * featherLen);
  const featherDir = (flow: Pt): Pt => unit(add(scale(perpLeft(flow), side * featherLen), scale(flow, -pennantW)));
  // A feather as a thin filled quad of geographic thickness (scales with zoom).
  const feather = (a: Pt, dir: Pt, len: number): void => {
    const tip = add(a, scale(dir, len));
    const n = scale(perpLeft(dir), halfThick);
    out.push(polygonFeature([ll(add(a, n)), ll(add(tip, n)), ll(sub(tip, n)), ll(sub(a, n)), ll(add(a, n))], props));
  };

  let cur = 0;
  for (let i = 0; i < pennants; i++) {
    const a = at(cur);
    const b = at(cur + pennantW);
    const apex = add(a.p, apexVec(a.flow));
    out.push(polygonFeature([ll(a.p), ll(apex), ll(b.p), ll(a.p)], props));
    cur += pennantW;
  }
  if (pennants && (full || half)) cur += gap * 1.1; // breathing room after the pennants
  for (let i = 0; i < full; i++) {
    const a = at(cur);
    feather(a.p, featherDir(a.flow), featherLen);
    cur += gap;
  }
  for (let i = 0; i < half; i++) {
    const a = at(cur);
    feather(a.p, featherDir(a.flow), featherLen * 0.5);
    cur += gap;
  }
  return out;
}
