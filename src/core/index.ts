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
export { VOLCANO_DESCRIPTOR, RADIOACTIVE_DESCRIPTOR, TROPICAL_CYCLONE_DESCRIPTOR } from "./descriptors/markers.js";

export { BUILTIN_PHENOMENA, defaultRegistry, jetStream, cb, icing, turbulence, tropopause, volcano, tropicalCyclone, radioactive } from "./registry.js";
export { makeTurbulence, DEFAULT_TURBULENCE_SYMBOLS, TURBULENCE_DESCRIPTOR, turbulenceDescriptor } from "./descriptors/turbulence.js";
export type { TurbulenceSymbol } from "./descriptors/turbulence.js";
export { makeCb, DEFAULT_CB_COVERAGE, CB_CLOUD_TYPE_BUFR, CB_DESCRIPTOR, cbDescriptor } from "./descriptors/cb.js";
export type { CbCoverage } from "./descriptors/cb.js";
export { makeIcing, DEFAULT_ICING_SYMBOLS, ICING_DESCRIPTOR, icingDescriptor } from "./descriptors/icing.js";
export type { IcingSymbol } from "./descriptors/icing.js";
export { TROPOPAUSE_DESCRIPTOR } from "./descriptors/tropopause.js";
export { JET_STREAM_DESCRIPTOR } from "./descriptors/jet-stream.js";
export { BUILTIN_DESCRIPTORS, resolveObjectSpec } from "./descriptors/index.js";
export { STOCK_GLYPHS } from "./descriptors/glyphs.js";

export type { SigwxFeature, SigwxFeatureProps } from "./geojson.js";
export { toFeatureCollection, fromFeatureCollection } from "./geojson.js";
