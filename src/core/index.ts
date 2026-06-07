/**
 * Pure SIGWX core (no DOM/map): the phenomenon registry, metadata schema, the
 * decoration generators and the GeoJSON chart (de)serialization. Everything here
 * is unit-testable without a map.
 */
export type { LatLng } from "./coord.js";
export { formatLat, formatLon, formatLatLng } from "./coord.js";

export type {
  LineStyle,
  TooltipStyle,
  TextStyle,
  EdgeStyle,
  AreaStyle,
  SymbolStyle,
  JetStyle,
  TurbulenceStyle,
  CbStyle,
  PhenomenonStyle,
} from "./style.js";
export { mergePhenomenonStyle, rgba } from "./style.js";

export type {
  GeometryPrimitive,
  RenderLayer,
  RenderProps,
  RenderFeature,
  Metadata,
  DecorationInput,
  DecorateFn,
  FieldSchema,
  NumberField,
  FlightLevelField,
  FlMode,
  EnumField,
  BoolField,
  TextField,
  ListField,
  DrawSpec,
  InteractionSpec,
  PhenomenonDef,
} from "./phenomenon.js";
export {
  PhenomenonRegistry,
  defaultMetadata,
  isVisible,
  validate,
  interactionOf,
} from "./phenomenon.js";

export * from "./decorate/index.js";

export { BUILTIN_PHENOMENA, defaultRegistry, jetStream, cb, turbulence } from "./registry.js";
export { makeTurbulence, DEFAULT_TURBULENCE_SYMBOLS } from "./phenomena/turbulence.js";
export type { TurbulenceSymbol } from "./phenomena/turbulence.js";

export type { SigwxFeature, SigwxFeatureProps } from "./geojson.js";
export { toFeatureCollection, fromFeatureCollection } from "./geojson.js";
