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
  anchor: LatLng;
  content: string;
  leader: boolean;
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
  const placedRects: Rect[] = [];

  // Pinned boxes first so they act as obstacles for the auto-placed ones.
  const ordered = [...reqs].sort((a, b) => Number(pins.has(key(b))) - Number(pins.has(key(a))));

  for (const req of ordered) {
    const anchorPx = proj.project(req.anchor);
    if (!anchorPx) continue;
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
          const d = gap + halfAlong;
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

    // Leader: only when the box doesn't sit on top of its anchor.
    if (req.leader && !contains(rect, anchorPx[0], anchorPx[1])) {
      leaders.push({
        type: "Feature",
        properties: { layer: "leaders", featureId: req.featureId, stroke: req.textBorder, strokeWidth: 1 },
        geometry: { type: "LineString", coordinates: [[req.anchor.lon, req.anchor.lat], [centerLL.lon, centerLL.lat]] },
      });
    }
  }
  return { boxes, leaders };
}
