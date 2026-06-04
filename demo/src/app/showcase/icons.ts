/** Inline SVG icons for the phenomenon buttons (stroke = currentColor). */
const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  // Jet stream: a flow arrow with a couple of wind-barb feather ticks (the flagship).
  jetStream: wrap(
    '<line x1="3" y1="15" x2="20" y2="8"/>' + // axis
      '<path d="M20 8 l-4 0.4 M20 8 l-1.6 3.4"/>' + // arrowhead
      '<line x1="9" y1="12.3" x2="7" y2="9"/>' + // feather tick 1
      '<line x1="12.5" y1="10.9" x2="10.5" y2="7.6"/>', // feather tick 2
  ),
  // CB (cumulonimbus): a scalloped cloud outline.
  cb: wrap(
    '<path d="M6 16 a1.6 1.6 0 0 1 -0.6 -3 a2.4 2.4 0 0 1 2.2 -3 a3 3 0 0 1 5.8 -0.6 a2.4 2.4 0 0 1 3 2.8 a1.8 1.8 0 0 1 -0.4 3.4 Z"/>',
  ),
  // Turbulence: a wavy / zigzag line.
  turbulence: wrap('<path d="M3 12 q3 -6 6 0 t6 0 t6 0"/>'),
  clear: wrap(
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  ),
};
