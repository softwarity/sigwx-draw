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
  /** Flip the bumps to point INWARD (into the area) instead of outward (the default).
   *  Outward is the cloud-edge convention; inward suits an interior ring (a hole). */
  invert?: boolean;
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
  // Bumps point AWAY from the ring's centroid → reliably OUTWARD whatever the draw winding
  // (freehand is CW or CCW unpredictably, so a signed-area test isn't enough — the user sees
  // it flip with their stroke direction). `invert` flips them inward (e.g. a hole). Per-edge,
  // so each bump faces out — fine for the convex-ish areas SIGWX draws.
  const n = planar.length;
  const cx = planar.reduce((s, p) => s + p[0], 0) / n;
  const cy = planar.reduce((s, p) => s + p[1], 0) / n;
  const S = Math.max(2, opts.samplesPerBump ?? 6);

  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = planar[i]!;
    const b = planar[(i + 1) % n]!;
    const seg = sub(b, a);
    const segLen = len(seg);
    if (segLen === 0) continue;
    const dir = unit(seg);
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let nrm = perpRight(dir);
    if (nrm[0] * (mid[0] - cx) + nrm[1] * (mid[1] - cy) < 0) nrm = [-nrm[0], -nrm[1]]; // face away from centroid
    const outward = scale(nrm, (opts.invert ? -1 : 1) * opts.amplitude);
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
