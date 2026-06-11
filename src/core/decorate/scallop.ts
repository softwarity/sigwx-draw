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
/** Signed area of a planar ring (positive = CCW). */
function signedArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

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
  // Orientation by NORMALIZED WINDING, not by centroid: normalize the ring to CCW, then
  // the outward side is ALWAYS to the right of travel — correct even along a deeply
  // concave "canal" carved by the eraser, where the centroid sits on the wrong side of
  // some edges. (Freehand draw direction doesn't matter: we re-wind here.) `invert`
  // flips the bumps inward (a hole's border).
  if (signedArea(planar) < 0) planar.reverse();
  const n = planar.length;
  const S = Math.max(2, opts.samplesPerBump ?? 6);

  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = planar[i]!;
    const b = planar[(i + 1) % n]!;
    const seg = sub(b, a);
    const segLen = len(seg);
    if (segLen === 0) continue;
    const dir = unit(seg);
    const nrm = perpRight(dir); // CCW ring ⇒ right of travel = outward
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

export interface TickOptions {
  /** Arc length between ticks, in planar degrees. */
  spacing: number;
  /** Tick length pointing INWARD (toward the centroid), in planar degrees. */
  length: number;
  /** Flip the ticks OUTWARD (away from the centroid) — a HOLE's boundary ticks point
   *  into the surrounding fill, not into the clear zone. */
  invert?: boolean;
}

/**
 * Small perpendicular TICKS along a ring, evenly spaced by arc length, each pointing INWARD
 * (toward the centroid) — the WAFC icing-area boundary convention. Returns one `[outer, inner]`
 * lon/lat segment per tick (render as a MultiLineString alongside the plain boundary line).
 */
export function inwardTicks(ring: Position[], opts: TickOptions): Position[][] {
  const pts = ring.map((c) => [c[0], c[1]] as Pt);
  if (pts.length >= 2) {
    const f = pts[0]!;
    const l = pts[pts.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) pts.pop(); // drop closing dup
  }
  if (pts.length < 3) return [];
  const k = frameK(pts);
  const planar = pts.map((c) => toPlanar(c, k));
  // Same winding-normalized orientation as the scallop (concavity-proof): CCW ⇒ the
  // interior is to the LEFT of travel.
  if (signedArea(planar) < 0) planar.reverse();
  const n = planar.length;
  const ticks: Position[][] = [];
  let total = 0; // arc length walked so far
  for (let i = 0; i < n; i++) {
    const a = planar[i]!;
    const b = planar[(i + 1) % n]!;
    const seg = sub(b, a);
    const segLen = len(seg);
    if (segLen === 0) continue;
    const dir = unit(seg);
    // ticks fall at arc positions that are multiples of `spacing`, within this edge.
    const firstTick = Math.ceil(total / opts.spacing) * opts.spacing;
    for (let t = firstTick; t < total + segLen; t += opts.spacing) {
      const base = add(a, scale(dir, t - total));
      // CCW ring ⇒ LEFT of travel = inward (the fill); `invert` (a hole) flips outward.
      let nrm: Pt = [-perpRight(dir)[0], -perpRight(dir)[1]];
      if (opts.invert) nrm = [-nrm[0], -nrm[1]];
      const inner = add(base, scale(nrm, opts.length));
      ticks.push([toLonLat(base, k), toLonLat(inner, k)]);
    }
    total += segLen;
  }
  return ticks;
}
