/**
 * Map-level aggregate style. Per-phenomenon visual tokens live on each
 * {@link import('../core/phenomenon.js').PhenomenonDef} (and are baked into the
 * decoration features); this aggregate only adds host-level overrides plus the
 * chrome the controller owns directly: selection highlight, edit handles, tooltip.
 */
import type { LineStyle, PhenomenonStyle, PointStyle, TooltipStyle } from "../core/index.js";

export interface SigwxStyle {
  /** Per-phenomenon overrides, merged onto each def's own `style`. */
  perPhenomenon: Record<string, Partial<PhenomenonStyle>>;
  /** Highlight drawn around the selected feature. */
  selection: LineStyle;
  /** A draggable shape vertex (geometric point). */
  handle: PointStyle;
  /** A business marker that slides along the curve (e.g. a jet break point). */
  slider: PointStyle;
  /** A control handle (e.g. width/radius) — styled distinctly. */
  controlHandle: PointStyle;
  /** Floating hover tooltip. */
  tooltip: TooltipStyle;
}

export interface SigwxStyleInput {
  perPhenomenon?: Record<string, Partial<PhenomenonStyle>>;
  selection?: Partial<LineStyle>;
  handle?: Partial<PointStyle>;
  slider?: Partial<PointStyle>;
  controlHandle?: Partial<PointStyle>;
  tooltip?: Partial<TooltipStyle>;
}

export const DEFAULT_STYLE: SigwxStyle = {
  perPhenomenon: {},
  selection: { color: "#58a6ff", width: 8, dash: [1, 2] },
  handle: { radius: 5, color: "#ffffff", strokeColor: "#58a6ff", strokeWidth: 2 },
  // The jet break point + its radial speed control share one orange identity.
  slider: { radius: 5, color: "#f0883e", strokeColor: "#ffffff", strokeWidth: 2 },
  controlHandle: { radius: 6, color: "#f0883e", strokeColor: "#ffffff", strokeWidth: 2 },
  tooltip: {
    background: "#0b1622",
    color: "#e6edf3",
    fontSize: 12,
    padding: "3px 7px",
    borderRadius: "4px",
    maxWidth: "260px",
  },
};

export function mergeStyle(base: SigwxStyle, input?: SigwxStyleInput): SigwxStyle {
  if (!input) return base;
  const sel = { ...base.selection, ...input.selection };
  return {
    perPhenomenon: { ...base.perPhenomenon, ...input.perPhenomenon },
    selection: sel.dash ? { ...sel, dash: [...sel.dash] } : sel,
    handle: { ...base.handle, ...input.handle },
    slider: { ...base.slider, ...input.slider },
    controlHandle: { ...base.controlHandle, ...input.controlHandle },
    tooltip: { ...base.tooltip, ...input.tooltip },
  };
}
