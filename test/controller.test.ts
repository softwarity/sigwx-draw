import type { FeatureCollection, MultiPolygon, Position } from "geojson";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LatLng } from "../src/core/index.js";
import type { KeyEvent, MapAdapter, MarkerWidget, PointerEvent, SigwxProfile, SymbolSprites, ToolbarItem, WidgetEdit } from "../src/map/index.js";
import { DEFAULT_STYLE, SigwxDraw } from "../src/map/index.js";

/** Headless mock adapter: records overlays, exposes a trivial linear projection. */
class MockAdapter implements MapAdapter {
  overlays = new Map<string, FeatureCollection>();
  cb: ((ev: PointerEvent) => void) | undefined;
  keyCb: ((ev: KeyEvent) => void) | undefined;
  widgets: MarkerWidget[] = [];
  widgetEditCb: ((e: WidgetEdit) => void) | undefined;
  widgetDeleteCb: ((e: { id: string }) => void) | undefined;
  widgetActionCb: ((e: { id: string; event: string }) => void) | undefined;
  coordFormat: ((ll: LatLng) => string) | undefined;
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
  toolbarItems: ToolbarItem[] = [];
  addToolbar(items: ToolbarItem[]): HTMLElement {
    this.toolbarItems = items;
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
  setInteractive(): void {} // draw-adapter 0.2.7 (lock map)
  setActiveTool(): void {} // draw-adapter 0.4.x (toolbar active-tool highlight)
  setCursor(): void {}
  onPointer(cb: (ev: PointerEvent) => void): void {
    this.cb = cb;
  }
  onKey(cb: (ev: KeyEvent) => void): void { this.keyCb = cb; } // draw-adapter 0.2.7 (keyboard transport)
  setWidgets(widgets: MarkerWidget[]): void { this.widgets = widgets; } // draw-adapter 0.3 (marker widgets)
  onWidgetEdit(cb: (e: WidgetEdit) => void): void { this.widgetEditCb = cb; }
  onWidgetDelete(cb: (e: { id: string }) => void): void { this.widgetDeleteCb = cb; }
  onWidgetAction(cb: (e: { id: string; event: string }) => void): void { this.widgetActionCb = cb; }
  setCoordFormat(fn: (ll: LatLng) => string): void { this.coordFormat = fn; }
  destroy(): void {}

  count(layer: string): number {
    return this.overlays.get(layer)?.features.length ?? 0;
  }
  ev(type: PointerEvent["type"], lon: number, lat: number, hit?: PointerEvent["hit"], mods?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): void {
    this.cb?.({ type, lngLat: { lon, lat }, ...(hit ? { hit } : {}), ...(mods ?? {}) } as PointerEvent);
  }
  key(key: string): void {
    this.keyCb?.({ key, code: key, ctrl: false, meta: false, shift: false, alt: false, preventDefault: () => {} });
  }
  editWidget(id: string, value: string, name?: string): void { this.widgetEditCb?.({ id, value, ...(name != null ? { name } : {}) }); }
  /** Simulate a gauge/dial cursor drag ⇒ onWidgetEdit({ id, name, value: String(v) }). */
  dragGauge(id: string, name: string, value: number): void { this.widgetEditCb?.({ id, name, value: String(value) }); }
  deleteWidget(id: string): void { this.widgetDeleteCb?.({ id }); }
  actionWidget(id: string, event: string): void { this.widgetActionCb?.({ id, event }); }
  widget(id: string): MarkerWidget | undefined { return this.widgets.find((w) => w.id === id); }
  clickWidget(id: string): void { this.ev("click", 0, 0, { overlay: "widget", props: { id } }); }
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

const JET: [number, number][] = [[0, 0], [2, 1], [4, 0], [6, 1]];
const POLY: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 4]];

describe("SigwxDraw controller (draw mode)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter });
    await sigwx.ready();
  });

  it("re-loading a saved drawing into a FRESH controller doesn't let the next draw overwrite a loaded feature (engine switch)", async () => {
    const first = stroke(sigwx, adapter, "cb", POLY);
    const saved = sigwx.save();
    expect(saved.features).toHaveLength(1);
    // Simulate the demo switching engines: brand-new adapter + controller, re-hydrate the SAME
    // collection, then draw again. The fresh controller's id counter must advance past the
    // loaded `fN` ids, or the new draw reuses `f0` and clobbers the loaded feature.
    const adapter2 = new MockAdapter();
    const sigwx2 = new SigwxDraw({ adapter: adapter2 });
    await sigwx2.ready();
    sigwx2.load(saved);
    const second = stroke(sigwx2, adapter2, "icing", [[10, 10], [14, 10], [14, 14], [10, 14]]);
    expect(second).not.toBe(first); // a fresh id, not a reused f0
    expect(sigwx2.save().features).toHaveLength(2); // the loaded feature SURVIVES the new draw
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

  it("a jet break point's editor is TWO cards: a speed dial ON the point + an FL gauge beside (3 cursors past 120 kt)", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET);
    expect(adapter.widget(`${id}#dial`)).toBeUndefined(); // no sub-selection → no cards
    sigwx.selectSubItem(1); // an interior break point
    expect(adapter.widget(`${id}#dial`)!.origin).toBeUndefined(); // default "center" — the dial rings the point
    const dial = () => adapter.widget(`${id}#dial`)!.child.items[0] as { kind: string; name: string; min: number; label?: string };
    const gauge = () => adapter.widget(`${id}#gauge`)!.child.items[0] as { kind: string; cursors: { name: string }[] };
    expect(dial().kind).toBe("dial");
    expect(dial().min).toBe(80); // the WAFC depiction floor
    expect(gauge().kind).toBe("gauge");
    expect(gauge().cursors).toHaveLength(1); // below 120 kt → the core FL only
    const pts = (): Record<string, unknown>[] => lastMeta(sigwx)["points"] as Record<string, unknown>[];
    adapter.dragGauge(id, "points.1.speed", 173); // dial drag → rounded to 5 kt, persisted
    expect(pts()[1]!["speed"]).toBe(175);
    expect(dial().label).toBe("175KT"); // the card re-rendered live
    adapter.dragGauge(id, "points.1.speed", 220); // past 120 → the isotach extent cursors appear
    expect(gauge().cursors).toHaveLength(3);
    adapter.dragGauge(id, "points.1.base", 99999); // base can never pass the core FL
    expect(pts()[1]!["base"]).toBe(300);
    sigwx.selectSubItem(null); // sub-deselection drops the cards
    expect(adapter.widget(`${id}#dial`)).toBeUndefined();
    expect(adapter.widget(`${id}#gauge`)).toBeUndefined();
  });

  it("renders NO on-map ✕ control; Backspace (via adapter.onKey) deletes the selection", () => {
    stroke(sigwx, adapter, "jetStream", JET); // selected on commit
    expect(sigwx.save().features).toHaveLength(1);
    expect(adapter.count("controls")).toBe(0); // the red ✕ is gone (keyboard only)
    adapter.key("Backspace"); // the adapter's normalized key event → delete the selection
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("draws a CB polygon: scalloped fill + edge + call-out + leader", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    expect(adapter.count("area-fill")).toBe(1);
    expect(adapter.count("edge")).toBe(1);
    expect(adapter.widget(id)).toBeDefined(); // SELECTED ⇒ the card replaces the call-out box
    expect(adapter.count("leaders")).toBeGreaterThan(0); // leader to the anchor
    sigwx.select(null);
    expect(adapter.count("text-boxes")).toBeGreaterThan(0); // unselected ⇒ the canvas call-out
  });

  it("dragging a jet's body (axis/barbs) translates the whole jet, like an area", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET);
    const coords = () => (sigwx.save().features[0]!.geometry as { coordinates: [number, number][] }).coordinates;
    const before = coords().map((c) => [...c] as [number, number]);
    adapter.ev("down", 2, 1, { overlay: "decoration", props: { featureId: id } });
    adapter.ev("move", 5, 4);
    adapter.ev("up", 5, 4);
    const after = coords();
    expect(after[0]![0]).not.toBeCloseTo(before[0]![0], 5); // it moved
    // rigid translate: inter-vertex offsets are preserved (the shape didn't deform)
    expect(after[1]![0] - after[0]![0]).toBeCloseTo(before[1]![0] - before[0]![0], 5);
    expect(after[1]![1] - after[0]![1]).toBeCloseTo(before[1]![1] - before[0]![1], 5);
  });

  it("tapping the CB call-out box does NOT cycle anymore — editing lives on the card's carousel", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    expect(lastMeta(sigwx)["coverage"]).toBe("OCNL"); // default
    adapter.ev("down", 5, 5, { overlay: "text-boxes", props: { featureId: id, labelId: "cb" } });
    adapter.ev("up", 5, 5);
    expect(lastMeta(sigwx)["coverage"]).toBe("OCNL"); // a tap selects/repositions, never cycles
    adapter.editWidget(id, "FRQ", "coverage"); // the card carousel is THE edit path
    expect(lastMeta(sigwx)["coverage"]).toBe("FRQ");
  });

  it("the ERASER rubs a clear HOLE (interior ring) — inverted border, arrow re-clamped outside it", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // (0,0)…(4,4)
    adapter.actionWidget(id, "erase"); // the card's − button arms the eraser
    adapter.ev("down", 2, 2); // rub the middle…
    adapter.ev("move", 2.4, 2);
    adapter.ev("up", 2.4, 2);
    const g = sigwx.save().features[0]!.geometry as { type: string; coordinates: Position[][] };
    expect(g.type).toBe("Polygon");
    expect(g.coordinates.length).toBe(2); // outer ring + ONE hole
    // the arrow tip is clamped OUTSIDE the hole (still inside the outer ring)
    sigwx.select(null);
    expect((sigwx.save().features[0]!.geometry as { coordinates: Position[][] }).coordinates).toHaveLength(2);
  });

  it("HOLE vertices edit like the others: flat handles, drag, delete-to-collapse", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // outer: 4 unique vertices (flat 0..3)
    adapter.actionWidget(id, "erase");
    adapter.ev("down", 2, 2); // tap → a round hole
    adapter.ev("up", 2, 2);
    adapter.key("Escape");
    const rings = () => (sigwx.save().features[0]!.geometry as { coordinates: Position[][] }).coordinates;
    expect(rings().length).toBe(2);
    const holeN = rings()[1]!.length - 1; // unique hole vertices
    // handles cover outer + hole (flat indexing)
    const handles = adapter.overlays.get("handles")!.features.filter((h) => h.properties?.["hClass"] === "vertex");
    expect(handles.length).toBe(4 + holeN);
    // DRAG a hole vertex (flat index 4 = the hole's first) → the hole moves with it
    const before = JSON.stringify(rings()[1]);
    adapter.ev("down", 0, 0, { overlay: "handles", props: { featureId: id, hClass: "vertex", role: "v4" } });
    adapter.ev("move", 2.2, 2.2);
    adapter.ev("up", 2.2, 2.2);
    expect(JSON.stringify(rings()[1])).not.toEqual(before);
    // DELETE hole vertices one by one — at the 3-vertex minimum the hole closes up
    for (let i = 0; i < holeN; i++) adapter.ev("dblclick", 0, 0, { overlay: "handles", props: { featureId: id, hClass: "vertex", role: "v4" } });
    expect(rings().length).toBe(1); // the hole is gone, the zone is whole again
  });

  it("the ERASER bites through the border (reshape) and CUTS an area in two (MultiPolygon)", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    adapter.actionWidget(id, "erase");
    // a vertical rub straight across the middle, edge to edge → split in two
    adapter.ev("down", 2, -1);
    adapter.ev("move", 2, 2);
    adapter.ev("move", 2, 5);
    adapter.ev("up", 2, 5);
    const g = sigwx.save().features[0]!.geometry;
    expect(g.type).toBe("MultiPolygon"); // the patate is now TWO areas…
    const leaders = (adapter.overlays.get("leaders")?.features ?? []).filter((l) => l.properties?.["featureId"] === id);
    expect(leaders.length).toBeGreaterThanOrEqual(2); // …each with its own arrow (selected ⇒ card replaces the box)
    adapter.key("Escape"); // exits the eraser
    adapter.ev("down", 1, 1); // a fresh down no longer rubs
    adapter.ev("up", 1, 1);
    expect(sigwx.save().features[0]!.geometry.type).toBe("MultiPolygon"); // unchanged
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
    stroke(sigwx, adapter, "cb", POLY);
    const saved = sigwx.save();
    expect(saved.features).toHaveLength(2);

    const fresh = new SigwxDraw({ adapter: new MockAdapter() });
    fresh.load(saved);
    expect(fresh.save().features).toHaveLength(2);
  });

  it("clicking a feature hit selects it", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
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
    const card = () => JSON.stringify(adapter.widget(id)!.anchor); // the card sits at the placed call-out
    const geom0 = geom(), card0 = card();
    adapter.ev("down", 1, 1, { overlay: "symbols", props: { featureId: id, labelId: "turb" } });
    adapter.ev("move", 10, 10);
    adapter.ev("up", 10, 10);
    expect(geom()).toEqual(geom0); // the zone itself does NOT move
    expect(card()).not.toEqual(card0); // the call-out (indicator) is repositioned
  });

  it("clicking the turbulence symbol does NOT cycle anymore — editing lives on the card's carousel", () => {
    stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const id = lastId(sigwx);
    adapter.ev("down", 1, 1, { overlay: "symbols", props: { featureId: id } });
    adapter.ev("up", 1, 1); // a tap selects/repositions, never cycles
    expect((sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["symbol"]).toBe("MOD");
    adapter.editWidget(id, "SEV", "symbol"); // the card carousel is THE edit path
    expect((sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["symbol"]).toBe("SEV");
  });

  it("turbulence FL gauge (card): base drags to the off-chart (XXX) notch below the floor; flightLevel moves it live", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const baseFL = (): unknown => (sigwx.save().features[0]!.properties!["metadata"] as Record<string, unknown>)["baseFL"];
    const gauge = () => (adapter.widget(`${id}#gauge`)!.child.items[0] as { kind: string; beyond?: { below?: boolean }; cursors: { name: string; value: number; label?: string }[] });
    expect(gauge().kind).toBe("gauge"); // a SATELLITE card beside the call-out carries the gauge
    expect(gauge().beyond?.below).toBe(true); // areas default to the off-chart XXX notch
    adapter.dragGauge(id, "baseFL", -99999); // way past the floor → clamps to the notch
    expect(baseFL()).toBe(245); // norm floor 250 − 5 = the off-chart notch…
    expect(gauge().cursors[0]!.label).toBe("XXX"); // …labelled XXX on the re-rendered card
    sigwx.setPhenomenonFlightLevel("turbulence", { min: 100 }); // lower the floor live
    adapter.dragGauge(id, "baseFL", -99999);
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

  it("phenomena.cb.extraCoverages extends the coverage carousel (OCNL/FRQ + added), keeping OCNL the default", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, phenomena: { cb: { extraCoverages: ["OCNL EMBD"] } } });
    await s.ready();
    let spec: { fields?: { key: string; options?: { value: unknown }[]; default?: unknown }[] } | null = null;
    s.on("select", (x) => (spec = x as never));
    stroke(s, a, "cb", [[0, 0], [4, 0], [4, 4], [0, 4]]); // freehand balloon
    const cov = spec!.fields?.find((f) => f.key === "coverage");
    const codes = cov?.options?.map((o) => String(o.value));
    expect(codes).toEqual(["OCNL", "FRQ", "OCNL EMBD"]); // completes, not replaces; default OCNL first
  });
});

describe("tropopause (one button → spot or contour by gesture)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter });
    await sigwx.ready();
  });

  it("a real drag draws a CONTOUR (LineString) — dotted edge + a centred FL label", () => {
    stroke(sigwx, adapter, "tropopause", [[0, 0], [2, 1], [4, 0]]); // ~206 px extent ≫ threshold
    const f = sigwx.save().features[0]!;
    expect(f.geometry.type).toBe("LineString");
    expect(f.properties!["phenomenon"]).toBe("tropopause");
    expect(adapter.count("edge")).toBeGreaterThanOrEqual(1); // the dotted iso-line
    expect(adapter.count("text-boxes")).toBeGreaterThanOrEqual(1); // the FL label
  });

  it("a click (no drag) drops a spot-height POINT", () => {
    sigwx.draw("tropopause");
    adapter.ev("down", 1, 1);
    adapter.ev("up", 1, 1); // no move → 1 coord → 0 px extent → point
    const f = sigwx.save().features[0]!;
    expect(f.geometry.type).toBe("Point");
    expect(f.properties!["phenomenon"]).toBe("tropopause");
  });

  it("a tiny drag (below the line threshold) also drops a POINT", () => {
    sigwx.draw("tropopause");
    adapter.ev("down", 0, 0);
    adapter.ev("move", 0.5, 0.2); // ~27 px extent < 60 px threshold
    adapter.ev("up", 0.5, 0.2);
    expect(sigwx.save().features[0]!.geometry.type).toBe("Point");
  });

  it("the single-FL gauge (satellite card) drags the contour's fl, clamped to the field range", () => {
    const id = stroke(sigwx, adapter, "tropopause", [[0, 0], [2, 1], [4, 0]]);
    expect(lastMeta(sigwx)["fl"]).toBe(380); // default
    // The gauge is a SATELLITE card (`#gauge`-suffixed id, like every satellite).
    const g = adapter.widget(`${id}#gauge`)!.child.items[0] as { kind: string; cursors: { name: string }[] };
    expect(g.kind).toBe("gauge"); // a satellite card beside the FL label, 1 cursor
    expect(g.cursors).toHaveLength(1);
    adapter.dragGauge(id, "fl", 99999); // way up → saturates at the field max (clamp, no notch)
    expect(lastMeta(sigwx)["fl"]).toBe(600);
    adapter.dragGauge(id, "fl", -99999); // …and way down → the field min
    expect(lastMeta(sigwx)["fl"]).toBe(250);
  });

  it("deleting contour vertices one by one collapses to a spot POINT at the last", () => {
    const id = stroke(sigwx, adapter, "tropopause", [[0, 0], [2, 1], [4, 0]]); // 3 vertices
    expect(sigwx.save().features[0]!.geometry.type).toBe("LineString");
    const del = (i: number) => adapter.ev("dblclick", 0, 0, { overlay: "handles", props: { featureId: id, hClass: "vertex", role: `v${i}` } });
    del(0); // 3 → 2 vertices, still a line
    expect(sigwx.save().features[0]!.geometry.type).toBe("LineString");
    del(0); // 2 → 1 → collapses to a spot point (keeps the `fl`)
    const f = sigwx.save().features[0]!;
    expect(f.geometry.type).toBe("Point");
    expect((f.properties!["metadata"] as Record<string, unknown>)["fl"]).toBe(380);
  });
});

describe("call-out boxes (draw-adapter 0.2.8 boxes a border-only label too)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter });
    await sigwx.ready();
  });

  const callout = (labelId: string) =>
    (adapter.overlays.get("text-boxes")?.features ?? []).find((b) => b.properties?.["labelId"] === labelId);

  it("turbulence FL call-out is UNBOXED — no textBackground NOR textBorder on the placed box", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    expect(callout("turb")).toBeUndefined(); // SELECTED ⇒ the widget card replaces the canvas call-out
    sigwx.select(null);
    expect(adapter.widget(id)).toBeUndefined(); // unselected ⇒ card gone, canvas call-out back
    const box = callout("turb");
    expect(box).toBeDefined();
    expect(box!.properties?.["textBackground"]).toBeUndefined();
    expect(box!.properties?.["textBorder"]).toBeUndefined(); // ← a border alone would draw a box in 0.2.8
  });

  it("CB call-out stays BOXED — textBackground + textBorder both present", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    expect(callout("cb")).toBeUndefined(); // SELECTED ⇒ the widget card replaces the canvas box
    sigwx.select(null);
    expect(adapter.widget(id)).toBeUndefined(); // unselected ⇒ card gone, canvas box back
    const box = callout("cb");
    expect(box).toBeDefined();
    expect(box!.properties?.["textBackground"]).toBeDefined();
    expect(box!.properties?.["textBorder"]).toBeDefined();
  });
});

describe("marker phenomena (TC / volcano / radioactive — inline-editable widgets)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter });
    await sigwx.ready();
  });

  const item = (w: MarkerWidget, kind: string) => w.child.items.find((i) => "kind" in i && i.kind === kind) as { kind: string; editable?: boolean } | undefined;

  it("dropping a volcano emits a SELECTED, editable widget — and NO overlay features", () => {
    const id = sigwx.draw("volcano"); // drop mode → created + selected, returns the id
    const w = adapter.widget(id);
    expect(w).toBeDefined();
    expect(item(w!, "glyph")).toBeDefined();
    expect(item(w!, "text")?.editable).toBe(true);  // selected ⇒ inline input
    expect(adapter.count("symbols")).toBe(0);       // the widget IS the rendering
    expect(adapter.count("text-boxes")).toBe(0);
  });

  it("typing the name (onWidgetEdit) writes metadata.name and frames the card with a coord", () => {
    const id = sigwx.draw("volcano");
    adapter.editWidget(id, "Etna");
    expect(lastMeta(sigwx)["name"]).toBe("Etna");
    const w = adapter.widget(id)!;
    expect(w.border).toBeDefined();          // framed once named
    expect(item(w, "coord")).toBeDefined();  // + the auto lat/long line
  });

  it("clicking a widget card selects its feature (the `widget` hit carries the id)", () => {
    const id = sigwx.draw("volcano");
    sigwx.select(null);
    expect(item(adapter.widget(id)!, "text")).toBeUndefined(); // deselected + unnamed ⇒ no text
    adapter.clickWidget(id);
    expect(item(adapter.widget(id)!, "text")?.editable).toBe(true); // selected again ⇒ editable
  });

  it("an UNSELECTED, UNNAMED volcano is glyph-only (no frame, no coord)", () => {
    const id = sigwx.draw("volcano");
    sigwx.select(null);
    const w = adapter.widget(id)!;
    expect(w.border).toBeUndefined();
    expect(w.child.items).toHaveLength(1);
    expect((w.child.items[0] as { kind: string }).kind).toBe("glyph");
  });

  it("a tropical cyclone is BARE: name 'NN', NO frame, NO coord; NH glyph not mirrored at +lat", () => {
    const id = sigwx.draw("tropicalCyclone"); // dropped at centre (lat 46 → NH)
    expect(lastMeta(sigwx)["name"]).toBe("NN");
    const w = adapter.widget(id)!;
    expect(w.border).toBeUndefined();             // no frame
    expect(item(w, "coord")).toBeUndefined();     // no coord line
    expect(item(w, "text")?.editable).toBe(true); // the NN name IS shown (editable while selected)
    expect((item(w, "glyph") as unknown as { svg: string }).svg).not.toContain("scale(-1"); // NH
  });

  it("a SELECTED marker carries a delete button; onWidgetDelete removes the feature", () => {
    const id = sigwx.draw("volcano");
    expect(adapter.widget(id)!.deletable).toBe(true);   // selected ⇒ ✕ (the input swallows Delete)
    sigwx.select(null);
    expect(adapter.widget(id)!.deletable).toBe(false);  // unselected ⇒ no ✕
    sigwx.select(id);
    adapter.deleteWidget(id);                            // click the ✕ → onWidgetDelete
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("a SELECTED CB carries the '+' edge-buttons control card; hidden once unselected; markers don't", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // drawn ⇒ selected
    const w = adapter.widget(id)!;
    expect(w.buttons?.[0]?.event).toBe("draw-more");
    expect(w.buttons?.[0]?.place).toBe("h-edges"); // + on top/bottom…
    // The eraser is no longer a card button — it's Ctrl/⌘ + hover (brush) / click (dig),
    // so the `+` is the ONLY edge button now.
    expect(w.buttons).toHaveLength(1);
    sigwx.select(null);
    expect(adapter.widget(id)).toBeUndefined(); // the control card exists ONLY while selected
    const vid = sigwx.draw("volcano"); // markers no longer carry edge buttons
    expect(adapter.widget(vid)!.buttons).toBeUndefined();
  });

  it("CB 'draw-more' (+) appends an EXTRA AREA to the SAME CB — MultiPolygon, one box, one arrow per area", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    adapter.actionWidget(id, "draw-more"); // click a "+" → draw mode, appending to THIS CB
    adapter.ev("down", 6, 6);
    adapter.ev("move", 8, 6);
    adapter.ev("move", 8, 8);
    adapter.ev("move", 6, 8);
    adapter.ev("up", 6, 8);
    const fc = sigwx.save();
    expect(fc.features).toHaveLength(1); // ONE logical CB…
    const g = fc.features[0]!.geometry;
    expect(g.type).toBe("MultiPolygon"); // …now holding TWO areas
    expect((g as MultiPolygon).coordinates).toHaveLength(2);
    expect(adapter.widget(id)).toBeDefined(); // back selected on the same CB — its card is live again
    // TWO leaders, each with its arrowhead "V" (2 features per area), all from the one box.
    const leaders = (adapter.overlays.get("leaders")?.features ?? []).filter((l) => l.properties?.["featureId"] === id);
    expect(leaders).toHaveLength(4);
  });

  it("deleting an appended area's vertices removes THE AREA; the last area demotes back to Polygon", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    adapter.actionWidget(id, "draw-more");
    adapter.ev("down", 6, 6);
    adapter.ev("move", 8, 6);
    adapter.ev("move", 8, 8);
    adapter.ev("move", 6, 8);
    adapter.ev("up", 6, 8);
    const before = (sigwx.save().features[0]!.geometry as MultiPolygon).coordinates;
    const n0 = before[0]![0]!.length - 1; // area 0's unique vertex count (flat indexing starts there)
    // Dbl-click the SECOND area's first vertex handle until that area dies (≤3 left → whole area).
    const del = () => adapter.ev("dblclick", 0, 0, { overlay: "handles", props: { featureId: id, hClass: "vertex", role: `v${n0}` } });
    let g = sigwx.save().features[0]!.geometry;
    let guard = 20;
    while (g.type === "MultiPolygon" && guard-- > 0) {
      del();
      g = sigwx.save().features[0]!.geometry;
    }
    expect(g.type).toBe("Polygon"); // the 2nd area vanished, back to a simple CB
    expect((g as { coordinates: unknown[][] }).coordinates[0]).toHaveLength(before[0]![0]!.length); // area 0 untouched
  });

  const appendArea = (id: string) => {
    adapter.actionWidget(id, "draw-more");
    adapter.ev("down", 6, 6);
    adapter.ev("move", 8, 6);
    adapter.ev("move", 8, 8);
    adapter.ev("move", 6, 8);
    adapter.ev("up", 6, 8);
  };

  it("dblclick inserts a vertex into the CLICKED area's ring (multi-area fix)", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // area 0: (0,0)…(4,4)
    appendArea(id); // area 1: (6,6)…(8,8)
    const g0 = sigwx.save().features[0]!.geometry as MultiPolygon;
    const n0 = g0.coordinates[0]![0]!.length;
    const n1 = g0.coordinates[1]![0]!.length;
    adapter.ev("dblclick", 7, 6, { overlay: "edge", props: { featureId: id } }); // on area 1's edge
    const g1 = sigwx.save().features[0]!.geometry as MultiPolygon;
    expect(g1.coordinates[1]![0]!.length).toBe(n1 + 1); // the clicked ring grew…
    expect(g1.coordinates[0]![0]!.length).toBe(n0); // …the other did not
  });

  it("clicking ONE area narrows the selection (handles for that ring only); Del removes the AREA, the box survives", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    appendArea(id); // append narrows to the NEW area — click area 0 to re-narrow there
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("up", 2, 2);
    const g = sigwx.save().features[0]!.geometry as MultiPolygon;
    const handles = (adapter.overlays.get("handles")?.features ?? []).filter((h) => h.properties?.["hClass"] === "vertex");
    expect(handles).toHaveLength(g.coordinates[0]![0]!.length - 1); // ring 0's unique verts only
    expect(adapter.widget(id)).toBeDefined(); // the info box stays selected with it
    adapter.key("Backspace"); // → delete the SELECTED AREA, not the feature
    expect(sigwx.save().features).toHaveLength(1); // feature (and box) survive
    const g1 = sigwx.save().features[0]!.geometry;
    expect(g1.type).toBe("Polygon"); // one area left → demoted
    const ring = (g1 as { coordinates: Position[][] }).coordinates[0]!;
    expect(ring.every((p) => p[0]! >= 5 && p[1]! >= 5)).toBe(true); // the APPENDED area remains
    adapter.key("Backspace"); // simple Polygon, no narrowed area → whole feature goes
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("dragging a narrowed area moves ONLY that area — the other area stays put", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    appendArea(id);
    const g0 = sigwx.save().features[0]!.geometry as MultiPolygon;
    const area0Before = JSON.stringify(g0.coordinates[0]);
    const a1lon = g0.coordinates[1]![0]![0]![0]!;
    // grab INSIDE area 1 (6..8 box) and drag it 1° east
    adapter.ev("down", 7, 7, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("move", 8, 7);
    adapter.ev("up", 8, 7);
    const g1 = sigwx.save().features[0]!.geometry as MultiPolygon;
    expect(JSON.stringify(g1.coordinates[0])).toBe(area0Before); // area 0 untouched
    expect(g1.coordinates[1]![0]![0]![0]!).toBeCloseTo(a1lon + 1, 5); // area 1 shifted ~1° east
  });

  it("SHIFT-click multi-selects areas: handles on both, drag moves BOTH, Del on all deletes the feature", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    appendArea(id);
    // click area 0, then SHIFT-click area 1 → both selected
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("up", 2, 2);
    adapter.ev("down", 7, 7, { overlay: "area-fill", props: { featureId: id } }, { shiftKey: true });
    const g0 = sigwx.save().features[0]!.geometry as MultiPolygon;
    const total = g0.coordinates[0]![0]!.length - 1 + (g0.coordinates[1]![0]!.length - 1);
    const a0 = g0.coordinates[0]![0]![0]![0]!; // primitives — save() hands back the LIVE geometry
    const a1 = g0.coordinates[1]![0]![0]![0]!;
    // drag while both selected: ALL areas move (the info box anchor follows the geometry)
    adapter.ev("move", 8, 7);
    adapter.ev("up", 8, 7);
    const handles = (adapter.overlays.get("handles")?.features ?? []).filter((h) => h.properties?.["hClass"] === "vertex");
    expect(handles).toHaveLength(total); // both rings' handles
    const g1 = sigwx.save().features[0]!.geometry as MultiPolygon;
    expect(g1.coordinates[0]![0]![0]![0]!).toBeCloseTo(a0 + 1, 5); // area 0 moved too
    expect(g1.coordinates[1]![0]![0]![0]!).toBeCloseTo(a1 + 1, 5); // area 1 moved
    adapter.key("Backspace"); // every area selected → the whole feature (box included) goes
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("the CB card's coverage line is a CAROUSEL control; its edit lands in metadata.coverage", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    const w = adapter.widget(id)!;
    const cov = w.child.items[0] as { kind: string; control?: string; name?: string; value?: string; options?: unknown[] };
    expect(cov.control).toBe("picker");
    expect(cov.name).toBe("coverage");
    expect(cov.value).toBe("OCNL");
    // the "CB" word folds INTO the clickable label, stacked under the coverage (pre-line);
    // the full coverage name rides along as the option `title` (tooltip).
    expect((cov.options as { value: string; label: string; title?: string }[]).map((o) => ({ value: o.value, label: o.label }))).toEqual([
      { value: "OCNL", label: "OCNL\nCB" },
      { value: "FRQ", label: "FRQ\nCB" },
    ]);
    expect((cov.options as { title?: string }[]).every((o) => typeof o.title === "string" && o.title.length > 0)).toBe(true);
    adapter.editWidget(id, "FRQ", "coverage"); // a carousel cycle
    expect(lastMeta(sigwx)["coverage"]).toBe("FRQ");
    expect((adapter.widget(id)!.child.items[0] as { value?: string }).value).toBe("FRQ"); // re-rendered
    adapter.editWidget(id, "ignored-name-field", undefined); // nameless = the markers' name input…
    expect(lastMeta(sigwx)["name"]).toBe("ignored-name-field"); // …routes to metadata.name (harmless on CB)
  });

  it("turbulence card: UNFRAMED (bare, like the call-out) but padded so edge buttons clear content, severity GLYPH carousel, canvas glyph suppressed while selected", () => {
    const id = stroke(sigwx, adapter, "turbulence", POLY);
    const w = adapter.widget(id)!;
    expect(w.bg).toBeUndefined();     // unframed: no box, no border (just bare text + glyph)
    expect(w.border).toBeUndefined();
    // …yet it still REQUESTS inner padding (it has +/− edge buttons): the adapter applies it bare.
    expect((w as { padding?: string }).padding).toBe("large");
    const sev = w.child.items[0] as { control?: string; name?: string; value?: string; options?: { value: string; svg?: string }[] };
    expect((adapter.widget(`${id}#gauge`)!.child.items[0] as { kind?: string }).kind).toBe("gauge"); // satellite gauge card
    expect(sev.control).toBe("picker");
    expect(sev.name).toBe("symbol");
    expect(sev.value).toBe("MOD");
    expect(sev.options?.map((o) => o.value)).toEqual(["MOD", "SEV"]);
    expect(sev.options?.every((o) => typeof o.svg === "string" && o.svg.includes("<svg"))).toBe(true); // real glyphs
    // the canvas severity glyph is NOT also rendered while the card replaces the call-out
    expect((adapter.overlays.get("symbols")?.features ?? []).filter((s) => s.properties?.["featureId"] === id)).toHaveLength(0);
    adapter.editWidget(id, "SEV", "symbol"); // cycle on the card
    expect(lastMeta(sigwx)["symbol"]).toBe("SEV");
    sigwx.select(null); // canvas call-out (and its glyph) come back
    expect((adapter.overlays.get("symbols")?.features ?? []).filter((s) => s.properties?.["featureId"] === id)).toHaveLength(1);
  });

  it("icing card: FRAMED b&w, fork glyph carousel, no leading blank lines", () => {
    const id = stroke(sigwx, adapter, "icing", POLY);
    const w = adapter.widget(id)!;
    expect(w.bg).toBeDefined(); // boxed panel
    expect(w.border).toBeDefined();
    const sev = w.child.items[0] as { control?: string; name?: string; value?: string; options?: { value: string }[] };
    expect(sev.control).toBe("picker");
    expect(sev.value).toBe("ICE_MOD");
    expect(sev.options?.map((o) => o.value)).toEqual(["ICE_MOD", "ICE_SEV"]);
    const texts = w.child.items.slice(1) as { value: string }[];
    expect(texts.every((t) => t.value.trim() !== "")).toBe(true); // the reserved blank lines are dropped
    adapter.editWidget(id, "ICE_SEV", "symbol");
    expect(lastMeta(sigwx)["symbol"]).toBe("ICE_SEV");
  });

  it("turbulence 'draw-more' (+) appends an EXTRA AREA — MultiPolygon, per-ring edges, one arrow per area", () => {
    const id = stroke(sigwx, adapter, "turbulence", POLY);
    const edges = () => (adapter.overlays.get("edge")?.features ?? []).filter((e) => e.properties?.["featureId"] === id).length;
    const before = edges();
    appendArea(id);
    const fc = sigwx.save();
    expect(fc.features).toHaveLength(1); // ONE logical zone…
    const g = fc.features[0]!.geometry;
    expect(g.type).toBe("MultiPolygon"); // …now holding TWO areas
    expect((g as MultiPolygon).coordinates).toHaveLength(2);
    expect(adapter.widget(id)).toBeDefined(); // back selected on the same zone — its card is live again
    expect(edges()).toBeGreaterThan(before); // a dashed balloon edge PER ring
    // TWO leaders, each with its arrowhead "V" (2 features per area), all from the one call-out.
    const leaders = (adapter.overlays.get("leaders")?.features ?? []).filter((l) => l.properties?.["featureId"] === id);
    expect(leaders).toHaveLength(4);
  });

  it("icing 'draw-more' (+) appends an EXTRA AREA — MultiPolygon, per-ring edges + ticks, one arrow per area", () => {
    const id = stroke(sigwx, adapter, "icing", POLY);
    const edges = () => (adapter.overlays.get("edge")?.features ?? []).filter((e) => e.properties?.["featureId"] === id).length;
    const before = edges();
    appendArea(id);
    const fc = sigwx.save();
    expect(fc.features).toHaveLength(1); // ONE logical zone…
    const g = fc.features[0]!.geometry;
    expect(g.type).toBe("MultiPolygon"); // …now holding TWO areas
    expect((g as MultiPolygon).coordinates).toHaveLength(2);
    expect(adapter.widget(id)).toBeDefined(); // back selected on the same zone — its card is live again
    expect(edges()).toBeGreaterThan(before); // a dashed edge + tick MultiLineString PER ring
    // TWO leaders, each with its arrowhead "V" (2 features per area), all from the one panel.
    const leaders = (adapter.overlays.get("leaders")?.features ?? []).filter((l) => l.properties?.["featureId"] === id);
    expect(leaders).toHaveLength(4);
  });

  it("turbulence and icing cards carry the '+' edge buttons (multi-area, like CB)", () => {
    for (const type of ["turbulence", "icing"]) {
      const id = stroke(sigwx, adapter, type, POLY);
      const b = adapter.widget(id)!.buttons?.[0];
      expect(b?.event).toBe("draw-more");
      expect(b?.title).toBe("Draw a linked area");
    }
  });

  it("declutter: a tiny UNSELECTED zone hides its call-out; selecting (or a big zone) shows it", () => {
    // span = 10 (mock) → threshold 15% = 1.5°; this zone's diag ≈ 0.14° → insignificant
    sigwx.load({ type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "tiny", phenomenon: "cb", metadata: { coverage: "OCNL", baseFL: 250, topFL: 400 } },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]]] } }] });
    const boxes = () => (adapter.overlays.get("text-boxes")?.features ?? []).filter((b) => b.properties?.["featureId"] === "tiny");
    const leaders = () => (adapter.overlays.get("leaders")?.features ?? []).filter((l) => l.properties?.["featureId"] === "tiny");
    expect(boxes()).toHaveLength(0); // call-out hidden…
    expect(leaders()).toHaveLength(0); // …leader + arrow too
    expect((adapter.overlays.get("edge")?.features ?? []).filter((e) => e.properties?.["featureId"] === "tiny").length).toBeGreaterThan(0); // the zone still draws
    sigwx.select("tiny"); // selection overrides the declutter (the card replaces the box)
    expect(adapter.widget("tiny")).toBeDefined();
    expect(leaders().length).toBeGreaterThan(0); // its leader points at the card
    sigwx.select(null);
    expect(boxes()).toHaveLength(0); // hidden again once unselected
    // a BIG zone keeps its call-out (the existing CB tests cover it: POLY diag 5.7 ≫ 0.5)
  });

  it("declutter applies to a JET: zoomed way out, an unselected jet keeps its axis but drops barbs + FL labels", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET); // diag ≈ 6.1° — significant on span 10
    const of = (layer: string) => (adapter.overlays.get(layer)?.features ?? []).filter((x) => x.properties?.["featureId"] === id);
    const before = { dec: of("decoration").length, tb: of("text-boxes").length }; // selected ⇒ chrome shows
    expect(before.dec).toBeGreaterThan(0); // the gate test is not vacuous (barbs/arrowhead exist)
    adapter.getViewSpan = () => 60; // zoom OUT: ratio 6.1/60 ≈ 0.10 < 0.15 (but > half = 0.075)
    sigwx.select(null); // deselect (re-renders) → the chrome declutters
    expect(of("edge").length).toBeGreaterThan(0); // the axis still marks the jet
    expect(of("decoration")).toHaveLength(1); // barbs gone… but the ARROWHEAD survives (direction)
    expect(of("decoration")[0]!.properties?.["declutter"]).toBe("late");
    expect(of("text-boxes")).toHaveLength(0); // FL label gone
    adapter.getViewSpan = () => 150; // further out: ratio ≈ 0.04 < 0.075 → the arrowhead goes too
    sigwx.select(id); // (re-render) selection overrides the declutter, whatever the zoom
    expect(of("decoration")).toHaveLength(before.dec);
    sigwx.select(null);
    expect(of("decoration")).toHaveLength(0); // fully decluttered way out
    expect(of("edge").length).toBeGreaterThan(0);
  });

  it("a tiny accidental '+' stroke does NOT append a ghost micro-area (the double-arrow bug)", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    adapter.actionWidget(id, "draw-more"); // enter append mode…
    adapter.ev("down", 6, 6);
    adapter.ev("move", 6.05, 6.05); // …but the gesture is ~3 px of jitter, not a shape
    adapter.ev("up", 6.05, 6.05);
    expect(sigwx.save().features[0]!.geometry.type).toBe("Polygon"); // no ghost second area
    expect(sigwx.save().features).toHaveLength(1);
    // and the aborted append must not capture the NEXT (normal) draw
    stroke(sigwx, adapter, "cb", [[10, 10], [12, 10], [12, 12], [10, 12]]);
    expect(sigwx.save().features).toHaveLength(2); // a NEW feature, not an appended area
  });

  it("pressing an area already IN the multi-set keeps the set — the drag moves ALL of it", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    appendArea(id);
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("up", 2, 2);
    adapter.ev("down", 7, 7, { overlay: "area-fill", props: { featureId: id } }, { shiftKey: true });
    adapter.ev("up", 7, 7); // both areas selected
    const g0 = sigwx.save().features[0]!.geometry as MultiPolygon;
    const a0 = g0.coordinates[0]![0]![0]![0]!;
    const a1 = g0.coordinates[1]![0]![0]![0]!;
    adapter.ev("down", 7, 7, { overlay: "area-fill", props: { featureId: id } }); // plain PRESS on one of them
    adapter.ev("move", 8, 7);
    adapter.ev("up", 8, 7);
    const g1 = sigwx.save().features[0]!.geometry as MultiPolygon;
    expect(g1.coordinates[0]![0]![0]![0]!).toBeCloseTo(a0 + 1, 5); // the set was kept…
    expect(g1.coordinates[1]![0]![0]![0]!).toBeCloseTo(a1 + 1, 5); // …and BOTH areas moved
  });

  it("dragging a SINGLE-area CB leaves its info box put (symmetry with box drags)", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // simple Polygon
    const before = adapter.widget(id)!.anchor;
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("move", 3, 2); // drag the (only) area 1° east
    adapter.ev("up", 3, 2);
    const after = adapter.widget(id)!.anchor;
    expect(after.lon).toBeCloseTo(before.lon, 5);
    expect(after.lat).toBeCloseTo(before.lat, 5);
  });

  it("dragging ONE area never drags the info box — even the box-anchor (largest) area", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // area 0 = largest = the box's placement anchor
    appendArea(id);
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } }); // narrow to area 0
    adapter.ev("up", 2, 2);
    const before = adapter.widget(id)!.anchor; // the card rides the placed call-out
    adapter.ev("down", 2, 2, { overlay: "area-fill", props: { featureId: id } });
    adapter.ev("move", 3, 2); // drag the anchor area 1° east
    adapter.ev("up", 3, 2);
    const after = adapter.widget(id)!.anchor;
    expect(after.lon).toBeCloseTo(before.lon, 5); // the box stayed put
    expect(after.lat).toBeCloseTo(before.lat, 5);
  });

  it("a chart PROFILE unfolds onto the options: palette, phenomena config, save() tag — explicit options win", async () => {
    // A consumer loads the profile AS JSON (package file or CDN), exactly like the lib does.
    const WAFS_SWH = (await import("../src/profiles/wafs.json")).default as unknown as SigwxProfile;
    const a = new MockAdapter();
    const s = new SigwxDraw({
      adapter: a,
      toolbar: true, // no explicit tools → the profile's palette drives the toolbar
      profile: { ...WAFS_SWH, phenomena: { cb: { flightLevel: { default: [260, 410] } } } },
    });
    await s.ready();
    const ids = a.toolbarItems.map((i) => i.id);
    expect(ids).toContain("jetStream");
    expect(ids).toContain("markers"); // the marker submenu builds from the profile palette too
    stroke(s, a, "cb", POLY);
    expect(lastMeta(s)["baseFL"]).toBe(260); // the profile's phenomena config applied…
    const fc = s.save() as { profile?: string };
    expect(fc.profile).toBe("wafs"); // …and the document carries its chart type

    // NO profile given ⇒ the fallback IS a profile (WAFS SWH), not scattered values
    expect((sigwx.save() as { profile?: string }).profile).toBe("wafs");

    // explicit options WIN over the profile (per phenomenon)
    const a2 = new MockAdapter();
    const s2 = new SigwxDraw({
      adapter: a2,
      profile: { ...WAFS_SWH, phenomena: { cb: { flightLevel: { default: [260, 410] } } } },
      phenomena: { cb: { flightLevel: { default: [300, 450] } } },
    });
    await s2.ready();
    stroke(s2, a2, "cb", POLY);
    expect(lastMeta(s2)["baseFL"]).toBe(300);
  });

  it("the toolbar groups the markers into ONE toggle submenu (children); others stay flat", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, toolbar: { tools: ["jetStream", "volcano", "tropicalCyclone", "radioactive"] } });
    await s.ready();
    const ids = a.toolbarItems.map((i) => i.id);
    expect(ids).toContain("jetStream");    // a flat tool
    expect(ids).toContain("markers");      // the grouped submenu
    expect(ids).not.toContain("volcano");  // a marker is a CHILD, not a top-level button
    const sub = a.toolbarItems.find((i) => i.id === "markers")!;
    expect(sub.toggle).toBe(true);         // split-button (mirrors the picked child)
    expect(sub.children?.map((c) => c.id)).toEqual(["volcano", "tropicalCyclone", "radioactive"]);
  });
});

describe("profile v2 — the single ingestion unit (objects / glyphs / grouped tools)", () => {
  /** A self-contained LL-ish profile: a patched stock CB, a fully INLINE marker
   *  descriptor whose glyph ships in the profile's own `glyphs` section, and a
   *  declarative grouped toolbar. Pure JSON end to end. */
  const FOG_SVG = '<svg viewBox="0 0 24 24"><g stroke="currentColor" fill="none"><path d="M3 9 H21 M3 13 H17 M3 17 H21"/></g></svg>';
  const profile = {
    id: "test-ll",
    vertical: { min: 0, max: 150, unit: "fl" as const },
    glyphs: { fog: FOG_SVG },
    objects: [
      { extends: "cb", style: { edge: { color: "#0a0a0a" } } },
      {
        schemaVersion: 1 as const,
        type: "fog",
        label: "Fog",
        gesture: { primitive: "point" as const, draw: "drop" as const },
        fields: [{ key: "name", kind: "text" as const, default: "" }],
        card: {
          framed: "when-named" as const,
          deletable: true,
          items: [{ glyph: "atlas:fog", size: 26 }, { input: { field: "name" } }, { coord: true }],
        },
        style: { color: "#445566" },
      },
    ],
    tools: ["fog", { group: "Convective", items: ["cb"] }],
  };

  it("ingests the whole profile: inline atlas + compiled objects + declarative groups", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile, toolbar: true });
    await s.ready();
    // The toolbar follows the profile's declarative palette (no auto-grouping).
    const ids = a.toolbarItems.map((i) => i.id);
    expect(ids).toContain("fog");
    const grp = a.toolbarItems.find((i) => i.id === "convective")!;
    expect(grp.title).toBe("Convective");
    expect(grp.toggle).toBe(true);
    expect(grp.children?.map((c) => c.id)).toEqual(["cb"]);
    // The INLINE descriptor works as a marker: drop → an editable card wearing the
    // profile-shipped glyph.
    const id = s.draw("fog");
    const w = a.widget(id)!;
    expect(w).toBeDefined();
    const glyph = w.child.items[0] as { kind: string; svg?: string };
    expect(glyph.kind).toBe("glyph");
    expect(glyph.svg).toContain("M3 9 H21");
    // The PATCHED stock CB wears the new edge ink (deep-merge, patch wins).
    s.select(null);
    const cbId = stroke(s, a, "cb", POLY);
    const edge = (a.overlays.get("edge")?.features ?? []).find((e) => e.properties?.["featureId"] === cbId);
    expect(edge?.properties?.["stroke"]).toBe("#0a0a0a");
    // `save()` tags the profile id.
    expect((s.save() as { profile?: string }).profile).toBe("test-ll");
  });

  it("the chart `vertical` is the FL-bounds fallback (no per-phenomenon flightLevel needed)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const id = stroke(s, a, "cb", POLY);
    // CB's flBeyond is ["xxx","xxx"]: one off-chart notch (±5) past each vertical bound.
    // (Base first: the stock CB keeps its HL métier defaults — base 250 — and the
    // base ≤ top pairing would pin a dragged top onto it. A REAL LL profile patches
    // the defaults via `extends`; this test only checks the vertical clamp chain.)
    a.dragGauge(id, "baseFL", -99999); // way below the LL floor → the XXX notch under it
    expect(lastMeta(s)["baseFL"]).toBe(-5);
    a.dragGauge(id, "topFL", 99999); // way past the ceiling → the XXX notch above it
    expect(lastMeta(s)["topFL"]).toBe(155);
  });
});

describe("setProfile — live re-ingestion, document preserved", () => {
  const load = async (over?: Partial<SigwxProfile>): Promise<SigwxProfile> => {
    const base = (await import("../src/profiles/wafs.json")).default as unknown as SigwxProfile;
    return { ...structuredClone(base), ...over };
  };

  it("re-injecting a profile with a patched colour re-decorates the SAME features", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a });
    await s.ready();
    const id = stroke(s, a, "cb", POLY);
    const edge0 = (a.overlays.get("edge")?.features ?? []).find((e) => e.properties?.["featureId"] === id);
    expect(edge0?.properties?.["stroke"]).toBe("#d1242f"); // default red scallop

    const profile = await load();
    const cb = profile.objects!.find((o) => typeof o === "object" && (o as { type?: string }).type === "cb") as Record<string, unknown>;
    (cb["style"] as Record<string, unknown>)["color"] = "#0a7d22";
    ((cb["style"] as Record<string, unknown>)["edge"] as Record<string, unknown>)["color"] = "#0a7d22";
    s.setProfile(profile);

    expect(s.save().features).toHaveLength(1); // the drawn CB is KEPT
    expect(s.save().features[0]!.properties!["id"]).toBe(id); // same feature id
    const edge1 = (a.overlays.get("edge")?.features ?? []).find((e) => e.properties?.["featureId"] === id);
    expect(edge1?.properties?.["stroke"]).toBe("#0a7d22"); // re-decorated with the new ink
  });

  it("re-injecting a profile that REMOVES a type drops its features (with a warning)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a });
    await s.ready();
    stroke(s, a, "cb", POLY);
    expect(s.save().features).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const profile = await load();
    profile.objects = profile.objects!.filter((o) => !(typeof o === "object" && (o as { type?: string }).type === "cb"));
    s.setProfile(profile);
    expect(s.save().features).toHaveLength(0); // the orphan CB is dropped
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("sigwxArea — panel replaces the call-out (no double)", () => {
  it("selected sigwxArea: NO call-out text-box remains for the feature", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const id = stroke(s, a, "sigwxArea", POLY); // draws + auto-selects
    const widgetIds = a.widgets.map((w) => w.id);
    const boxFids = (a.overlays.get("text-boxes")?.features ?? []).map((f) => f.properties?.["featureId"]);
    expect(widgetIds).toContain(id);     // the panel exists
    expect(boxFids).not.toContain(id);   // call-out replaced → no double (single CB on screen)
  });

  // Regression: the amount/type pickers carry an explicit `label: "{value}"`, so the
  // interpreter renders the CODE as TEXT. WITHOUT it, a label-less picker falls back to
  // implicit glyph resolution and `sprite("OCNL")`/`sprite("FRQ")` hit the stock CB-coverage
  // glyphs ("OCNL\nCB", "FRQ\nCB") seeded by DEFAULT_SPRITES — re-introducing the doubled
  // "OCNL CB" on screen. Assert the pickers stay pure text (the amount shown WITHOUT the type).
  it("amount picker renders text codes, never the stacked CB glyph", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const id = stroke(s, a, "sigwxArea", POLY); // draws + auto-selects
    const panel = a.widget(id)!;
    const pickers = panel.child.items.filter(
      (i): i is { kind: string; name?: string; value?: string; color?: string; options?: { value: string; label?: string; svg?: string; title?: string }[] } =>
        "control" in i && (i as { control?: string }).control === "picker",
    );
    const amount = pickers.find((p) => p.name === "amount")!;
    expect(amount.value).toBe("OCNL");                          // amount alone, no type appended
    expect(amount.options?.every((o) => o.svg === undefined && typeof o.label === "string")).toBe(true);
    // and nothing rendered for this field carries the leaked stacked-CB glyph
    expect(JSON.stringify(amount)).not.toContain("\\nCB");
    // the picker text is tinted with the control HANDLE colour (like the gauge/dial knobs)
    expect(amount.color).toBe(DEFAULT_STYLE.control.handle.fill);
    // the terse cloud codes carry their full name as a tooltip (CB → "Cumulonimbus", CI → "Cirrus")
    const type = pickers.find((p) => p.name === "type")!;
    expect(type.options?.find((o) => o.value === "CB")).toMatchObject({ label: "CB", title: "Cumulonimbus" });
    expect(type.options?.find((o) => o.value === "CI")).toMatchObject({ label: "CI", title: "Cirrus" });
  });

  it("picker text colour follows style.control.handle (customisable like the gauge/dial)", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile, style: { control: { handle: { fill: "#0969da" } } } });
    await s.ready();
    const id = stroke(s, a, "sigwxArea", POLY);
    const amount = (a.widget(id)!.child.items as { control?: string; name?: string; color?: string }[])
      .find((i) => i.control === "picker" && i.name === "amount")!;
    expect(amount.color).toBe("#0969da");
  });
});
