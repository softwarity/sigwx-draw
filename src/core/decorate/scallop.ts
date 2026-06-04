/**
 * Scalloped (cloud-edge) ring generator for CB / icing areas. We replace each
 * edge of the polygon with a run of outward bumps (sine arcs approximating
 * semicircles). The result is an ordinary densified ring — plain GeoJSON both
 * map engines render identically, which is the whole point (a scallop can't be
 * done with MapLibre paint properties).
 */
import type { Position } from "geojson";

import { add, frameK, len, scale, sub, toLonLat, toPlanar, unit } from "./geo.js";
import type { Pt } from "./geo.js";

export interface ScallopOptions {
  /** Target arc length of one bump, in planar degrees. */
  wavelength: number;
  /** Outward bump height, in planar degrees. */
  amplitude: number;
  /** Points sampled per bump (higher = rounder). Default 6. */
  samplesPerBump?: number;
}

function signedArea(planar: Pt[]): number {
  let a = 0;
  for (let i = 0; i + 1 < planar.length; i++) {
    a += planar[i]![0] * planar[i + 1]![1] - planar[i + 1]![0] * planar[i]![1];
  }
  return a / 2;
}

/** Right-hand perpendicular (90° CW) of a unit vector. */
const perpRight = (u: Pt): Pt => [u[1], -u[0]];

/**
 * Build a scalloped ring from a polygon outer ring (lon/lat, closed or not).
 * Returns a closed lon/lat ring suitable for a Polygon's coordinates[0].
 */
export function scallopRing(ring: Position[], opts: ScallopOptions): Position[] {
  const pts = ring.map((c) => [c[0], c[1]] as Pt);
  if (pts.length && pts.length >= 2) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) pts.pop(); // drop closing dup
  }
  if (pts.length < 3) return ring;

  const k = frameK(pts);
  const planar = pts.map((c) => toPlanar(c, k));
  // Exterior ring (CCW, area > 0) ⇒ outward is to the right; flip for CW.
  const outSign = signedArea(planar) > 0 ? 1 : -1;
  const S = Math.max(2, opts.samplesPerBump ?? 6);

  const out: Pt[] = [];
  const n = planar.length;
  for (let i = 0; i < n; i++) {
    const a = planar[i]!;
    const b = planar[(i + 1) % n]!;
    const seg = sub(b, a);
    const segLen = len(seg);
    if (segLen === 0) continue;
    const dir = unit(seg);
    const outward = scale(perpRight(dir), outSign * opts.amplitude);
    const nBumps = Math.max(1, Math.round(segLen / opts.wavelength));
    for (let bump = 0; bump < nBumps; bump++) {
      for (let s = 1; s <= S; s++) {
        const tt = (bump + s / S) / nBumps; // global fraction along this edge
        const base = add(a, scale(seg, tt));
        const local = (s / S); // bump-local fraction for the sine bulge
        const bulge = Math.sin(Math.PI * local);
        out.push(add(base, scale(outward, bulge)));
      }
    }
  }
  if (out.length) out.push(out[0]!); // close
  return out.map((p) => toLonLat(p, k));
}
