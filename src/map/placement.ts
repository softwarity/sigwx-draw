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
  content: string;
  leader: boolean;
  /** Draw an arrowhead at the anchor end of the leader (call-out pointing to a zone). */
  arrow?: boolean;
  /** Keep the box at least this many px from the anchor (clears an area's extent). */
  avoidRadius?: number;
  /** Optional sprite glyph shown just above the box (e.g. the turbulence severity). */
  symbol?: string;
  symbolColor?: string;
  symbolSize?: number;
  textColor: string;
  textSize: number;
  textHalo: string;
  textBackground: string;
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

interface Rect {
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

function estimateBox(content: string, size: number): { w: number; h: number } {
  const lines = content.split("\n");
  const maxChars = Math.max(1, ...lines.map((l) => l.length));
  return { w: maxChars * size * 0.6 + 8, h: lines.length * size * 1.3 + 6 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

const key = (a: AnnReq): string => `${a.featureId}:${a.labelId}`;

export function placeAnnotations(reqs: AnnReq[], proj: Projector, pins: Map<string, Pin>): Placed {
  const boxes: RenderFeature[] = [];
  const leaders: RenderFeature[] = [];
  const symbols: RenderFeature[] = [];
  const placedRects: Rect[] = [];

  // Pinned boxes first so they act as obstacles for the auto-placed ones.
  const ordered = [...reqs].sort((a, b) => Number(pins.has(key(b))) - Number(pins.has(key(a))));

  for (const req of ordered) {
    const anchorPx = proj.project(req.anchor);
    if (!anchorPx) continue;
    // Box places from `anchor` (centroid, stable); the leader/arrow aims at `arrowAnchor`.
    const arrowLL = req.arrowAnchor ?? req.anchor;
    const arrowPx = proj.project(arrowLL) ?? anchorPx;
    const { w, h } = estimateBox(req.content, req.textSize);
    const pin = pins.get(key(req));

    let cx = 0;
    let cy = 0;
    if (pin) {
      cx = anchorPx[0] + pin.dx;
      cy = anchorPx[1] + pin.dy;
    } else {
      // Push the box out by its own half-size along the candidate direction so
      // it sits BESIDE the anchor (leader visible, no overlap), then escalate the
      // gap until a slot is free of already-placed boxes.
      let best: [number, number] | null = null;
      outer: for (const gap of GAPS) {
        for (const [ux, uy] of DIRS) {
          const halfAlong = Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
          const d = (req.avoidRadius ?? 0) + gap + halfAlong;
          const c: [number, number] = [anchorPx[0] + ux * d, anchorPx[1] + uy * d];
          const rect: Rect = { x: c[0] - w / 2, y: c[1] - h / 2, w, h };
          if (!placedRects.some((r) => overlaps(rect, r))) {
            best = c;
            break outer;
          }
        }
      }
      [cx, cy] = best ?? [anchorPx[0] + GAPS[0]! + w / 2, anchorPx[1]];
    }

    const rect: Rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    placedRects.push(rect);
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
      textBackground: req.textBackground,
      textBorder: req.textBorder,
    };
    boxes.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [centerLL.lon, centerLL.lat] } });

    // Severity (or other) glyph sits just above the box — part of the call-out.
    if (req.symbol) {
      const symLL = proj.unproject([cx, cy - h / 2 - 12]);
      if (symLL) {
        symbols.push({
          type: "Feature",
          properties: { layer: "symbols", featureId: req.featureId, labelId: req.labelId, symbol: req.symbol, size: req.symbolSize ?? 1.1, symbolColor: req.symbolColor ?? req.textBorder },
          geometry: { type: "Point", coordinates: [symLL.lon, symLL.lat] },
        });
      }
    }

    // Leader: attach at the TOP-centre of the box (just above the first text line, by the
    // glyph), then PAD the box end toward the anchor so the line starts clear of the
    // symbol/text instead of under them. Hidden when too short to show past that padding
    // (box sits on/at the anchor → the symbol is right on the tip).
    const calloutPx: [number, number] = [cx, cy - h / 2];
    const leaderLen = Math.hypot(arrowPx[0] - calloutPx[0], arrowPx[1] - calloutPx[1]) || 1;
    const ux = (arrowPx[0] - calloutPx[0]) / leaderLen;
    const uy = (arrowPx[1] - calloutPx[1]) / leaderLen;
    // Base gap (px), plus the glyph's vertical extent when the leader heads UP toward it
    // (the symbol sits above the box, so only an upward leader runs through it).
    const pad = req.symbol ? 8 + 18 * Math.max(0, -uy) : 6;
    // The call-out's occupied zone = the box PLUS the glyph band above it. Hide the
    // leader + arrow when the arrow anchor falls under that zone (symbol over the tip).
    const occupied: Rect = req.symbol ? { x: rect.x, y: rect.y - 22, w: rect.w, h: rect.h + 22 } : rect;
    if (req.leader && !contains(occupied, arrowPx[0], arrowPx[1]) && leaderLen >= pad + LEADER_STUB) {
      const startPx: [number, number] = [calloutPx[0] + ux * pad, calloutPx[1] + uy * pad];
      const startLL = proj.unproject(startPx) ?? centerLL;
      leaders.push({
        type: "Feature",
        properties: { layer: "leaders", featureId: req.featureId, stroke: req.textBorder, strokeWidth: 1 },
        geometry: { type: "LineString", coordinates: [[arrowLL.lon, arrowLL.lat], [startLL.lon, startLL.lat]] },
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
  return { boxes, leaders, symbols };
}
