/**
 * Built-in glyph atlas — the ENGINE CHROME ONLY (`plus`/`minus`, worn by the
 * `draw_and_link`/`erase` action buttons). NEVER a phenomenon's art: a métier
 * glyph (cb, turbulence, volcano…) lives in the PROFILE (`glyphs` section) and
 * travels with its descriptor — see `descriptors/glyphs.ts`. So the core carries
 * no SVG for a phenomenon you don't load.
 *
 * Normalized art: `<svg viewBox="0 0 24 24">…</svg>`, `currentColor`. Hosts/profiles
 * extend the atlas via `registerExtensions({ glyphs })` / the inline `glyphs` section.
 */

const svg24 = (inner: string): string => `<svg viewBox='0 0 24 24'>${inner}</svg>`;

// SVG attributes use SINGLE quotes (a profile inlines these escape-free into JSON).
const MINUS = "<g fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round'><path d='M6 12 H18'/></g>";
const PLUS = "<g fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round'><path d='M12 6 V18 M6 12 H18'/></g>";

/** The built-in atlas: engine chrome only. */
export const BUILTIN_GLYPHS: Record<string, string> = {
  plus: svg24(PLUS),
  minus: svg24(MINUS),
};
