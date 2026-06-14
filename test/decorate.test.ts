import type { Geometry } from "geojson";
import { beforeAll, describe, expect, it } from "vitest";

import {
  clampInArea,
  barbCounts,
  cb,
  clampInRing,
  turbulence,
  defaultMetadata,
  isSimpleRing,
  isVisible,
  jetStream,
  pointInRing,
  radialSortRing,
  scallopRing,
  tropopause,
  validate,
  windBarbFeatures,
} from "../src/core/index.js";
import type { Pt, RenderFeature } from "../src/core/index.js";

const byLayer = (fs: RenderFeature[], layer: string) =>
  fs.filter((f) => f.properties.layer === layer);

describe("clampInRing (movable anchor constraint)", () => {
  const sq: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]]; // a 4×4 square
  it("leaves an inside point untouched", () => {
    expect(pointInRing([2, 2], sq)).toBe(true);
    expect(clampInRing([2, 2], sq)).toEqual([2, 2]);
  });
  it("clamps an outside point onto the nearest boundary edge", () => {
    expect(pointInRing([6, 2], sq)).toBe(false);
    expect(clampInRing([6, 2], sq)).toEqual([4, 2]); // projected onto the right edge
  });
  it("clamps to the nearest corner when outside past a vertex", () => {
    expect(clampInRing([6, 6], sq)).toEqual([4, 4]);
  });
});

describe("isSimpleRing (keep the CAT polygon simple)", () => {
  it("accepts a simple square (open or closed)", () => {
    expect(isSimpleRing([[0, 0], [4, 0], [4, 4], [0, 4]])).toBe(true);
    expect(isSimpleRing([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]])).toBe(true);
  });
  it("rejects a self-crossing bow-tie", () => {
    expect(isSimpleRing([[0, 0], [4, 4], [4, 0], [0, 4]])).toBe(false);
  });
  it("radialSortRing untangles a bow-tie into a simple polygon", () => {
    const fixed = radialSortRing([[0, 0], [4, 4], [4, 0], [0, 4]]);
    expect(isSimpleRing(fixed)).toBe(true);
  });
});

describe("turbulence flightLevel.beyond (off-chart XXX vs clamp)", () => {
  const sqGeom: Geometry = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  // topFL 700 > max, baseFL 200 < min → both off the FL250–600 chart.
  const content = (fl: { min?: number; max?: number; beyond?: ["clamp" | "xxx", "clamp" | "xxx"] }) =>
    String(
      turbulence.decorate({ geometry: sqGeom, metadata: { symbol: "MOD", topFL: 700, baseFL: 200 }, style: turbulence.style, flightLevel: fl }).find((f) => f.properties.layer === "annotations")?.properties["content"] ?? "",
    );
  it("renders XXX off-chart by default (areas → ['xxx','xxx'])", () => {
    expect(content({ min: 250, max: 600 })).toContain("XXX");
  });
  it("renders the raw FL (no XXX) when beyond is clamp", () => {
    const c = content({ min: 250, max: 600, beyond: ["clamp", "clamp"] });
    expect(c).not.toContain("XXX");
    expect(c).toContain("700");
  });
});

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

describe("jetStream change bars (±20 step, FL-aware)", () => {
  const line: Geometry = { type: "LineString", coordinates: [[0, 0], [1, 0], [2, 0], [3, 0]] };
  const P = (t: number, speed: number, fl: number) => ({ t, speed, fl });
  const md = (pts: { t: number; speed: number; fl: number }[]) => ({ points: pts });
  const cbTicks = (pts: { t: number; speed: number; fl: number }[]) =>
    byLayer(jetStream.decorate({ geometry: line, metadata: md(pts), style: jetStream.style }), "decoration")
      .filter((f) => f.geometry.type === "LineString").length; // 2 ticks per change bar

  it("draws a change bar for a −20 step DOWN to the 80 floor (o80 A100 B80 o80 → B80 ||)", () => {
    expect(cbTicks([P(0, 80, 300), P(0.33, 100, 300), P(0.66, 80, 300), P(1, 80, 300)])).toBe(2);
  });

  it("suppresses the max-wind FL label when the peak is at an endpoint (extremities are undecorated)", () => {
    // Peak 120 kt at the END (i=last). The barb loop never decorates ends, so the FL box
    // must be suppressed too — constant FL means no interior FL-change label either ⇒ none.
    const fs = jetStream.decorate({ geometry: line, metadata: md([P(0, 80, 300), P(0.5, 100, 300), P(1, 120, 300)]), style: jetStream.style });
    expect(byLayer(fs, "text-boxes").length).toBe(0); // no label floating on the bare tip
  });

  it("a jet END (extremity) never draws feathers, even when its FL is edited to differ from its neighbour", () => {
    const deco = (endFL: number): number =>
      byLayer(jetStream.decorate({ geometry: line, metadata: md([P(0, 80, 300), P(0.5, 120, 300), P(1, 80, endFL)]), style: jetStream.style }), "decoration").length;
    expect(deco(270)).toBe(deco(300)); // editing the end's FL must NOT sprout feathers on the extremity
  });

  it("a change bar reverts to feathers + FL label when its FL changes vs the previous point", () => {
    const at = (bfl: number) => jetStream.decorate({
      geometry: line, metadata: md([P(0, 80, 300), P(0.33, 105, 300), P(0.66, 85, bfl), P(1, 80, 300)]), style: jetStream.style,
    });
    // Same FL → B85 is a change bar.
    expect(byLayer(at(300), "decoration").filter((f) => f.geometry.type === "LineString").length).toBe(2);
    // FL changed → no change bar at B, and a FL310 label appears.
    const changed = at(310);
    expect(byLayer(changed, "decoration").filter((f) => f.geometry.type === "LineString").length).toBe(0);
    expect(byLayer(changed, "text-boxes").some((f) => String(f.properties.text).includes("FL310"))).toBe(true);
  });

  it("a tied max-speed plateau shows feathers + FL — never a change bar carrying the FL (o80 A100 B100 o80)", () => {
    const fs = jetStream.decorate({
      geometry: line, metadata: md([P(0, 80, 300), P(0.33, 100, 300), P(0.66, 100, 300), P(1, 80, 300)]), style: jetStream.style,
    });
    expect(byLayer(fs, "decoration").filter((f) => f.geometry.type === "LineString").length).toBe(0); // no || at the plateau top
    expect(byLayer(fs, "text-boxes").some((f) => String(f.properties.text).includes("FL300"))).toBe(true); // FL still shown (on the feathered max)
  });

  it("an 80-kt point whose FL differs from its neighbour shows feathers + a FL label (not a bare floor)", () => {
    const dec = (bfl: number) => jetStream.decorate({
      geometry: line, metadata: md([P(0, 80, 300), P(0.5, 100, 300), P(0.75, 80, bfl), P(1, 80, 300)]), style: jetStream.style,
    });
    const polys = (fs: ReturnType<typeof dec>) => byLayer(fs, "decoration").filter((f) => f.geometry.type === "Polygon").length;
    // Same FL → the 80 point is a change bar; differing FL → it draws feathers (more polys) + its FL.
    expect(polys(dec(310))).toBeGreaterThan(polys(dec(300)));
    expect(byLayer(dec(310), "text-boxes").some((f) => String(f.properties.text).includes("FL310"))).toBe(true);
    expect(byLayer(dec(300), "text-boxes").some((f) => String(f.properties.text).includes("FL310"))).toBe(false);
  });
});

describe("cb / turbulence", () => {
  const poly: Geometry = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  it("anchors the call-out at the AREA centroid, robust to uneven vertices", () => {
    // A square with extra points clustered on the bottom edge: the vertex mean skews
    // down (y≈0.8), but the area centroid is the true centre (1,1) → the leader arrow
    // then points at the zone's middle, not a skewed spot.
    const skewed: Geometry = { type: "Polygon", coordinates: [[[0, 0], [0.5, 0], [1, 0], [1.5, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
    const ann = byLayer(turbulence.decorate({ geometry: skewed, metadata: { symbol: "MOD", topFL: 360, baseFL: 250 }, style: turbulence.style }), "annotations")[0]!;
    const [x, y] = (ann.geometry as { coordinates: [number, number] }).coordinates;
    expect(x).toBeCloseTo(1, 5);
    expect(y).toBeCloseTo(1, 5); // NOT 0.8 (the density-skewed vertex mean)
  });
  it("CB emits a scalloped fill + edge + a single call-out box (coverage / CB / top / base)", () => {
    const fs = cb.decorate({ geometry: poly, metadata: { coverage: "OCNL", topFL: 350, baseFL: 100 }, style: cb.style });
    expect(byLayer(fs, "area-fill").length).toBe(1);
    expect(byLayer(fs, "edge").length).toBe(1);
    const ann = byLayer(fs, "annotations")[0]!;
    expect(ann.properties.arrow).toBe(true);
    expect(ann.properties.cycleField).toBeUndefined(); // the coverage is edited on the SELECTED card's carousel
    const content = String(ann.properties.content);
    expect(content).toContain("OCNL"); // coverage — in the box itself now
    expect(content).toContain("CB");
    expect(content).toContain("FL350"); // top in range
    expect(content).toContain("XXX"); // base 100 < FL250 floor → XXX
    expect(ann.properties.textColor).toBe("#1f2328"); // black & white panel (the scallop stays red)
  });
  it("CB stacks a multi-word coverage onto its own lines (EMBD → one line more)", () => {
    const fs = cb.decorate({ geometry: poly, metadata: { coverage: "OCNL EMBD", topFL: 350, baseFL: 300 }, style: cb.style });
    const content = String(byLayer(fs, "annotations")[0]!.properties.content);
    expect(content).toContain("OCNL\nEMBD\nCB"); // the space splits → "EMBD" on its own line, above CB
  });
  it("turbulence shows the FL range, with XXX when a bound runs off the chart (base < min / top > max)", () => {
    const fs = turbulence.decorate({ geometry: poly, metadata: { symbol: "SEV", topFL: 360, baseFL: 200 }, style: turbulence.style });
    const edge = byLayer(fs, "edge")[0]!;
    expect(edge.properties.dash).toBeDefined();
    const ann = byLayer(fs, "annotations")[0]!;
    expect(ann.properties.symbol).toBe("SEV"); // the symbol code IS the sprite id, riding the call-out
    expect(ann.properties.arrow).toBe(true); // leader arrow points back to the zone
    expect(String(ann.properties.content)).toContain("FL360"); // top in range → FL360
    expect(String(ann.properties.content)).toContain("XXX"); // base 200 < FL250 floor → XXX
    expect(String(ann.properties.content)).not.toContain("FL200");
  });

  it("severe turbulence uses a DARKER ink than moderate (edge/fill/text all follow severity)", () => {
    const dec = (symbol: string) => {
      const fs = turbulence.decorate({ geometry: poly, metadata: { symbol, topFL: 360, baseFL: 300 }, style: turbulence.style });
      return { fill: byLayer(fs, "area-fill"), edge: byLayer(fs, "edge"), ann: byLayer(fs, "annotations") };
    };
    const mod = dec("MOD");
    const sev = dec("SEV");
    // The severity ink drives the fill tint, the edge AND the FL text — all differ MOD↔SEV.
    expect(sev.fill[0]!.properties.fillColor).not.toBe(mod.fill[0]!.properties.fillColor);
    expect(sev.edge[0]!.properties.stroke).not.toBe(mod.edge[0]!.properties.stroke);
    expect(sev.ann[0]!.properties.textColor).not.toBe(mod.ann[0]!.properties.textColor);
  });

  it("the `flightLevel` range moves the XXX threshold (off-chart sentinel follows the configured range)", () => {
    const md = { symbol: "MOD", topFL: 650, baseFL: 150 };
    const content = String(byLayer(turbulence.decorate({ geometry: poly, metadata: md, style: turbulence.style, flightLevel: { min: 100, max: 600 } }), "annotations")[0]!.properties.content);
    expect(content).toContain("FL150"); // base 150 ≥ new floor 100 → real FL (not XXX)
    expect(content).toContain("XXX"); // top 650 > new ceiling 600 → XXX
  });

  it("turbulence FL fields carry NO chart bounds — they resolve from the PROFILE (flightLevel/vertical)", () => {
    // The descriptor model: a phenomenon's schema only carries métier defaults; the
    // chart clamp (SWH FL250–600) comes from the profile, so HL/ML share one descriptor.
    const top = turbulence.schema.find((s) => s.key === "topFL");
    const base = turbulence.schema.find((s) => s.key === "baseFL");
    expect(top && top.type === "fl" ? [top.min, top.max] : null).toEqual([undefined, undefined]);
    expect(base && base.type === "fl" ? [base.min, base.max] : null).toEqual([undefined, undefined]);
  });
});

describe("metadata defaults & validation", () => {
  it("builds defaults from the schema", () => {
    const m = defaultMetadata(cb);
    expect(m).toMatchObject({ coverage: "OCNL", baseFL: 250, topFL: 400 });
  });
  it("flags an invalid enum value", () => {
    const errors = validate(cb, { coverage: "BOGUS" });
    expect(errors["coverage"]).toBeDefined();
  });
});

describe("tropopause (single-FL spot / contour)", () => {
  it("contour (LineString) → a dotted blue edge + an un-boxed FL at the middle", () => {
    const line: Geometry = { type: "LineString", coordinates: [[0, 0], [2, 1], [4, 0]] };
    const fs = tropopause.decorate({ geometry: line, metadata: { fl: 400 }, style: tropopause.style });
    const edge = byLayer(fs, "edge")[0]!;
    expect(edge.geometry.type).toBe("LineString");
    expect(edge.properties.dash).toBeDefined(); // dotted
    const label = byLayer(fs, "text-boxes")[0]!;
    expect(label.geometry.type).toBe("Point");
    expect(label.properties.text).toBe("FL400");
    expect(label.properties.textBackground).toBeUndefined(); // NOT boxed (contour)
  });

  it("spot (Point) → a single BOXED FL, no line", () => {
    const pt: Geometry = { type: "Point", coordinates: [3, 2] };
    const fs = tropopause.decorate({ geometry: pt, metadata: { fl: 460 }, style: tropopause.style });
    expect(byLayer(fs, "edge")).toHaveLength(0); // no contour for a spot
    const label = byLayer(fs, "text-boxes")[0]!;
    expect(label.properties.text).toBe("FL460");
    expect(label.properties.textBackground).toBeDefined(); // boxed (spot height)
    expect(label.geometry).toMatchObject({ type: "Point", coordinates: [3, 2] });
  });

  it("the only metadata is `fl` (no top/base, no enum)", () => {
    const m = defaultMetadata(tropopause);
    expect(Object.keys(m)).toEqual(["fl"]);
    expect(m["fl"]).toBe(380);
  });
});

describe("clampInArea (hole-aware arrow tip)", () => {
  const outer: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole: Pt[] = [[4, 4], [6, 4], [6, 6], [4, 6]];

  it("pushes a hole-trapped tip to the MIDDLE of the free corridor, not the hole's edge", () => {
    const q = clampInArea([5, 5], { outer, holes: [hole] });
    const d = Math.max(Math.abs(q[0] - 5), Math.abs(q[1] - 5)); // distance from the hole centre
    expect(d).toBeGreaterThan(1.5); // clearly past the hole edge (at 1)…
    expect(d).toBeLessThan(4.5); // …but not hugging the outer ring (at 5): mid-corridor ≈ 3
  });

  it("leaves a tip already in cloud untouched", () => {
    expect(clampInArea([2, 2], { outer, holes: [hole] })).toEqual([2, 2]);
  });
});

describe("fronts (TEMSI family B — the front-symbols decorator)", () => {
  const line: Geometry = { type: "LineString", coordinates: [[0, 0], [5, 1], [10, 0], [15, 1]] };
  // Front objects default their icon to `atlas:<type>` (declared in the profile's `glyphs`),
  // so register the TEMSI glyphs first — exactly what profile ingestion does at runtime.
  beforeAll(async () => {
    const { registerExtensions } = await import("../src/core/index.js");
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as { glyphs: Record<string, string> };
    registerExtensions({ glyphs: profile.glyphs });
  });
  it("a cold front renders a base line + triangle pips along it", async () => {
    const { FRONT_COLD_DESCRIPTOR } = await import("../src/core/descriptors/index.js");
    const { defFromDescriptor } = await import("../src/core/index.js");
    const def = defFromDescriptor(FRONT_COLD_DESCRIPTOR);
    const fs = def.decorate({ geometry: line, metadata: {}, style: def.style });
    expect(byLayer(fs, "edge").length).toBe(1); // the base line
    const pips = byLayer(fs, "decoration").filter((f) => f.geometry.type === "Polygon");
    expect(pips.length).toBeGreaterThan(0); // triangles along it
  });
  it("every front type compiles and decorates (line + pips)", async () => {
    const { FRONT_DESCRIPTORS } = await import("../src/core/descriptors/index.js");
    const { defFromDescriptor } = await import("../src/core/index.js");
    for (const d of FRONT_DESCRIPTORS) {
      const def = defFromDescriptor(d);
      const fs = def.decorate({ geometry: line, metadata: {}, style: def.style });
      expect(fs.length).toBeGreaterThan(1);
    }
  });
});
