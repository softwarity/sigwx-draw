/**
 * Default glyph sprite atlas (inline SVG). v1 ships the turbulence intensity
 * glyphs; more (volcano, TC, H/L, icing) plug in here as the registry grows.
 * Hosts can override via `new SigwxDraw({ symbolSprite })`.
 *
 * The sprite plumbing (colorize / rasterize / data-URI, `SPRITE_PX`) now lives in
 * `@softwarity/draw-adapter` — this module only owns the SIGWX-specific defaults.
 */
import type { SymbolSprites } from "./adapter.js";

// Standard turbulence symbols: a horizontal line with one peak (MOD) or two peaks (SEV).
// The stroke is `currentColor` so the adapters can re-tint a sprite per feature
// (`symbolColor`) — see the adapter's `colorizeSprite`.
const TURB_MOD = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M5 20 H13 L16 12 L19 20 H27"/></g></svg>`;

const TURB_SEV = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M5 22 H13 L16 14 L19 22 H27"/><path d="M11 15 L16 7 L21 15"/></g></svg>`;

/** CB call-out glyph: the coverage amount over "CB" (e.g. OCNL / CB) — the text the WAFC
 *  chart actually draws. The coverage CODE is the sprite id, so tapping it cycles the
 *  coverage (carousel). Host coverages register their own via this helper. `currentColor`
 *  re-tints per feature. */
export function coverageGlyph(code: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="36" viewBox="0 0 40 36">` +
    `<g fill="currentColor" font-family="Arial, Helvetica, sans-serif" font-weight="700" text-anchor="middle">` +
    `<text x="20" y="16" font-size="14">${code}</text><text x="20" y="32" font-size="14">CB</text>` +
    `</g></svg>`
  );
}

// Sprite ids match the symbol `code`s so the decorate draws `sprite = metadata.symbol`:
// turbulence intensities (MOD/SEV) and CB coverage amounts (OCNL/FRQ), each tap-to-cycle.
export const DEFAULT_SPRITES: SymbolSprites = {
  MOD: TURB_MOD,
  SEV: TURB_SEV,
  OCNL: coverageGlyph("OCNL"),
  FRQ: coverageGlyph("FRQ"),
};

/** Fallback ink when a symbol feature carries no `symbolColor`. */
export const DEFAULT_SYMBOL_COLOR = "#9a6700";
