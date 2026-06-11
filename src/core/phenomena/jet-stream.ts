/**
 * Jet stream — a smooth, directional curve whose per-segment data lives in a list
 * of **break points** (each at a parametric `t` on the curve, carrying speed + FL,
 * and top/base at the max-wind point). The rendering is fully derived (WAFC guide
 * §3.5): smoothed axis, arrow at the downstream end, wind barbs per segment (side
 * from the hemisphere), change bars at interior breaks where speed/FL changes, FL
 * call-out boxes, and a vertical-extent box at the max-wind point when ≥ 120 kt.
 *
 * This is the proof that the architecture handles geometric points (the curve)
 * AND business points (the breaks) that follow the curve but are dissociated.
 */
import {
  add,
  arrowheadFeature,
  barbCounts,
  catmullRom,
  changeBarFeatures,
  coordsOf,
  featherSide,
  frameK,
  lineFeature,
  perpLeft,
  pointAtFraction,
  pointFeature,
  polylineLength,
  scale,
  sub,
  toLonLat,
  toPlanar,
  windBarbFeatures,
} from "../decorate/index.js";
import type { Pt } from "../decorate/index.js";
import type { DecorateFn, Metadata, PhenomenonDef, RenderFeature } from "../phenomenon.js";
import { fl, num, textBoxProps } from "./util.js";

/** High-level SIGWX (SWH) chart FL bounds — the default jet FL gauge clamp (FL250–600,
 *  same chart as turbulence). Overridable per phenomenon via `flightLevel.{min,max}`. */
const FL_MIN = 250;
const FL_MAX = 600;

interface Break {
  t: number;
  speed: number;
  fl: number;
  top: number | undefined;
  base: number | undefined;
}

function breaks(metadata: Metadata): Break[] {
  const raw = (metadata["points"] as Metadata[] | undefined) ?? [];
  return raw
    .map((p) => ({ t: num(p["t"]), speed: num(p["speed"]), fl: num(p["fl"]), top: p["top"] as number | undefined, base: p["base"] as number | undefined }))
    .sort((a, b) => a.t - b.t);
}

const decorate: DecorateFn = ({ geometry, metadata, style, resolution }) => {
  const coords = coordsOf(geometry);
  if (coords.length < 2) return [];
  const pts = breaks(metadata);
  if (!pts.length) return [];
  const maxSpeed = Math.max(...pts.map((p) => p.speed));
  if (maxSpeed < 80) return []; // jets below 80 kt are not depicted

  const k = frameK(coords);
  const dense = catmullRom(coords as Pt[], 16);
  const planar = dense.map((c) => toPlanar(c, k));
  const total = polylineLength(planar);
  const reversed = metadata["reversed"] === true;
  const stroke = style.arrow?.color ?? style.color;
  const out: RenderFeature[] = [];

  // One "px unit" in geographic degrees → barbs are a constant SCREEN-size glyph
  // (no resolution = headless: full detail). `screenPx` is the jet's on-screen length.
  const px = resolution && resolution > 0 ? resolution : total / 750;
  const screenPx = total / px;
  // Level of detail: shed decoration as the jet shrinks on screen, down to the bare
  // line when very far out (labels first, then barbs, then the arrow).
  const showArrow = metadata["arrow"] !== false && screenPx > 40;
  const showBarbs = screenPx > 80;
  const showLabels = screenPx > 170;

  // Smoothed jet axis (bold).
  out.push(lineFeature(dense, { layer: "edge", stroke: style.arrow?.color ?? style.color, strokeWidth: style.arrow?.width ?? 3 }));

  // Arrow at the downstream end (start when reversed).
  const arrowSize = Math.max(0.035, total * 0.035);
  if (showArrow) {
    const n = planar.length;
    const tip = reversed ? planar[0]! : planar[n - 1]!;
    const dir = reversed ? sub(planar[0]!, planar[1]!) : sub(planar[n - 1]!, planar[n - 2]!);
    // `declutter:"late"`: the arrowhead carries the jet's DIRECTION — zoomed out it outlives
    // the barbs/labels (hides only at half the declutter threshold).
    out.push(arrowheadFeature(tip, dir, k, arrowSize, { layer: "decoration", stroke, strokeWidth: 1, fillColor: stroke, declutter: "late" }));
  }
  // Leave room for the arrowhead at the downstream tip so the end barb doesn't overlap it.
  const endMargin = showArrow ? arrowSize * 1.8 : 0;

  // One wind barb (the "fleche") AT each data point, showing the wind there, on
  // the line, oriented to the local tangent. Feathers cluster upstream of the
  // point, on the low-pressure side (NH left / SH right).
  // A barb cluster's along-shaft footprint ≈ featherLen × clusterUnit(speed). The
  // combined footprint of all barbs must stay below the jet's own length (the
  // barbs shouldn't outweigh the line) — so cap featherLen accordingly. Otherwise
  // it's a constant ≈30 px screen glyph.
  const clusterUnit = (speed: number): number => {
    const { pennants, full, half } = barbCounts(speed);
    return 0.5 * pennants + 0.28 * (full + half) + (pennants && full + half ? 0.31 : 0);
  };
  // Only points that actually draw feathers (>80) count toward the footprint cap;
  // the 80-floor points draw nothing, so they mustn't shrink the barbs.
  const footprint = pts.reduce((s, p) => s + (p.speed > 80 ? clusterUnit(p.speed) : 0), 0) || 1;
  const featherLen = Math.min(px * 30, (total * 0.5) / footprint); // Σ footprints ≤ ½ the line
  const thickness = Math.min(px * 1.6, featherLen * 0.09); // thin, but proportional when capped
  const gap = featherLen * 0.28;
  const cbLength = featherLen * 0.7; // change-bar tick length
  const cbGap = featherLen * 0.2; // spacing between the two parallel ticks
  // Real along-shaft HALF-footprint of a barb cluster, matching windBarbFeatures'
  // layout (pennants of width featherLen/2, then `gap` between feathers, ~1.1·gap
  // breathing after the pennants). Used to anchor the FL label under the cluster
  // MIDDLE — `clusterUnit` above over-estimates it, so the label drifted to the
  // cluster's downstream end (e.g. onto the last 10-kt feather of 50+10×4+5).
  const clusterMid = (speed: number): number => {
    const { pennants, full, half } = barbCounts(speed);
    const pw = featherLen * 0.5;
    const c0 = pennants * pw + (pennants && full + half ? gap * 1.1 : 0);
    return (c0 + Math.max(0, full + half - 1) * gap) / 2;
  };

  // Per WAFC fig 11 (§3.5.8): a point's depiction follows the speed PROFILE.
  //  - speed 80 (the floor) → nothing (clean baseline);
  //  - a strictly monotonic transition whose step from the previous point is
  //    EXACTLY ±20 KT → a change bar (two parallel ticks; a change bar means ±20);
  //  - otherwise (extremum, endpoint, or a non-±20 step), >80 → full feathers
  //    decoding the absolute speed.
  // The max-wind point ALWAYS shows feathers (it decodes the peak speed and carries
  // the FL label) — never a change bar, even on a tie/plateau (first of the ties).
  const maxPt = pts.reduce((m, p) => (p.speed > m.speed ? p : m), pts[0]!);
  // A change bar (`||`, meaning a ±20 KT step) sits at a point whose step FROM THE
  // PREVIOUS point is exactly ±20, where the trend does NOT reverse (a peak/valley
  // shows feathers), and whose FL is UNCHANGED from the previous (a FL change needs
  // feathers + a FL label, not a bar). It MAY sit at the 80 floor (e.g. a −20 step
  // down to 80). Everything else >80 draws feathers; the bare floor draws nothing.
  const isCBar = (i: number): boolean => {
    const p = pts[i]!;
    if (p === maxPt) return false; // the peak/plateau-top is feathers + FL, not a bar
    const pv = i > 0 ? pts[i - 1]! : null;
    const nx = i < pts.length - 1 ? pts[i + 1]! : null;
    if (!pv || !nx) return false; // need both neighbours; ends/last → feathers
    if (Math.abs(p.speed - pv.speed) !== 20) return false; // exactly ±20 KT
    const noReversal = pv.speed > p.speed ? nx.speed <= p.speed : nx.speed >= p.speed;
    return noReversal && num(p.fl) === num(pv.fl);
  };
  if (showBarbs) pts.forEach((p, i) => {
    if (i === 0 || i === pts.length - 1) return; // jet extremities (ends) are never decorated — the line + arrowhead carry them
    const st = pointAtFraction(planar, p.t);
    if (isCBar(i)) {
      out.push(...changeBarFeatures({ point: st.p, tangent: st.dir, k, length: cbLength, gap: cbGap, props: { layer: "decoration", stroke, strokeWidth: 3 } }));
      return;
    }
    // The 80 floor draws nothing — UNLESS its FL differs from the previous point:
    // a FL change must be shown (80 feathers + its FL label), not a bare baseline.
    const flChange = i > 0 && num(p.fl) !== num(pts[i - 1]!.fl);
    if (p.speed <= 80 && !flChange) return;
    const lat = toLonLat(st.p, k)[1];
    out.push(
      ...windBarbFeatures({
        planar,
        k,
        startT: p.t,
        speedKt: p.speed,
        featherLen,
        gap,
        thickness,
        endMargin,
        side: featherSide(lat),
        flowSign: reversed ? -1 : 1,
        props: { layer: "decoration", stroke, fillColor: stroke },
      }),
    );
  });

  // FL call-outs (WAFC §3.5.5 "at points along its length"): a plain "FLxxx" at
  // the max-wind point (+ vertical extent "lower/upper" when ≥120, fig 9) AND at
  // every point where the FL CHANGES. Constant FL → one label (at the max, fig 11);
  // varying FL → one per change. Attached below the line, rotated, no leader.
  const flNum = (v: number | undefined): string => String(Math.round(num(v))).padStart(3, "0");
  // NO box: just text + halo. A box (textBackground/textBorder) would NOT rotate with the
  // (rotated) label on OL/Leaflet — it floats off the text — so the jet FL is never boxed.
  const tbp = textBoxProps(style);
  const tb = { textColor: tbp.textColor, textSize: tbp.textSize, textHalo: tbp.textHalo };
  const flLabel = (p: Break, withExtent: boolean): void => {
    // Anchor under the MIDDLE of the barb cluster (the point sits at one end of it),
    // a touch below the line.
    const flowSign = reversed ? -1 : 1;
    const half = clusterMid(p.speed);
    const centerArc = Math.max(0, Math.min(total, p.t * total + flowSign * half));
    const st = pointAtFraction(planar, centerArc / total);
    const flow = scale(st.dir, flowSign);
    const sideSign = featherSide(toLonLat(st.p, k)[1]);
    const anchor = add(st.p, scale(perpLeft(flow), -sideSign * featherLen * 0.6));
    const lines = [fl(p.fl)];
    if (withExtent && p.speed >= 120) {
      // Show the vertical extent ≥120; default to fl ± 40 until the gauge sets it.
      const top = p.top != null ? p.top : Math.min(FL_MAX, num(p.fl) + 40);
      const base = p.base != null ? p.base : Math.max(FL_MIN, num(p.fl) - 40);
      lines.push(`${flNum(Math.min(top, base))}/${flNum(Math.max(top, base))}`); // lower/upper
    }
    let ang = (Math.atan2(-flow[1], flow[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    else if (ang < -90) ang += 180;
    out.push(pointFeature(toLonLat(anchor, k), { layer: "text-boxes", text: lines.join("\n"), rotation: ang, ...tb }));
  };
  if (showLabels) {
    // The max-wind FL label sits UNDER the peak's feathers — but the extremities are
    // never decorated, so skip it when the peak is the start/end (else a label box +
    // gauge would float at the bare tip). The interior FL-change labels below cover it.
    const maxI = pts.indexOf(maxPt);
    if (maxPt && maxPt.speed > 80 && maxI > 0 && maxI < pts.length - 1) flLabel(maxPt, true);
    // FL only at interior FEATHER points where it changes — never at the start/end,
    // nor on a change bar (a `||` means a ±20 KT speed step at constant FL). A point
    // whose FL changed is NOT a change bar (isCBar requires same FL) → it shows
    // feathers and gets its FL label here.
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1 || p === maxPt) return; // ends + max handled above
      if (isCBar(i)) return; // change bar → no FL
      if (num(p.fl) !== num(pts[i - 1]!.fl)) flLabel(p, false); // FL change (incl. an 80\\ point)
    });
  }

  return out;
};

const overFL = (m: Metadata): boolean => num(m["speed"]) >= 120;

export const jetStream: PhenomenonDef = {
  type: "jetStream",
  label: "Jet stream",
  // Toolbar glyph: a CURVED jet axis (arrow + a few feathers on the low-pressure
  // side) with FL300 below — the iconic sweeping jet stream.
  icon:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 17 Q11.5 16.5 16.5 8"/>' + // curved axis
    '<path d="M18.5 4.6 L18.2 9 L14.8 7 Z" fill="currentColor" stroke="none"/>' + // fine triangle tip, aligned to the curve's end tangent
    '<path d="M5.5 16.5 L7.4 16.1 L2.8 13 Z" fill="currentColor" stroke="none"/>' + // 50-kt pennant, swept BACK toward the tail
    '<path d="M9 15.6 L5 12.8" stroke-width="1.3"/>' + // full barbs, parallel, leaning back (up-left)
    '<path d="M11.2 14.4 L7.2 11.6" stroke-width="1.3"/>' +
    '<text x="14.5" y="20" font-size="5.3" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" transform="rotate(-25 14.5 20)">FL300</text>' +
    "</svg>",
  primitives: ["polyline"],
  draw: {
    minVertices: 2,
    interaction: { primitive: "polyline", smooth: true, directional: true, freehand: true, mode: "draw" },
  },
  schema: [
    {
      type: "list",
      key: "points",
      label: "Break points",
      itemLabel: (it, i) => `#${i + 1} · ${Math.round(num(it["speed"]))}KT`,
      // Default = start / centre / end all at the 80 KT floor → a bare jet with no
      // barbs. The forecaster raises points (radial control) to build the profile.
      default: [
        { t: 0, speed: 80, fl: 300 },
        { t: 0.5, speed: 80, fl: 300 },
        { t: 1, speed: 80, fl: 300 },
      ],
      itemSchema: [
        { type: "number", key: "speed", label: "Speed", unit: "kt", min: 80, max: 250, step: 5, default: 100 },
        { type: "fl", key: "fl", label: "Flight level", default: 300, min: FL_MIN, max: FL_MAX },
        { type: "fl", key: "top", label: "Extent top", default: 340, min: FL_MIN, max: FL_MAX, visibleWhen: overFL },
        { type: "fl", key: "base", label: "Extent base", default: 260, min: FL_MIN, max: FL_MAX, visibleWhen: overFL },
      ],
    },
  ],
  decorate,
  // A jet is just an arrow (axis + feathers + pennants + arrowhead) and FL text.
  style: {
    color: "#1f2328",
    arrow: { color: "#1f2328", width: 3 },
    text: { color: "#1f2328", halo: "#ffffff", size: 13 },
  },
  summary: (m) => {
    const ps = breaks(m);
    const mx = ps.length ? Math.max(...ps.map((p) => p.speed)) : 0;
    return `Jet max ${Math.round(mx)}KT`;
  },
};
