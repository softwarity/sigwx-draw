/**
 * The stock descriptors + métier glyphs, DERIVED FROM the profile JSONs — which are the
 * SINGLE SOURCE OF TRUTH. `wafs.json` carries the eight WAFS phenomena (+ their glyphs);
 * `temsi-euroc.json` adds the four TEMSI fronts. There is NO hand-written descriptor DATA
 * anywhere in TypeScript: a profile's `objects` reference these by name (`"cb"`), patch
 * them (`{ "extends": "cb", … }`), or ship their own inline. The only thing that can't
 * live in JSON — the custom RENDERING — is a NAMED extension (`jet-barbs`, `front-symbols`),
 * registered in `registry.ts`.
 */
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import wafs from "../../profiles/wafs.json" with { type: "json" };
import temsiEuroc from "../../profiles/temsi-euroc.json" with { type: "json" };

interface RawProfile {
  objects?: unknown[];
  glyphs?: Record<string, string>;
}

/** Index the full inline descriptors of one or more profiles by `type` (first wins). */
function indexByType(...profiles: RawProfile[]): Record<string, PhenomenonDescriptor> {
  const out: Record<string, PhenomenonDescriptor> = {};
  for (const p of profiles)
    for (const o of p.objects ?? [])
      if (o && typeof o === "object" && "type" in o) {
        const d = o as unknown as PhenomenonDescriptor;
        if (!(d.type in out)) out[d.type] = d;
      }
  return out;
}

/** Stock descriptors by type — sourced from the profile JSONs (WAFS eight + TEMSI fronts). */
export const BUILTIN_DESCRIPTORS: Record<string, PhenomenonDescriptor> = indexByType(
  wafs as unknown as RawProfile,
  temsiEuroc as unknown as RawProfile,
);

/** The stock métier glyphs (toolbar / card / canvas), merged from the source profiles. */
export const STOCK_GLYPHS: Record<string, string> = {
  ...(wafs as unknown as RawProfile).glyphs,
  ...(temsiEuroc as unknown as RawProfile).glyphs,
};
