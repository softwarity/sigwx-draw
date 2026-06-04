import type { FeatureCollection } from "geojson";
import { beforeEach, describe, expect, it } from "vitest";

import type { LatLng } from "../src/core/index.js";
import type { MapAdapter, PointerEvent, SymbolSprites, ToolbarItem } from "../src/map/index.js";
import { SigwxDraw } from "../src/map/index.js";

/** Headless mock adapter: records overlays, exposes a trivial linear projection. */
class MockAdapter implements MapAdapter {
  overlays = new Map<string, FeatureCollection>();
  cb: ((ev: PointerEvent) => void) | undefined;
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
  setPanEnabled(): void {}
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

/** Freehand draw (jet): press, drag through the points, release. */
function stroke(sigwx: SigwxDraw, a: MockAdapter, type: string, pts: [number, number][]): string {
  sigwx.addPhenomenon(type);
  a.ev("down", pts[0]![0], pts[0]![1]);
  for (const [lon, lat] of pts.slice(1)) a.ev("move", lon, lat);
  const last = pts[pts.length - 1]!;
  a.ev("up", last[0], last[1]);
  return lastId(sigwx);
}

/** Click-laid polygon (CB/turbulence): click each point, then double-click. */
function clickDraw(sigwx: SigwxDraw, a: MockAdapter, type: string, pts: [number, number][]): string {
  sigwx.addPhenomenon(type);
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

  it("draws a CB polygon: scalloped fill + edge + call-out + leader", () => {
    clickDraw(sigwx, adapter, "cb", POLY);
    expect(adapter.count("area-fill")).toBe(1);
    expect(adapter.count("edge")).toBe(1);
    expect(adapter.count("text-boxes")).toBe(1); // placed call-out
    expect(adapter.count("leaders")).toBe(1); // leader to the anchor
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
    const s = new SigwxDraw({ adapter: a, limits: { jetStream: { speed: { min: 100, max: 200 } } } });
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
});
