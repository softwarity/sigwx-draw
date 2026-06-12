/**
 * Turbulence descriptor — a dashed-bold polygon whose call-out carries a chosen
 * symbol glyph (MOD / SEV by default; hosts extend the catalogue), in PURE JSON.
 * The symbol set is data-driven: each entry's `code` IS the sprite id, so the
 * call-out just rides `symbol = metadata.symbol`. Per-severity ink (SEV darker
 * than MOD, WAFC shading contrast) drives edge + fill tint + glyph + FL text.
 */
import { defFromDescriptor } from "../descriptor/interpret.js";
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import type { PhenomenonDef } from "../phenomenon.js";

/** One entry of the turbulence symbol catalogue: a `code` (also the sprite id) + label. */
export interface TurbulenceSymbol {
  code: string;
  label: string;
}

/** The two charted intensities (BoM charts MOD & SEV); a host can append more types. */
export const DEFAULT_TURBULENCE_SYMBOLS: TurbulenceSymbol[] = [
  { code: "MOD", label: "MOD — moderate" },
  { code: "SEV", label: "SEV — severe" },
];

/** The turbulence descriptor for a symbol catalogue (`symbols[0]` is the default). */
export function turbulenceDescriptor(symbols: TurbulenceSymbol[] = DEFAULT_TURBULENCE_SYMBOLS): PhenomenonDescriptor {
  return {
    schemaVersion: 1,
    type: "turbulence",
    label: "Turbulence",
    gesture: { primitive: "polygon", draw: "lasso", smooth: true, multiArea: true, erasable: true, default: "regular-polygon" },
    fields: [
      { key: "symbol", kind: "enum", label: "Symbol", options: symbols.map((s) => ({ value: s.code, label: s.label })) },
      // base BEFORE top so `flightLevel.default: [base, top]` maps in order. NO chart
      // bounds here — they resolve from the profile (`flightLevel`, else `vertical`).
      { key: "baseFL", kind: "fl", label: "Base", default: 250 },
      { key: "topFL", kind: "fl", label: "Top", default: 360 },
    ],
    flBeyond: ["xxx", "xxx"], // an area's base/top may extend off-chart → "XXX"
    render: {
      edge: { treatment: "dash", width: 3, dash: [3, 2] },
      fill: { opacity: 0.18 },
      // Per-severity ink: the field value picks the style subkey (`*` = every other
      // code, host-added types included — they wear the MOD grey).
      ink: { byField: "symbol", map: { SEV: "sev", "*": "mod" } },
      // WAFC Washington "direct" call-out: UNBOXED — glyph above the FL range, text +
      // halo only (the severity ink tints text, glyph and leader/arrow alike).
      callout: {
        id: "turb",
        anchor: "largest-area-centroid",
        leader: "straight",
        arrow: true,
        box: false,
        symbol: { byField: "symbol" },
        content: ["{topFL|flx:top}", "{baseFL|flx:base}"],
      },
    },
    // Selected: an UNFRAMED panel (glyph carousel over the FL lines) + the satellite gauge.
    card: {
      framed: false,
      items: [
        { carousel: { field: "symbol" } }, // no label ⇒ GLYPH options (sprite per code)
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
    // Grey shading per the WAFC norm — MOD light grey, SEV darker grey (the ink drives
    // edge + fill + glyph + FL text; `text` carries only a halo).
    style: {
      color: "#5f6368",
      mod: { color: "#6e7681" }, // medium grey (visible)
      sev: { color: "#2a2e33" }, // dark grey — darker than MOD (severity contrast)
      edge: { width: 3, dash: [3, 2], decorator: "dashed" },
      area: { opacity: 0.18 },
      symbol: { sprite: symbols[0]?.code ?? "MOD", size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: "{symbol} TURB {topFL|fl}/{baseFL|fl}",
  };
}

/** The default turbulence descriptor (MOD / SEV catalogue). */
export const TURBULENCE_DESCRIPTOR: PhenomenonDescriptor = turbulenceDescriptor();

/** Build the turbulence phenomenon for a symbol catalogue (compiled descriptor). */
export function makeTurbulence(symbols: TurbulenceSymbol[] = DEFAULT_TURBULENCE_SYMBOLS): PhenomenonDef {
  return defFromDescriptor(turbulenceDescriptor(symbols));
}
