/**
 * `jet-barbs` — THE flagship named decorator extension (the only code an entire
 * WAFS chart still needs): the jet stream's fully derived rendering per WAFC
 * guide §3.5. Smoothed axis, arrow at the downstream end (`declutter: "late"` —
 * it carries the DIRECTION), wind-barb clusters per break point (feather side
 * from the hemisphere), change bars (`||` = a ±20 KT step at constant FL, fig 11),
 * FL call-outs at the max-wind point (+ vertical extent ≥ `depthAt`, fig 9) and
 * at every FL change.
 *
 * Registered as a built-in through the SAME mechanism a host would use:
 * `registerExtensions({ decorators: { "jet-barbs": jetBarbs } })` — done EXPLICITLY
 * by the jet descriptor module (never via a bare side-effect import: the package is
 * `sideEffects: false`, a bundler may drop those). A descriptor mounts it with
 * `"decorations": [{ "use": "jet-barbs", "listField": "points", "floor": 80,
 * "depthAt": 120 }]`.
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
import type { DecorationInput, Metadata, RenderFeature } from "../phenomenon.js";
import { fl, num, textBoxProps } from "../phenomena/util.js";

interface Break {
  t: number;
  speed: number;
  fl: number;
  top: number | undefined;
  base: number | undefined;
}

/** The break-point list, `t`-sorted. Exported for the summary path. */
export function jetBreaks(metadata: Metadata, listField = "points"): Break[] {
  const raw = (metadata[listField] as Metadata[] | undefined) ?? [];
  return raw
    .map((p) => ({ t: num(p["t"]), speed: num(p["speed"]), fl: num(p["fl"]), top: p["top"] as number | undefined, base: p["base"] as number | undefined }))
    .sort((a, b) => a.t - b.t);
}

export function jetBarbs(input: DecorationInput, params: Record<string, unknown>): RenderFeature[] {
  const { geometry, metadata, style, resolution } = input;
  const listField = typeof params["listField"] === "string" ? params["listField"] : "points";
  const floor = num(params["floor"], 80); // jets below the depiction floor are not drawn
  const depthAt = num(params["depthAt"], 120); // vertical extent shows from here (fig 9)
  const changeBarStep = num(params["changeBarStep"], 20); // KT speed step that draws a `||` (WAFC fig 11)
  const extentSeed = num(params["extentSeed"], 40); // FL half-window seeded around the wind point until set
  // Chart FL clamp for the extent seeds (profile-resolved; WAFS fallback map-free).
  const flMin = num(input.flightLevel?.min, 250);
  const flMax = num(input.flightLevel?.max, 600);

  const coords = coordsOf(geometry);
  if (coords.length < 2) return [];
  const pts = jetBreaks(metadata, listField);
  if (!pts.length) return [];
  const maxSpeed = Math.max(...pts.map((p) => p.speed));
  if (maxSpeed < floor) return [];

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

  // Arrow at the downstream end (start when reversed). A constant ≈16 px SCREEN glyph (like the barbs'
  // `featherLen`), capped to a fraction of the line so it scales down on a short jet and never outgrows
  // it. The old `total * 0.035` scaled with the jet's LENGTH → a long jet grew a giant arrowhead.
  const arrowSize = Math.min(px * 16, total * 0.3);
  if (showArrow) {
    const n = planar.length;
    const tip = reversed ? planar[0]! : planar[n - 1]!;
    const dir = reversed ? sub(planar[0]!, planar[1]!) : sub(planar[n - 1]!, planar[n - 2]!);
    // `declutter:"late"`: the arrowhead carries the jet's DIRECTION — zoomed out it outlives
    // the barbs/labels (hides only at half the declutter threshold).
    out.push(arrowheadFeature(tip, dir, k, arrowSize, { layer: "decoration", stroke, strokeWidth: 1, fillColor: stroke, declutter: "late", obstacle: true }));
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
  // Only points that actually draw feathers (>floor) count toward the footprint cap;
  // the floor points draw nothing, so they mustn't shrink the barbs.
  const footprint = pts.reduce((s, p) => s + (p.speed > floor ? clusterUnit(p.speed) : 0), 0) || 1;
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
  //  - speed at the floor → nothing (clean baseline);
  //  - a strictly monotonic transition whose step from the previous point is
  //    EXACTLY ±20 KT → a change bar (two parallel ticks; a change bar means ±20);
  //  - otherwise (extremum, endpoint, or a non-±20 step), >floor → full feathers
  //    decoding the absolute speed.
  // The max-wind point ALWAYS shows feathers (it decodes the peak speed and carries
  // the FL label) — never a change bar, even on a tie/plateau (first of the ties).
  const maxPt = pts.reduce((m, p) => (p.speed > m.speed ? p : m), pts[0]!);
  // A change bar (`||`, meaning a ±20 KT step) sits at a point whose step FROM THE
  // PREVIOUS point is exactly ±20, where the trend does NOT reverse (a peak/valley
  // shows feathers), and whose FL is UNCHANGED from the previous (a FL change needs
  // feathers + a FL label, not a bar). It MAY sit at the floor (e.g. a −20 step
  // down to it). Everything else >floor draws feathers; the bare floor draws nothing.
  const isCBar = (i: number): boolean => {
    const p = pts[i]!;
    if (p === maxPt) return false; // the peak/plateau-top is feathers + FL, not a bar
    const pv = i > 0 ? pts[i - 1]! : null;
    const nx = i < pts.length - 1 ? pts[i + 1]! : null;
    if (!pv || !nx) return false; // need both neighbours; ends/last → feathers
    if (Math.abs(p.speed - pv.speed) !== changeBarStep) return false; // exactly ±changeBarStep KT
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
    // The floor draws nothing — UNLESS its FL differs from the previous point:
    // a FL change must be shown (floor feathers + its FL label), not a bare baseline.
    const flChange = i > 0 && num(p.fl) !== num(pts[i - 1]!.fl);
    if (p.speed <= floor && !flChange) return;
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
        props: { layer: "decoration", stroke, fillColor: stroke, obstacle: true },
      }),
    );
  });

  // FL call-outs (WAFC §3.5.5 "at points along its length"): a plain "FLxxx" at
  // the max-wind point (+ vertical extent "lower/upper" when ≥ depthAt, fig 9) AND
  // at every point where the FL CHANGES. Constant FL → one label (at the max,
  // fig 11); varying FL → one per change. Attached below the line, rotated, no leader.
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
    const lines = [fl(p.fl)];
    if (withExtent && p.speed >= depthAt) {
      // Show the vertical extent ≥ depthAt; default to fl ± extentSeed until the gauge sets it.
      const top = p.top != null ? p.top : Math.min(flMax, num(p.fl) + extentSeed);
      const base = p.base != null ? p.base : Math.max(flMin, num(p.fl) - extentSeed);
      lines.push(`${flNum(Math.min(top, base))}/${flNum(Math.max(top, base))}`); // lower/upper
    }
    // Push the label clear of the FEATHER reach (featherLen) AND its own (fixed screen-size) half-height
    // + a gap, on its side. The label can land on the feather side (it flips with hemisphere), so it must
    // clear both the line AND the barbs — never just the line. The label terms are screen px (× px) so
    // they don't shrink on zoom-out (when featherLen does) — no creeping onto the line/barbs at any zoom.
    const labelHalfPx = lines.length * tbp.textSize * 0.65;
    const anchor = add(st.p, scale(perpLeft(flow), -sideSign * (featherLen + (labelHalfPx + 5) * px)));
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
    if (maxPt && maxPt.speed > floor && maxI > 0 && maxI < pts.length - 1) flLabel(maxPt, true);
    // FL only at interior FEATHER points where it changes — never at the start/end,
    // nor on a change bar (a `||` means a ±20 KT speed step at constant FL). A point
    // whose FL changed is NOT a change bar (isCBar requires same FL) → it shows
    // feathers and gets its FL label here.
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1 || p === maxPt) return; // ends + max handled above
      if (isCBar(i)) return; // change bar → no FL
      if (num(p.fl) !== num(pts[i - 1]!.fl)) flLabel(p, false); // FL change (incl. a floor point)
    });
  }

  return out;
}
