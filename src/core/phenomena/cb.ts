/**
 * Cumulonimbus (CB) — a scalloped (cloud-edge) polygon whose call-out carries the
 * coverage (OCNL / FRQ by default; a host can extend) above the top/base FL. Click the
 * CB glyph on the map to cycle the coverage (carousel, like turbulence MOD↔SEV); drag the
 * box to reposition the call-out; the FL gauge edits base/top.
 *
 * Per WAFC (guide §3.7.4) a CB area IMPLIES thunderstorms, hail, and moderate/severe
 * turbulence AND icing — these are NOT drawn separately on the CB. Embedded (EMBD)
 * coverage was discontinued in January 2025, so the default catalogue is OCNL / FRQ.
 */
import type { MarkerWidget } from "@softwarity/draw-adapter";

import { coordsOf, frameK, lineFeature, outerRings, pointFeature, polygonFeature, polylineLength, scallopRing, toPlanar } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature, WidgetInput } from "../phenomenon.js";
import { fl, num, regularPolygon, ringCentroid, str, textBoxProps } from "./util.js";

/** A `+` glyph for CB's transient edge action buttons. */
const CB_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 6 V18 M6 12 H18"/></svg>';

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

/** High-level SIGWX (SWH) FL gauge clamp range (FL250–FL600), as turbulence. */
const FL_MIN = 250;
const FL_MAX = 600;

/**
 * Build the CB phenomenon for a coverage catalogue. `coverages[0]` is the default. The
 * `coverage` metadata field stores the chosen `code`; it is the first (and only) enum, so
 * the map's generic carousel cycles it when the CB glyph is tapped.
 */
export function makeCb(coverages: CbCoverage[] = DEFAULT_CB_COVERAGE): PhenomenonDef {
  const first = coverages[0]?.code ?? "OCNL";

  const decorate: DecorateFn = ({ geometry, metadata, style, flightLevel, leaderThunderbolt }) => {
    // A CB may be MULTI-AREA (drawn with the call-out's `+` button): one logical CB — one
    // box, one metadata set — whose geometry holds several polygons. Scallop + fill EACH.
    const rings = outerRings(geometry).filter((r) => r.length >= 3);
    if (!rings.length) return [];
    // Bump direction is per-feature: toggled ON THE MAP (tap the central handle) via the
    // `scallopInvert` metadata flag; falls back to the style default. true → bumps point INWARD.
    const invert = metadata["scallopInvert"] != null ? Boolean(metadata["scallopInvert"]) : style.edge?.scallopSide === "in";
    const out: RenderFeature[] = [];

    // Chart vertical bounds (FL250–600 by default; overridable via `flightLevel`). A base
    // BELOW min or top ABOVE max → "XXX" (the off-chart sentinel, per WAFC).
    const flMin = num(flightLevel?.min, FL_MIN);
    const flMax = num(flightLevel?.max, FL_MAX);
    const flx = (v: unknown, isBase: boolean): string => {
      const n = num(v);
      const off = isBase ? n < flMin : n > flMax;
      const xxx = (flightLevel?.beyond?.[isBase ? 0 : 1] ?? "xxx") === "xxx";
      return off && xxx ? "XXX" : fl(n);
    };

    const ink = style.edge?.color ?? style.color; // red — the scalloped EDGE (the area outline)
    const callout = style.text?.color ?? "#1f2328"; // black — the call-out panel, per the WAFC visuals
    for (const ring of rings) {
      // Scallop each boundary — real geometry; bumps point OUTWARD (away from the fill), so a
      // concave edge / hole naturally reads as bumps "into" it. `scallopRing` orients by the ring.
      const k = frameK(ring);
      const perim = polylineLength(ring.map((c) => toPlanar(c, k)));
      const wavelength = Math.max(0.05, perim / 36);
      const scalloped = scallopRing(ring, { wavelength, amplitude: wavelength * 0.6, invert });
      if (style.area) {
        out.push(polygonFeature(scalloped, { layer: "area-fill", fillColor: style.area.color ?? style.color, fillOpacity: style.area.opacity ?? 0.12 }));
      }
      out.push(lineFeature(scalloped, { layer: "edge", stroke: ink, strokeWidth: style.edge?.width ?? 2 }));
    }

    // Call-out: ONE framed box "{coverage} / CB / {top} / {base}" — black text + white box + black
    // border + black leader/arrow (the WAFC panel is black & white; the scallop stays red). The
    // coverage is edited on the SELECTED card's carousel. Anchored at the LARGEST area's
    // centroid (`coordsOf` of a MultiPolygon = its largest ring); the controller aims one
    // leader/arrow at EACH area.
    const coverage = str(metadata["coverage"], first);
    out.push(
      pointFeature(ringCentroid(coordsOf(geometry)), {
        layer: "annotations",
        labelId: "cb",
        // Multi-word coverages (e.g. "OCNL EMBD") stack onto their own lines (one line more).
        content: `${coverage.replace(/ /g, "\n")}\nCB\n${flx(metadata["topFL"], false)}\n${flx(metadata["baseFL"], true)}`,
        leader: true,
        arrow: true,
        // Lightning-bolt leader by default (convective); `leaderThunderbolt:false` → plain straight.
        ...(leaderThunderbolt === false ? {} : { leaderStyle: "lightning" }),
        ...textBoxProps(style),
        textColor: callout,
        textBackground: style.text?.background ?? "#ffffff",
        textBorder: callout, // black box border + leader/arrow
      }),
    );
    return out;
  };

  return {
    type: "cb",
    label: "Cumulonimbus (CB)",
    // Toolbar glyph: a scalloped CB cloud (the WAFC red CB symbol, drawn in currentColor) —
    // a lumpy closed blob with uneven rounded lobes (generated via scallopRing on an irregular ring).
    icon:
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">' +
      '<g transform="rotate(-15 12 12)">' +
      '<path d="M13.1 5.3 L14.1 5 L15 5.1 L15.7 5.5 L16.4 6.3 L17 7.3 L18.1 7.2 L19 7.2 L19.8 7.5 L20.3 8.1 L20.6 9 L20.7 10 L21.4 10.8 L21.8 11.5 L21.9 12.2 L21.5 12.8 L20.9 13.3 L20 13.8 L20.1 14.8 L20.1 15.7 L19.8 16.4 L19.2 16.8 L18.3 17 L17.3 17 L16.6 18 L15.8 18.7 L15 19.1 L14.1 19.1 L13.1 18.8 L12 18.3 L10.9 18.7 L9.9 19 L9 18.9 L8.3 18.5 L7.6 17.7 L7 16.7 L5.9 16.8 L5 16.8 L4.2 16.5 L3.7 15.9 L3.4 15 L3.3 14 L2.6 13.2 L2.2 12.5 L2.1 11.8 L2.5 11.2 L3.1 10.7 L4 10.2 L3.9 9.2 L3.9 8.3 L4.2 7.6 L4.8 7.2 L5.7 7 L6.7 7 L7.4 6 L8.2 5.3 L9 4.9 L9.9 4.9 L10.9 5.2 L12 5.7 Z"/>' +
      '</g>' +
      '<text x="12" y="12.5" font-size="7" font-weight="700" text-anchor="middle" dominant-baseline="central" stroke="none" fill="currentColor" font-family="system-ui, -apple-system, sans-serif">CB</text>' +
      "</svg>",
    primitives: ["polygon"],
    draw: {
      closed: true,
      minVertices: 3,
      // Freehand balloon draw (closed + smoothed input), then the boundary is scalloped.
      interaction: { primitive: "polygon", freehand: true, smooth: true, mode: "draw" },
      defaultGeometry: (c, span) => regularPolygon(c, span),
    },
    schema: [
      // `coverage` is the FIRST (only) enum → the map's call-out carousel cycles it.
      {
        type: "enum",
        key: "coverage",
        label: "Coverage",
        default: first,
        options: coverages.map((c) => ({ value: c.code, label: c.label })),
      },
      // base BEFORE top so `flightLevel.default: [base, top]` maps in order.
      { type: "fl", key: "baseFL", label: "Base", default: 250, min: FL_MIN, max: FL_MAX },
      { type: "fl", key: "topFL", label: "Top", default: 400, min: FL_MIN, max: FL_MAX },
    ],
    decorate,
    // When SELECTED, the call-out box is REPLACED by a DOM card at the same placed spot —
    // same content, plus `+` buttons straddling its edges (`onWidgetAction("draw-more")`).
    // The COVERAGE line is a `"carousel"` control (click = next, shift-click = previous,
    // emits `onWidgetEdit({id, name:"coverage", value})`) — it replaces the old tap-the-box
    // cycle while selected. The leader/arrow still points at the card. Returns null when
    // unselected (or before the first placement) ⇒ the canvas call-out renders as usual.
    widget: ({ id, metadata, editable, style, callout }: WidgetInput): MarkerWidget | null => {
      if (!editable || !callout) return null;
      const ink = style.text?.color ?? "#1f2328"; // black & white, like the canvas call-out
      // The canvas content is `{coverage (multi-word = multi-line)}\nCB\n{top}\n{base}` — keep
      // its LAST 2 lines (the flx-formatted FLs); the coverage AND the "CB" word fold into the
      // carousel as a stacked multi-line label (mirrors the canvas; needs the adapter's
      // `white-space: pre-line` on the control, else it degrades to one line).
      const tail = callout.content.split("\n").slice(-2);
      return {
        id,
        anchor: { lon: callout.at[0]!, lat: callout.at[1]! },
        bg: style.text?.background ?? "#ffffff",
        border: ink,
        radius: "small",
        padding: "small",
        font: { color: ink, size: style.text?.size ?? 13 },
        child: {
          dir: "v",
          align: "center",
          gap: 0,
          items: [
            { kind: "text", value: str(metadata["coverage"], first), control: "carousel", name: "coverage", options: coverages.map((c) => ({ value: c.code, label: `${c.code.replace(/ /g, "\n")}\nCB` })) },
            ...tail.map((value) => ({ kind: "text" as const, value })),
          ],
        },
        buttons: [{ event: "draw-more", place: ["top", "left", "bottom"], svg: CB_PLUS, bordered: true, title: "Draw a linked area" }],
      };
    },
    // Red scalloped edge (PNG convention). The ink drives edge + fill tint + glyph + FL text.
    style: {
      color: "#d1242f",
      edge: { color: "#d1242f", width: 2, decorator: "scallop" },
      area: { color: "#d1242f", opacity: 0.12 },
      symbol: { sprite: first, size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: (m) => `${str(m["coverage"], first)} CB ${fl(m["topFL"])}/${fl(m["baseFL"])}`,
    flBeyond: ["xxx", "xxx"], // a CB's base/top may extend off-chart → "XXX"
  };
}

/** Default CB phenomenon (OCNL / FRQ coverage). */
export const cb: PhenomenonDef = makeCb();
