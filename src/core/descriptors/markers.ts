/**
 * Point-marker descriptors — Tropical Cyclone, Volcanic eruption, Radioactive spot
 * (ICAO SIGWX §3.10 / §3.11 / §3.12). The first phenomena migrated to PURE JSON
 * (see PROFILES.md): each is a Point whose whole visual is an
 * inline-editable marker card — a glyph + an editable NAME + the auto lat/long,
 * framed once named. They differ only by the glyph (the TC's NH/SH orientation is
 * the declarative `byHemisphere` variant), the default name and the card pinning.
 *
 * These objects are the living documentation of the descriptor format: storable,
 * servable, host-editable — a TEMSI marker is one of these with another glyph.
 */
import type { PhenomenonDescriptor } from "../descriptor/types.js";

/** Volcanic eruption — the base dot marks the eruption location; glyph-only until named. */
export const VOLCANO_DESCRIPTOR: PhenomenonDescriptor = {
  schemaVersion: 1,
  type: "volcano",
  label: "Volcanic eruption",
  gesture: { primitive: "point", draw: "drop" },
  fields: [{ key: "name", kind: "text", label: "Name", default: "" }],
  card: {
    framed: "when-named",
    origin: "bottom", // the card pins on the base dot (the eruption location)
    deletable: true,
    items: [
      { glyph: "atlas:volcano", size: 26 },
      { input: { field: "name" } },
      { coord: true },
    ],
  },
  style: { color: "#1f2328" },
};

/** Radioactive materials release of significance to aviation — glyph-only until named. */
export const RADIOACTIVE_DESCRIPTOR: PhenomenonDescriptor = {
  schemaVersion: 1,
  type: "radioactive",
  label: "Radioactive spot",
  gesture: { primitive: "point", draw: "drop" },
  fields: [{ key: "name", kind: "text", label: "Name", default: "" }],
  card: {
    framed: "when-named",
    deletable: true,
    items: [
      { glyph: "atlas:radioactive", size: 26 },
      { input: { field: "name" } },
      { coord: true },
    ],
  },
  style: { color: "#1f2328" },
};

/** Tropical cyclone — the spiral mirrors by hemisphere (NH/SH from the latitude);
 *  named `"NN"` until christened; NEVER framed, no coord (bare glyph + name). */
export const TROPICAL_CYCLONE_DESCRIPTOR: PhenomenonDescriptor = {
  schemaVersion: 1,
  type: "tropicalCyclone",
  label: "Tropical cyclone",
  icon: "atlas:tc-nh", // NH art for the toolbar
  gesture: { primitive: "point", draw: "drop" },
  fields: [{ key: "name", kind: "text", label: "Name", default: "NN" }],
  card: {
    framed: false,
    deletable: true,
    items: [
      { glyph: { byHemisphere: { n: "atlas:tc-nh", s: "atlas:tc-sh" } }, size: 26 },
      { input: { field: "name" } },
    ],
  },
  style: { color: "#1f2328" },
};
