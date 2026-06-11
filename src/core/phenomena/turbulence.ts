/**
 * Turbulence — a dashed-bold polygon whose call-out carries a chosen symbol glyph
 * (MOD / SEV by default; a host can extend the catalogue with more types). The
 * symbol set is data-driven: each entry's `code` IS the sprite id, so the decorate
 * just draws `sprite = metadata.symbol`. Click the glyph on the map to pick another
 * (carousel for a small set, radial picker for a large one — handled by the map layer).
 */
import type { MarkerWidget } from "@softwarity/draw-adapter";

import { catmullRomClosed, coordsOf, lineFeature, pointFeature, polygonFeature } from "../decorate/index.js";
import type { Pt } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature, WidgetInput } from "../phenomenon.js";
import { fl, num, regularPolygon, ringCentroid, str } from "./util.js";

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

/** High-level SIGWX (SWH) chart bounds — the default FL gauge clamp range.
 *  FL250–FL600 per the current norm (was FL250–FL630 before January 2024). */
const FL_MIN = 250;
const FL_MAX = 600;

/**
 * Build the turbulence phenomenon for a given symbol catalogue. `symbols[0]` is the
 * default (e.g. MOD). The `symbol` metadata field stores the chosen `code`, which
 * doubles as the sprite id — so each catalogue glyph must be registered under its code.
 */
export function makeTurbulence(symbols: TurbulenceSymbol[] = DEFAULT_TURBULENCE_SYMBOLS): PhenomenonDef {
  const first = symbols[0]?.code ?? "MOD";

  const decorate: DecorateFn = ({ geometry, metadata, style, flightLevel }) => {
    const ring = coordsOf(geometry);
    if (ring.length < 3) return [];
    const smooth = catmullRomClosed(ring as Pt[], 16); // soft "balloon" outline, not angular
    const out: RenderFeature[] = [];

    // Chart vertical bounds (FL250–600 by default; overridable via `flightLevel`).
    // base BELOW min, or top ABOVE max → "XXX" (the off-chart sentinel, per WAFC).
    const flMin = num(flightLevel?.min, FL_MIN);
    const flMax = num(flightLevel?.max, FL_MAX);
    const flx = (v: unknown, isBase: boolean): string => {
      const n = num(v);
      const off = isBase ? n < flMin : n > flMax;
      const xxx = (flightLevel?.beyond?.[isBase ? 0 : 1] ?? "xxx") === "xxx"; // areas default to XXX off-chart
      return off && xxx ? "XXX" : fl(n);
    };

    const sym = str(metadata["symbol"], first); // chosen intensity/type code (= sprite id)
    // Per-severity ink: SEV is a DARKER grey than MOD (WAFC shading contrast). It drives
    // the edge, the fill tint, the glyph AND the FL text — so the whole call-out reads as
    // MOD vs SEV. The `text` style carries only a halo (its colour IS the severity ink).
    const ink = (sym === "SEV" ? style.sev : style.mod)?.color ?? style.color;
    if (style.area) {
      out.push(polygonFeature(smooth, { layer: "area-fill", fillColor: style.area.color ?? ink, fillOpacity: style.area.opacity ?? 0.18 }));
    }
    // Dashed boundary (the `dash` prop tells the adapters to draw it dashed).
    out.push(
      lineFeature(smooth, {
        layer: "edge",
        stroke: style.edge?.color ?? ink,
        strokeWidth: style.edge?.width ?? 3,
        dash: style.edge?.dash ?? [3, 2],
      }),
    );

    // WAFC Washington "direct" call-out: arrow back to the zone, box with the chosen
    // glyph ABOVE the FL range (one bound may be XXX). Click the glyph on the map to
    // pick another from the catalogue.
    out.push(
      pointFeature(ringCentroid(ring), {
        layer: "annotations",
        labelId: "turb",
        content: `${flx(metadata["topFL"], false)}\n${flx(metadata["baseFL"], true)}`,
        leader: true,
        arrow: true,
        symbol: sym, // the code IS the sprite id
        symbolColor: style.symbol?.color ?? ink,
        // NO textBackground → CAT's FL is NOT boxed: just the glyph ABOVE + the FL text with a
        // halo (unlike CB/icing whose call-out IS a black & white panel). `textBorder` only
        // tints the leader/arrow here.
        textColor: ink, // FL text follows the severity
        textSize: style.text?.size ?? 13,
        textHalo: style.text?.halo ?? "#ffffff",
        textBorder: ink, // leader/arrow ink
      }),
    );
    return out;
  };

  return {
    type: "turbulence",
    label: "Turbulence",
    // Toolbar glyph: a dashed irregular "bubble" (the area) with a small boxed "1"
    // at its centre (the placed symbol).
    icon:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 1.3 C17.8 0.9 23.2 3.6 22.6 10.9 C22.2 17.6 17.7 22.2 11.8 21.8 C5.5 21.4 1.3 16.7 1.9 10.1 C2.4 4.1 6.2 1.7 12 1.3 Z" stroke-dasharray="2.8 2.3"/>' +
      // The standard MOD turbulence glyph (an inverted V with feet) at the centre.
      '<path d="M8 14 H10.5 L12 9 L13.5 14 H16"/>' +
      "</svg>",
    primitives: ["polygon"],
    draw: {
      closed: true,
      minVertices: 3,
      // Freehand: draw the outline like inflating a balloon — closed + smoothed.
      interaction: { primitive: "polygon", freehand: true, smooth: true, mode: "draw" },
      defaultGeometry: (c, span) => regularPolygon(c, span),
    },
    schema: [
      {
        type: "enum",
        key: "symbol",
        label: "Symbol",
        default: first,
        options: symbols.map((s) => ({ value: s.code, label: s.label })),
      },
      // base BEFORE top so `flightLevel.default: [base, top]` maps in order ([min-side, max-side]).
      { type: "fl", key: "baseFL", label: "Base", default: 250, min: FL_MIN, max: FL_MAX },
      { type: "fl", key: "topFL", label: "Top", default: 360, min: FL_MIN, max: FL_MAX },
    ],
    decorate,
    // When SELECTED, the call-out (glyph above the FL text) is REPLACED by a DOM card at
    // the same placed spot — UNFRAMED like the canvas call-out — whose severity glyph is a
    // `"carousel"` control (click = next, shift-click = previous; emits name:"symbol").
    // Returns null when unselected ⇒ the canvas call-out (tap-the-glyph cycle) renders as usual.
    widget: ({ id, metadata, editable, style, callout, sprite }: WidgetInput): MarkerWidget | null => {
      if (!editable || !callout) return null;
      const sym = str(metadata["symbol"], first);
      const ink = (sym === "SEV" ? style.sev : style.mod)?.color ?? style.color;
      const options = symbols.map((s) => {
        const svg = sprite?.(s.code);
        return svg ? { value: s.code, svg } : { value: s.code, label: s.code };
      });
      // The canvas call-out centres the TEXT box on the placed anchor with the glyph ABOVE
      // it — this card stacks glyph + text, so a plain "center" origin would shift the whole
      // assembly DOWN by half the glyph. Pin the card at its TEXT block's centre instead
      // (fractional origin), so select/unselect don't jump.
      const fontPx = style.text?.size ?? 13;
      const textH = callout.content.split("\n").length * fontPx * 1.3;
      const glyphH = 32; // sprite intrinsic px (the carousel renders it 1:1)
      return {
        id,
        anchor: { lon: callout.at[0]!, lat: callout.at[1]! },
        origin: { x: 0.5, y: (glyphH + textH / 2) / (glyphH + textH) },
        font: { color: ink, size: fontPx },
        child: {
          dir: "v",
          align: "center",
          gap: 0,
          items: [
            { kind: "text", value: sym, control: "carousel", name: "symbol", options },
            ...callout.content.split("\n").map((value) => ({ kind: "text" as const, value })),
          ],
        },
      };
    },
    // Grey shading per the WAFC norm — MOD light grey, SEV darker grey (the ink drives
    // edge + fill + glyph + FL text; `text` carries only a halo). See `decorate`.
    style: {
      color: "#5f6368",
      mod: { color: "#6e7681" }, // medium grey (visible)
      sev: { color: "#2a2e33" }, // dark grey — darker than MOD (severity contrast)
      edge: { width: 3, dash: [3, 2], decorator: "dashed" },
      area: { opacity: 0.18 },
      symbol: { sprite: first, size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: (m) => `${str(m["symbol"], first)} TURB ${fl(m["topFL"])}/${fl(m["baseFL"])}`,
    flBeyond: ["xxx", "xxx"], // an area's base/top may extend off-chart → "XXX"
  };
}

/** Default turbulence phenomenon (MOD / SEV catalogue). */
export const turbulence: PhenomenonDef = makeTurbulence();
