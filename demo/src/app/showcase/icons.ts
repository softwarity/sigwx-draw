/** Inline SVG icons for the phenomenon buttons (stroke = currentColor). */
const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Filled Material-style icon (fill = currentColor) — for the 2D/3D toggle. */
const wrapFill = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">${body}</svg>`;

export const ICONS: Record<string, string> = {
  // 2D/3D toggle: Material "earth" globe (3D) ↔ the flat map-in-a-box (2D).
  globe: wrapFill(
    '<path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>',
  ),
  flat: wrapFill(
    '<path d="M5,3C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3H5M15.78,5H19V17.18C18.74,16.38 17.69,15.79 16.8,15.79H15.8V12.79A1,1 0 0,0 14.8,11.79H8.8V9.79H10.8A1,1 0 0,0 11.8,8.79V6.79H13.8C14.83,6.79 15.67,6 15.78,5M5,10.29L9.8,14.79V15.79C9.8,16.9 10.7,17.79 11.8,17.79V19H5V10.29Z"/>',
  ),
  // Jet stream: a flow arrow with a couple of wind-barb feather ticks (the flagship).
  jetStream: wrap(
    '<path d="M3 17 Q11.5 16.5 16.5 8" stroke-width="1.5"/>' + // curved axis
      '<path d="M18.5 4.6 L18.2 9 L14.8 7 Z" fill="currentColor" stroke="none"/>' + // fine triangle tip, aligned to the curve tangent
      '<path d="M5.5 16.5 L7.4 16.1 L2.8 13 Z" fill="currentColor" stroke="none"/>' + // 50-kt pennant, swept back
      '<path d="M9 15.6 L5 12.8" stroke-width="1.3"/>' + // full barbs, parallel, leaning back
      '<path d="M11.2 14.4 L7.2 11.6" stroke-width="1.3"/>',
  ),
  // CB (cumulonimbus): a scalloped cloud outline.
  cb: wrap(
    '<path d="M6 16 a1.6 1.6 0 0 1 -0.6 -3 a2.4 2.4 0 0 1 2.2 -3 a3 3 0 0 1 5.8 -0.6 a2.4 2.4 0 0 1 3 2.8 a1.8 1.8 0 0 1 -0.4 3.4 Z"/>',
  ),
  // Turbulence: a dashed irregular "bubble" with the MOD glyph (inverted V + feet) inside.
  turbulence:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 1.3 C17.8 0.9 23.2 3.6 22.6 10.9 C22.2 17.6 17.7 22.2 11.8 21.8 C5.5 21.4 1.3 16.7 1.9 10.1 C2.4 4.1 6.2 1.7 12 1.3 Z" stroke-dasharray="2.8 2.3"/>' +
    '<path d="M8 14 H10.5 L12 9 L13.5 14 H16"/>' +
    "</svg>",
  clear: wrap(
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  ),
};
