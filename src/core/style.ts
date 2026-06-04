/**
 * Pure style tokens (no DOM/map). These live in `core` because the decoration
 * functions ({@link DecorateFn}) read a {@link PhenomenonStyle} to bake concrete
 * paint values into the GeoJSON features they emit — so the adapters stay dumb
 * (they just read `properties.stroke`, `.fillColor`, …). The map-level aggregate
 * style ({@link import('../map/style.js').SigwxStyle}) is assembled from these.
 */

export interface FillStyle {
  color: string;
  /** 0–1. */
  opacity: number;
}

export interface LineStyle {
  color: string;
  width: number;
  /** Dash pattern (alternating on/off lengths). Omit for a solid line. */
  dash?: number[];
}

export interface PointStyle {
  radius: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
}

export interface LabelStyle {
  color: string;
  size: number;
  haloColor: string;
  haloWidth: number;
}

/** Floating HTML tooltip shown on hover. */
export interface TooltipStyle {
  background: string;
  color: string;
  fontSize: number;
  padding: string;
  borderRadius: string;
  maxWidth: string;
}

/**
 * Style for one phenomenon. The `edge.decorator` only *selects* how the edge is
 * drawn (solid / dashed); the scalloped edge itself is real geometry produced by
 * `core/decorate`, so a "scallop" decorator is just drawn solid over that ring.
 */
export interface PhenomenonStyle {
  /** Base hue (fronts: cold=blue, warm=red, …). Used as a fallback for sub-styles. */
  color: string;
  /** Area fill (CB / turbulence / icing polygons). Omit for line/point phenomena. */
  fill?: FillStyle;
  /** Edge stroke + how it is treated. */
  edge?: LineStyle & { decorator?: "scallop" | "dashed" | "plain" };
  /** Stroke for derived decorations (barbs, arrowheads, triangles). */
  decoration?: LineStyle;
  /** Glyph reference for the symbols layer (volcano, TC, turbulence, icing, H/L). */
  symbol?: { sprite: string; size: number; color?: string };
  /** Text-box label (FL boxes, wind speed, names). */
  textBox?: LabelStyle & { background: string; border: string };
}

/** Merge a partial phenomenon style onto a resolved base (one level of nesting). */
export function mergePhenomenonStyle(
  base: PhenomenonStyle,
  over?: Partial<PhenomenonStyle>,
): PhenomenonStyle {
  if (!over) return base;
  const out: PhenomenonStyle = { color: over.color ?? base.color };
  const fill = { ...base.fill, ...over.fill };
  if (fill.color !== undefined) out.fill = fill as unknown as NonNullable<PhenomenonStyle["fill"]>;
  const edge = { ...base.edge, ...over.edge };
  if (edge.color !== undefined) {
    out.edge = (edge.dash ? { ...edge, dash: [...edge.dash] } : edge) as unknown as NonNullable<PhenomenonStyle["edge"]>;
  }
  const deco = { ...base.decoration, ...over.decoration };
  if (deco.color !== undefined) {
    out.decoration = (deco.dash ? { ...deco, dash: [...deco.dash] } : deco) as unknown as NonNullable<PhenomenonStyle["decoration"]>;
  }
  const sym = { ...base.symbol, ...over.symbol };
  if (sym.sprite !== undefined) out.symbol = sym as unknown as NonNullable<PhenomenonStyle["symbol"]>;
  const tb = { ...base.textBox, ...over.textBox };
  if (tb.color !== undefined) out.textBox = tb as unknown as NonNullable<PhenomenonStyle["textBox"]>;
  return out;
}

/**
 * Convert a hex colour (`#rgb` / `#rrggbb`) + opacity to `rgba(…)` (OpenLayers has
 * no separate fill-opacity). Other colour forms are returned unchanged.
 */
export function rgba(color: string, opacity: number): string {
  const c = color.trim();
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  let r: number;
  let g: number;
  let b: number;
  if (m6) {
    r = parseInt(m6[1]!, 16);
    g = parseInt(m6[2]!, 16);
    b = parseInt(m6[3]!, 16);
  } else if (m3) {
    r = parseInt(m3[1]! + m3[1]!, 16);
    g = parseInt(m3[2]! + m3[2]!, 16);
    b = parseInt(m3[3]! + m3[3]!, 16);
  } else {
    return color;
  }
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
