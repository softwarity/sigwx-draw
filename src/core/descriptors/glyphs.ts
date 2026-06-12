/**
 * MÉTIER glyphs of the eight stock descriptors — NOT part of the core atlas.
 *
 * These ship WITH the stock descriptors (so `extends: "cb"` / `defaultRegistry()`
 * can compile them) and are ALSO inlined into a preset profile's `glyphs` section
 * by `npm run gen:profiles` — so a profile is self-sufficient (clone it and the
 * icons travel with it; drop a phenomenon and its SVG goes too). The core atlas
 * (`descriptor/atlas.ts`) keeps ONLY the engine chrome (`plus`/`minus`), never a
 * phenomenon's art.
 *
 * Normalized art: `<svg viewBox='0 0 24 24'>…</svg>`, `currentColor`, the consuming
 * SLOT dresses them (toolbar ~22 px, card glyph via `size`). SVG attributes use
 * SINGLE quotes so the generated profile JSON stays escape-free (`"<svg viewBox='…'>"`
 * instead of `"<svg viewBox=\"…\">"`). Final volcano/radioactive art ships by
 * replacing an entry here (or overriding in a profile).
 */
const svg24 = (inner: string): string => `<svg viewBox='0 0 24 24'>${inner}</svg>`;

// ── point-marker glyphs (placeholders — currentColor) ─────────────────────────
const VOLCANO =
  "<g fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round'>" +
  "<path d='M10.3 9 L8.7 4.6'/><path d='M12 8.4 L12 3.8'/><path d='M13.7 9 L15.3 4.6'/></g>" +
  "<path d='M3.8 18.6 L9 9 L10.8 10.7 L13.2 10.7 L15 9 L20.2 18.6 Z' fill='currentColor'/>" +
  "<circle cx='12' cy='20' r='1.4' fill='currentColor'/>";

// The ICAO TC mark: a "6" and a "9" superposed, their closed loops merged into ONE central
// ring with two opposite spiral tails (180° rotational symmetry).
const TC_NH =
  "<g fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'>" +
  "<circle cx='12' cy='12' r='3.6'/>" +
  "<path d='M14.9 9.9 C16.4 7.3 15.6 4.6 12.8 3.1'/>" +
  "<path d='M9.1 14.1 C7.6 16.7 8.4 19.4 11.2 20.9'/>" +
  "</g>";
const TC_SH = `<g transform='translate(24,0) scale(-1,1)'>${TC_NH}</g>`; // SH = NH mirrored

const RADIOACTIVE =
  "<g fill='currentColor'>" +
  "<path d='M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z'/>" +
  "<path d='M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z' transform='rotate(120 12 12)'/>" +
  "<path d='M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z' transform='rotate(240 12 12)'/>" +
  "<circle cx='12' cy='12' r='2.3'/></g>";

// Tropopause: a wavy blue DOTTED contour with its FL below — the iconic iso-line.
const TROPOPAUSE_ICON =
  "<g fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M2 13 Q7 7 12 11 T22 8' stroke-dasharray='3.2 1.6'/>" +
  "<text x='12' y='21.5' font-size='6.2' font-weight='700' fill='currentColor' stroke='none' text-anchor='middle' font-family='sans-serif'>FL380</text>" +
  "</g>";

// The scalloped CB cloud outline (shared by the CB and icing toolbar art) — a lumpy
// closed blob with uneven rounded lobes, rotated −15°.
const CLOUD_BLOB =
  "<g transform='rotate(-15 12 12)'>" +
  "<path d='M13.1 5.3 L14.1 5 L15 5.1 L15.7 5.5 L16.4 6.3 L17 7.3 L18.1 7.2 L19 7.2 L19.8 7.5 L20.3 8.1 L20.6 9 L20.7 10 L21.4 10.8 L21.8 11.5 L21.9 12.2 L21.5 12.8 L20.9 13.3 L20 13.8 L20.1 14.8 L20.1 15.7 L19.8 16.4 L19.2 16.8 L18.3 17 L17.3 17 L16.6 18 L15.8 18.7 L15 19.1 L14.1 19.1 L13.1 18.8 L12 18.3 L10.9 18.7 L9.9 19 L9 18.9 L8.3 18.5 L7.6 17.7 L7 16.7 L5.9 16.8 L5 16.8 L4.2 16.5 L3.7 15.9 L3.4 15 L3.3 14 L2.6 13.2 L2.2 12.5 L2.1 11.8 L2.5 11.2 L3.1 10.7 L4 10.2 L3.9 9.2 L3.9 8.3 L4.2 7.6 L4.8 7.2 L5.7 7 L6.7 7 L7.4 6 L8.2 5.3 L9 4.9 L9.9 4.9 L10.9 5.2 L12 5.7 Z'/>" +
  "</g>";

// CB: the cloud blob + "CB" at the centre. Width/height kept (slot-tuned art).
const CB_ICON =
  "<svg viewBox='0 0 24 24' width='24' height='24' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round'>" +
  CLOUD_BLOB +
  "<text x='12' y='12.5' font-size='7' font-weight='700' text-anchor='middle' dominant-baseline='central' stroke='none' fill='currentColor' font-family='system-ui, -apple-system, sans-serif'>CB</text>" +
  "</svg>";

// Icing: the same cloud, the icing FORK at the centre instead of "CB".
const ICING_ICON =
  "<svg viewBox='0 0 24 24' width='24' height='24' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round'>" +
  CLOUD_BLOB +
  "<path d='M8.5 8 V11.5 Q8.5 13 9.7 13 H14.3 Q15.5 13 15.5 11.5 V8 M10.8 11 V17 M13.2 11 V17' stroke-width='1.3' stroke-linecap='round'/>" +
  "</svg>";

// Turbulence: a dashed irregular "bubble" (the area) with the standard MOD glyph
// (an inverted V with feet) at its centre.
const TURBULENCE_ICON =
  "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M12 1.3 C17.8 0.9 23.2 3.6 22.6 10.9 C22.2 17.6 17.7 22.2 11.8 21.8 C5.5 21.4 1.3 16.7 1.9 10.1 C2.4 4.1 6.2 1.7 12 1.3 Z' stroke-dasharray='2.8 2.3'/>" +
  "<path d='M8 14 H10.5 L12 9 L13.5 14 H16'/>" +
  "</svg>";

// Jet stream: a CURVED jet axis (arrow + a few feathers on the low-pressure side)
// with FL300 below — the iconic sweeping jet stream.
const JET_STREAM_ICON =
  "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M3 17 Q11.5 16.5 16.5 8'/>" +
  "<path d='M18.5 4.6 L18.2 9 L14.8 7 Z' fill='currentColor' stroke='none'/>" +
  "<path d='M5.5 16.5 L7.4 16.1 L2.8 13 Z' fill='currentColor' stroke='none'/>" +
  "<path d='M9 15.6 L5 12.8' stroke-width='1.3'/>" +
  "<path d='M11.2 14.4 L7.2 11.6' stroke-width='1.3'/>" +
  "<text x='14.5' y='20' font-size='5.3' font-weight='700' text-anchor='middle' fill='currentColor' stroke='none' font-family='sans-serif' transform='rotate(-25 14.5 20)'>FL300</text>" +
  "</svg>";

/** The stock descriptors' métier glyphs, by atlas id. Registered with the stock
 *  registry and inlined into preset profiles' `glyphs` sections. */
export const STOCK_GLYPHS: Record<string, string> = {
  volcano: svg24(VOLCANO),
  "tc-nh": svg24(TC_NH),
  "tc-sh": svg24(TC_SH),
  radioactive: svg24(RADIOACTIVE),
  tropopause: svg24(TROPOPAUSE_ICON),
  cb: CB_ICON,
  icing: ICING_ICON,
  turbulence: TURBULENCE_ICON,
  jetStream: JET_STREAM_ICON,
};
