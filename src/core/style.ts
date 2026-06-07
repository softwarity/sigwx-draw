/**
 * Pure style tokens (no DOM/map). These live in `core` because the decoration
 * functions ({@link DecorateFn}) read a {@link PhenomenonStyle} to bake concrete
 * paint values into the GeoJSON features they emit — so the adapters stay dumb
 * (they just read `properties.stroke`, `.fillColor`, …). The map-level aggregate
 * style ({@link import('../map/style.js').SigwxStyle}) is assembled from these.
 */

export interface LineStyle {
  color: string;
  width: number;
  /** Dash pattern (alternating on/off lengths). Omit for a solid line. */
  dash?: number[];
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

// ── Shared sub-styles ────────────────────────────────────────────────────────
/** Label text — colour + halo (an outline that keeps the text legible over the map). */
export interface TextStyle { color?: string; halo?: string; size?: number; background?: string }
/** Area boundary. `decorator` only *selects* the treatment (solid/dashed); a scalloped
 *  edge is real geometry from `core/decorate`, so "scallop" just draws solid over it. */
export interface EdgeStyle { color?: string; width?: number; dash?: number[]; decorator?: "scallop" | "dashed" | "plain" }
/** Area fill — colour (defaults to the resolved ink) + opacity. */
export interface AreaStyle { color?: string; opacity?: number }
/** Symbols-layer glyph. */
export interface SymbolStyle { sprite: string; size?: number; color?: string }

// ── Per-phenomenon styles (each phenomenon exposes ONLY what it draws) ─────────
/** Jet stream — an arrow (axis + feathers + pennants + arrowhead) and FL text. */
export interface JetStyle {
  color: string;
  arrow?: { color?: string; width?: number };
  text?: TextStyle;
}
/** Turbulence — per-severity ink (MOD lighter / SEV darker) that drives the edge, the
 *  fill tint, the glyph AND the FL text; a dashed edge; a fill; and a haloed FL text. */
export interface TurbulenceStyle {
  color: string;
  mod?: { color?: string };
  sev?: { color?: string };
  edge?: EdgeStyle;
  area?: AreaStyle;
  symbol?: SymbolStyle;
  text?: TextStyle;
}
/** Cumulonimbus — a scalloped edge, a fill, and a coverage/FL label. */
export interface CbStyle {
  color: string;
  edge?: EdgeStyle;
  area?: AreaStyle;
  symbol?: SymbolStyle;
  text?: TextStyle;
}

/**
 * The superset of every phenomenon's style fields — what {@link DecorateFn} receives
 * and {@link mergePhenomenonStyle} operates on. Each specific style ({@link JetStyle},
 * {@link TurbulenceStyle}, {@link CbStyle}) is a subset, hence assignable to this.
 */
export interface PhenomenonStyle {
  color: string;
  arrow?: { color?: string; width?: number };
  mod?: { color?: string };
  sev?: { color?: string };
  edge?: EdgeStyle;
  area?: AreaStyle;
  symbol?: SymbolStyle;
  text?: TextStyle;
}

/** Merge a partial phenomenon style onto a resolved base (one level of nesting). */
export function mergePhenomenonStyle(
  base: PhenomenonStyle,
  over?: Partial<PhenomenonStyle>,
): PhenomenonStyle {
  if (!over) return base;
  const out: PhenomenonStyle = { color: over.color ?? base.color };
  const arrow = { ...base.arrow, ...over.arrow };
  if (arrow.color !== undefined || arrow.width !== undefined) out.arrow = arrow;
  const mod = { ...base.mod, ...over.mod };
  if (mod.color !== undefined) out.mod = mod;
  const sev = { ...base.sev, ...over.sev };
  if (sev.color !== undefined) out.sev = sev;
  const edge = { ...base.edge, ...over.edge };
  if (edge.color !== undefined || edge.width !== undefined || edge.dash !== undefined || edge.decorator !== undefined) {
    out.edge = edge.dash ? { ...edge, dash: [...edge.dash] } : edge;
  }
  const area = { ...base.area, ...over.area };
  if (area.color !== undefined || area.opacity !== undefined) out.area = area;
  const sym = { ...base.symbol, ...over.symbol };
  if (sym.sprite !== undefined) out.symbol = { ...sym, sprite: sym.sprite };
  const text = { ...base.text, ...over.text };
  if (text.color !== undefined || text.halo !== undefined || text.size !== undefined || text.background !== undefined) out.text = text;
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
