/** Shared helpers for the built-in phenomenon defs. */
import type { Geometry, Position } from "geojson";

import type { LatLng } from "../coord.js";
import type { PhenomenonStyle } from "../style.js";

export const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
export const fl = (v: unknown): string => `FL${String(Math.round(num(v))).padStart(3, "0")}`;

/** Average of a coordinate ring/line — a cheap label anchor. */
export function centroid(coords: Position[]): Position {
  if (!coords.length) return [0, 0];
  let x = 0;
  let y = 0;
  for (const c of coords) {
    x += c[0]!;
    y += c[1]!;
  }
  return [x / coords.length, y / coords.length];
}

/**
 * Area-weighted polygon centroid (shoelace) — the TRUE geometric centre of a
 * ring, robust to uneven vertex spacing (unlike {@link centroid}, the vertex
 * mean, which a freehand outline's clustered points skew badly). Drops a closing
 * duplicate vertex; falls back to the mean for a degenerate (zero-area) ring.
 */
export function ringCentroid(ring: Position[]): Position {
  const closed =
    ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const n = pts.length;
  if (n < 3) return centroid(ring);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % n]!;
    const f = x0! * y1! - x1! * y0!;
    a += f;
    cx += (x0! + x1!) * f;
    cy += (y0! + y1!) * f;
  }
  if (Math.abs(a) < 1e-9) return centroid(ring);
  return [cx / (3 * a), cy / (3 * a)];
}

/** Concrete text-box paint props from a phenomenon style. */
export function textBoxProps(style: PhenomenonStyle): {
  textColor: string;
  textSize: number;
  textHalo: string;
  textBackground: string;
  textBorder: string;
} {
  return {
    textColor: style.text?.color ?? "#111111",
    textSize: style.text?.size ?? 13,
    textHalo: style.text?.halo ?? "#ffffff",
    textBackground: style.text?.background ?? "#ffffff",
    textBorder: style.color, // leader/box ink — decorates override with the resolved ink
  };
}

/** A regular polygon (closed ring) of `n` points around a centre. */
export function regularPolygon(c: LatLng, span: number, n = 5): Geometry {
  const rx = span * 0.18;
  const ry = span * 0.18;
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    ring.push([c.lon + rx * Math.cos(ang), c.lat + ry * Math.sin(ang)]);
  }
  ring.push(ring[0]!); // close
  return { type: "Polygon", coordinates: [ring] };
}
