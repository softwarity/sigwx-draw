import { describe, expect, it } from "vitest";
import type { FieldSchema } from "../src/core/index.js";

import {
  layerAltitude,
  layerFlKeys,
  sliceBand,
  centeredBand,
  bandAround,
  adjacentBand,
} from "../src/core/index.js";

const fl = (key: string): FieldSchema => ({ type: "fl", key, label: key });

describe("multi-layer FL band arithmetic (the TEMSI cloud-layer stack)", () => {
  it("layerAltitude sorts by top FL, else base, else 0", () => {
    expect(layerAltitude({ topFL: 300, baseFL: 250 })).toBe(300);
    expect(layerAltitude({ baseFL: 250 })).toBe(250); // no top ⇒ base
    expect(layerAltitude({})).toBe(0); // un-set ⇒ sinks
  });

  it("layerFlKeys picks base/top by name, falls back to schema order, null below two FL fields", () => {
    expect(layerFlKeys([fl("baseFL"), fl("topFL")])).toEqual(["baseFL", "topFL"]);
    expect(layerFlKeys([fl("topFL"), fl("baseFL")])).toEqual(["baseFL", "topFL"]); // by name, not order
    expect(layerFlKeys([fl("lower"), fl("upper")])).toEqual(["lower", "upper"]); // neither matches ⇒ order
    expect(layerFlKeys([fl("baseFL")])).toBeNull(); // only one FL field
    expect(layerFlKeys([{ type: "enum", key: "amount", label: "", options: [] }, fl("x")])).toBeNull();
  });

  it("sliceBand cuts n equal 5-FL-snapped bands bottom-up; the last reaches max; degenerate ⇒ null", () => {
    expect(sliceBand(250, 400, 3, 0)).toEqual({ base: 250, top: 300 }); // bottom third
    expect(sliceBand(250, 400, 3, 1)).toEqual({ base: 300, top: 350 });
    expect(sliceBand(250, 400, 3, 2)).toEqual({ base: 350, top: 400 }); // top third reaches max
    expect(sliceBand(0, 300, 3, 9)).toEqual({ base: 200, top: 300 }); // index clamps to n-1
    expect(sliceBand(100, 102, 1, 0)).toBeNull(); // a band rounds to zero height
  });

  it("centeredBand sits one 1/n slice on the mid-altitude (room above AND below)", () => {
    expect(centeredBand(0, 300, 3)).toEqual({ base: 100, top: 200 });
  });

  it("bandAround centres a slice on fl, snapped + clamped wholly inside the range", () => {
    expect(bandAround(0, 300, 3, 250)).toEqual({ base: 200, top: 300 });
    expect(bandAround(0, 300, 3, 290)).toEqual({ base: 200, top: 300 }); // near the top ⇒ shifted in
    expect(bandAround(0, 300, 3, 10)).toEqual({ base: 0, top: 100 }); // near the bottom ⇒ shifted in
  });

  it("adjacentBand butts a new layer against the stack (or a bottom slice when empty)", () => {
    expect(adjacentBand(0, 300, 3, [], [], "top")).toEqual({ base: 0, top: 100 }); // first layer
    expect(adjacentBand(0, 300, 3, [200], [100], "top")).toEqual({ base: 200, top: 300 }); // above highest top
    expect(adjacentBand(0, 300, 3, [200], [100], "bottom")).toEqual({ base: 0, top: 100 }); // below lowest base
  });
});
