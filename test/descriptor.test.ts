import { describe, expect, it } from "vitest";

import {
  CB_DESCRIPTOR,
  defFromDescriptor,
  mergeDescriptor,
  resolveObjectSpec,
} from "../src/core/index.js";
import type { PhenomenonDescriptor } from "../src/core/index.js";

describe("profile objects composition (descriptor spec §2b)", () => {
  it("resolves a stock name to the shipped descriptor, as-is", () => {
    expect(resolveObjectSpec("cb", mergeDescriptor)).toBe(CB_DESCRIPTOR);
  });

  it("an `extends` entry deep-merges its patch (patch wins, base untouched)", () => {
    const patched = resolveObjectSpec(
      { extends: "cb", style: { edge: { color: "#0a0a0a" } }, summary: "patched" },
      mergeDescriptor,
    );
    expect(patched.style.edge?.color).toBe("#0a0a0a");
    expect(patched.style.color).toBe("#d1242f"); // untouched sibling key survives the merge
    expect(patched.summary).toBe("patched");
    expect(CB_DESCRIPTOR.style.edge?.color).toBe("#d1242f"); // the stock object is never mutated
    expect(CB_DESCRIPTOR.summary).not.toBe("patched");
  });

  it("a keyed-array patch addresses fields by their `key` (the §2b fields form)", () => {
    const patched = resolveObjectSpec(
      { extends: "cb", fields: { baseFL: { default: 30 }, topFL: { default: 150 } } },
      mergeDescriptor,
    );
    const by = (k: string) => patched.fields?.find((f) => f.key === k);
    expect(by("baseFL")?.kind === "fl" && by("baseFL")?.default).toBe(30);
    expect(by("topFL")?.kind === "fl" && by("topFL")?.default).toBe(150);
    expect(by("coverage")?.kind).toBe("enum"); // unnamed items pass through unchanged
    expect(CB_DESCRIPTOR.fields?.find((f) => f.key === "baseFL")?.default).toBe(250); // base untouched
  });

  it("an unknown stock name fails listing the available descriptors", () => {
    expect(() => resolveObjectSpec("fog", mergeDescriptor)).toThrow(/Unknown stock descriptor "fog".*cb.*jetStream/s);
  });

  it("a patched descriptor COMPILES like a stock one (the interpreter sees no difference)", () => {
    const def = defFromDescriptor(
      resolveObjectSpec({ extends: "cb", label: "CB (LL)", style: { color: "#336699" } }, mergeDescriptor),
    );
    expect(def.type).toBe("cb");
    expect(def.label).toBe("CB (LL)");
    expect(def.style.color).toBe("#336699");
  });
});

describe("descriptor validation (names fail fast, listing the available)", () => {
  const marker = (over: Partial<PhenomenonDescriptor>): PhenomenonDescriptor => ({
    schemaVersion: 1,
    type: "x",
    label: "X",
    icon: "atlas:volcano", // a valid icon — each test targets ONE specific unknown name
    gesture: { primitive: "point", draw: "drop" },
    fields: [{ key: "name", kind: "text", default: "" }],
    card: { framed: "when-named", items: [{ glyph: "atlas:volcano", size: 26 }, { input: { field: "name" } }] },
    style: { color: "#111111" },
    ...over,
  });

  it("an unknown atlas glyph fails at COMPILE time, listing the available ids", () => {
    expect(() => defFromDescriptor(marker({ icon: "atlas:nope" }))).toThrow(/Unknown atlas glyph "nope".*volcano/s);
  });

  it("an unknown named action fails at compile time", () => {
    expect(() =>
      defFromDescriptor(
        marker({
          gesture: { primitive: "polygon", draw: "lasso" },
          render: { edge: { treatment: "dash" } },
          card: { items: [{ text: "x" }], buttons: [{ place: "left", action: "self-destruct" }] },
        }),
      ),
    ).toThrow(/Unknown action "self-destruct".*erase/s);
  });

  it("a card item must set exactly ONE control key", () => {
    expect(() =>
      defFromDescriptor(marker({ card: { items: [{ text: "a", coord: true }] } })),
    ).toThrow(/exactly ONE/);
  });
});

describe("profile JSONs are THE source of the descriptors; glyphs are referenced (svgs/ bank)", () => {
  it("wafs.json holds full inline descriptors; its glyphs are REFERENCES (not inline SVG)", async () => {
    const { BUILTIN_DESCRIPTORS, STOCK_GLYPHS } = await import("../src/core/index.js");
    const profile = (await import("../src/profiles/wafs.json")).default as {
      objects: PhenomenonDescriptor[];
      glyphs: Record<string, string>;
      vertical: { min: number; max: number };
    };
    expect(profile.objects.map((o) => o.type)).toEqual([
      "jetStream", "cb", "icing", "turbulence", "tropopause", "volcano", "tropicalCyclone", "radioactive",
    ]);
    // BUILTIN_DESCRIPTORS is DERIVED from this JSON — every WAFS stock entry IS the very
    // object the profile holds (single source of truth, no TS↔JSON duplication).
    for (const o of profile.objects) expect(BUILTIN_DESCRIPTORS[o.type]).toBe(o);
    // SOURCE `glyphs` = REFERENCES (paths into svgs/), NOT inline SVG — the build resolves
    // them to inline SVG in dist. The lib's stock BUTTON glyphs come from stock-glyphs.json.
    expect(profile.glyphs.cb).toMatch(/\.svg$/);
    expect(profile.glyphs.cb).not.toMatch(/^<svg/);
    expect(STOCK_GLYPHS.cb).toMatch(/^<svg/);
    expect(profile.vertical).toMatchObject({ min: 250, max: 600 });
  });

  it("the TEMSI profiles are full inline descriptors (fronts too); glyphs are references", async () => {
    for (const id of ["temsi-france", "temsi-euroc"]) {
      const profile = (await import(`../src/profiles/${id}.json`)).default as {
        objects: PhenomenonDescriptor[];
        glyphs: Record<string, string>;
      };
      for (const o of profile.objects) {
        expect(typeof o).toBe("object"); // NOT a "name" string reference — fully inline
        expect(o.type).toBeTruthy();
        expect(o.style).toBeTruthy();
        // No object carries an inline SVG icon — fronts (and every other object) reference
        // their icon by name (the default `atlas:<type>`, declared in `glyphs`).
        if (typeof o.icon === "string") expect(o.icon).not.toMatch(/^<svg/);
        if (o.type.startsWith("front")) {
          expect(o.icon).toBeUndefined(); // defaults to atlas:<type>
          expect(profile.glyphs[o.type]).toMatch(/\.svg$/);
        }
      }
      // glyphs hold ONLY bank references (paths) now — no inline <svg> anywhere (single source:
      // the svgs/ bank; the build inlines them into the dist profile).
      for (const ref of Object.values(profile.glyphs)) expect(ref).toMatch(/\.svg$/);
    }
  });
});

describe("movable line label (0°C isotherm)", () => {
  it("def.movableLabel is set and the label rides metadata.labelT along the line", async () => {
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as {
      objects: PhenomenonDescriptor[];
      glyphs: Record<string, string>;
    };
    // zeroIsotherm defaults its icon to `atlas:zeroIsotherm` (declared in `glyphs`) — register
    // the profile glyphs first, exactly as profile ingestion does at runtime.
    const { registerExtensions } = await import("../src/core/index.js");
    registerExtensions({ glyphs: profile.glyphs });
    const spec = profile.objects.find((o) => o.type === "zeroIsotherm")!;
    const def = defFromDescriptor(resolveObjectSpec(spec, mergeDescriptor));
    expect(def.movableLabel).toBe(true);
    const line = { type: "LineString" as const, coordinates: [[0, 46], [10, 46]] };
    const labelLon = (labelT?: number): number => {
      const metadata = { fl: 100, ...(labelT !== undefined ? { labelT } : {}) };
      const feats = def.decorate({ geometry: line, metadata, style: def.style, resolution: 0 });
      const box = feats.find((f) => f.geometry.type === "Point")!;
      return (box.geometry as { coordinates: number[] }).coordinates[0]!;
    };
    expect(labelLon()).toBeCloseTo(5, 1); // default = mid
    expect(labelLon(0.2)).toBeCloseTo(2, 1); // slid toward the start
    expect(labelLon(0.8)).toBeCloseTo(8, 1); // slid toward the end
  });
});

describe("tropopause spot — 3 forms via boxShape (rect / pentagon-up / pentagon-down)", () => {
  it("the spot card's frame shape follows `kind`; the contour keeps its label", async () => {
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as { objects: PhenomenonDescriptor[] };
    const def = defFromDescriptor(resolveObjectSpec(profile.objects.find((o) => o.type === "tropopause")!, mergeDescriptor));
    const call = def.widget as (i: unknown) => { boxShape?: string | number[][] }[] | { boxShape?: string | number[][] } | null;
    const base = { id: "t", style: def.style, chrome: {}, sprite: () => undefined, flightLevel: { min: 0, max: 600 } };
    const spotShape = (kind: string): string | number[][] | undefined => {
      const w = call({ ...base, geometry: { type: "Point", coordinates: [2, 46] }, metadata: { fl: 460, kind }, editable: false });
      return (Array.isArray(w) ? w[0] : w)?.boxShape;
    };
    expect(spotShape("fl")).toBe("rect"); // plain box
    expect(spotShape("high")).toBe("pentagon-up"); // cap holds the H (adapter preset, cap inside [0,1])
    expect(spotShape("low")).toBe("pentagon-down"); // point holds the L
    // contour (LineString) ⇒ no card (the FL label is drawn by decorate)
    expect(call({ ...base, geometry: { type: "LineString", coordinates: [[0, 46], [5, 46]] }, metadata: { fl: 460, kind: "fl" }, editable: false })).toBeNull();
  });
});
