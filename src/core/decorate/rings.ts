/**
 * Ring / vertex TOPOLOGY for editable polygonal geometries — pure, map-free.
 *
 * The eraser cuts holes (inner rings) and bites/splits areas (MultiPolygon), and every
 * vertex — outer OR hole, across every area — must edit uniformly. These helpers give that
 * a single FLAT index space: {@link flatRings} enumerates outer+hole rings area by area,
 * {@link vertices} flattens their unique vertices into one `v${i}` list, and
 * {@link ringOfFlat} / {@link setVertex} resolve a flat index back to its ring. This
 * flat-indexing invariant is load-bearing for the eraser/holes editing and is the reason the
 * family lives in `core` (testable without a map), not buried in the controller.
 */
import type { Geometry, Position } from "geojson";

/** Two positions are the same point (exact lon/lat equality). */
export function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** A ring's UNIQUE vertices (drops the closing duplicate). */
export function openRing(ring: Position[]): Position[] {
  return ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring;
}

/** Mean of a ring's unique vertices — the default arrow-tip target of an area. */
export function ringMean(ring: Position[]): [number, number] {
  const u = openRing(ring);
  let x = 0;
  let y = 0;
  for (const p of u) {
    x += p[0]!;
    y += p[1]!;
  }
  return u.length ? [x / u.length, y / u.length] : [0, 0];
}

/** Every editable RING of a polygonal geometry — outer + HOLES (eraser clear zones), area by
 *  area. The FLAT vertex indexing ({@link vertices}/{@link setVertex}/`v${i}` roles) walks them
 *  ALL, so hole vertices edit exactly like outer ones. */
export function flatRings(geom: Geometry): { area: number; poly: Position[][]; ringIndex: number; ring: Position[] }[] {
  if (geom.type === "Polygon") return geom.coordinates.map((ring, ringIndex) => ({ area: 0, poly: geom.coordinates, ringIndex, ring }));
  if (geom.type === "MultiPolygon") return geom.coordinates.flatMap((poly, area) => poly.map((ring, ringIndex) => ({ area, poly, ringIndex, ring })));
  return [];
}

/** Resolve a FLAT vertex index to its ring — outer or hole — plus the local index. */
export function ringOfFlat(geom: Geometry, i: number): { area: number; poly: Position[][]; ringIndex: number; ring: Position[]; local: number } | null {
  let off = i;
  for (const fr of flatRings(geom)) {
    const n = openRing(fr.ring).length;
    if (off < n) return { ...fr, local: off };
    off -= n;
  }
  return null;
}

/** Editable vertices, FLAT across areas AND their holes (`v${i}` roles, setVertex/removeVertex
 *  share the same flat indexing). */
export function vertices(geom: Geometry): Position[] {
  if (geom.type === "LineString") return geom.coordinates;
  if (geom.type === "Point") return [geom.coordinates];
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") return flatRings(geom).flatMap((fr) => openRing(fr.ring));
  return [];
}

/** The geometry's rings as a MultiLineString outline (for hit-testing the edges). */
export function outline(geom: Geometry): Geometry {
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") return { type: "MultiLineString", coordinates: flatRings(geom).map((fr) => fr.ring) };
  return geom;
}

/** Move the flat-indexed vertex `i` to `p`, IN PLACE — resolving the ring (outer OR hole) and
 *  keeping a ring's closing duplicate in sync when its first vertex moves. */
export function setVertex(geom: Geometry, i: number, p: Position): void {
  if (geom.type === "Point") {
    geom.coordinates = p;
  } else if (geom.type === "LineString") {
    if (geom.coordinates[i]) geom.coordinates[i] = p;
  } else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    const hit = ringOfFlat(geom, i); // flat index → ring (outer OR hole) + local
    if (!hit || !hit.ring[hit.local]) return;
    hit.ring[hit.local] = p;
    if (hit.local === 0 && hit.ring.length > 1) hit.ring[hit.ring.length - 1] = p;
  }
}
