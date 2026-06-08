/** The SIGWX overlay manifest (bottom → top). The adapters build one source +
 *  renderer per entry; `core/decorate` tags each feature with its target layer. */
import type { LayerSpec } from "./adapter.js";

export const SIGWX_LAYERS: LayerSpec[] = [
  { id: "area-fill", kind: "fill" },
  { id: "selection", kind: "line" },
  { id: "edge", kind: "line" },
  { id: "decoration", kind: "line" },
  { id: "leaders", kind: "line" },
  { id: "text-boxes", kind: "text" },
  // `symbols` ABOVE `text-boxes` so a call-out glyph placed INSIDE the box (icing) isn't hidden
  // by the box fill. The hit-test still resolves handles (higher z) first, so it doesn't affect
  // double-click vertex insertion (verified on all 3 engines).
  { id: "symbols", kind: "symbol" },
  { id: "handles", kind: "circle" },
  { id: "controls", kind: "text" }, // editing affordances (the ✕ delete control) — top + hidden in snapshots
];

export const OVERLAY_IDS: string[] = SIGWX_LAYERS.map((l) => l.id);

/** Logical bucket name the decorate fns emit call-out requests under (the
 *  controller's placement pass consumes it → `text-boxes` + `leaders`). It is
 *  NOT an adapter overlay. */
export const ANNOTATION_BUCKET = "annotations";

/** Overlays a pointer hit may resolve against (selection / handle / pin drag).
 *  `decoration` is included so clicking a jet's barbs (not just the thin axis)
 *  selects it. */
export const HIT_OVERLAYS = new Set(["controls", "handles", "edge", "decoration", "area-fill", "symbols", "text-boxes"]);
