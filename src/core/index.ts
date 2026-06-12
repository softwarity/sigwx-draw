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
  IcingStyle,
  TropopauseStyle,
  MarkerStyle,
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
  WidgetInput,
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
export * from "./descriptor/index.js";

export { BUILTIN_PHENOMENA, defaultRegistry, jetStream, cb, icing, turbulence, tropopause, volcano, tropicalCyclone, radioactive } from "./registry.js";
// Stock descriptors + builders — all DERIVED from the profile JSONs (single source).
export {
  BUILTIN_DESCRIPTORS, STOCK_GLYPHS, resolveObjectSpec,
  JET_STREAM_DESCRIPTOR, CB_DESCRIPTOR, ICING_DESCRIPTOR, TURBULENCE_DESCRIPTOR, TROPOPAUSE_DESCRIPTOR,
  VOLCANO_DESCRIPTOR, TROPICAL_CYCLONE_DESCRIPTOR, RADIOACTIVE_DESCRIPTOR,
  FRONT_COLD_DESCRIPTOR, FRONT_WARM_DESCRIPTOR, FRONT_OCCLUDED_DESCRIPTOR, FRONT_STATIONARY_DESCRIPTOR, FRONT_DESCRIPTORS,
  makeTurbulence, DEFAULT_TURBULENCE_SYMBOLS, turbulenceDescriptor,
  makeCb, DEFAULT_CB_COVERAGE, CB_CLOUD_TYPE_BUFR, cbDescriptor,
  makeIcing, DEFAULT_ICING_SYMBOLS, icingDescriptor,
} from "./descriptors/index.js";
export type { CbCoverage, TurbulenceSymbol, IcingSymbol } from "./descriptors/index.js";

export type { SigwxFeature, SigwxFeatureProps } from "./geojson.js";
export { toFeatureCollection, fromFeatureCollection } from "./geojson.js";
