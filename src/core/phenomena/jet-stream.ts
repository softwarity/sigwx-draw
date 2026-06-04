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
  const stroke = style.decoration?.color ?? style.color;
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
  out.push(lineFeature(dense, { layer: "edge", stroke: style.edge?.color ?? style.color, strokeWidth: style.edge?.width ?? 3 }));

  // Arrow at the downstream end (start when reversed).
  const arrowSize = Math.max(0.035, total * 0.035);
  if (showArrow) {
    const n = planar.length;
    const tip = reversed ? planar[0]! : planar[n - 1]!;
    const dir = reversed ? sub(planar[0]!, planar[1]!) : sub(planar[n - 1]!, planar[n - 2]!);
    out.push(arrowheadFeature(tip, dir, k, arrowSize, { layer: "decoration", stroke, strokeWidth: 1, fillColor: stroke }));
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

  // Per WAFC fig 11 (§3.5.8): a point's depiction follows the speed PROFILE.
  //  - speed 80 (the floor) → nothing (clean baseline);
  //  - a strictly monotonic transition whose step from the previous point is
  //    EXACTLY ±20 KT → a change bar (two parallel ticks; a change bar means ±20);
  //  - otherwise (extremum, endpoint, or a non-±20 step), >80 → full feathers
  //    decoding the absolute speed.
  if (showBarbs) pts.forEach((p, i) => {
    if (p.speed <= 80) return;
    const st = pointAtFraction(planar, p.t);
    const prev = i > 0 ? pts[i - 1]!.speed : null;
    const next = i < pts.length - 1 ? pts[i + 1]!.speed : null;
    const monotonic = prev != null && next != null && ((prev < p.speed && p.speed < next) || (prev > p.speed && p.speed > next));
    const isChangeBar = monotonic && prev != null && Math.abs(p.speed - prev) === 20;
    if (isChangeBar) {
      out.push(...changeBarFeatures({ point: st.p, tangent: st.dir, k, length: cbLength, gap: cbGap, props: { layer: "decoration", stroke, strokeWidth: 3 } }));
    } else {
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
    }
  });

  // FL call-outs (WAFC §3.5.5 "at points along its length"): a boxed "FLxxx" at
  // the max-wind point (+ vertical extent "lower/upper" when ≥120, fig 9) AND at
  // every point where the FL CHANGES. Constant FL → one label (at the max, fig 11);
  // varying FL → one per change. Attached below the line, rotated, no leader.
  const flNum = (v: number | undefined): string => String(Math.round(num(v))).padStart(3, "0");
  const tb = textBoxProps(style);
  const flLabel = (p: Break, withExtent: boolean): void => {
    // Anchor under the MIDDLE of the barb cluster (the point sits at one end of it),
    // a touch below the line.
    const flowSign = reversed ? -1 : 1;
    const half = clusterUnit(p.speed) * featherLen * 0.5;
    const centerArc = Math.max(0, Math.min(total, p.t * total + flowSign * half));
    const st = pointAtFraction(planar, centerArc / total);
    const flow = scale(st.dir, flowSign);
    const sideSign = featherSide(toLonLat(st.p, k)[1]);
    const anchor = add(st.p, scale(perpLeft(flow), -sideSign * featherLen * 0.6));
    const lines = [fl(p.fl)];
    if (withExtent && p.speed >= 120) {
      // Show the vertical extent ≥120; default to fl ± 40 until the gauge sets it.
      const top = p.top != null ? p.top : Math.min(630, num(p.fl) + 40);
      const base = p.base != null ? p.base : Math.max(0, num(p.fl) - 40);
      lines.push(`${flNum(Math.min(top, base))}/${flNum(Math.max(top, base))}`); // lower/upper
    }
    let ang = (Math.atan2(-flow[1], flow[0]) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    else if (ang < -90) ang += 180;
    out.push(pointFeature(toLonLat(anchor, k), { layer: "text-boxes", text: lines.join("\n"), rotation: ang, ...tb }));
  };
  const maxPt = pts.reduce((m, p) => (p.speed > m.speed ? p : m), pts[0]!);
  if (showLabels) {
    if (maxPt && maxPt.speed > 80) flLabel(maxPt, true);
    // FL only at interior FEATHER points (extrema) where it changes — never at the
    // start/end, nor on a change bar (a `||` means a ±20 KT speed step, not a FL).
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1 || p === maxPt || p.speed <= 80) return;
      const prev = pts[i - 1]!.speed;
      const next = pts[i + 1]!.speed;
      const monotonic = (prev < p.speed && p.speed < next) || (prev > p.speed && p.speed > next);
      if (monotonic && Math.abs(p.speed - prev) === 20) return; // change bar → no FL
      if (num(p.fl) !== num(pts[i - 1]!.fl)) flLabel(p, false);
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
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2.5 16 Q12 16 18 8"/>' +
    '<path d="M18 8 L13.8 7.6 M18 8 L16.4 12"/>' +
    '<line x1="5.2" y1="16" x2="3.6" y2="11" stroke-width="1.8"/>' +
    '<line x1="7.6" y1="15.6" x2="6" y2="10.6" stroke-width="1.8"/>' +
    '<line x1="9.8" y1="14" x2="8.4" y2="9.4" stroke-width="1.8"/>' +
    '<text x="12" y="22.2" font-size="6.2" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">FL300</text>' +
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
        { type: "fl", key: "fl", label: "Flight level", default: 300 },
        { type: "fl", key: "top", label: "Extent top", default: 340, visibleWhen: overFL },
        { type: "fl", key: "base", label: "Extent base", default: 260, visibleWhen: overFL },
      ],
    },
  ],
  decorate,
  style: {
    color: "#1f2328",
    edge: { color: "#1f2328", width: 3 },
    decoration: { color: "#1f2328", width: 2 },
    textBox: { color: "#1f2328", size: 13, haloColor: "#ffffff", haloWidth: 2, background: "#ffffff", border: "#1f2328" },
  },
  summary: (m) => {
    const ps = breaks(m);
    const mx = ps.length ? Math.max(...ps.map((p) => p.speed)) : 0;
    return `Jet max ${Math.round(mx)}KT`;
  },
};
