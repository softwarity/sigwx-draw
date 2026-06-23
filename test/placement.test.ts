import { describe, it, expect } from "vitest";
import { placeAnnotations, estimateBox, type AnnReq, type Rect, type Projector, type Placed } from "../src/map/placement.js";

// Identity projector: px === lon/lat, so frame / obstacles / anchors all share one coordinate space.
const proj: Projector = { project: (p) => [p.lon, p.lat], unproject: (px) => ({ lon: px[0], lat: px[1] }) };

const req = (id: string, at: [number, number], extra: Partial<AnnReq> = {}): AnnReq => ({
  featureId: id, labelId: "L", anchor: { lon: at[0], lat: at[1] },
  content: "XX", leader: true, textColor: "#000", textSize: 10, textHalo: "#fff", textBorder: "#000", ...extra,
});

const rectOf = (b: Placed["boxes"][number]): Rect => {
  const c = (b.geometry as { coordinates: [number, number] }).coordinates;
  const p = b.properties as { text: string; textSize: number };
  const { w, h } = estimateBox(p.text, p.textSize);
  return { x: c[0] - w / 2, y: c[1] - h / 2, w, h };
};
const boxOf = (placed: Placed, fid: string): Rect => rectOf(placed.boxes.find((b) => (b.properties as { featureId: string }).featureId === fid)!);
const inside = (r: Rect, f: Rect): boolean => r.x >= f.x - 0.01 && r.y >= f.y - 0.01 && r.x + r.w <= f.x + f.w + 0.01 && r.y + r.h <= f.y + f.h + 0.01;
const has = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe("placeAnnotations — cartouche frame bound + tip protection + obstacle padding", () => {
  const frame: Rect = { x: 0, y: 0, w: 100, h: 100 };

  it("clamps a call-out box INSIDE the chart frame (anchor hard against the edge)", () => {
    const placed = placeAnnotations([req("A", [98, 50])], proj, new Map(), [], undefined, frame, 0);
    expect(inside(boxOf(placed, "A"), frame)).toBe(true);
  });

  it("never lets a box cover ANOTHER feature's leader tip (it's protected)", () => {
    // A's tip sits at {56,50} — right where B's box would naturally land beside its own anchor.
    const a = req("A", [10, 50], { arrowAnchor: { lon: 56, lat: 50 }, arrow: true });
    const b = req("B", [30, 50]);
    const placed = placeAnnotations([a, b], proj, new Map(), [], undefined, frame, 0);
    expect(has(boxOf(placed, "B"), 56, 50)).toBe(false); // B's box clears A's tip
  });

  it("keeps a card a `pad` margin off a small obstacle (no flush contact)", () => {
    const badge: Rect = { x: 40, y: 44, w: 12, h: 12 }; // a tropopause-sized badge
    const placed = placeAnnotations([req("A", [20, 50])], proj, new Map(), [badge], undefined, undefined, 8);
    const inflated: Rect = { x: badge.x - 8, y: badge.y - 8, w: badge.w + 16, h: badge.h + 16 };
    expect(overlap(boxOf(placed, "A"), inflated)).toBe(0); // ≥ 8 px from the real badge edge
  });

  it("with NO frame and NO pad, placement is unchanged (box can leave any bound)", () => {
    const placed = placeAnnotations([req("A", [98, 50])], proj, new Map(), []);
    expect(boxOf(placed, "A").x).toBeGreaterThan(100); // free to sit past x=100 (legacy behaviour)
  });
});
