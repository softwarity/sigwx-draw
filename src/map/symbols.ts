/**
 * SIGWX symbol-sprite defaults.
 *
 * The recolourable SYMBOL atlas (turbulence MOD/SEV, icing ICE_*, CB-coverage glyphs) is NO
 * LONGER baked here as inline SVG: the art lives in the `svgs/` bank and each profile references
 * it by code in its `sprites` section (`"MOD": "wmo/turbulence/turb-mod.svg"`), which the build
 * inlines into the dist profile and `SigwxDraw` registers per profile. A chart therefore ships
 * ONLY the symbols it draws — none are weighed into the lib. The sprite plumbing
 * (colorize / rasterize / data-URI, `SPRITE_PX`) lives in `@softwarity/draw-adapter`.
 *
 * Only the engine-level default ink remains here (it is not phenomenon data — it is the fallback
 * tint the adapter uses for a symbol/icon feature that carries no `symbolColor`).
 */

/** Fallback ink when a symbol feature carries no `symbolColor`. */
export const DEFAULT_SYMBOL_COLOR = "#9a6700";
