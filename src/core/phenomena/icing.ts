/**
 * Icing — a PURPLE dashed-edge polygon whose call-out carries a chosen intensity glyph
 * (the WAFC "fork": MOD / SEV), exactly like CB/turbulence (draw → panel → FL gauge → on-map
 * controls) but: a dashed purple boundary (no scallop), the icing fork glyph, and a BLACK &
 * WHITE call-out (box / glyph / FL / leader), per the WAFC chart. The fill + edge follow the
 * intensity (MOD lighter, SEV darker purple). Tap the glyph on the map to cycle MOD ↔ SEV.
 */
import type { MarkerWidget } from "@softwarity/draw-adapter";

import { catmullRomClosed, coordsOf, frameK, inwardTicks, lineFeature, outerRings, pointFeature, polygonFeature, polylineLength, toPlanar } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature, WidgetInput } from "../phenomenon.js";
import { fl, num, PLUS_GLYPH, regularPolygon, ringCentroid, str, textBoxProps } from "./util.js";

/** One icing intensity: a `code` (which IS the sprite id, e.g. `ICE_MOD`) + a display label. */
export interface IcingSymbol {
  code: string;
  label: string;
}

/** The two charted icing intensities. Sprite ids are `ICE_*` so they never clash with the
 *  turbulence MOD/SEV glyphs. Extend via `makeIcing([...])`. */
export const DEFAULT_ICING_SYMBOLS: IcingSymbol[] = [
  { code: "ICE_MOD", label: "MOD — moderate" },
  { code: "ICE_SEV", label: "SEV — severe" },
];

/** High-level SIGWX (SWH) FL gauge clamp range (FL250–FL600), as CB / turbulence. */
const FL_MIN = 250;
const FL_MAX = 600;

/**
 * Build the icing phenomenon for an intensity catalogue. `symbols[0]` is the default. The
 * `symbol` metadata field stores the chosen `code` (= sprite id), so the map's generic
 * carousel cycles it when the glyph is tapped.
 */
export function makeIcing(symbols: IcingSymbol[] = DEFAULT_ICING_SYMBOLS): PhenomenonDef {
  const first = symbols[0]?.code ?? "ICE_MOD";

  const decorate: DecorateFn = ({ geometry, metadata, style, flightLevel, leaderThunderbolt }) => {
    // An icing zone may be MULTI-AREA (drawn with the card's `+` button): one logical
    // zone — one panel, one metadata set — whose geometry holds several polygons.
    // Smooth + fill + tick EACH.
    const rings = outerRings(geometry).filter((r) => r.length >= 3);
    if (!rings.length) return [];

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

    const sym = str(metadata["symbol"], first); // chosen intensity code (= sprite id)
    // Purple AREA per intensity (MOD lighter, SEV darker). The CALL-OUT is black & white
    // (box / glyph / FL / leader) — decoupled from the purple area, per the WAFC visuals.
    const ink = (sym === "ICE_SEV" ? style.sev : style.mod)?.color ?? style.color;
    const callout = style.text?.color ?? "#1f2328";
    const edgeInk = style.edge?.color ?? ink;
    const edgeW = style.edge?.width ?? 2.5;
    const out: RenderFeature[] = [];
    for (const ring of rings) {
      const smooth = catmullRomClosed(ring, 16); // soft "balloon" outline
      if (style.area) {
        out.push(polygonFeature(smooth, { layer: "area-fill", fillColor: style.area.color ?? ink, fillOpacity: style.area.opacity ?? 0.18 }));
      }
      // Purple boundary + small INWARD ticks at regular spacing (the WAFC icing-area convention) —
      // NOT a scallop (CB). A short perpendicular tick toward the interior every ~1/44 of the perimeter.
      out.push(lineFeature(smooth, { layer: "edge", stroke: edgeInk, strokeWidth: edgeW, dash: style.edge?.dash ?? [4, 2] }));
      const fk = frameK(smooth);
      const perim = polylineLength(smooth.map((c) => toPlanar(c, fk)));
      const spacing = Math.max(0.05, perim / 44);
      const ticks = inwardTicks(smooth, { spacing, length: spacing * 0.26 });
      if (ticks.length) {
        out.push({ type: "Feature", properties: { layer: "edge", stroke: edgeInk, strokeWidth: edgeW }, geometry: { type: "MultiLineString", coordinates: ticks } });
      }
    }

    // Call-out: the fork glyph above the FL range (one bound may be XXX), in a black & white
    // box. Tap the glyph on the map to cycle the intensity. ONE panel, anchored at the
    // LARGEST area's centroid (`coordsOf` of a MultiPolygon = its largest ring); the
    // controller aims one leader/arrow at EACH area.
    out.push(
      pointFeature(ringCentroid(coordsOf(geometry)), {
        layer: "annotations",
        labelId: "icing",
        // Two leading blank lines reserve room for the glyph INSIDE the box (its top half).
        content: ` \n \n${flx(metadata["topFL"], false)}\n${flx(metadata["baseFL"], true)}`,
        leader: true,
        arrow: true,
        // Lightning-bolt leader by default; `leaderThunderbolt:false` → plain straight.
        ...(leaderThunderbolt === false ? {} : { leaderStyle: "lightning" }),
        symbol: sym, // the code IS the sprite id
        symbolColor: callout, // black glyph
        symbolInside: true, // the glyph sits in the box top, not above it
        ...textBoxProps(style),
        textColor: callout, // black FL text
        textBackground: style.text?.background ?? "#ffffff",
        textBorder: callout, // black box + leader/arrow
      }),
    );
    return out;
  };

  return {
    type: "icing",
    label: "Icing",
    // Toolbar glyph: the CB cloud (scalloped, rotated) but with the icing FORK at the centre
    // instead of "CB". `currentColor` so the toolbar tints it.
    icon:
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">' +
      '<g transform="rotate(-15 12 12)">' +
      '<path d="M13.1 5.3 L14.1 5 L15 5.1 L15.7 5.5 L16.4 6.3 L17 7.3 L18.1 7.2 L19 7.2 L19.8 7.5 L20.3 8.1 L20.6 9 L20.7 10 L21.4 10.8 L21.8 11.5 L21.9 12.2 L21.5 12.8 L20.9 13.3 L20 13.8 L20.1 14.8 L20.1 15.7 L19.8 16.4 L19.2 16.8 L18.3 17 L17.3 17 L16.6 18 L15.8 18.7 L15 19.1 L14.1 19.1 L13.1 18.8 L12 18.3 L10.9 18.7 L9.9 19 L9 18.9 L8.3 18.5 L7.6 17.7 L7 16.7 L5.9 16.8 L5 16.8 L4.2 16.5 L3.7 15.9 L3.4 15 L3.3 14 L2.6 13.2 L2.2 12.5 L2.1 11.8 L2.5 11.2 L3.1 10.7 L4 10.2 L3.9 9.2 L3.9 8.3 L4.2 7.6 L4.8 7.2 L5.7 7 L6.7 7 L7.4 6 L8.2 5.3 L9 4.9 L9.9 4.9 L10.9 5.2 L12 5.7 Z"/>' +
      "</g>" +
      '<path d="M8.5 8 V11.5 Q8.5 13 9.7 13 H14.3 Q15.5 13 15.5 11.5 V8 M10.8 11 V17 M13.2 11 V17" stroke-width="1.3" stroke-linecap="round"/>' +
      "</svg>",
    primitives: ["polygon"],
    draw: {
      closed: true,
      minVertices: 3,
      // Freehand balloon draw (closed + smoothed input).
      interaction: { primitive: "polygon", freehand: true, smooth: true, mode: "draw" },
      defaultGeometry: (c, span) => regularPolygon(c, span),
    },
    schema: [
      // `symbol` is the FIRST (only) enum → the map's call-out carousel cycles it.
      {
        type: "enum",
        key: "symbol",
        label: "Intensity",
        default: first,
        options: symbols.map((s) => ({ value: s.code, label: s.label })),
      },
      // base BEFORE top so `flightLevel.default: [base, top]` maps in order.
      { type: "fl", key: "baseFL", label: "Base", default: 250, min: FL_MIN, max: FL_MAX },
      { type: "fl", key: "topFL", label: "Top", default: 360, min: FL_MIN, max: FL_MAX },
    ],
    decorate,
    // When SELECTED, the black & white call-out panel is REPLACED by a DOM card at the same
    // placed spot, whose fork glyph is a `"carousel"` control (click = next, shift-click =
    // previous; emits name:"symbol"), plus `+` buttons straddling its edges
    // (`onWidgetAction("draw-more")` — multi-area). The canvas content's leading BLANK lines (reserved for
    // the inside glyph) are dropped — the glyph is its own card item. Returns null when
    // unselected ⇒ the canvas call-out (tap-the-glyph cycle) renders as usual.
    widget: ({ id, metadata, editable, style, callout, sprite }: WidgetInput): MarkerWidget | null => {
      if (!editable || !callout) return null;
      const ink = style.text?.color ?? "#1f2328"; // black & white, like the canvas panel
      const sym = str(metadata["symbol"], first);
      const options = symbols.map((s) => {
        const svg = sprite?.(s.code);
        return svg ? { value: s.code, svg } : { value: s.code, label: s.code.replace("ICE_", "") };
      });
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
            { kind: "text", value: sym, control: "carousel", name: "symbol", options },
            ...callout.content.split("\n").filter((l) => l.trim() !== "").map((value) => ({ kind: "text" as const, value })),
          ],
        },
        buttons: [{ event: "draw-more", place: ["top", "left", "bottom"], svg: PLUS_GLYPH, bordered: true, title: "Draw a linked area" }],
      };
    },
    // Purple shading per the WAFC norm — MOD lighter, SEV darker (the ink drives edge + fill);
    // the call-out is black & white (see `decorate`).
    style: {
      color: "#8250df",
      mod: { color: "#a371f7" }, // medium purple
      sev: { color: "#6639ba" }, // dark purple — darker than MOD
      edge: { width: 2.5, dash: [4, 2], decorator: "dashed" },
      area: { opacity: 0.18 },
      symbol: { sprite: first, size: 1 },
      text: { halo: "#ffffff", size: 13 },
    },
    summary: (m) => `${str(m["symbol"], first).replace("ICE_", "")} ICE ${fl(m["topFL"])}/${fl(m["baseFL"])}`,
    flBeyond: ["xxx", "xxx"], // an icing area's base/top may extend off-chart → "XXX"
  };
}

/** Default icing phenomenon (MOD / SEV catalogue). */
export const icing: PhenomenonDef = makeIcing();
