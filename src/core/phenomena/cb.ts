/**
 * Cumulonimbus / convection — a scalloped (cloud-edge) polygon. Proves
 * enum/bool metadata → style + label: coverage (ISOL/OCNL/FRQ), EMBD flag and
 * top/base FL are rendered as a label box; the scalloped edge is real geometry.
 */
import { coordsOf, frameK, lineFeature, polygonFeature, polylineLength, scallopRing, toPlanar } from "../decorate/index.js";
import { pointFeature } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature } from "../phenomenon.js";
import { centroid, fl, str, textBoxProps } from "./util.js";
import { regularPolygon } from "./util.js";

const decorate: DecorateFn = ({ geometry, metadata, style }) => {
  const ring = coordsOf(geometry);
  if (ring.length < 3) return [];
  const k = frameK(ring);
  const perim = polylineLength(ring.map((c) => toPlanar(c, k)));
  const wavelength = Math.max(0.05, perim / 36);
  const scalloped = scallopRing(ring, { wavelength, amplitude: wavelength * 0.6 });

  const out: RenderFeature[] = [];
  if (style.fill) {
    out.push(polygonFeature(scalloped, { layer: "area-fill", fillColor: style.fill.color, fillOpacity: style.fill.opacity }));
  }
  out.push(
    lineFeature(scalloped, { layer: "edge", stroke: style.edge?.color ?? style.color, strokeWidth: style.edge?.width ?? 2 }),
  );

  const coverage = str(metadata["coverage"], "ISOL");
  const embedded = metadata["embedded"] === true;
  const label = `${embedded ? "EMBD " : ""}${coverage} CB`;
  const c = centroid(ring);
  out.push(
    pointFeature(c, {
      layer: "annotations",
      labelId: "cb",
      content: `${label}\n${fl(metadata["topFL"])}/${fl(metadata["baseFL"])}`,
      leader: true,
      ...textBoxProps(style),
    }),
  );
  return out;
};

export const cb: PhenomenonDef = {
  type: "cb",
  label: "Cumulonimbus (CB)",
  primitives: ["polygon"],
  draw: {
    closed: true,
    minVertices: 3,
    interaction: { primitive: "polygon", mode: "draw" },
    defaultGeometry: (c, span) => regularPolygon(c, span),
  },
  schema: [
    {
      type: "enum",
      key: "coverage",
      label: "Coverage",
      default: "ISOL",
      options: [
        { value: "ISOL", label: "ISOL — isolated" },
        { value: "OCNL", label: "OCNL — occasional" },
        { value: "FRQ", label: "FRQ — frequent" },
      ],
    },
    { type: "bool", key: "embedded", label: "Embedded (EMBD)", default: false },
    { type: "fl", key: "topFL", label: "Top", default: 350 },
    { type: "fl", key: "baseFL", label: "Base", default: 100 },
  ],
  decorate,
  style: {
    color: "#d1242f",
    fill: { color: "#d1242f", opacity: 0.12 },
    edge: { color: "#d1242f", width: 2, decorator: "scallop" },
    textBox: { color: "#d1242f", size: 13, haloColor: "#ffffff", haloWidth: 2, background: "#ffffff", border: "#d1242f" },
  },
  summary: (m) => `${m["embedded"] ? "EMBD " : ""}${str(m["coverage"], "ISOL")} CB ${fl(m["topFL"])}/${fl(m["baseFL"])}`,
};
