/**
 * Back-compat shim. The map adapter now lives in `@softwarity/draw-adapter` (the
 * shared, generic, data-driven adapter used by every @softwarity drawing lib).
 * This module re-exports the generic types under their historical names and keeps
 * the few SIGWX-specific aliases the public API still surfaces.
 *
 * The engine adapters (`MapLibreAdapter`, `OpenLayersAdapter`, `LeafletAdapter`)
 * are thin wrappers over the lib that pre-bind the SIGWX manifest — see the
 * `*-adapter.ts` files, `layers.ts` (manifest) and `style-features.ts` (decorate).
 */
export type {
  MapAdapter,
  LayerKind,
  LayerSpec,
  SymbolSprites,
  PointerEvent,
  KeyEvent,
  ToolbarItem,
  ToolbarOptions,
  ToolbarPosition,
  ToolbarPadding,
  SnapshotQuality,
  SnapshotDelivery,
  SnapshotTarget,
  SnapshotOptions,
} from "@softwarity/draw-adapter";
export { cursorForHit } from "@softwarity/draw-adapter";

/** Projection is the host map's concern; kept for the web-component wrapper. */
export type Projection = "mercator" | "globe";
