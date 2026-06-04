/**
 * SIGWX chart (de)serialization. The canonical output is a plain GeoJSON
 * `FeatureCollection`: one feature per phenomenon, base geometry in lon/lat, with
 * `{ id, phenomenon, metadata }` in `properties`. Decorations are derived and
 * never serialized. No TAC, no IWXXM in v1.
 */
import type { Feature, FeatureCollection, Geometry } from "geojson";

import type { Metadata, PhenomenonRegistry } from "./phenomenon.js";

export interface SigwxFeatureProps {
  id: string;
  phenomenon: string;
  metadata: Metadata;
}

export type SigwxFeature = Feature<Geometry, SigwxFeatureProps>;

export function toFeatureCollection(features: SigwxFeature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/**
 * Validate & normalize a loaded FeatureCollection into chart features. Drops any
 * feature whose phenomenon is unknown to the registry or that lacks geometry.
 */
export function fromFeatureCollection(
  fc: FeatureCollection,
  registry: PhenomenonRegistry,
): SigwxFeature[] {
  const out: SigwxFeature[] = [];
  for (const f of fc.features) {
    const props = (f.properties ?? {}) as Partial<SigwxFeatureProps>;
    if (!f.geometry || typeof props.phenomenon !== "string" || !registry.has(props.phenomenon)) continue;
    out.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: typeof props.id === "string" ? props.id : `f${out.length}`,
        phenomenon: props.phenomenon,
        metadata: (props.metadata ?? {}) as Metadata,
      },
    });
  }
  return out;
}
