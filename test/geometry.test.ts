import { describe, expect, it } from "vitest";
import type { Geometry } from "geojson";

import {
  // ring / vertex topology (core/decorate/rings.ts) — the eraser/holes flat-indexing invariant
  samePoint,
  openRing,
  ringMean,
  flatRings,
  ringOfFlat,
  vertices,
  setVertex,
  outline,
  // geometry / distance (core/decorate/geo.ts)
  segDist,
  zoneSpanRatio,
  nearestArea,
} from "../src/core/index.js";

// A 10×10 square (closed) with a 3..6 square HOLE (closed): outer + hole = the eraser case.
const square = (): Geometry => ({
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], // outer, 4 unique
    [[3, 3], [6, 3], [6, 6], [3, 6], [3, 3]], // hole, 4 unique
  ],
});

describe("ring topology — flat outer+hole vertex indexing (eraser / holes invariant)", () => {
  it("openRing drops the closing duplicate; ringMean averages the unique vertices", () => {
    expect(openRing([[0, 0], [2, 0], [2, 2], [0, 0]])).toEqual([[0, 0], [2, 0], [2, 2]]);
    expect(openRing([[0, 0], [2, 0]])).toEqual([[0, 0], [2, 0]]); // already open
    expect(ringMean([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])).toEqual([1, 1]);
    expect(samePoint([1, 2], [1, 2])).toBe(true);
    expect(samePoint([1, 2], [1, 3])).toBe(false);
  });

  it("flatRings enumerates outer + holes (Polygon) and every area's rings (MultiPolygon)", () => {
    const fr = flatRings(square());
    expect(fr.map((r) => [r.area, r.ringIndex])).toEqual([[0, 0], [0, 1]]); // outer then hole
    const mp: Geometry = { type: "MultiPolygon", coordinates: [square().type === "Polygon" ? (square() as { coordinates: number[][][] }).coordinates : []] };
    expect(flatRings(mp).map((r) => r.area)).toEqual([0, 0]); // both rings under area 0
  });

  it("vertices flattens outer+hole unique vertices; ringOfFlat resolves a flat index back", () => {
    expect(vertices(square())).toHaveLength(8); // 4 outer + 4 hole, closing dups dropped
    const hit = ringOfFlat(square(), 5); // index 4 = hole[0], 5 = hole[1]
    expect(hit?.ringIndex).toBe(1); // the HOLE ring
    expect(hit?.local).toBe(1);
  });

  it("setVertex moves the flat-indexed vertex (hole too) and syncs a ring's closing duplicate", () => {
    const g = square();
    setVertex(g, 4, [99, 99]); // flat 4 = first HOLE vertex
    const ring = (g as { coordinates: number[][][] }).coordinates[1]!;
    expect(ring[0]).toEqual([99, 99]);
    expect(ring[ring.length - 1]).toEqual([99, 99]); // closing duplicate kept in sync
    setVertex(g, 0, [-1, -1]); // flat 0 = first OUTER vertex
    const outer = (g as { coordinates: number[][][] }).coordinates[0]!;
    expect(outer[0]).toEqual([-1, -1]);
    expect(outer[outer.length - 1]).toEqual([-1, -1]);
  });

  it("outline turns a polygon (with hole) into a MultiLineString of all its rings", () => {
    const o = outline(square());
    expect(o.type).toBe("MultiLineString");
    expect((o as { coordinates: number[][][] }).coordinates).toHaveLength(2); // outer + hole
  });
});

describe("pure geometry / distance helpers", () => {
  it("segDist is the squared point→segment distance, clamped to the endpoints", () => {
    expect(segDist([0, 1], [0, 0], [2, 0])).toBeCloseTo(1, 6); // perpendicular onto the segment
    expect(segDist([5, 0], [0, 0], [2, 0])).toBeCloseTo(9, 6); // past b ⇒ clamps to (2,0)
    expect(segDist([-3, 0], [0, 0], [2, 0])).toBeCloseTo(9, 6); // before a ⇒ clamps to (0,0)
  });

  it("zoneSpanRatio is the largest ring's bbox diagonal over the view span", () => {
    expect(zoneSpanRatio(square(), 100)).toBeCloseTo(Math.hypot(10, 10) / 100, 6);
    expect(zoneSpanRatio(square(), 0)).toBe(1); // no view span ⇒ neutral
  });

  it("nearestArea picks the area a point is inside, else the nearest boundary", () => {
    const mp: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]], // area 0 around (1,1)
        [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]], // area 1 around (11,11)
      ],
    };
    expect(nearestArea(mp, [11, 11])).toBe(1); // inside area 1
    expect(nearestArea(mp, [1, 1])).toBe(0); // inside area 0
    expect(nearestArea(mp, [4, 1])).toBe(0); // outside, nearest to area 0's edge
  });
});
