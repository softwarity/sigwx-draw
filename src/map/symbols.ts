/**
 * Default glyph sprite atlas (inline SVG). v1 ships the turbulence intensity
 * glyphs; more (volcano, TC, H/L, icing) plug in here as the registry grows.
 * Hosts can override via `new SigwxDraw({ symbolSprite })`.
 */
import type { SymbolSprites } from "./adapter.js";

const TURB_MOD = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
<g fill="none" stroke="#9a6700" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M16 6 V26"/><path d="M8 13 L16 6 L24 13"/></g></svg>`;

const TURB_SEV = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
<g fill="none" stroke="#9a6700" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M16 4 V28"/><path d="M8 11 L16 4 L24 11"/><path d="M8 18 L16 11 L24 18"/></g></svg>`;

export const DEFAULT_SPRITES: SymbolSprites = {
  "turb-mod": TURB_MOD,
  "turb-sev": TURB_SEV,
};

/** Sprite pixel size both adapters rasterize/draw at (icon-size 1 ⇒ this many px). */
export const SPRITE_PX = 32;

export function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.trim());
}

/** Rasterize an SVG sprite into an HTMLImageElement (for MapLibre `addImage`). */
export function loadSpriteImage(svg: string, px = SPRITE_PX): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(px, px);
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e instanceof Error ? e : new Error("sprite load failed"));
    img.src = svgToDataUrl(svg);
  });
}
