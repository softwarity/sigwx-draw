/**
 * Turbulence / CAT — a dashed-bold polygon with an intensity glyph. Proves the
 * symbol/sprite path: the MOD/SEV intensity selects a registered glyph drawn by
 * the symbols layer (engine-agnostic via the adapter's sprite atlas).
 */
import { coordsOf, lineFeature, pointFeature, polygonFeature } from "../decorate/index.js";
import type { DecorateFn, PhenomenonDef, RenderFeature } from "../phenomenon.js";
import { centroid, fl, str, textBoxProps } from "./util.js";
import { regularPolygon } from "./util.js";

const decorate: DecorateFn = ({ geometry, metadata, style }) => {
  const ring = coordsOf(geometry);
  if (ring.length < 3) return [];
  const intensity = str(metadata["intensity"], "MOD");
  const out: RenderFeature[] = [];

  if (style.fill) {
    out.push(polygonFeature(ring, { layer: "area-fill", fillColor: style.fill.color, fillOpacity: style.fill.opacity }));
  }
  // Dashed bold outline (the `dash` prop tells the adapters to draw it dashed).
  out.push(
    lineFeature(ring, {
      layer: "edge",
      stroke: style.edge?.color ?? style.color,
      strokeWidth: style.edge?.width ?? 3,
      dash: style.edge?.dash ?? [3, 2],
    }),
  );

  const c = centroid(ring);
  // Intensity glyph (sprite id selected by intensity).
  out.push(
    pointFeature(c, {
      layer: "symbols",
      symbol: intensity === "SEV" ? "turb-sev" : "turb-mod",
      size: style.symbol?.size ?? 1,
      symbolColor: style.symbol?.color ?? style.color,
    }),
  );
  // Intensity + FL call-out (placed with anti-collision + leader).
  out.push(
    pointFeature(c, {
      layer: "annotations",
      labelId: "turb",
      content: `${intensity}\n${fl(metadata["topFL"])}/${fl(metadata["baseFL"])}`,
      leader: true,
      ...textBoxProps(style),
    }),
  );
  return out;
};

export const turbulence: PhenomenonDef = {
  type: "turbulence",
  label: "Turbulence / CAT",
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
      key: "intensity",
      label: "Intensity",
      default: "MOD",
      options: [
        { value: "MOD", label: "MOD — moderate" },
        { value: "SEV", label: "SEV — severe" },
      ],
    },
    { type: "fl", key: "topFL", label: "Top", default: 350 },
    { type: "fl", key: "baseFL", label: "Base", default: 200 },
  ],
  decorate,
  style: {
    color: "#9a6700",
    fill: { color: "#d4a72c", opacity: 0.1 },
    edge: { color: "#9a6700", width: 3, decorator: "dashed", dash: [3, 2] },
    symbol: { sprite: "turb-mod", size: 1, color: "#9a6700" },
    textBox: { color: "#9a6700", size: 13, haloColor: "#ffffff", haloWidth: 2, background: "#ffffff", border: "#9a6700" },
  },
  summary: (m) => `${str(m["intensity"], "MOD")} TURB ${fl(m["topFL"])}/${fl(m["baseFL"])}`,
};
