/** Map layer: the controller, adapters, style and overlay manifest. */
export { SigwxDraw } from "./sigwx-draw.js";
export type { SigwxDrawOptions, PhenomenonConfig, PhenomenaConfig, NumRange, TurbulenceType, FormSpec, ResolvedField } from "./sigwx-draw.js";

export type {
  MapAdapter,
  LayerKind,
  LayerSpec,
  SymbolSprites,
  PointerEvent,
  KeyEvent,
  MarkerWidget,
  WidgetBox,
  WidgetGlyph,
  WidgetText,
  WidgetCoord,
  WidgetNode,
  WidgetOrigin,
  WidgetEdit,
  Projection,
  ToolbarItem,
  ToolbarOptions,
  ToolbarPosition,
  ToolbarPadding,
  SnapshotQuality,
  SnapshotDelivery,
  SnapshotTarget,
  SnapshotOptions,
} from "./adapter.js";

export { SIGWX_LAYERS, OVERLAY_IDS } from "./layers.js";
export { DEFAULT_STYLE, mergeStyle } from "./style.js";
export type { SigwxStyle, SigwxStyleInput } from "./style.js";
export { DEFAULT_SPRITES } from "./symbols.js";

// NOTE: the adapters are NOT re-exported here on purpose — importing them eagerly loads
// their peer (maplibre-gl / ol). Keep the root entry (and `./core`) peer-free; reach the
// adapters via the dedicated subpath exports:
//   import { MapLibreAdapter, createMapLibreMap } from "@softwarity/sigwx-draw/maplibre";
//   import { OpenLayersAdapter, createOpenLayersMap } from "@softwarity/sigwx-draw/openlayers";
