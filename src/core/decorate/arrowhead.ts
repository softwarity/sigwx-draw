/** Filled triangular arrowhead at a line tip, for the jet-stream direction. */
import type { RenderFeature, RenderProps } from "../phenomenon.js";
import { polygonFeature } from "./feature.js";
import { add, perpLeft, scale, sub, toLonLat, unit } from "./geo.js";
import type { Pt } from "./geo.js";

/**
 * Build a small FILLED arrowhead at `tip` (planar), opening back against `dir`
 * (the unit travel direction, planar). `size` is the wing length in planar
 * degrees. Filled via `props.fillColor`.
 */
export function arrowheadFeature(
  tip: Pt,
  dir: Pt,
  k: number,
  size: number,
  props: RenderProps,
): RenderFeature {
  const u = unit(dir);
  const back = scale(u, -size);
  const perp = perpLeft(u);
  const wingA = add(add(tip, back), scale(perp, size * 0.5));
  const wingB = add(add(tip, back), scale(perp, -size * 0.5));
  const ll = (p: Pt) => toLonLat(p, k);
  return polygonFeature([ll(wingA), ll(tip), ll(wingB), ll(wingA)], props);
}

/** Convenience: arrowhead from the last two coords of a planar polyline. */
export function arrowheadFromEnd(
  planar: Pt[],
  k: number,
  size: number,
  props: RenderProps,
): RenderFeature | null {
  const n = planar.length;
  if (n < 2) return null;
  return arrowheadFeature(planar[n - 1]!, sub(planar[n - 1]!, planar[n - 2]!), k, size, props);
}
