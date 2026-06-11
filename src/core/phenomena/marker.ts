/**
 * Point-marker phenomena — Tropical Cyclone, Volcanic eruption, Radioactive spot
 * (ICAO SIGWX §3.10 / §3.11 / §3.12). Each is a Point whose **whole visual is an
 * inline-editable marker card** (the adapter's `MarkerWidget`): a glyph + an editable
 * NAME + the auto lat/long, framed once named. They differ only by the glyph (+ the
 * TC's NH/SH orientation, derived from the latitude) and the default name. The name is
 * typed INLINE on the card (no form); the lat/long is filled by the adapter from the
 * point and updates when it's moved.
 *
 * The glyphs here are PLACEHOLDERS (`currentColor`) — final art is swapped in later.
 */
import type { MarkerWidget, WidgetNode } from "@softwarity/draw-adapter";
import type { PhenomenonDef, WidgetInput } from "../phenomenon.js";
import { str } from "./util.js";

// ── placeholder glyphs: inner SVG (currentColor), viewBox 0 0 24 24 ───────────
const VOLCANO =
  '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<path d="M10.3 9 L8.7 4.6"/><path d="M12 8.4 L12 3.8"/><path d="M13.7 9 L15.3 4.6"/></g>' +
  '<path d="M3.8 18.6 L9 9 L10.8 10.7 L13.2 10.7 L15 9 L20.2 18.6 Z" fill="currentColor"/>' +
  '<circle cx="12" cy="20" r="1.4" fill="currentColor"/>';
// The ICAO TC mark: a "6" and a "9" superposed, their closed loops merged into ONE central
// ring with two opposite spiral tails (180° rotational symmetry).
const TC_NH =
  '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="3.6"/>' +
  '<path d="M14.9 9.9 C16.4 7.3 15.6 4.6 12.8 3.1"/>' +
  '<path d="M9.1 14.1 C7.6 16.7 8.4 19.4 11.2 20.9"/>' +
  "</g>";
const TC_SH = `<g transform="translate(24,0) scale(-1,1)">${TC_NH}</g>`; // SH = NH mirrored horizontally
const RADIOACTIVE =
  '<g fill="currentColor">' +
  '<path d="M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z"/>' +
  '<path d="M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z" transform="rotate(120 12 12)"/>' +
  '<path d="M10.2 8.88 L7.5 4.21 A9 9 0 0 1 16.5 4.21 L13.8 8.88 A3.6 3.6 0 0 0 10.2 8.88 Z" transform="rotate(240 12 12)"/>' +
  '<circle cx="12" cy="12" r="2.3"/></g>';

const glyphSvg = (inner: string): string => `<svg viewBox="0 0 24 24">${inner}</svg>`;
const iconSvg = (inner: string): string => `<svg viewBox="0 0 24 24" width="22" height="22">${inner}</svg>`;

interface MarkerSpec {
  type: string;
  label: string;
  /** Glyph inner SVG; a function when it depends on the latitude (TC → NH/SH). */
  glyph: string | ((lat: number) => string);
  /** Default name: `"NN"` (TC — always framed) or `""` (volcano/radioactive — glyph-only until named). */
  nameDefault: string;
  ink: string;
  /** Where the card pins to the point: volcano → its base dot, TC/radioactive → centre. */
  origin: "center" | "bottom";
  /** `true` ⇒ NEVER frame the card and NEVER show the coord line — just glyph + name (TC). */
  bare?: boolean;
}

function makeMarker(spec: MarkerSpec): PhenomenonDef {
  const widget = ({ id, geometry, metadata, editable, style }: WidgetInput): MarkerWidget => {
    const [lon, lat] = geometry.type === "Point" ? (geometry.coordinates as [number, number]) : [0, 0];
    const name = str(metadata["name"], "");
    const ink = style.color; // glyph + card frame
    const textInk = style.text?.color ?? ink; // name/coord may deviate, else follow the ink
    const inner = typeof spec.glyph === "function" ? spec.glyph(lat) : spec.glyph;
    // Box + coord show only while editing (selected) or once named; else just the glyph.
    // A `bare` marker (TC) is NEVER framed and shows no coord — only the glyph + name.
    const framed = !spec.bare && (editable || name !== "");
    const items: WidgetNode[] = [{ kind: "glyph", svg: glyphSvg(inner), size: 26, color: ink }];
    if (editable) items.push({ kind: "text", value: name, editable: true, control: "input", name: "name", autofocus: true });
    else if (name !== "") items.push({ kind: "text", value: name });
    if (framed) items.push({ kind: "coord" });
    return {
      id,
      anchor: { lon, lat },
      origin: spec.origin,
      // A delete ✕ when selected — the name <input> swallows Delete/Backspace, so the keyboard
      // delete can't reach the controller; the card button fires `onWidgetDelete` instead.
      deletable: editable,
      ...(framed ? { bg: "#ffffff", border: ink, radius: "small", padding: "small" } : {}),
      font: { color: textInk, size: style.text?.size ?? 13 },
      child: { dir: "v", align: "center", gap: 2, items },
    };
  };

  return {
    type: spec.type,
    label: spec.label,
    icon: iconSvg(typeof spec.glyph === "function" ? spec.glyph(1) : spec.glyph), // NH for the toolbar
    primitives: ["point"],
    draw: {
      interaction: { primitive: "point", mode: "drop" },
      defaultGeometry: (c) => ({ type: "Point", coordinates: [c.lon, c.lat] }),
    },
    schema: [{ type: "text", key: "name", label: "Name", default: spec.nameDefault }],
    decorate: () => [], // a marker has no derived render features — the widget IS the rendering
    widget,
    style: { color: spec.ink },
  };
}

/** Tropical cyclone — the spiral mirrors by hemisphere (NH/SH from latitude); name `"NN"` until named. */
export const tropicalCyclone: PhenomenonDef = makeMarker({
  type: "tropicalCyclone",
  label: "Tropical cyclone",
  glyph: (lat) => (lat >= 0 ? TC_NH : TC_SH),
  nameDefault: "NN",
  ink: "#1f2328",
  origin: "center",
  bare: true, // TC: no frame, no coord — just the spiral + the name
});

/** Volcanic eruption — the base dot marks the eruption location; glyph-only until named. */
export const volcano: PhenomenonDef = makeMarker({
  type: "volcano",
  label: "Volcanic eruption",
  glyph: VOLCANO,
  nameDefault: "",
  ink: "#1f2328",
  origin: "bottom",
});

/** Radioactive materials release of significance to aviation — glyph-only until named. */
export const radioactive: PhenomenonDef = makeMarker({
  type: "radioactive",
  label: "Radioactive spot",
  glyph: RADIOACTIVE,
  nameDefault: "",
  ink: "#1f2328",
  origin: "center",
});
