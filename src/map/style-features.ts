/**
 * The **style-in-the-data** bridge to `@softwarity/draw-adapter`. The generic
 * adapter is dumb: it reads render-props off each feature (picked by the layer's
 * `kind`). Every SIGWX overlay already carries its render props (baked by the
 * controller / `core/decorate`) EXCEPT `handles`, whose look used to live in the
 * per-engine adapters (the `handleCase` expressions, driven by `setStyle`). This
 * `decorate()` bakes the resolved {@link SigwxStyle} into the handle props so the
 * adapter never sees a domain type — and the three engines render identically.
 */
import type { Feature, FeatureCollection } from "geojson";

import type { SigwxStyle } from "./style.js";

/** Armed-for-deletion handles turn red (matches the old `circle-color` case). */
const DANGER = "#f85149";

/**
 * Bake the resolved style into per-feature render-props for overlay `id`. Only the
 * `handles` (circle) overlay needs translation; every other overlay is returned
 * untouched (its props are already baked). Pure: returns a new FeatureCollection.
 */
export function decorate(id: string, data: FeatureCollection, s: SigwxStyle): FeatureCollection {
  if (id !== "handles" || !data.features.length) return data;
  return { type: "FeatureCollection", features: data.features.map((f) => bakeHandle(f, s)) };
}

function bakeHandle(f: Feature, s: SigwxStyle): Feature {
  const p = { ...(f.properties ?? {}) } as Record<string, unknown>;
  const hClass = p["hClass"];
  // Break points / on-map controls share the orange control identity; everything
  // else uses the plain vertex handle. "end" (jet extremity) swaps fill/stroke.
  const control = hClass === "slider" || hClass === "control";
  const h = control ? s.control.handle : s.handle;
  const swap = hClass === "end";
  Object.assign(p, {
    fill: p["danger"] === true ? DANGER : swap ? s.handle.stroke : h.fill,
    stroke: swap ? s.handle.fill : h.stroke,
    radius: h.radius,
    strokeWidth: h.strokeWidth,
  });
  return { ...f, properties: p };
}
