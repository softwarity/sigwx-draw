import type { Geometry } from "geojson";
import { describe, expect, it } from "vitest";

import {
  barbCounts,
  cb,
  defaultMetadata,
  isVisible,
  jetStream,
  scallopRing,
  turbulence,
  validate,
  windBarbFeatures,
} from "../src/core/index.js";
import type { RenderFeature } from "../src/core/index.js";

const byLayer = (fs: RenderFeature[], layer: string) =>
  fs.filter((f) => f.properties.layer === layer);

describe("barbCounts (wind-speed → feathers)", () => {
  it("50 kt → 1 pennant", () => {
    expect(barbCounts(50)).toEqual({ pennants: 1, full: 0, half: 0 });
  });
  it("115 kt → 2 pennants + 1 full + 1 half", () => {
    expect(barbCounts(115)).toEqual({ pennants: 2, full: 1, half: 1 });
  });
  it("rounds to the nearest 5 kt", () => {
    expect(barbCounts(83)).toEqual({ pennants: 1, full: 3, half: 1 }); // 85 = 1×50 + 3×10 + 1×5
  });
});

describe("windBarbFeatures", () => {
  const planar = [[0, 0], [10, 0]] as [number, number][];
  it("emits one feature per feather", () => {
    const fs = windBarbFeatures({ planar, k: 1, startT: 0, speedKt: 115, featherLen: 0.5, gap: 0.3, props: { layer: "decoration" } });
    const { pennants, full, half } = barbCounts(115);
    expect(fs).toHaveLength(pennants + full + half);
  });
  it("emits nothing for calm", () => {
    expect(windBarbFeatures({ planar, k: 1, startT: 0, speedKt: 0, featherLen: 0.5, gap: 0.3, props: { layer: "decoration" } })).toHaveLength(0);
  });
});

describe("scallopRing", () => {
  it("densifies a square ring into many points and stays closed", () => {
    const square = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const out = scallopRing(square, { wavelength: 0.25, amplitude: 0.1 });
    expect(out.length).toBeGreaterThan(square.length * 4);
    expect(out[0]).toEqual(out[out.length - 1]); // closed
  });
});

describe("jetStream.decorate (break points)", () => {
  const line: Geometry = { type: "LineString", coordinates: [[0, 0], [2, 0], [4, 0]] };
  const pts = (...specs: { t: number; speed: number; fl: number; top?: number; base?: number }[]) => ({ points: specs });

  it("renders nothing when the max speed is below 80 kt", () => {
    const md = pts({ t: 0, speed: 60, fl: 300 }, { t: 1, speed: 60, fl: 300 });
    expect(jetStream.decorate({ geometry: line, metadata: md, style: jetStream.style })).toHaveLength(0);
  });
  it("shows nothing at the 80 floor, feathers at a >80 peak", () => {
    const md = pts({ t: 0, speed: 80, fl: 300 }, { t: 0.5, speed: 125, fl: 300 }, { t: 1, speed: 80, fl: 300 });
    const fs = jetStream.decorate({ geometry: line, metadata: md, style: jetStream.style });
    expect(byLayer(fs, "edge").length).toBe(1); // smoothed axis
    // The 80 ends contribute nothing; the 125 peak contributes feathers (polygons).
    const decoTypes = byLayer(fs, "decoration").map((f) => f.geometry.type);
    expect(decoTypes).toContain("Polygon"); // feathers (+ arrow)
    expect(decoTypes).not.toContain("LineString"); // no change bars (no monotonic interior)
  });
  it("draws change bars on monotonic slopes, feathers at extrema", () => {
    // 80 → 100 → 125 → 105 → 85 : 100 & 105 are monotonic (change bars), 125 peak &
    // 85 end are feathers, the 80 start is nothing.
    const md = pts(
      { t: 0, speed: 80, fl: 300 },
      { t: 0.25, speed: 100, fl: 300 },
      { t: 0.5, speed: 125, fl: 300 },
      { t: 0.75, speed: 105, fl: 300 },
      { t: 1, speed: 85, fl: 300 },
    );
    const fs = jetStream.decorate({ geometry: line, metadata: md, style: jetStream.style });
    const decoTypes = byLayer(fs, "decoration").map((f) => f.geometry.type);
    expect(decoTypes).toContain("LineString"); // change bars (100, 105)
    expect(decoTypes).toContain("Polygon"); // feathers (125, 85) + arrow
  });
});

describe("jet-depth visibleWhen (on the break-point item schema)", () => {
  const list = jetStream.schema.find((f) => f.key === "points")!;
  const topField = list.type === "list" ? list.itemSchema.find((f) => f.key === "top")! : undefined;
  it("hidden below 120 kt, shown at/above", () => {
    expect(isVisible(topField!, { speed: 100 })).toBe(false);
    expect(isVisible(topField!, { speed: 120 })).toBe(true);
  });
});

describe("cb / turbulence", () => {
  const poly: Geometry = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  it("CB emits a scalloped fill + edge + call-out", () => {
    const fs = cb.decorate({ geometry: poly, metadata: { coverage: "OCNL", embedded: true, topFL: 350, baseFL: 100 }, style: cb.style });
    expect(byLayer(fs, "area-fill").length).toBe(1);
    expect(byLayer(fs, "edge").length).toBe(1);
    const labels = byLayer(fs, "annotations");
    expect(labels.some((f) => String(f.properties.content).includes("EMBD OCNL CB"))).toBe(true);
  });
  it("turbulence emits a dashed edge + intensity symbol", () => {
    const fs = turbulence.decorate({ geometry: poly, metadata: { intensity: "SEV", topFL: 350, baseFL: 200 }, style: turbulence.style });
    const edge = byLayer(fs, "edge")[0]!;
    expect(edge.properties.dash).toBeDefined();
    const sym = byLayer(fs, "symbols")[0]!;
    expect(sym.properties.symbol).toBe("turb-sev");
  });
});

describe("metadata defaults & validation", () => {
  it("builds defaults from the schema", () => {
    const m = defaultMetadata(cb);
    expect(m).toMatchObject({ coverage: "ISOL", embedded: false, topFL: 350, baseFL: 100 });
  });
  it("flags an invalid enum value", () => {
    const errors = validate(cb, { coverage: "BOGUS" });
    expect(errors["coverage"]).toBeDefined();
  });
});
