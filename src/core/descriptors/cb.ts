/**
 * Cumulonimbus (CB) descriptor — a scalloped (cloud-edge) polygon whose call-out
 * carries the coverage (OCNL / FRQ by default; hosts extend) above the top/base
 * FL, in PURE JSON. Per WAFC (guide §3.7.4) a CB area IMPLIES thunderstorms,
 * hail, and moderate/severe turbulence AND icing — these are NOT drawn separately.
 * Embedded (EMBD) coverage was discontinued in January 2025 → OCNL / FRQ.
 */
import { defFromDescriptor } from "../descriptor/interpret.js";
import type { EnumOptionDescriptor, PhenomenonDescriptor } from "../descriptor/types.js";
import type { PhenomenonDef } from "../phenomenon.js";

/** One CB coverage amount: `code` (stored in metadata), `label`, and the WMO BUFR
 *  0-20-008 figure for IWXXM export. The cloud type is always CB ({@link CB_CLOUD_TYPE_BUFR}). */
export interface CbCoverage {
  code: string;
  label: string;
  /** WMO BUFR table 0-20-008 "Cloud Distribution for Aviation" figure (IWXXM export). */
  bufr?: number;
}

/** Current WAFC high-level CB coverage amounts: OCNL (50–75%) / FRQ (>75%). ISOL (bufr 8)
 *  is legacy; EMBD combinations were discontinued Jan 2025. Extend via `makeCb([...])`. */
export const DEFAULT_CB_COVERAGE: CbCoverage[] = [
  { code: "OCNL", label: "OCNL — occasional (50–75%)", bufr: 10 },
  { code: "FRQ", label: "FRQ — frequent (>75%)", bufr: 12 },
];

/** WMO BUFR table 0-20-012 "Cloud Type" figure for Cumulonimbus — fixed (IWXXM export). */
export const CB_CLOUD_TYPE_BUFR = 9;

/** The CB descriptor for a coverage catalogue (`coverages[0]` is the default). */
export function cbDescriptor(coverages: CbCoverage[] = DEFAULT_CB_COVERAGE): PhenomenonDescriptor {
  const options: EnumOptionDescriptor[] = coverages.map((c) => ({
    value: c.code,
    label: c.label,
    // The BUFR figure rides as opaque `meta` (IWXXM export reads it from the descriptor).
    ...(c.bufr !== undefined ? { meta: { bufr: c.bufr } } : {}),
  }));
  return {
    schemaVersion: 1,
    type: "cb",
    label: "Cumulonimbus (CB)",
    gesture: { primitive: "polygon", draw: "lasso", smooth: true, multiArea: true, erasable: true, default: "regular-polygon" },
    fields: [
      { key: "coverage", kind: "enum", label: "Coverage", options },
      { key: "baseFL", kind: "fl", label: "Base", default: 250 },
      { key: "topFL", kind: "fl", label: "Top", default: 400 },
    ],
    flBeyond: ["xxx", "xxx"], // a CB's base/top may extend off-chart → "XXX"
    render: {
      edge: { treatment: "scallop", width: 2 },
      fill: { opacity: 0.12 },
      // B&W panel "{coverage} / CB / top / base" (multi-word coverages stack), lightning
      // leader (convective); the scallop stays red — only the call-out is black & white.
      callout: {
        anchor: "largest-area-centroid",
        leader: "lightning",
        arrow: true,
        box: true,
        content: ["{coverage|stack}", "CB", "{topFL|flx:top}", "{baseFL|flx:base}"],
      },
    },
    card: {
      framed: true,
      items: [
        // The coverage AND the "CB" word fold into the carousel as a stacked label
        // (needs the adapter's `white-space: pre-line`, else it degrades to one line).
        { carousel: { field: "coverage", label: "{value|stack}\nCB" } },
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
    // Red scalloped edge (PNG convention). The ink drives edge + fill tint + glyph + FL text.
    style: {
      color: "#d1242f",
      edge: { color: "#d1242f", width: 2, decorator: "scallop" },
      area: { color: "#d1242f", opacity: 0.12 },
      symbol: { sprite: coverages[0]?.code ?? "OCNL", size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: "{coverage} CB {topFL|fl}/{baseFL|fl}",
  };
}

/** The default CB descriptor (OCNL / FRQ coverage). */
export const CB_DESCRIPTOR: PhenomenonDescriptor = cbDescriptor();

/** Build the CB phenomenon for a coverage catalogue (compiled descriptor). */
export function makeCb(coverages: CbCoverage[] = DEFAULT_CB_COVERAGE): PhenomenonDef {
  return defFromDescriptor(cbDescriptor(coverages));
}
