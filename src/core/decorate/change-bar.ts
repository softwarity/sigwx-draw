/**
 * Change bars — two thin parallel lines perpendicular to the jet core, marking a
 * ±20 KT wind-speed change (where there's no room for feathers) or a ±3000 ft
 * height change (WAFC guide §3.5.8).
 */
import type { RenderFeature, RenderProps } from "../phenomenon.js";
import { lineFeature } from "./feature.js";
import { add, perpLeft, scale, toLonLat, unit } from "./geo.js";
import type { Pt } from "./geo.js";

export interface ChangeBarOptions {
  /** Point on the jet (planar). */
  point: Pt;
  /** Travel direction at the point (planar). */
  tangent: Pt;
  /** Planar frame cos(lat₀). */
  k: number;
  /** Tick length (perpendicular), planar degrees. */
  length: number;
  /** Spacing between the two parallel ticks (along the axis), planar degrees. */
  gap: number;
  props: RenderProps;
}

export function changeBarFeatures(opts: ChangeBarOptions): RenderFeature[] {
  const along = unit(opts.tangent);
  const perp = perpLeft(along);
  const ll = (p: Pt) => toLonLat(p, opts.k);
  return [-opts.gap / 2, opts.gap / 2].map((off) => {
    const base = add(opts.point, scale(along, off));
    const a = add(base, scale(perp, opts.length / 2));
    const b = add(base, scale(perp, -opts.length / 2));
    return lineFeature([ll(a), ll(b)], opts.props);
  });
}
