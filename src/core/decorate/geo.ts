/**
 * Pure planar-frame geometry helpers for the decoration generators.
 *
 * SIGWX decorations (wind barbs, scallops, arrowheads) need consistent lengths
 * and correct perpendiculars on the map. We work in a local equirectangular
 * frame: x = lon·cos(lat₀), y = lat (degrees). Distances are then uniform across
 * both axes, so a "perpendicular" and a "length" mean what they look like. Good
 * enough at chart scale; the frame's reference latitude is the geometry's mean.
 */
import type { Geometry } from "geojson";

export const D2R = Math.PI / 180;
export type Pt = [number, number];

/** The working coordinate list of a geometry (polygon → outer ring; multi-polygon →
 *  the LARGEST outer ring, i.e. the "main" area — centroid/clamp defaults read it). */
export function coordsOf(geometry: Geometry): Pt[] {
  switch (geometry.type) {
    case "LineString":
      return geometry.coordinates as Pt[];
    case "Polygon":
      return (geometry.coordinates[0] ?? []) as Pt[];
    case "MultiPolygon": {
      let best: Pt[] = [];
      let bestA = -1;
      for (const r of outerRings(geometry)) {
        const a = Math.abs(shoelace(r));
        if (a > bestA) {
          bestA = a;
          best = r;
        }
      }
      return best;
    }
    case "Point":
      return [geometry.coordinates as Pt];
    default:
      return [];
  }
}

/** The outer ring of EACH area of a polygonal geometry (Polygon → 1; MultiPolygon → N).
 *  A multi-area phenomenon (CB extended with its `+` button) decorates each one. */
export function outerRings(geometry: Geometry): Pt[][] {
  if (geometry.type === "Polygon") return [(geometry.coordinates[0] ?? []) as Pt[]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((p) => (p[0] ?? []) as Pt[]);
  return [];
}

/** Signed shoelace sum in raw lon/lat — only used to COMPARE ring sizes. */
function shoelace(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Ray-casting: is point `p` inside the polygon `ring` (lon/lat; open or closed)? */
export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/** Closest point on the ring's boundary to `p` (clamped per edge segment). */
export function nearestOnRing(p: Pt, ring: Pt[]): Pt {
  let best: Pt = ring[0] ?? p;
  let bestD = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    const c: Pt = [a[0] + t * vx, a[1] + t * vy];
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Constrain `p` to inside the ring: `p` itself if already inside, else the nearest
 *  boundary point. Used to keep a draggable anchor within its polygon. */
export function clampInRing(p: Pt, ring: Pt[]): Pt {
  if (ring.length < 3) return p;
  return pointInRing(p, ring) ? p : nearestOnRing(p, ring);
}

/** Drop a closing duplicate vertex so a ring is a clean cyclic vertex list. */
function openRing(ring: Pt[]): Pt[] {
  const n = ring.length;
  return n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1] ? ring.slice(0, -1) : ring;
}

const ccw3 = (a: Pt, b: Pt, c: Pt): number => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Do segments p1p2 and p3p4 properly cross (excluding shared endpoints / collinear touch)? */
export function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = ccw3(p3, p4, p1);
  const d2 = ccw3(p3, p4, p2);
  const d3 = ccw3(p1, p2, p3);
  const d4 = ccw3(p1, p2, p4);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Is the ring a SIMPLE polygon — no two NON-adjacent edges cross? (Open or closed input.) */
export function isSimpleRing(ring: Pt[]): boolean {
  const r = openRing(ring);
  const n = r.length;
  if (n < 4) return true; // a triangle (or less) can't self-intersect
  for (let i = 0; i < n; i++) {
    const a1 = r[i]!;
    const a2 = r[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if ((i + 1) % n === j || (j + 1) % n === i) continue; // adjacent edges share a vertex
      if (segmentsCross(a1, a2, r[j]!, r[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/** Reorder a ring's vertices by angle about its centroid → a guaranteed-simple (star) polygon.
 *  Used to untangle a self-crossing freehand stroke without throwing its shape away. */
export function radialSortRing(ring: Pt[]): Pt[] {
  const r = openRing(ring);
  const n = r.length || 1;
  const cx = r.reduce((s, p) => s + p[0], 0) / n;
  const cy = r.reduce((s, p) => s + p[1], 0) / n;
  return [...r].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

/** cos(mean latitude) for the local frame; clamped away from 0 near the poles. */
export function frameK(coords: Pt[]): number {
  if (!coords.length) return 1;
  const meanLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return Math.max(0.05, Math.cos(meanLat * D2R));
}

export const toPlanar = (c: Pt, k: number): Pt => [c[0] * k, c[1]];
export const toLonLat = (p: Pt, k: number): Pt => [p[0] / k, p[1]];

export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
export const len = (a: Pt): number => Math.hypot(a[0], a[1]);
export function unit(a: Pt): Pt {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
}
/** Left-hand perpendicular of a unit vector (90° CCW). */
export const perpLeft = (u: Pt): Pt => [-u[1], u[0]];

/** Total planar length of a polyline. */
export function polylineLength(planar: Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < planar.length; i++) total += len(sub(planar[i + 1]!, planar[i]!));
  return total;
}

export interface Station {
  /** Position in the planar frame. */
  p: Pt;
  /** Unit travel direction (along the line) in the planar frame. */
  dir: Pt;
  /** Distance from the start, in planar units. */
  along: number;
}

/**
 * Sample a polyline (planar) at a fixed spacing, returning a station at each
 * sample with the local travel direction. The first sample is at `offset` from
 * the start; samples never fall exactly on the end (so a barb has room).
 */
export function sampleAlong(planar: Pt[], spacing: number, offset = spacing / 2): Station[] {
  const stations: Station[] = [];
  if (planar.length < 2 || spacing <= 0) return stations;
  const total = polylineLength(planar);
  for (let d = offset; d < total; d += spacing) {
    let acc = 0;
    for (let i = 0; i + 1 < planar.length; i++) {
      const a = planar[i]!;
      const b = planar[i + 1]!;
      const segLen = len(sub(b, a));
      if (acc + segLen >= d) {
        const f = segLen > 0 ? (d - acc) / segLen : 0;
        const dir = unit(sub(b, a));
        stations.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], dir, along: d });
        break;
      }
      acc += segLen;
    }
  }
  return stations;
}

/** Unit travel direction at the last vertex of a polyline (planar). */
export function endDirection(planar: Pt[]): Pt {
  const n = planar.length;
  if (n < 2) return [1, 0];
  return unit(sub(planar[n - 1]!, planar[n - 2]!));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Station at fraction `t` (0..1) of a polyline's arc length (planar). */
export function pointAtFraction(planar: Pt[], t: number): Station {
  if (planar.length < 2) return { p: planar[0] ?? [0, 0], dir: [1, 0], along: 0 };
  const total = polylineLength(planar);
  const target = clamp(t, 0, 1) * total;
  let acc = 0;
  for (let i = 0; i + 1 < planar.length; i++) {
    const a = planar[i]!;
    const b = planar[i + 1]!;
    const segLen = len(sub(b, a));
    if (acc + segLen >= target || i === planar.length - 2) {
      const f = segLen > 0 ? (target - acc) / segLen : 0;
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], dir: unit(sub(b, a)), along: target };
    }
    acc += segLen;
  }
  return { p: planar[planar.length - 1]!, dir: endDirection(planar), along: total };
}

/** Nearest fraction (0..1) on a polyline to a cursor point (planar) — for sliding handles. */
export function projectToFraction(planar: Pt[], cursor: Pt): number {
  if (planar.length < 2) return 0;
  const total = polylineLength(planar) || 1;
  let best = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let i = 0; i + 1 < planar.length; i++) {
    const a = planar[i]!;
    const b = planar[i + 1]!;
    const ab = sub(b, a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
    let tt = ((cursor[0] - a[0]) * ab[0] + (cursor[1] - a[1]) * ab[1]) / l2;
    tt = clamp(tt, 0, 1);
    const q: Pt = [a[0] + ab[0] * tt, a[1] + ab[1] * tt];
    const d = (q[0] - cursor[0]) ** 2 + (q[1] - cursor[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = (acc + Math.sqrt(l2) * tt) / total;
    }
    acc += Math.sqrt(l2);
  }
  return best;
}
