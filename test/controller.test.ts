import type { FeatureCollection, MultiPolygon, Position } from "geojson";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LatLng } from "../src/core/index.js";
import type { KeyEvent, MapAdapter, MarkerWidget, PointerEvent, SigwxProfile, SymbolSprites, ToolbarItem, WidgetEdit } from "../src/map/index.js";
import { DEFAULT_STYLE, SigwxDraw } from "../src/map/index.js";
import { nudgeClear } from "../src/map/placement.js";

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

/** Click-to-place a point marker: the button ARMS draw mode, then a map click drops it (default at
 *  the view centre, lat 46 ⇒ NH) and selects it. Returns the new feature's id. */
function dropMarker(sigwx: SigwxDraw, a: MockAdapter, type: string, lon = 2, lat = 46): string {
  sigwx.draw(type);
  a.ev("down", lon, lat);
  a.ev("up", lon, lat);
  a.ev("click", lon, lat); // the browser's trailing click after a click-placement (swallowed by didDrag)
  return lastId(sigwx);
}

/** Walk a widget tree and collect every picker control node (a layer-stack panel nests its
 *  pickers inside `stack.items[].body`, so a flat `child.items` scan no longer finds them). */
type PickerNode = { kind?: string; control?: string; name?: string; value?: string; color?: string; mode?: string; options?: { value: string; label?: string; svg?: string; title?: string }[] };
function collectPickers(node: unknown): PickerNode[] {
  if (!node || typeof node !== "object") return [];
  let out: PickerNode[] = [];
  if ((node as PickerNode).control === "picker") out.push(node as PickerNode);
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const x of v) out = out.concat(collectPickers(x));
    else if (v && typeof v === "object") out = out.concat(collectPickers(v));
  }
  return out;
}

/** Walk a widget tree and collect every gauge node (FL gauges live in a satellite card now). */
type Cursor = { name: string; value: number; label: string };
type Range = { id?: string; base: Cursor; top: Cursor; color: string };
type GaugeNode = { kind?: string; cursors?: Cursor[]; ranges?: Range[]; active?: number | string };
function collectGauges(node: unknown): GaugeNode[] {
  if (!node || typeof node !== "object") return [];
  let out: GaugeNode[] = [];
  if ((node as GaugeNode).kind === "gauge") out.push(node as GaugeNode);
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const x of v) out = out.concat(collectGauges(x));
    else if (v && typeof v === "object") out = out.concat(collectGauges(v));
  }
  return out;
}

/** Text lines of a (now-static-sprite) call-out cartouche — its content moved from the canvas
 *  text-box into the sprite's `child` WidgetBox text leaves. */
function spriteLines(w: MarkerWidget | undefined): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if ((n as { kind?: string }).kind === "text" && typeof (n as { value?: unknown }).value === "string") out.push((n as { value: string }).value);
    for (const v of Object.values(n as Record<string, unknown>)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
  };
  if (w?.child) walk(w.child);
  return out;
}

const JET: [number, number][] = [[0, 0], [2, 1], [4, 0], [6, 1]];
const POLY: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 4]];

describe("nudgeClear — a dropped cartouche yields to a fixed obstacle", () => {
  const overlap = (p: [number, number], w: number, h: number, o: { x: number; y: number; w: number; h: number }): number => {
    const dx = Math.min(p[0] + w / 2, o.x + o.w) - Math.max(p[0] - w / 2, o.x);
    const dy = Math.min(p[1] + h / 2, o.y + o.h) - Math.max(p[1] - h / 2, o.y);
    return dx > 0 && dy > 0 ? dx * dy : 0;
  };
  it("bumps a box OUT of an overlapping obstacle, and is a no-op when already clear", () => {
    const obstacle = { x: 0, y: 0, w: 60, h: 60 };
    const clear = nudgeClear([10, 10], 40, 40, [obstacle]); // dropped box overlaps the obstacle
    expect(overlap(clear, 40, 40, obstacle)).toBe(0);       // …and is nudged fully clear
    expect(clear).not.toEqual([10, 10]);                    // it actually moved
    expect(nudgeClear([300, 300], 40, 40, [obstacle])).toEqual([300, 300]); // far away ⇒ untouched
  });
});

describe("self-anchored labels are fixed obstacles (tropopause / isotherm), like point markers", () => {
  const cbAt = (cx: number, cy: number, r = 2.2) => ({
    type: "Feature" as const,
    properties: { id: "cb1", phenomenon: "cb", metadata: { coverage: "OCNL", baseFL: 250, topFL: 400 } },
    geometry: { type: "Polygon" as const, coordinates: [[[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r]]] },
  });
  it("an auto-placed cartouche routes around a tropopause label dropped on its spot", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a });
    await s.ready();
    const placedAt = (s as unknown as { placedAt: Map<string, [number, number]> }).placedAt;
    // 1) CB alone — note where its auto call-out lands.
    s.load({ type: "FeatureCollection", features: [cbAt(2, 46)] });
    const p1 = placedAt.get("cb1");
    expect(p1).toBeTruthy();
    // 2) Drop a tropopause SPOT exactly on that spot ⇒ it's now a fixed no-go zone.
    s.load({
      type: "FeatureCollection",
      features: [
        cbAt(2, 46),
        { type: "Feature", properties: { id: "tropo1", phenomenon: "tropopause", metadata: { fl: 380, kind: "fl" } }, geometry: { type: "Point", coordinates: p1! } },
      ],
    });
    const p2 = placedAt.get("cb1");
    expect(p2).not.toEqual(p1); // the cartouche moved to clear the tropopause label
  });
});

describe("isotherm — the temperature is an inline tap-to-cycle picker IN the label (no external control)", () => {
  it("a selected line isotherm carries the temp picker IN its card; the decorated box is suppressed; cycling edits temp", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    s.load({ type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "iso", phenomenon: "zeroIsotherm", metadata: { temp: "−20", fl: 100 } }, geometry: { type: "LineString", coordinates: [[0, 46], [5, 46]] } }] });
    s.select("iso");
    // The label became a CARD (widget) anchored on the line, carrying the temp as an INLINE picker —
    // not the old external satellite picker.
    const card = a.widget("iso");
    expect(card).toBeDefined();
    const temp = collectPickers(card).find((p) => p.name === "temp")!;
    expect(temp.control).toBe("picker");
    expect(temp.value).toBe("−20");
    expect(temp.options?.map((o) => o.value)).toEqual(["0", "−10", "−20"]);
    // The decorated label box is suppressed under the card — no text-box for the feature.
    const tb = (a.overlays.get("text-boxes")?.features ?? []).filter((f) => (f.properties as Record<string, unknown>)?.["featureId"] === "iso");
    expect(tb).toHaveLength(0);
    // Tapping the picker (cycle) edits the temperature.
    a.editWidget("iso", "0", "temp");
    expect(lastMeta(s)["temp"]).toBe("0");
  });
});

describe("WMO symbol markers place as a BARE icon (no frame / name / coord), edited by their picker", () => {
  it("the button ARMS a draw mode; a click drops the bare icon AT the click, selected with ONLY its picker", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    s.draw("wmo-precipitation"); // arms the tool — nothing placed yet (NOT dropped at the centre)
    expect(s.save().features).toHaveLength(0);
    a.ev("down", 3, 47);
    a.ev("up", 3, 47); // click where you want it ⇒ placed THERE, selected (edit mode)
    const id = lastId(s);
    const feat = s.save().features.find((f) => (f.properties as Record<string, unknown>)?.["id"] === id)!;
    expect(feat.geometry.type).toBe("Point");
    expect((feat.geometry as { coordinates: number[] }).coordinates).toEqual([3, 47]); // at the click, NOT the view centre
    const w = a.widget(id)!;
    expect(w).toBeDefined();
    expect(w.bg).toBeUndefined(); // no frame
    expect(w.border).toBeUndefined();
    expect(w.deletable).toBeFalsy(); // no ✕ — the Delete key removes it (no name input to swallow it)
    // the card carries ONLY the symbol picker — no name <input>, no coord readout
    const kinds = w.child.items.map((it) => ("control" in it ? (it as { control?: string }).control : (it as { kind?: string }).kind));
    expect(kinds).toEqual(["picker"]);
    expect(collectPickers(w)[0]?.name).toBe("symbol");
    // `open` ⇒ the picker requests auto-open (`autofocus`): the adapter opens its menu on each select.
    const picker = w.child.items[0] as { autofocus?: boolean; color?: string; menuColor?: string };
    expect(picker.autofocus).toBe(true);
    // The trigger glyph keeps the NATURAL ink (no `color` — a true preview); only the MENU (petals)
    // takes the control accent, via `menuColor`.
    expect(picker.color).toBeUndefined();
    expect(picker.menuColor).toBe(DEFAULT_STYLE.control.handle.fill);
  });

  it("picking a symbol DESELECTS the marker (quick-pick: pick & done)", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const selId = () => (s as unknown as { selectedId: string | null }).selectedId;
    s.draw("wmo-precipitation");
    a.ev("down", 3, 47); a.ev("up", 3, 47); a.ev("click", 3, 47); // placed + selected
    const id = lastId(s);
    expect(selId()).toBe(id);
    a.editWidget(id, "snow", "symbol"); // pick a symbol in the (flower) picker
    expect(lastMeta(s)["symbol"]).toBe("snow"); // applied…
    expect(selId()).toBeNull(); // …and deselected
  });

  it("DRAGGING a marker MOVES it without selecting; only a TAP selects (a drag never pops the picker)", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const selId = () => (s as unknown as { selectedId: string | null }).selectedId;
    s.load({ type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "m", phenomenon: "wmo-precipitation", metadata: { symbol: "rain" } }, geometry: { type: "Point", coordinates: [2, 46] } }] });
    s.select(null);
    // A marker's UNSELECTED hit surfaces as a text-boxes Point (interpret.ts) ⇒ onDown arms a translate.
    const hit = { overlay: "text-boxes", props: { featureId: "m" } } as PointerEvent["hit"];
    a.ev("down", 2, 46, hit);
    a.ev("move", 4, 44);
    a.ev("up", 4, 44);
    expect(selId()).toBeNull(); // dragged ⇒ NOT selected
    const coords = (s.save().features.find((f) => (f.properties as Record<string, unknown>)?.["id"] === "m")!.geometry as { coordinates: number[] }).coordinates;
    expect(coords).not.toEqual([2, 46]); // …but it MOVED
    a.ev("down", 4, 44, hit); a.ev("up", 4, 44); a.ev("click", 4, 44, hit); // a plain TAP selects
    expect(selId()).toBe("m");
  });
});

describe("handle hygiene — a layer-stack area shows NO on-path slider", () => {
  const sliders = (a: MockAdapter): unknown[] =>
    (a.overlays.get("handles")?.features ?? []).filter((h) => {
      const cls = (h.properties as Record<string, unknown>)["hClass"];
      return cls === "slider" || cls === "end"; // the jet break-point sliders
    });
  it("a `repeat` area (cloudConvective) draws only vertices + the arrow anchor — no `t`-parameterized slider", async () => {
    const france = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: france });
    await s.ready();
    stroke(s, a, "cloudConvective", POLY); // drawn ⇒ selected; its list items are FL layers, NOT path points
    // Bug regression: the layer-stack list used to spawn a stray slider handle at the path start
    // (item `t` defaults to 0 ⇒ vertex 0). The stack edits on the card/gauge, so: no slider.
    expect(sliders(a)).toHaveLength(0);
  });
  it("a non-`repeat` list (jet) KEEPS its break-point sliders on the curve", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a });
    await s.ready();
    stroke(s, a, "jetStream", JET);
    expect(sliders(a).length).toBeGreaterThan(0);
  });
});

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

  it("coincident jet FL cursors stay clean & ordered LIB-side (label overlap is the adapter's job)", () => {
    const id = stroke(sigwx, adapter, "jetStream", JET);
    sigwx.selectSubItem(1);
    const cursors = (): { name: string; value: number; label: string }[] =>
      (adapter.widget(`${id}#gauge`)!.child.items[0] as { cursors: { name: string; value: number; label: string }[] }).cursors;
    adapter.dragGauge(id, "points.1.speed", 220); // ⇒ 3 cursors (base / fl / top)
    adapter.dragGauge(id, "points.1.top", 9999); // top → ceiling
    adapter.dragGauge(id, "points.1.fl", 9999); // core dragged up to MEET top ⇒ they coincide
    const pts = (lastMeta(sigwx)["points"] as Record<string, unknown>[])[1]!;
    // The lib clamps to the chart ceiling and keeps base ≤ fl ≤ top — never a runaway "60000".
    expect(pts["fl"]).toBe(600);
    expect(pts["top"]).toBe(600);
    // Each cursor keeps a clean ≤3-digit (or `FL###`) label even when two share a value — so a
    // garbled on-screen number is purely the adapter overlapping two labels at the same Y.
    for (const c of cursors()) expect(c.label.replace(/^FL/, "")).toMatch(/^\d{3}$/);
    expect(cursors().filter((c) => c.value === 600)).toHaveLength(2); // fl + top coincide, both valid
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
    expect(adapter.widget(id)?.static).toBe(true); // unselected ⇒ the call-out is a static sprite
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
    const gauge = () => (adapter.widget(`${id}#gauge`)!.child.items[0] as { kind: string; beyond?: { below?: boolean }; ranges: { base: { name: string; label?: string }; top: { label?: string }; color: string }[] });
    expect(gauge().kind).toBe("gauge"); // a SATELLITE card beside the call-out carries the gauge
    expect(gauge().ranges[0]!.base.name).toBe("baseFL"); // a draggable 1-band (ranges), feature-scoped
    expect(gauge().ranges[0]!.color).toBe("#5f6368"); // band inked in the turbulence colour (visible, grab-able)
    expect(gauge().beyond?.below).toBe(true); // areas default to the off-chart XXX notch
    adapter.dragGauge(id, "baseFL", -99999); // way past the floor → clamps to the notch
    expect(baseFL()).toBe(245); // norm floor 250 − 5 = the off-chart notch…
    expect(gauge().ranges[0]!.base.label).toBe("XXX"); // …labelled XXX on the re-rendered band
    sigwx.setPhenomenonFlightLevel("turbulence", { min: 100 }); // lower the floor live
    adapter.dragGauge(id, "baseFL", -99999);
    expect(baseFL()).toBe(95); // notch follows the new floor (100 − 5)
  });

  it("a base/top area FL gauge (CB) is a draggable 1-band (ranges) inked in the phenomenon colour, band FILLED", () => {
    const id = stroke(sigwx, adapter, "cb", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    const gauge = adapter.widget(`${id}#gauge`)!.child.items[0] as { kind: string; cursors?: unknown; ranges: { base: { name: string }; top: { name: string }; color: string; fill?: string }[] };
    expect(gauge.kind).toBe("gauge");
    expect(gauge.cursors).toBeUndefined(); // a draggable band, NOT two independent cursors
    expect(gauge.ranges).toHaveLength(1);
    expect([gauge.ranges[0]!.base.name, gauge.ranges[0]!.top.name]).toEqual(["baseFL", "topFL"]); // feature-scoped
    expect(gauge.ranges[0]!.color).toBe("#d1242f"); // CB identity colour (style.color)
    expect(gauge.ranges[0]!.fill).toBeUndefined(); // CB/icing keep a FILLED band (no transparent override)
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

  it("turbulence call-out sprite is UNBOXED — NO bg, NO border (bare text + glyph, like its canvas call-out)", () => {
    const id = stroke(sigwx, adapter, "turbulence", [[0, 0], [4, 0], [4, 4], [0, 4]]);
    expect(adapter.widget(id)?.static).toBeUndefined(); // SELECTED ⇒ the editable card, not a sprite
    sigwx.select(null);
    const w = adapter.widget(id);
    expect(w?.static).toBe(true);      // unselected ⇒ a static sprite cartouche (no canvas text-box)
    expect(w?.bg).toBeUndefined();     // UNBOXED ⇒ no background
    expect(w?.border).toBeUndefined(); // …and no border (bare)
  });

  it("CB call-out sprite stays BOXED — opaque bg + frame border", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    expect(adapter.widget(id)?.static).toBeUndefined(); // SELECTED ⇒ the editable card, not a sprite
    sigwx.select(null);
    const w = adapter.widget(id);
    expect(w?.static).toBe(true);
    expect(w?.bg).toBeDefined();
    expect(w?.border).toBeDefined();  // BOXED ⇒ framed
  });
});

describe("marker phenomena (TC / volcano / radioactive — inline-editable widgets)", () => {
  let adapter: MockAdapter;
  let sigwx: SigwxDraw;

  // The recolourable severity sprites now ship in the PROFILE (the build inlines its `svgs/`
  // refs into the dist profile); a unit test runs on the SOURCE profiles (refs, not inlined),
  // so it injects the resolved glyphs through the host `symbolSprite` API — the supported path.
  const SYMBOL_SPRITES = {
    MOD: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M5 20 H13 L16 12 L19 20 H27" fill="none" stroke="currentColor"/></svg>',
    SEV: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M5 22 H13 L16 14 L19 22 H27" fill="none" stroke="currentColor"/></svg>',
    ICE_MOD: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M9 5 V16 Q9 19 11 19 H21 Q23 19 23 16 V5" fill="none" stroke="currentColor"/></svg>',
    ICE_SEV: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M9 5 V16 Q9 19 11 19 H21 Q23 19 23 16 V5" fill="none" stroke="currentColor"/></svg>',
  };

  beforeEach(async () => {
    adapter = new MockAdapter();
    sigwx = new SigwxDraw({ adapter, symbolSprite: SYMBOL_SPRITES });
    await sigwx.ready();
  });

  const item = (w: MarkerWidget, kind: string) => w.child.items.find((i) => "kind" in i && i.kind === kind) as { kind: string; editable?: boolean } | undefined;

  it("dropping a volcano emits a SELECTED, editable widget — and NO overlay features", () => {
    const id = dropMarker(sigwx, adapter, "volcano"); // drop mode → created + selected, returns the id
    const w = adapter.widget(id);
    expect(w).toBeDefined();
    expect(item(w!, "glyph")).toBeDefined();
    expect(item(w!, "text")?.editable).toBe(true);  // selected ⇒ inline input
    expect(adapter.count("symbols")).toBe(0);       // the widget IS the rendering
    expect(adapter.count("text-boxes")).toBe(0);
  });

  it("typing the name (onWidgetEdit) writes metadata.name and frames the card with a coord", () => {
    const id = dropMarker(sigwx, adapter, "volcano");
    adapter.editWidget(id, "Etna");
    expect(lastMeta(sigwx)["name"]).toBe("Etna");
    const w = adapter.widget(id)!;
    expect(w.border).toBeDefined();          // framed once named
    expect(item(w, "coord")).toBeDefined();  // + the auto lat/long line
  });

  it("clicking a widget card selects its feature (the `widget` hit carries the id)", () => {
    const id = dropMarker(sigwx, adapter, "volcano");
    sigwx.select(null);
    expect(item(adapter.widget(id)!, "text")).toBeUndefined(); // deselected + unnamed ⇒ no text
    adapter.clickWidget(id);
    expect(item(adapter.widget(id)!, "text")?.editable).toBe(true); // selected again ⇒ editable
  });

  it("an UNSELECTED, UNNAMED volcano is glyph-only (no frame, no coord)", () => {
    const id = dropMarker(sigwx, adapter, "volcano");
    sigwx.select(null);
    const w = adapter.widget(id)!;
    expect(w.border).toBeUndefined();
    expect(w.child.items).toHaveLength(1);
    expect((w.child.items[0] as { kind: string }).kind).toBe("glyph");
  });

  it("a tropical cyclone is BARE: name 'NN', NO frame, NO coord; NH glyph not mirrored at +lat", () => {
    const id = dropMarker(sigwx, adapter, "tropicalCyclone"); // dropped at centre (lat 46 → NH)
    expect(lastMeta(sigwx)["name"]).toBe("NN");
    const w = adapter.widget(id)!;
    expect(w.border).toBeUndefined();             // no frame
    expect(item(w, "coord")).toBeUndefined();     // no coord line
    expect(item(w, "text")?.editable).toBe(true); // the NN name IS shown (editable while selected)
    expect((item(w, "glyph") as unknown as { svg: string }).svg).not.toContain("scale(-1"); // NH
  });

  it("a SELECTED marker carries a delete button; onWidgetDelete removes the feature", () => {
    const id = dropMarker(sigwx, adapter, "volcano");
    expect(adapter.widget(id)!.deletable).toBe(true);   // selected ⇒ ✕ (the input swallows Delete)
    sigwx.select(null);
    expect(adapter.widget(id)!.deletable).toBe(false);  // unselected ⇒ no ✕
    sigwx.select(id);
    adapter.deleteWidget(id);                            // click the ✕ → onWidgetDelete
    expect(sigwx.save().features).toHaveLength(0);
  });

  it("a SELECTED CB shows the 'draw-more' badge at its arrow TIP (a draggable glyph, not a card edge button); both hidden once unselected; markers don't", () => {
    const id = stroke(sigwx, adapter, "cb", POLY); // drawn ⇒ selected
    const w = adapter.widget(id)!;
    // The `+` moved OFF the card to a floating badge at the leader tip (where the old
    // scallop-flip tap was). The eraser was already gone (Ctrl/⌘ + hover) → the card now
    // carries NO edge buttons at all.
    expect(w.buttons).toBeUndefined();
    // The badge is a sizable GLYPH (not a button — a button would swallow the tip's re-aim
    // drag it sits on); the controller drives it (tap = draw-more, drag = re-aim).
    const tip = adapter.widget(`${id}#draw`)!;
    expect(tip.buttons).toBeUndefined();
    expect(tip.bg).toBe("#ffffff"); // framed like the card's edge buttons (white disc + ink border)
    expect(tip.border).toBe("#1f2328");
    const g = tip.child.items[0] as { kind: string; svg: string; size?: number; color?: string };
    expect(g.kind).toBe("glyph");
    expect(g.color).toBe("#1f2328"); // black glyph (orange was invisible)
    expect(g.size).toBeGreaterThanOrEqual(14); // bigger than the former bordered `+` (~12px)
    sigwx.select(null);
    expect(adapter.widget(id)?.static).toBe(true); // unselected ⇒ the editable card is replaced by a static sprite
    expect(adapter.widget(`${id}#draw`)).toBeUndefined(); // …and the draw badge exists ONLY while selected
    const vid = dropMarker(sigwx, adapter, "volcano"); // markers no longer carry edge buttons
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
    // With the `+` moved to the arrow-tip and the eraser gone, the card has NO edge buttons,
    // so it requests NO padding — the unframed card is now truly bare (like the call-out).
    expect((w as { padding?: string }).padding).toBeUndefined();
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
    sigwx.select(null); // unselected ⇒ a static sprite cartouche carries the glyph (no canvas symbol)
    expect(adapter.widget(id)?.static).toBe(true);
    expect((adapter.overlays.get("symbols")?.features ?? []).filter((s) => s.properties?.["featureId"] === id)).toHaveLength(0);
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

  it("turbulence and icing show the 'draw-more' badge at the arrow TIP (a glyph, not the card edge), like CB", () => {
    for (const type of ["turbulence", "icing"]) {
      const id = stroke(sigwx, adapter, type, POLY);
      expect(adapter.widget(id)!.buttons).toBeUndefined(); // not a card-edge button any more
      const badge = adapter.widget(`${id}#draw`)!; // the floating arrow-tip badge
      expect(badge.buttons).toBeUndefined();
      const g = badge.child.items[0] as { kind: string; svg: string; size?: number };
      expect(g.kind).toBe("glyph");
      expect(g.svg).toBeTruthy();
    }
  });

  it("the arrow-tip 'draw' badge: a TAP enters append-draw; a DRAG re-aims the tip instead (never blocks it)", () => {
    const id = stroke(sigwx, adapter, "cb", POLY);
    const badgeHit = { overlay: "widget" as const, props: { id: `${id}#draw` } };
    // DRAG the badge (down → move → up): re-aims the arrow tip, does NOT enter draw mode.
    adapter.ev("down", 4, 4, badgeHit);
    adapter.ev("move", 5, 5);
    adapter.ev("up", 5, 5);
    expect(sigwx.save().features).toHaveLength(1); // still ONE feature, no new draw armed
    // TAP the badge (down → up → click, no move): enters append-draw on THIS feature. onUp
    // harmlessly clears the armed anchor drag (no move ⇒ no re-aim); onClick fires draw-more.
    adapter.ev("down", 4, 4, badgeHit);
    adapter.ev("up", 4, 4, badgeHit);
    adapter.ev("click", 4, 4, badgeHit);
    adapter.ev("down", 6, 6); // draw the extra area
    adapter.ev("move", 8, 6);
    adapter.ev("move", 8, 8);
    adapter.ev("up", 6, 8);
    const f = sigwx.save().features.find((x) => x.properties!["id"] === id)!;
    expect(f.geometry.type).toBe("MultiPolygon"); // the tap appended an area to the SAME CB
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
  /** A self-contained LL-ish profile: a stock CB referenced by NAME, a fully INLINE
   *  marker descriptor whose glyph ships in the profile's own `glyphs` section, and a
   *  declarative grouped toolbar. Pure JSON end to end. */
  const FOG_SVG = '<svg viewBox="0 0 24 24"><g stroke="currentColor" fill="none"><path d="M3 9 H21 M3 13 H17 M3 17 H21"/></g></svg>';
  const profile = {
    id: "test-ll",
    vertical: { min: 0, max: 150, unit: "fl" as const },
    glyphs: { fog: FOG_SVG },
    objects: [
      "cb",
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
    // The stock CB (referenced by NAME) wears its shipped edge ink, as-is.
    s.select(null);
    const cbId = stroke(s, a, "cb", POLY);
    const edge = (a.overlays.get("edge")?.features ?? []).find((e) => e.properties?.["featureId"] === cbId);
    expect(edge?.properties?.["stroke"]).toBe("#d1242f");
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
    // base ≤ top pairing would pin a dragged top onto it. A REAL LL profile ships its
    // own inline CB with LL defaults; this test only checks the vertical clamp chain.)
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

describe("cloudConvective — panel replaces the call-out (no double)", () => {
  it("selected cloudConvective: NO call-out text-box remains for the feature", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // draws + auto-selects
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
    const id = stroke(s, a, "cloudConvective", POLY); // draws + auto-selects
    const panel = a.widget(id)!;
    // The pickers now live in the stack's active-layer BODY, with list-scoped names.
    const pickers = collectPickers(panel);
    const amount = pickers.find((p) => p.name === "layers.0.amount")!;
    expect(amount.value).toBe("OCNL");                          // amount alone, no type appended
    expect(amount.options?.every((o) => o.svg === undefined && typeof o.label === "string")).toBe(true);
    // and nothing rendered for this field carries the leaked stacked-CB glyph
    expect(JSON.stringify(amount)).not.toContain("\\nCB");
    // the picker text is tinted with the control HANDLE colour (like the gauge/dial knobs)
    expect(amount.color).toBe(DEFAULT_STYLE.control.handle.fill);
    // the terse cloud codes carry their full name as a tooltip (CB → "Cumulonimbus", CU → "Cumulus")
    const type = pickers.find((p) => p.name === "layers.0.type")!;
    expect(type.options?.find((o) => o.value === "CB")).toMatchObject({ label: "CB", title: "Cumulonimbus" });
    expect(type.options?.find((o) => o.value === "CU")).toMatchObject({ label: "CU", title: "Cumulus" });
  });

  it("picker text colour follows style.control.handle (customisable like the gauge/dial)", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile, style: { control: { handle: { fill: "#0969da" } } } });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    const amount = collectPickers(a.widget(id)!).find((i) => i.name === "layers.0.amount")!;
    expect(amount.color).toBe("#0969da");
  });
});

describe("cloudConvective — multi-layer data & cartouche", () => {
  const loadFrance = async () => (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
  const layersOf = (s: SigwxDraw): Record<string, unknown>[] => lastMeta(s)["layers"] as Record<string, unknown>[];

  it("removeLayer keeps at least min:1", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.actionWidget(id, "removeLayer:0"); // only layer -> floored at min:1
    expect(layersOf(s)).toHaveLength(1);
    a.actionWidget(id, "addLayer");
    expect(layersOf(s)).toHaveLength(2);
    a.actionWidget(id, "removeLayer:1");
    expect(layersOf(s)).toHaveLength(1);
  });

  it("a list-scoped FL edit clamps to 5-FL steps and keeps base <= top", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.dragGauge(id, "layers.0.topFL", 73); // -> 75 (5-FL step)
    expect(layersOf(s)[0]!["topFL"]).toBe(75);
    a.dragGauge(id, "layers.0.baseFL", 120); // base can't pass the top -> clamps to 75
    expect(layersOf(s)[0]!["baseFL"]).toBe(75);
  });

  it("changing a layer's type resets its amount via optionsBy (CB -> cloud amounts)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    expect(layersOf(s)[0]!["amount"]).toBe("OCNL"); // a CB amount
    a.editWidget(id, "CU", "layers.0.type"); // CB -> CU (the other convective type, non-CB amounts)
    expect(layersOf(s)[0]!["type"]).toBe("CU");
    expect(layersOf(s)[0]!["amount"]).toBe("FEW"); // OCNL invalid for non-CB -> first cloud amount
  });

  it("the rest cartouche stacks one line per layer (qty type top/base)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.actionWidget(id, "addLayer"); // 2 layers
    s.select(null); // deselect -> the static sprite cartouche renders (panel no longer replaces it)
    const lines = spriteLines(a.widget(id));
    expect(lines.filter((l) => l.includes("CB")).length).toBe(2); // one CB line per layer
  });

  it("a SINGLE layer's rest cartouche uses the NORMAL centered column (amount / type / top / base), not the compact stacked line", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // ONE layer by default (CB / OCNL)
    s.select(null); // deselect -> the static sprite cartouche renders
    const lines = spriteLines(a.widget(id));
    expect(lines).toHaveLength(4); // a column, not one packed line
    expect(lines[0]).toBe("OCNL"); // amount on its own line
    expect(lines[1]).toBe("CB"); // type on its own line
    expect(lines[2]).toMatch(/^(\d{3}|XXX)$/); // top — bare 3-digit level on the chart (no "FL")
    expect(lines[3]).toMatch(/^(\d{3}|XXX)$/); // base
    expect(lines.some((l) => /OCNL.*CB/.test(l))).toBe(false); // NOT the compact "OCNL CB .../..." line
  });

  it("EUROC restricts a non-CB (CU) layer's cloud amounts to BKN/OVC (optionsBy reset)", async () => {
    const a = new MockAdapter();
    const profile = (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const s = new SigwxDraw({ adapter: a, profile });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.editWidget(id, "CU", "layers.0.type"); // a non-CB convective layer
    const amount = collectPickers(a.widget(id)!).find((p) => p.name === "layers.0.amount")!;
    expect(amount.options?.map((o) => o.value)).toEqual(["BKN", "OVC"]);
    expect(layersOf(s)[0]!["amount"]).toBe("BKN"); // OCNL reset to the first valid amount
  });
});

describe("cloudNonConvective — non-convective cloud + composite icing/turb placeholders", () => {
  const loadFrance = async () => (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;

  it("offers ONLY non-convective cloud types (no CB/CU)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    const type = collectPickers(a.widget(id)!).find((p) => p.name === "layers.0.type")!;
    const values = type.options?.map((o) => o.value) ?? [];
    expect(values).toContain("AS");
    expect(values).not.toContain("CB");
    expect(values).not.toContain("CU");
  });

  it("both composite buttons are wired (icing → top, turbulence → bottom)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    const buttons = a.widget(id)!.buttons ?? [];
    expect(buttons.find((b) => b.place === "top")?.event).toBe("composite:icing");
    expect(buttons.find((b) => b.place === "bottom")?.event).toBe("composite:turb");
  });

  it("clicking turbulence creates a zone-level turb sub-object (MOD default) glued BELOW, with a ✕ on its top edge", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    a.actionWidget(id, "composite:turb");
    const turb = lastMeta(s)["turb"] as Record<string, unknown>;
    expect(turb).toBeDefined();
    expect(turb["symbol"]).toBe("MOD"); // moderate by default
    const card = a.widget(`${id}#turb`)!;
    expect(card.anchorTo).toEqual({ id, side: "bottom" }); // glued BELOW the zone, to its measured edge
    expect(card.bg).toBe("#ffffff");  // sidecar look: framed + opaque even though turbulence is bare
    expect(card.border).toBeDefined();
    expect(card.padding).toBe("large"); // same padding as the other (framed) cards
    expect(card.radius).toBe("small");  // same rounded corners as the other cards
    expect((card.buttons ?? []).some((b) => b.event === "removeComposite:turb" && b.place === "top")).toBe(true);
    expect(a.widget(`${id}#turb#gauge`)).toBeDefined(); // its own FL gauge (focused)
  });

  it("clicking icing creates a zone-level icing sub-object (MOD default) and focuses its glued card", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    expect(lastMeta(s)["icing"]).toBeUndefined();      // no composite until asked
    expect(a.widget(`${id}#gauge`)).toBeDefined();     // zone FL gauge present while zone editable
    expect(a.widget(`${id}#gauge`)!.anchorTo).toEqual({ id, side: "right", gap: 2 }); // glued to the panel's measured edge
    a.actionWidget(id, "composite:icing");
    const icing = lastMeta(s)["icing"] as Record<string, unknown>;
    expect(icing).toBeDefined();
    expect(icing["symbol"]).toBe("ICE_MOD");           // moderate by default
    // the glued composite card is editable (severity picker on the icing sub-object)
    const card = a.widget(`${id}#icing`);
    expect(card).toBeDefined();
    expect(collectPickers(card!).find((p) => p.name === "symbol")).toBeDefined();
    // the zone card is now selected-but-not-editable → its FL gauge is gone
    expect(a.widget(`${id}#gauge`)).toBeUndefined();
  });

  it("editing the focused icing writes severity + FL into metadata.icing (not the zone)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    a.actionWidget(id, "composite:icing");
    a.editWidget(`${id}#icing`, "ICE_SEV", "symbol");
    a.dragGauge(`${id}#icing`, "topFL", 123); // → 125 (5-FL step)
    const icing = lastMeta(s)["icing"] as Record<string, unknown>;
    expect(icing["symbol"]).toBe("ICE_SEV");
    expect(icing["topFL"]).toBe(125);
    expect(lastMeta(s)["symbol"]).toBeUndefined(); // the ZONE itself gained no severity field
  });

  it("once icing exists BOTH cards render (zone stays a clickable panel) — only one FL gauge at a time", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    a.actionWidget(id, "composite:icing"); // icing focused
    expect(a.widget(id)).toBeDefined();              // the zone card is still a panel (so it's clickable)
    expect(a.widget(`${id}#icing`)).toBeDefined();   // the icing card too
    expect(a.widget(`${id}#gauge`)).toBeUndefined();        // zone gauge hidden (icing focused)
    expect(a.widget(`${id}#icing#gauge`)).toBeDefined();    // only the icing gauge shows
    expect(a.widget(`${id}#icing#gauge`)!.anchorTo).toEqual({ id: `${id}#icing`, side: "right", gap: 2 }); // glued to the icing card, not the zone
    // the delete ✕ takes the add button's spot: on the icing card's frontier edge (bottom)…
    expect((a.widget(`${id}#icing`)!.buttons ?? []).some((b) => b.event === "removeComposite:icing" && b.place === "bottom")).toBe(true);
    // …and the zone card's icing ADD button is gone (replaced by that ✕)
    expect((a.widget(id)!.buttons ?? []).some((b) => b.event === "composite:icing")).toBe(false);
  });

  it("the icing card's ✕ removes the composite and returns focus to the zone (its gauge is back)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    a.actionWidget(id, "composite:icing");
    expect(lastMeta(s)["icing"]).toBeDefined();
    a.actionWidget(id, "removeComposite:icing");
    expect(lastMeta(s)["icing"]).toBeUndefined();       // composite gone
    expect(a.widget(`${id}#icing`)).toBeUndefined();    // its card gone
    expect(a.widget(`${id}#gauge`)).toBeDefined();      // focus back on the zone ⇒ zone gauge returns
  });

  it("dragging the UNSELECTED composite summary card repositions the call-out — it does NOT misfire as a select", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudNonConvective", POLY);
    a.actionWidget(id, "composite:icing"); // a composite ⇒ the unselected view is ONE summary card (id == feature id)
    s.select(null);
    expect(s.selectedId).toBeNull();
    expect(a.widget(id)).toBeDefined(); // the summary card carries the bare feature id (it REPLACES the canvas box)
    // DRAG the card body (down on the widget, move well past the threshold, up) → repositions, stays unselected.
    a.ev("down", 2, 2, { overlay: "widget", props: { id } });
    a.ev("move", 4, 2);
    a.ev("up", 4, 2);
    expect(s.selectedId).toBeNull(); // ← the regression: selecting on DOWN used to break the drag into a click
    // …while a plain TAP (down/up with no move, then the adapter's click) still selects.
    a.ev("down", 2, 2, { overlay: "widget", props: { id } });
    a.ev("up", 2, 2);
    a.clickWidget(id);
    expect(s.selectedId).toBe(id);
  });
});

describe("cloudConvective — multi-layer GAUGES editor (one gauge per layer, panel = active layer)", () => {
  const loadFrance = async () => (await import("../src/profiles/temsi-france.json")).default as unknown as SigwxProfile;
  const layersOf = (s: SigwxDraw): Record<string, unknown>[] => lastMeta(s)["layers"] as Record<string, unknown>[];
  const hasStack = (a: MockAdapter, id: string): boolean =>
    (a.widget(id)!.child.items as unknown[]).some((n) => (n as { kind?: string }).kind === "stack");

  it("the selected panel is ALWAYS the flat active-layer card — never the adapter `stack`, even with N layers", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // 1 layer
    expect(hasStack(a, id)).toBe(false);
    expect(collectGauges(a.widget(id)!)).toHaveLength(0); // gauges live in the satellite, not the panel
    a.actionWidget(id, "addLayer"); // 2 layers — the stack editor would switch to a `stack` here
    a.actionWidget(id, "addLayer"); // 3 layers
    expect(hasStack(a, id)).toBe(false); // …the gauges editor stays flat
    // The panel pickers belong to ONE (the active) layer — not a per-layer pile.
    const names = collectPickers(a.widget(id)!).map((p) => p.name).sort();
    expect(names).toHaveLength(2);
    expect(names.every((n) => /^layers\.\d+\.(amount|type)$/.test(n!))).toBe(true);
    expect(new Set(names.map((n) => n!.split(".")[1])).size).toBe(1); // both scoped to the SAME layer index
  });

  it("the side satellite carries ONE multi-range gauge — N overlapping bands on a shared axis, one colour per layer, `canAdd` below max", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.actionWidget(id, "addLayer");
    a.actionWidget(id, "addLayer"); // 3 layers
    const sat = a.widget(`${id}#gauge`)!;
    const gauges = collectGauges(sat);
    expect(gauges).toHaveLength(1); // ONE gauge, N ranges (shared axis)
    const gauge = gauges[0]!;
    expect(gauge.ranges).toHaveLength(3); // one range per layer
    expect(gauge.cursors).toBeUndefined(); // ranges mode, not cursors
    expect(gauge.ranges!.map((r) => [r.base.name, r.top.name])).toEqual([
      ["layers.0.baseFL", "layers.0.topFL"],
      ["layers.1.baseFL", "layers.1.topFL"],
      ["layers.2.baseFL", "layers.2.topFL"],
    ]);
    // each layer's band + handles take a DISTINCT colour (so overlapping ranges read apart).
    const colors = gauge.ranges!.map((r) => r.color);
    expect(colors.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    expect(new Set(colors).size).toBe(3);
    // adding a layer is the adapter's hover-`+` (an "add here" over an empty axis span emitting
    // `addLayerAt:<fl>`), GATED by the gauge's `canAdd` (true below max). No fixed axis buttons ride
    // the satellite or the panel anymore.
    expect((gauge as { canAdd?: boolean }).canAdd).toBe(true);
    expect(sat.buttons ?? []).toHaveLength(0);
    expect(a.widget(id)!.buttons ?? []).toHaveLength(0);
  });

  it("the multi-range track length is STABLE — independent of the chart's FL extent (the ticks absorb it, not the slider)", async () => {
    const loadEuroc = async () => (await import("../src/profiles/temsi-euroc.json")).default as unknown as SigwxProfile;
    const lengthFor = async (profile: SigwxProfile) => {
      const a = new MockAdapter();
      const s = new SigwxDraw({ adapter: a, profile });
      await s.ready();
      const id = stroke(s, a, "cloudConvective", POLY);
      return collectGauges(a.widget(`${id}#gauge`)!)[0]!.length;
    };
    const franceLen = await lengthFor(await loadFrance()); // ground→FL150 (narrow extent)
    const eurocLen = await lengthFor(await loadEuroc()); //   ground→FL450 (3× the extent)
    expect(franceLen).toBe(eurocLen); // same slider size despite very different FL ranges
    expect(franceLen).toBe(230); // ~3× the editor card (GAUGE_STACK_LENGTH), NOT (max-min)*0.5
  });

  it("touching a layer's gauge makes it the active (edited) layer — the panel pickers follow", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.actionWidget(id, "addLayer"); // 2 layers
    a.dragGauge(id, "layers.1.topFL", 90); // touch layer 1's band → it becomes active
    expect(collectPickers(a.widget(id)!).map((p) => p.name).sort()).toEqual(["layers.1.amount", "layers.1.type"]);
    expect(collectGauges(a.widget(`${id}#gauge`)!)[0]!.active).toBe(1); // active range = touched layer (rendered on top)
    a.dragGauge(id, "layers.0.topFL", 90); // touch layer 0's band → the panel syncs back to 0
    expect(collectPickers(a.widget(id)!).map((p) => p.name).sort()).toEqual(["layers.0.amount", "layers.0.type"]);
    expect(collectGauges(a.widget(`${id}#gauge`)!)[0]!.active).toBe(0);
  });

  it("the editing card is framed in the ACTIVE layer's accent colour over a very-light tint of it", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    a.actionWidget(id, "addLayer"); // 2 layers
    const panel = () => a.widget(id)! as unknown as { border?: string; bg?: string };
    const gaugeColor = (i: number) => collectGauges(a.widget(`${id}#gauge`)!)[0]!.ranges![i]!.color;
    // layer 0 active by default → frame in its colour; bg is a pale (mostly-white) tint of it.
    a.dragGauge(id, "layers.0.topFL", 90); // make 0 active
    expect(panel().border).toBe(gaugeColor(0)); // frame == active range colour
    expect(panel().bg).toMatch(/^#f/i); // very-light tint (near white)
    expect(panel().bg).not.toBe(gaugeColor(0));
    // touch layer 1 → both the frame AND the band colour switch together.
    a.dragGauge(id, "layers.1.topFL", 90);
    expect(panel().border).toBe(gaugeColor(1));
    expect(gaugeColor(1)).not.toBe(gaugeColor(0)); // distinct per layer
  });

  it("a hover-`+` add (`addLayerAt:<fl>`) seeds a layer; `canAdd` flips false at max:4", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    const canAdd = () => (collectGauges(a.widget(`${id}#gauge`)!)[0] as { canAdd?: boolean }).canAdd;
    expect(canAdd()).toBe(true);
    for (let i = 0; i < 3; i++) a.actionWidget(`${id}#gauge`, "addLayerAt:70"); // → 4 layers (max)
    expect(layersOf(s)).toHaveLength(4);
    expect(canAdd()).toBe(false); // at the ceiling no further add is offered
    a.actionWidget(`${id}#gauge`, "addLayerAt:70"); // past max → no-op
    expect(layersOf(s)).toHaveLength(4);
  });

  it("the FIRST layer is CENTRED on the FL range; a hover-`+` (`addLayerAt:<fl>`) drops a band CENTRED on the hovered FL", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() }); // range 0–150, max:4
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY);
    const band = (l: Record<string, unknown>): [number, number] => [l["baseFL"] as number, l["topFL"] as number];
    // one layer ⇒ a 1/max-tall slice (150/4 = 37.5 → 40) CENTRED on the axis (mid 75 ⇒ [55,95]).
    expect(layersOf(s).map(band)).toEqual([[55, 95]]);
    // addLayerAt:<fl> → a 40-tall band CENTRED on the snapped FL, clamped wholly inside the range.
    a.actionWidget(`${id}#gauge`, "addLayerAt:120"); // centred on 120 → [100,140]
    expect(layersOf(s).map(band)).toContainEqual([100, 140]);
    a.actionWidget(`${id}#gauge`, "addLayerAt:20"); // near the floor → shifts inside → [0,40]
    expect(layersOf(s).map(band)).toContainEqual([0, 40]);
  });

  it("the editing control stays put when a layer is added/removed (call-out frozen at selection)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() });
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // drawn ⇒ selected ⇒ call-out offset frozen
    // The gauge + panel both ride the placed call-out (`anchor`). A growing cartouche used to widen
    // the box and slide its centre sideways on every add; the freeze keeps the anchor fixed.
    const gaugeAt = (): unknown => JSON.stringify(a.widget(`${id}#gauge`)!.anchor);
    const panelAt = (): unknown => JSON.stringify(a.widget(id)!.anchor);
    const g0 = gaugeAt();
    const p0 = panelAt();
    a.actionWidget(`${id}#gauge`, "addLayer"); // 2 layers — cartouche grows a line
    a.actionWidget(`${id}#gauge`, "addLayer"); // 3 layers
    expect(gaugeAt()).toBe(g0);
    expect(panelAt()).toBe(p0);
    a.actionWidget(`${id}#gauge`, "removeRange:0:0"); // drop one back
    expect(gaugeAt()).toBe(g0);
  });

  it("a hover-`+` can add a band IN A GAP (mid-axis, not just at the ends)", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() }); // range 0–150, max:4
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // 1 layer CENTRED: [55,95]
    const band = (l: Record<string, unknown>): [number, number] => [l["baseFL"] as number, l["topFL"] as number];
    a.actionWidget(`${id}#gauge`, "addLayerAt:130"); // a band up high → [110,150]
    a.actionWidget(`${id}#gauge`, "addLayerAt:20"); //  one down low  → [0,40] (a gap stays at [40,55] & [95,110])
    expect(layersOf(s).map(band)).toEqual([[110, 150], [55, 95], [0, 40]]); // sorted top-first, gaps are fine
  });

  it("a band flung off the axis (`removeRange:<i>`) drops THAT layer; survivors keep their FL; min-1 guarded", async () => {
    const a = new MockAdapter();
    const s = new SigwxDraw({ adapter: a, profile: await loadFrance() }); // range 0–150, max:4, min:1
    await s.ready();
    const id = stroke(s, a, "cloudConvective", POLY); // [55,95]
    a.actionWidget(`${id}#gauge`, "addLayer"); // [95,135] (generic add, stacks on top)
    a.actionWidget(`${id}#gauge`, "addLayerAt:35"); // [15,55] (hover-add centred low)
    const band = (l: Record<string, unknown>): [number, number] => [l["baseFL"] as number, l["topFL"] as number];
    expect(layersOf(s).map(band)).toEqual([[95, 135], [55, 95], [15, 55]]);
    // fling the MIDDLE band off the axis ⇒ only it goes; the other two keep their FL (NO re-slice ⇒ a gap is fine).
    // (the adapter emits `removeRange:<idx>:<rangeId>` — the lib parses the leading index, ignoring the id suffix.)
    a.actionWidget(`${id}#gauge`, "removeRange:1:1");
    expect(layersOf(s).map(band)).toEqual([[95, 135], [15, 55]]);
    // flinging down to the last layer is REFUSED (min:1): the lone survivor stays put.
    a.actionWidget(`${id}#gauge`, "removeRange:0:0");
    expect(layersOf(s)).toHaveLength(1);
    a.actionWidget(`${id}#gauge`, "removeRange:0:0"); // last one — guarded, no-op
    expect(layersOf(s)).toHaveLength(1);
  });

  // (Per-END room gating — "nothing fits above the ceiling" — moved to the adapter: its hover-`+`
  // only appears over an EMPTY axis span, so the lib no longer pre-computes top/bottom availability.
  // The lib's only gate is `canAdd` at `repeat.max`, covered above.)
});
