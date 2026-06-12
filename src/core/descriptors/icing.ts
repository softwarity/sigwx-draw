/**
 * Icing descriptor — a PURPLE dashed-edge polygon with small INWARD ticks (the
 * WAFC icing-area convention) whose call-out carries the intensity "fork" glyph
 * (MOD / SEV) INSIDE a black & white panel, in PURE JSON. The fill + edge follow
 * the intensity (MOD lighter, SEV darker purple); the call-out stays b&w.
 */
import { defFromDescriptor } from "../descriptor/interpret.js";
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import type { PhenomenonDef } from "../phenomenon.js";

/** One icing intensity: a `code` (which IS the sprite id, e.g. `ICE_MOD`) + a label. */
export interface IcingSymbol {
  code: string;
  label: string;
}

/** The two charted icing intensities. Sprite ids are `ICE_*` so they never clash with
 *  the turbulence MOD/SEV glyphs. Extend via `makeIcing([...])`. */
export const DEFAULT_ICING_SYMBOLS: IcingSymbol[] = [
  { code: "ICE_MOD", label: "MOD — moderate" },
  { code: "ICE_SEV", label: "SEV — severe" },
];

/** The icing descriptor for an intensity catalogue (`symbols[0]` is the default). */
export function icingDescriptor(symbols: IcingSymbol[] = DEFAULT_ICING_SYMBOLS): PhenomenonDescriptor {
  return {
    schemaVersion: 1,
    type: "icing",
    label: "Icing",
    gesture: { primitive: "polygon", draw: "lasso", smooth: true, multiArea: true, erasable: true, default: "regular-polygon" },
    fields: [
      { key: "symbol", kind: "enum", label: "Intensity", options: symbols.map((s) => ({ value: s.code, label: s.label })) },
      { key: "baseFL", kind: "fl", label: "Base", default: 250 },
      { key: "topFL", kind: "fl", label: "Top", default: 360 },
    ],
    flBeyond: ["xxx", "xxx"],
    render: {
      edge: { treatment: "ticks", width: 2.5, dash: [4, 2] },
      fill: { opacity: 0.18 },
      ink: { byField: "symbol", map: { ICE_SEV: "sev", "*": "mod" } },
      // B&W panel: the fork glyph INSIDE the box top (leading blank lines reserve its
      // room — engine convention), lightning leader (the WAFC convective convention).
      callout: {
        anchor: "largest-area-centroid",
        leader: "lightning",
        arrow: true,
        box: true,
        symbol: { byField: "symbol", inside: true },
        content: ["{topFL|flx:top}", "{baseFL|flx:base}"],
      },
    },
    card: {
      framed: true,
      items: [
        { carousel: { field: "symbol" } }, // glyph options (fork sprites per code)
        { text: "{topFL|flx:top}" },
        { text: "{baseFL|flx:base}" },
      ],
      buttons: [
        { place: "h-edges", action: "draw_and_link", svg: "atlas:plus", title: "Draw a linked area" },
        { place: "left", action: "erase", svg: "atlas:minus", title: "Eraser — rub a clear hole" },
      ],
    },
    satellites: [
      { part: "gauge", anchor: "callout", pin: "flRef", side: "right", items: [{ gauge: { cursors: ["baseFL", "topFL"] } }] },
    ],
    // Purple shading per the WAFC norm — MOD lighter, SEV darker (the ink drives edge +
    // fill); the call-out is black & white.
    style: {
      color: "#8250df",
      mod: { color: "#a371f7" }, // medium purple
      sev: { color: "#6639ba" }, // dark purple — darker than MOD
      edge: { width: 2.5, dash: [4, 2], decorator: "dashed" },
      area: { opacity: 0.18 },
      symbol: { sprite: symbols[0]?.code ?? "ICE_MOD", size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: "{symbol|strip:ICE_} ICE {topFL|fl}/{baseFL|fl}",
  };
}

/** The default icing descriptor (MOD / SEV catalogue). */
export const ICING_DESCRIPTOR: PhenomenonDescriptor = icingDescriptor();

/** Build the icing phenomenon for an intensity catalogue (compiled descriptor). */
export function makeIcing(symbols: IcingSymbol[] = DEFAULT_ICING_SYMBOLS): PhenomenonDef {
  return defFromDescriptor(icingDescriptor(symbols));
}
