import type { FeatureCollection } from "geojson";
import { beforeEach, describe, expect, it } from "vitest";

import type { LatLng } from "../src/core/index.js";
import type { MapAdapter, PointerEvent, SymbolSprites, ToolbarItem } from "../src/map/index.js";
import { SigwxDraw } from "../src/map/index.js";

/** Headless mock adapter: records overlays, exposes a trivial linear projection. */
class MockAdapter implements MapAdapter {
  overlays = new Map<string, FeatureCollection>();
  cb: ((ev: PointerEvent) => void) | undefined;
  panEnabled = true;
  ready(): Promise<void> {
    return Promise.resolve();
  }
  registerSymbols(_s: SymbolSprites): Promise<void> {
    return Promise.resolve();
  }
  setOverlay(id: string, data: FeatureCollection): void {
    this.overlays.set(id, data);
  }
  setStyle(): void {}
  setTooltip(): void {}
  addToolbar(_items: ToolbarItem[]): HTMLElement {
    return {} as HTMLElement;
  }
  getCenter(): LatLng {
    return { lat: 46, lon: 2 };
  }
  getViewSpan(): number {
    return 10;
  }
  project(p: LatLng): [number, number] {
    return [p.lon * 50, -p.lat * 50];
  }
  unproject(px: [number, number]): LatLng {
    return { lon: px[0] / 50, lat: -px[1] / 50 };
  }
  onViewChange(): void {}
  setPanEnabled(enabled: boolean): void {
    this.panEnabled = enabled;
  }
  setDoubleClickZoom(): void {}
  setCursor(): void {}
  onPointer(cb: (ev: PointerEvent) => void): void {
    this.cb = cb;
  }
  destroy(): void {}

  count(layer: string): number {
    return this.overlays.get(layer)?.features.length ?? 0;
  }
  ev(type: PointerEvent["type"], lon: number, lat: number, hit?: PointerEvent["hit"]): void {
    this.cb?.({ type, lngLat: { lon, lat }, ...(hit ? { hit } : {}) });
  }
}

const lastId = (sigwx: SigwxDraw): string => {
  const fc = sigwx.save();
  return fc.features[fc.features.length - 1]!.properties!["id"] as string;
};

const lastMeta = (sigwx: SigwxDraw): Record<string, unknown> => {
  const fc = sigwx.save();
  return fc.features[fc.features.length - 1]!.properties!["metadata"] as Record<string, unknown>;
};

/** Freehand draw (jet): press, drag through the points, release. */
function stroke(sigwx: SigwxDraw, a: MockAdapter, type: string, pts: [number, number][]): string {
  sigwx.draw(type);
  a.ev("down", pts[0]![0], pts[0]![1]);
  for (const [lon, lat] of pts.slice(1)) a.ev("move", lon, lat);
  const last = pts[pts.length - 1]!;
  a.ev("up", last[0], last[1]);
  return lastId(sigwx);
}

/** Click-laid polygon (CB/turbulence): click each point, then double-click. */
function clickDraw(sigwx: SigwxDraw, a: MockAdapter, type: string, pts: [number, number][]): string {
  sigwx.draw(type);
  for (const [lon, lat] of pts) a.ev("click", lon, lat);
  const last = pts[pts.length - 1]!;
  a.ev("dblclick", last[0], last[1]);
  return lastId(sigwx);
}

const JET: [number, number][] = [[0, 0], [2, 1], [4, 0], [6, 1]];
const POLY: [number, number][] = [[0, 0], [4, 0], [4, 4]];

describe("SigwxDraw controller (draw mode)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter });
    await sigwx.ready();
  });

  it("draws a jet: smoothed axis + handles; no barbs at the 80 floor by default", () => {
    stroke(sigwx, adapter, "jetStream", JET);
    expect(sigwx.save().features).toHaveLength(1);
    expect(adapter.count("edge")).toBe(1);
    expect(adapter.count("handles")).toBeGreaterThan(0); // vertices + sliders (selected)
  });

  it("adds barbs as a break point is raised above the 80 floor", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET);
    const before = adapter.count("decoration");
    sigwx.updateListItem(id, "points", 1, { speed: 220 }); // raise the centre point
    expect(adapter.count("decoration")).toBeGreaterThan(before);
  });

  it("pressing a control handle with no selected sub-item leaves pan ENABLED (no stuck-pan)", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET); // feature selected, but no sub-item
    adapter.panEnabled = true;
    // `speed` control requires a selected sub-item → the branch arms NO drag; pan must stay on.
    adapter.ev("down", 1, 1, { overlay: "handles", props: { featureId: id, hClass: "control", role: "speed" } });
    expect(adapter.panEnabled).toBe(true);
    adapter.ev("up", 1, 1);
    expect(adapter.panEnabled).toBe(true);
  });

  it("phenomena.turbulence.flightLevel.default sets the area's [base, top]", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, phenomena: { turbulence: { flightLevel: { default: [300, 420] } } } });
    await s.ready();
    stroke(s, a, "turbulence", [[0, 0], [2, 0], [2, 2], [0, 2]]);
    const md = lastMeta(s);
    expect(md["baseFL"]).toBe(300);
    expect(md["topFL"]).toBe(420);
  });

  it("phenomena.jetStream.flightLevel.default sets every break point's core FL", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, phenomena: { jetStream: { flightLevel: { default: 320 } } } });
    await s.ready();
    stroke(s, a, "jetStream", JET);
    const pts = lastMeta(s)["points"] as { fl: number }[];
    expect(pts.every((p) => p.fl === 320)).toBe(true);
  });

  it("the ✕ delete control (controls overlay) removes the selected feature", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET);
    expect(sigwx.save().features).toHaveLength(1);
    // A press on the ✕ (rendered in the `controls` overlay) deletes the feature.
    adapter.ev("down", 1, 1, { overlay: "controls", props: { featureId: id } });
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("draws a CB polygon: scalloped fill + edge + call-out + leader", () => {
    clickDraw(sigwx, adapter, "cb", POLY);
    expect(adapter.count("area-fill")).toBe(1);
    expect(adapter.count("edge")).toBe(1);
    expect(adapter.count("text-boxes")).toBeGreaterThan(0); // placed call-out (+ FL-gauge labels while selected)
    expect(adapter.count("leaders")).toBeGreaterThan(0); // leader to the anchor (+ gauge axis)
  });

  it("emits a form spec with a list section for the jet", () => {
    let spec: { list?: { items: unknown[] } } | null = null;
    sigwx.on("select", (s) => (spec = s as never));
    stroke(sigwx, adapter, "jetStream", JET);
    expect(spec).not.toBeNull();
    expect(spec!.list?.items.length).toBe(3); // start / centre / end at the 80 floor
  });

  it("sub-selection exposes the selected break point's fields", () => {
    let spec: { list?: { selectedIndex: number | null; itemValues?: Record<string, unknown> } } | null = null;
    sigwx.on("select", (s) => (spec = s as never));
    stroke(sigwx, adapter, "jetStream", JET);
    sigwx.selectSubItem(0);
    expect(spec!.list?.selectedIndex).toBe(0);
    expect(spec!.list?.itemValues?.["speed"]).toBe(80);
  });

  it("applies configurable speed limits to the break-point form fields", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, phenomena: { jetStream: { speed: { min: 100, max: 200 } } } });
    await s.ready();
    let spec: { list?: { itemFields?: { key: string; min?: number; max?: number }[] } } | null = null;
    s.on("select", (x) => (spec = x as never));
    stroke(s, a, "jetStream", JET);
    s.selectSubItem(1); // an interior break point (extremities hide the speed field)
    const speedField = spec!.list?.itemFields?.find((fld) => fld.key === "speed");
    expect(speedField?.min).toBe(100);
    expect(speedField?.max).toBe(200);
  });

  it("save → load round-trips the chart", () => {
    stroke(sigwx, adapter, "jetStream", JET);
    clickDraw(sigwx, adapter, "cb", POLY);
    const saved = sigwx.save();
    expect(saved.features).toHaveLength(2);

    const fresh = new SigwxDraw({ adapter: new MockAdapter() });
    fresh.load(saved);
    expect(fresh.save().features).toHaveLength(2);
  });

  it("clicking a feature hit selects it", () => {
    const id = clickDraw(sigwx, adapter, "cb", POLY);
    sigwx.select(null);
    expect(adapter.count("handles")).toBe(0);
    adapter.ev("click", 2, 2, { overlay: "edge", props: { featureId: id } });
    expect(adapter.count("handles")).toBeGreaterThan(0);
  });

  it("dragging the zone body (edge/fill) moves the whole zone", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const before = JSON.stringify(sigwx.save().features[0]!.geometry);
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("move", 5, 5);
    adapter.ev("up", 5, 5);
    expect(JSON.stringify(sigwx.save().features[0]!.geometry)).not.toEqual(before); // zone translated
  });

  it("dragging the call-out symbol repositions the indicator (call-out), NOT the zone", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const geom = () => JSON.stringify(sigwx.save().features[0]!.geometry);
    const box = () => JSON.stringify(adapter.overlays.get("text-boxes")?.features.map((f) => f.geometry));
    const geom0 = geom(), box0 = box();
    adapter.ev("down", 1, 1, { overlay: "symbols", props: { featureId: id, labelId: "turb" } });
    adapter.ev("move", 10, 10);
    adapter.ev("up", 10, 10);
    expect(geom()).toEqual(geom0); // the zone itself does NOT move
    expect(box()).not.toEqual(box0); // the call-out (indicator) is repositioned
  });

  it("clicking the turbulence symbol (no drag) cycles its enum", () => {
    stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const id = lastId(sigwx);
    const sym0 = (sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["symbol"];
    adapter.ev("down", 1, 1, { overlay: "symbols", props: { featureId: id } });
    adapter.ev("up", 1, 1); // no move → a click cycles MOD → SEV
    const sym1 = (sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["symbol"];
    expect(sym0).toBe("MOD");
    expect(sym1).toBe("SEV");
  });

  it("turbulence FL gauge: base drags to the off-chart (XXX) notch below the floor; flightLevel moves it live", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const baseFL = (): unknown => (sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["baseFL"];
    const dragBaseDown = (): void => {
      adapter.ev("down", 1, 1, { overlay: "handles", props: { featureId: id, hClass: "control", role: "mBase" } });
      adapter.ev("move", 1, -99999); // far DOWN (low lat → high screen-y → low FL), past the floor
      adapter.ev("up", 1, -99999);
    };
    dragBaseDown();
    expect(baseFL()).toBe(245); // norm floor 250 − 5 = the off-chart notch (shown XXX)
    sigwx.setPhenomenonFlightLevel("turbulence", { min: 100 }); // lower the floor live
    dragBaseDown();
    expect(baseFL()).toBe(95); // notch follows the new floor (100 − 5)
  });

  it("turbulenceTypes extends the symbol catalogue (MOD/SEV + added), keeping MOD the default", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, turbulenceTypes: [{ code: "MTW", label: "Mountain wave", svg: "<svg/>" }] });
    await s.ready();
    let spec: { fields?: { key: string; options?: { value: unknown }[]; default?: unknown }[] } | null = null;
    s.on("select", (x) => (spec = x as never));
    stroke(s, a, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]); // freehand balloon
    const sym = spec!.fields?.find((f) => f.key === "symbol");
    const codes = sym?.options?.map((o) => String(o.value));
    expect(codes).toEqual(["MOD", "SEV", "MTW"]); // completes, not replaces; default MOD first
  });
});
