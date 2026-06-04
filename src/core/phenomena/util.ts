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

/** Concrete text-box paint props from a phenomenon style. */
export function textBoxProps(style: PhenomenonStyle): {
  textColor: string;
  textSize: number;
  textHalo: string;
  textBackground: string;
  textBorder: string;
} {
  return {
    textColor: style.textBox?.color ?? "#111111",
    textSize: style.textBox?.size ?? 13,
    textHalo: style.textBox?.haloColor ?? "#ffffff",
    textBackground: style.textBox?.background ?? "#ffffff",
    textBorder: style.textBox?.border ?? style.color,
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
