/**
 * Douglas-Peucker simplification — turns a dense freehand stroke into a handful
 * of editable anchor points (the smoothing spline then re-rounds them). Planar
 * lon/lat with a degree tolerance; fine at chart scale.
 */
import { len, sub } from "./geo.js";
import type { Pt } from "./geo.js";

/** Perpendicular distance from `p` to the segment a–b (planar). */
function perpDist(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 === 0) return len(sub(p, a));
  let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2;
  t = Math.max(0, Math.min(1, t));
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]));
}

export function simplify(points: Pt[], tolerance: number): Pt[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => [p[0], p[1]] as Pt);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i]!, points[s]!, points[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
