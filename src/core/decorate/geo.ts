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

/** The working coordinate list of a geometry (polygon → outer ring). */
export function coordsOf(geometry: Geometry): Pt[] {
  switch (geometry.type) {
    case "LineString":
      return geometry.coordinates as Pt[];
    case "Polygon":
      return (geometry.coordinates[0] ?? []) as Pt[];
    case "Point":
      return [geometry.coordinates as Pt];
    default:
      return [];
  }
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
