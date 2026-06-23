/**
 * Map-level aggregate style: the GLOBAL chrome the controller owns directly —
 * selection highlight, edit handles, slider/control handles, tooltip. A
 * phenomenon's own visual tokens are NOT here; they live on each
 * {@link import('../core/phenomenon.js').PhenomenonDef} and are overridden per
 * type via the `phenomena` option (`{ jetStream: { style } }`).
 */
import type { HighlightStyle } from "@softwarity/draw-adapter";
import type { LineStyle, TooltipStyle } from "../core/index.js";

/** The fixed chart-area "cartouche": the BOLD perimeter frame + the minimum MARGIN (px) kept between
 *  the area boundary and the viewport edge when it's framed (so the limit never sits against the screen). */
export interface AreaStyle {
  frame: HighlightStyle;
  padding: number;
}

/** A point handle — fill + stroke (the stroke doubles as a halo for map legibility). */
export interface HandleStyle {
  fill: string;
  stroke: string;
  radius: number;
  strokeWidth: number;
}
/** Gauge axis / band / slider rail. */
export interface ControlLineStyle {
  color: string;
  width: number;
}
/** Gauge numbers / speed value — colour + halo. */
export interface ControlTextStyle {
  color: string;
  halo: string;
}

export interface SigwxStyle {
  /** Highlight drawn around the selected feature. */
  selection: LineStyle;
  /** A draggable shape vertex (geometric point) + its halo (the stroke). */
  handle: HandleStyle;
  /** On-map editing controls (speed dial, FL gauge, jet break points). */
  control: {
    line: ControlLineStyle;
    handle: HandleStyle;
    text: ControlTextStyle;
  };
  /** Floating hover tooltip. */
  tooltip: TooltipStyle;
  /** The fixed chart-area frame + framing margin (`setArea`). */
  area: AreaStyle;
}

export interface SigwxStyleInput {
  selection?: Partial<LineStyle>;
  handle?: Partial<HandleStyle>;
  control?: {
    line?: Partial<ControlLineStyle>;
    handle?: Partial<HandleStyle>;
    text?: Partial<ControlTextStyle>;
  };
  tooltip?: Partial<TooltipStyle>;
  area?: { frame?: Partial<HighlightStyle>; padding?: number };
}

export const DEFAULT_STYLE: SigwxStyle = {
  selection: { color: "#58a6ff", width: 8 }, // solid by default; hosts may set `selection.dash`
  handle: { fill: "#ffffff", stroke: "#58a6ff", radius: 5, strokeWidth: 2 },
  control: {
    // The jet break point, its radial speed dial and the FL gauge share one orange identity.
    line: { color: "#f0883e", width: 2 },
    handle: { fill: "#f0883e", stroke: "#ffffff", radius: 6, strokeWidth: 2 },
    text: { color: "#5a3000", halo: "#ffffff" },
  },
  tooltip: {
    background: "#0b1622",
    color: "#e6edf3",
    fontSize: 12,
    padding: "3px 7px",
    borderRadius: "4px",
    maxWidth: "260px",
  },
  // The chart-area cartouche: a bold dark perimeter, a 40 px framing margin, and a soft veil that
  // DIMS everything OUTSIDE the area (spotlight on the chart). `dimOutside` is a cheap GL complement
  // fill (follows pan/zoom for free) — preferred over the heavier `blurOutside`. Tune colour/opacity
  // (or swap for a dark veil) here, or per host via `style.area.frame`.
  area: { frame: { color: "#1f2328", width: 3, dimOutside: "rgba(255,255,255,0.5)" }, padding: 40 },
};

export function mergeStyle(base: SigwxStyle, input?: SigwxStyleInput): SigwxStyle {
  if (!input) return base;
  const sel = { ...base.selection, ...input.selection };
  return {
    selection: sel.dash ? { ...sel, dash: [...sel.dash] } : sel,
    handle: { ...base.handle, ...input.handle },
    control: {
      line: { ...base.control.line, ...input.control?.line },
      handle: { ...base.control.handle, ...input.control?.handle },
      text: { ...base.control.text, ...input.control?.text },
    },
    tooltip: { ...base.tooltip, ...input.tooltip },
    area: { frame: { ...base.area.frame, ...input.area?.frame }, padding: input.area?.padding ?? base.area.padding },
  };
}
