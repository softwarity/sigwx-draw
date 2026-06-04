/**
 * Catmull-Rom spline — the jet core is a smooth curve passing through the
 * forecaster's anchor points. We densify the control polyline into a smooth
 * one; all downstream placement (barbs, change bars, annotations) then uses the
 * dense polyline via the arc-length helpers in `geo.ts`.
 */
import type { Pt } from "./geo.js";

function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/**
 * Densify control points into a smooth Catmull-Rom polyline passing through
 * them. < 3 points are returned unchanged (a straight segment needs no spline).
 */
export function catmullRom(points: Pt[], samplesPerSeg = 16): Pt[] {
  const n = points.length;
  if (n < 3) return points.map((p) => [p[0], p[1]] as Pt);
  const at = (i: number): Pt => points[Math.max(0, Math.min(n - 1, i))]!;
  const out: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < samplesPerSeg; s++) out.push(catmull(p0, p1, p2, p3, s / samplesPerSeg));
  }
  out.push(at(n - 1));
  return out;
}

/** The dense coordinate list actually rendered for a path: smoothed or raw. The
 *  jet's decorate and the controller's slider placement both call this so a
 *  break point sits exactly on the drawn curve. */
export function renderPathCoords(coords: Pt[], smooth: boolean): Pt[] {
  return smooth ? catmullRom(coords, 16) : coords.map((c) => [c[0], c[1]] as Pt);
}
