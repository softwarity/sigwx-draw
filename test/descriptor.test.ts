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

describe("profile JSONs are THE source of the stock descriptors (no TS data copy)", () => {
  it("wafs.json is self-contained: full inline descriptors + métier glyphs, and IS the stock", async () => {
    const { BUILTIN_DESCRIPTORS } = await import("../src/core/index.js");
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
    expect(Object.keys(profile.glyphs)).toContain("cb");
    expect(profile.vertical).toMatchObject({ min: 250, max: 600 });
  });

  it("the TEMSI profiles are autoportant (every object is a FULL inline descriptor, fronts too)", async () => {
    for (const id of ["temsi-france", "temsi-euroc"]) {
      const profile = (await import(`../src/profiles/${id}.json`)).default as {
        objects: PhenomenonDescriptor[];
        glyphs: Record<string, string>;
      };
      for (const o of profile.objects) {
        expect(typeof o).toBe("object"); // NOT a "name" string reference — fully inline
        expect(o.type).toBeTruthy();
        expect(o.style).toBeTruthy();
        if (o.type.startsWith("front")) expect(o.icon).toMatch(/^<svg/); // fronts carry their inline icon
      }
      expect(Object.keys(profile.glyphs).length).toBeGreaterThan(0);
    }
  });
});
