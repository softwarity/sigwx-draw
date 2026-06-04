/** The SIGWX overlay manifest (bottom → top). The adapters build one source +
 *  renderer per entry; `core/decorate` tags each feature with its target layer. */
import type { LayerSpec } from "./adapter.js";

export const SIGWX_LAYERS: LayerSpec[] = [
  { id: "area-fill", kind: "fill" },
  { id: "selection", kind: "line" },
  { id: "edge", kind: "line" },
  { id: "decoration", kind: "line" },
  { id: "symbols", kind: "symbol" },
  { id: "leaders", kind: "line" },
  { id: "text-boxes", kind: "text" },
  { id: "handles", kind: "circle" },
];

export const OVERLAY_IDS: string[] = SIGWX_LAYERS.map((l) => l.id);

/** Logical bucket name the decorate fns emit call-out requests under (the
 *  controller's placement pass consumes it → `text-boxes` + `leaders`). It is
 *  NOT an adapter overlay. */
export const ANNOTATION_BUCKET = "annotations";

/** Overlays a pointer hit may resolve against (selection / handle / pin drag).
 *  `decoration` is included so clicking a jet's barbs (not just the thin axis)
 *  selects it. */
export const HIT_OVERLAYS = new Set(["handles", "edge", "decoration", "area-fill", "symbols", "text-boxes"]);
