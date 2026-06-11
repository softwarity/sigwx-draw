/** Tiny constructors for the tagged render features the adapters consume. */
import type { Position } from "geojson";

import type { RenderFeature, RenderProps } from "../phenomenon.js";

export function lineFeature(coords: Position[], props: RenderProps): RenderFeature {
  return { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };
}

export function polygonFeature(ring: Position[], props: RenderProps, holes: Position[][] = []): RenderFeature {
  return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring, ...holes] } };
}

export function pointFeature(coord: Position, props: RenderProps): RenderFeature {
  return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: coord } };
}
