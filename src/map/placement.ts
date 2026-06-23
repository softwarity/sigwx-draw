/**
 * Call-out box placement with greedy screen-space anti-collision.
 *
 * Decorate functions emit annotation *requests* (anchor + content). This pass —
 * run by the controller after collecting every feature's requests — projects the
 * anchors to pixels, estimates each box's size, and slots each box at the first
 * candidate offset that doesn't overlap an already-placed box. Manually pinned
 * boxes keep their offset and act as obstacles. It then un-projects the chosen
 * centre back to lon/lat and emits the box (`text-boxes`) plus a leader line
 * (`leaders`) to its anchor. Re-run on pan/zoom (it's screen-space).
 */
import type { LatLng, RenderFeature, RenderProps } from "../core/index.js";

export interface Projector {
  project(p: LatLng): [number, number] | null;
  unproject(px: [number, number]): LatLng | null;
}

export interface AnnReq {
  featureId: string;
  labelId: string;
  /** Box placement reference (the zone centroid) — also the pin origin, so the box is stable. */
  anchor: LatLng;
  /** Where the leader/arrow POINTS (user-movable tip inside the zone); defaults to `anchor`. */
  arrowAnchor?: LatLng;
  /** Multi-area phenomenon (CB MultiPolygon): ONE leader/arrow per entry, all from the same
   *  box. Takes precedence over `arrowAnchor` when set. */
  arrowAnchors?: LatLng[];
  content: string;
  leader: boolean;
  /** Draw an arrowhead at the anchor end of the leader (call-out pointing to a zone). */
  arrow?: boolean;
  /** "lightning" → a zigzag bolt leader attaching UNDER the box (convective/CB). */
  leaderStyle?: string;
  /** Keep the box at least this many px from the anchor (clears an area's extent). */
  avoidRadius?: number;
  /** Optional sprite glyph shown just above the box (e.g. the turbulence severity). */
  symbol?: string;
  symbolColor?: string;
  symbolSize?: number;
  /** Place the glyph INSIDE the box top (icing) instead of above it. The content must reserve
   *  leading blank lines for it. */
  symbolInside?: boolean;
  textColor: string;
  textSize: number;
  textHalo: string;
  textBackground?: string;
  textBorder: string;
}

export interface Pin {
  dx: number;
  dy: number;
}

export interface Placed {
  boxes: RenderFeature[];
  leaders: RenderFeature[];
  symbols: RenderFeature[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DIRS: [number, number][] = [
  [1, 0], [1, -1], [1, 1], [0, -1],
  [0, 1], [-1, 1], [-1, -1], [-1, 0],
];
/** Gap (px) between the anchor and the box's near edge; escalates on collision. */
const GAPS = [16, 34, 58, 92];
/** Minimum VISIBLE leader length (px) past the box-end padding; shorter → hide it. */
const LEADER_STUB = 12;

export function estimateBox(content: string, size: number): { w: number; h: number } {
  const lines = content.split("\n");
  const maxChars = Math.max(1, ...lines.map((l) => l.length));
  return { w: maxChars * size * 0.6 + 8, h: lines.length * size * 1.3 + 6 };
}

/** Area (px²) of the intersection of two rects — 0 when they don't overlap. */
function overlapArea(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > 0 && dy > 0 ? dx * dy : 0;
}

/** Bump a box CENTRE `c` (size `w`×`h`, px) OUT of `obstacles`: if it overlaps any, ring-search
 *  outward (8 dirs × growing radius) for the nearest FREE centre; if none is free, the
 *  least-overlapping. No overlap ⇒ `c` returned unchanged. Used to make a just-DROPPED cartouche
 *  yield so it never covers a fixed element (a point marker, or another pinned cartouche). */
export function nudgeClear(c: [number, number], w: number, h: number, obstacles: Rect[]): [number, number] {
  const ov = (p: [number, number]): number => {
    const r: Rect = { x: p[0] - w / 2, y: p[1] - h / 2, w, h };
    return obstacles.reduce((s, o) => s + overlapArea(r, o), 0);
  };
  if (ov(c) === 0) return c;
  let best = c;
  let bestOv = ov(c);
  for (const rad of [14, 30, 50, 74, 102, 140]) {
    for (const [ux, uy] of DIRS) {
      const p: [number, number] = [c[0] + ux * rad, c[1] + uy * rad];
      const o = ov(p);
      if (o === 0) return p;
      if (o < bestOv) { bestOv = o; best = p; }
    }
  }
  return best;
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

const key = (a: AnnReq): string => `${a.featureId}:${a.labelId}`;

/** A lightning-bolt (⚡, a "Z") polyline from `a` to `b` (planar px) — the CB convective leader.
 *  THREE segments: forward along the axis to mid-way, then a diagonal that BACKTRACKS by ~1/12 of
 *  the length to the LEFT (a square "Z" kink), then forward again to the tip. Returns lon/lat. */
function lightningPath(a: [number, number], b: [number, number], proj: Projector): [number, number][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const lx = uy; // LEFT perpendicular of the a→b travel (screen y-down)
  const ly = -ux;
  // Kink size: proportional on a short leader (so the "Z" stays readable) but CAPPED in px —
  // like the fixed-size arrowhead — else a long leader grows a huge, inelegant zigzag.
  const k = Math.min(len / 12, 14);
  const mx = a[0] + dx * 0.5; // mid-way
  const my = a[1] + dy * 0.5;
  const h = k / 2;
  // P1 forward-right of mid, P2 back-left of mid → the diagonal P1→P2 goes back + left.
  const P1: [number, number] = [mx + (ux - lx) * h, my + (uy - ly) * h];
  const P2: [number, number] = [mx - (ux - lx) * h, my - (uy - ly) * h];
  const out: [number, number][] = [];
  for (const q of [a, P1, P2, b] as [number, number][]) {
    const ll = proj.unproject(q);
    if (ll) out.push([ll.lon, ll.lat]);
  }
  return out;
}

/** Inflate a rect by `p` px on every side — the anti-collision breathing-room (a small badge then
 *  keeps a margin from any card instead of touching it). `p = 0` ⇒ unchanged. */
function inflate(r: Rect, p: number): Rect {
  return p ? { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p } : r;
}
/** Clamp a box CENTRE so its `w`×`h` rect stays fully inside `frame` (centre it when it's larger). */
function clampBoxInside(c: [number, number], w: number, h: number, frame: Rect): [number, number] {
  const loX = frame.x + w / 2, hiX = frame.x + frame.w - w / 2;
  const loY = frame.y + h / 2, hiY = frame.y + frame.h - h / 2;
  return [loX > hiX ? frame.x + frame.w / 2 : Math.max(loX, Math.min(hiX, c[0])),
          loY > hiY ? frame.y + frame.h / 2 : Math.max(loY, Math.min(hiY, c[1]))];
}
/** Clamp a POINT inside `frame` — keeps a leader tip from leaving the chart area. */
function clampPtInside(p: [number, number], frame: Rect): [number, number] {
  return [Math.max(frame.x, Math.min(frame.x + frame.w, p[0])), Math.max(frame.y, Math.min(frame.y + frame.h, p[1]))];
}
/** Half-size (px) of the keep-clear guard around a protected leader tip (no OTHER box may cover it). */
const TIP_GUARD = 11;

/** `obstacles` = FIXED rects (screen px) that auto-placed call-outs must AVOID but which are never
 *  themselves placed/moved — e.g. point markers (volcano/TC/radioactive) that own their spot.
 *  `activeFid` = the call-out being ACTIVELY dragged: it holds its pin (follows the cursor) and is
 *  placed FIRST, so every OTHER call-out — even a previously-pinned one — yields/flees it. */
export function placeAnnotations(reqs: AnnReq[], proj: Projector, pins: Map<string, Pin>, obstacles: Rect[] = [], activeFid?: string, frame?: Rect, pad = 0): Placed {
  const boxes: RenderFeature[] = [];
  const leaders: RenderFeature[] = [];
  const symbols: RenderFeature[] = [];
  // Fixed obstacles are seeded INFLATED so boxes keep a `pad` margin off them (small badges included).
  const placedRects: Rect[] = obstacles.map((o) => inflate(o, pad));

  // Project + (frame-)clamp every leader tip ONCE: reused to (a) PROTECT each tip — a padded guard rect
  // every OTHER feature's box must clear — and (b) draw the leader to the (clamped) tip.
  const tipPx = new Map<string, [number, number][]>();
  const guards: { r: Rect; fid: string }[] = [];
  for (const req of reqs) {
    const arrows = req.arrowAnchors?.length ? req.arrowAnchors : [req.arrowAnchor ?? req.anchor];
    const pts: [number, number][] = [];
    for (const a of arrows) {
      let px = proj.project(a);
      if (!px) continue;
      if (frame) px = clampPtInside(px, frame);
      pts.push(px);
      guards.push({ r: inflate({ x: px[0] - TIP_GUARD, y: px[1] - TIP_GUARD, w: 2 * TIP_GUARD, h: 2 * TIP_GUARD }, pad), fid: req.featureId });
    }
    tipPx.set(key(req), pts);
  }

  // PRIORITY order so lower-priority boxes yield: the actively-dragged call-out first (it owns the
  // cursor), then the other pinned ones, then the auto-placed. A pin is otherwise just a PREFERENCE.
  const rank = (req: AnnReq): number => (activeFid != null && req.featureId === activeFid ? 2 : pins.has(key(req)) ? 1 : 0);
  const ordered = [...reqs].sort((a, b) => rank(b) - rank(a));

  for (const req of ordered) {
    const anchorPx = proj.project(req.anchor);
    if (!anchorPx) continue;
    // Box places from `anchor` (centroid, stable); the leader(s)/arrow(s) aim at the precomputed
    // (frame-clamped) tips — ONE per area for a multi-area phenomenon (CB MultiPolygon).
    const { w, h } = estimateBox(req.content, req.textSize);
    const k = key(req);
    const myTips = tipPx.get(k) ?? [];
    const pin = pins.get(k);
    const isActive = activeFid != null && req.featureId === activeFid;
    // What THIS box must clear: every placed rect + every OTHER feature's protected tip guard (its OWN
    // tips are exempt — a card may sit over its own arrow tip). Candidates are clamped INSIDE the frame.
    const avoid = guards.length ? [...placedRects, ...guards.filter((g) => g.fid !== req.featureId).map((g) => g.r)] : placedRects;
    const clampC = (c: [number, number]): [number, number] => (frame ? clampBoxInside(c, w, h, frame) : c);
    const ovAt = (c: [number, number]): number => { const r: Rect = { x: c[0] - w / 2, y: c[1] - h / 2, w, h }; return avoid.reduce((s, o) => s + overlapArea(r, o), 0); };

    // A pinned box keeps its spot ONLY if (frame-clamped and) free — or if it's the actively-dragged
    // one; else it YIELDS (searches a new slot). This lets a dragged card push pinned cards away.
    const pinC = pin ? clampC([anchorPx[0] + pin.dx, anchorPx[1] + pin.dy]) : null;
    const pinFree = pinC != null && ovAt(pinC) === 0;

    let cx = 0;
    let cy = 0;
    if (pinC && (isActive || pinFree)) {
      [cx, cy] = pinC;
    } else {
      // Push the box out beside the anchor (visible leader), escalating the gap until a slot is FREE of
      // every obstacle. Each candidate is clamped INSIDE the frame first. If none is free, fall back to
      // the LEAST-overlapping (still in-frame) candidate so boxes spread out instead of stacking.
      let best: [number, number] | null = null;
      let least: [number, number] = clampC([anchorPx[0] + GAPS[0]! + w / 2, anchorPx[1]]);
      let leastOv = Infinity;
      outer: for (const gap of GAPS) {
        for (const [ux, uy] of DIRS) {
          const halfAlong = Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
          const d = (req.avoidRadius ?? 0) + gap + halfAlong;
          const c = clampC([anchorPx[0] + ux * d, anchorPx[1] + uy * d]);
          const ov = ovAt(c);
          if (ov === 0) { best = c; break outer; }
          if (ov < leastOv) { leastOv = ov; least = c; }
        }
      }
      [cx, cy] = best ?? least;
      // A pinned card that had to YIELD updates its pin so it PERSISTS (order-independent result).
      if (pin && !isActive) pins.set(k, { dx: cx - anchorPx[0], dy: cy - anchorPx[1] });
    }

    const rect: Rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    placedRects.push(inflate(rect, pad)); // padded so later boxes keep their distance
    const centerLL = proj.unproject([cx, cy]);
    if (!centerLL) continue;

    const props: RenderProps = {
      layer: "text-boxes",
      featureId: req.featureId,
      labelId: req.labelId,
      text: req.content,
      textColor: req.textColor,
      textSize: req.textSize,
      textHalo: req.textHalo,
      // A BOXED call-out (CB/icing) sets `textBackground`; its border (`textBorder`) goes on the
      // box too. An UNBOXED call-out (turbulence: `textBorder` is only the leader/arrow/glyph ink,
      // no background) must NOT draw a box — and draw-adapter 0.2.8+ boxes a border-only label, so
      // we forward `textBorder` to the box ONLY alongside a background. The leader below still
      // reads `req.textBorder` for its ink, so it stays coloured either way.
      ...(req.textBackground !== undefined ? { textBackground: req.textBackground, textBorder: req.textBorder } : {}),
    };
    boxes.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [centerLL.lon, centerLL.lat] } });

    // Severity (or other) glyph: just ABOVE the box (turbulence), or INSIDE its top half
    // (icing — the content reserves leading blank lines for it).
    if (req.symbol) {
      const symLL = proj.unproject([cx, req.symbolInside ? cy - h / 4 : cy - h / 2 - 12]);
      if (symLL) {
        symbols.push({
          type: "Feature",
          // A glyph INSIDE the box is a touch smaller so it keeps a margin off the box top
          // (OL/Leaflet box padding is tighter than MapLibre's, where it would otherwise touch).
          properties: { layer: "symbols", featureId: req.featureId, labelId: req.labelId, symbol: req.symbol, size: req.symbolSize ?? (req.symbolInside ? 0.82 : 1.1), symbolColor: req.symbolColor ?? req.textBorder },
          geometry: { type: "Point", coordinates: [symLL.lon, symLL.lat] },
        });
      }
    }

    // Leader: attach at the TOP-centre of the box (just above the first text line, by the
    // glyph), then PAD the box end toward the anchor so the line starts clear of the
    // symbol/text instead of under them. Hidden when too short to show past that padding
    // (box sits on/at the anchor → the symbol is right on the tip).
    // A "lightning" leader (CB) attaches at the box CENTRE (≈ just under the "CB" line) and
    // zigzags; the default attaches at the top-centre (by the glyph) in a straight line.
    const bolt = req.leaderStyle === "lightning";
    // A glyph ABOVE the box (turbulence) → attach the leader at the box TOP. Otherwise (CB's
    // boxed text, or icing's glyph INSIDE the box) → attach at the CENTRE. Lightning + straight obey this.
    const topGlyph = !!req.symbol && !req.symbolInside;
    const calloutPx: [number, number] = [cx, topGlyph ? cy - h / 2 : cy];
    // The call-out's occupied zone = the box PLUS the glyph band above it (only when the glyph
    // sits ABOVE). Hide a leader + arrow whose arrow anchor falls under that zone.
    const occupied: Rect = topGlyph ? { x: rect.x, y: rect.y - 22, w: rect.w, h: rect.h + 22 } : rect;
    for (const arrowPx of myTips) {
      const arrowLL = proj.unproject(arrowPx);
      if (!arrowLL) continue;
      const leaderLen = Math.hypot(arrowPx[0] - calloutPx[0], arrowPx[1] - calloutPx[1]) || 1;
      const ux = (arrowPx[0] - calloutPx[0]) / leaderLen;
      const uy = (arrowPx[1] - calloutPx[1]) / leaderLen;
      // Base gap (px), plus the glyph's vertical extent when the leader heads UP toward it
      // (the symbol sits above the box, so only an upward leader runs through it).
      const leadPad = topGlyph ? 8 + 18 * Math.max(0, -uy) : 6;
      if (req.leader && !contains(occupied, arrowPx[0], arrowPx[1]) && leaderLen >= leadPad + LEADER_STUB) {
        const startPx: [number, number] = [calloutPx[0] + ux * leadPad, calloutPx[1] + uy * leadPad];
        const startLL = proj.unproject(startPx) ?? centerLL;
        leaders.push({
          type: "Feature",
          properties: { layer: "leaders", featureId: req.featureId, stroke: req.textBorder, strokeWidth: 1 },
          geometry: { type: "LineString", coordinates: bolt ? lightningPath(startPx, arrowPx, proj) : [[arrowLL.lon, arrowLL.lat], [startLL.lon, startLL.lat]] },
        });
        // Arrowhead at the arrow anchor (pointing into the zone), as an open "V".
        if (req.arrow) {
          const L = 9;
          const W = 5;
          const wingA = proj.unproject([arrowPx[0] - L * ux + W * -uy, arrowPx[1] - L * uy + W * ux]);
          const wingB = proj.unproject([arrowPx[0] - L * ux - W * -uy, arrowPx[1] - L * uy - W * ux]);
          if (wingA && wingB) {
            leaders.push({
              type: "Feature",
              properties: { layer: "leaders", featureId: req.featureId, stroke: req.textBorder, strokeWidth: 1.5 },
              geometry: { type: "LineString", coordinates: [[wingA.lon, wingA.lat], [arrowLL.lon, arrowLL.lat], [wingB.lon, wingB.lat]] },
            });
          }
        }
      }
    }
  }
  return { boxes, leaders, symbols };
}
