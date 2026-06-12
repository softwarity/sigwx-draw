/**
 * Stock-descriptor barrel. Everything here is DERIVED from the profile JSONs (the single
 * source of truth — see `stock.ts`); the named `*_DESCRIPTOR` exports are kept only as
 * API-stable aliases that POINT AT the JSON objects (no second copy). A profile references
 * these by name in its `objects` (`"cb"`, `"frontCold"`), patches them (`{ "extends": "cb",
 * … }`), or ships its own inline. Custom rendering that can't be expressed in JSON is a
 * NAMED extension (`jet-barbs`, `front-symbols`) — never data in TypeScript.
 */
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import { BUILTIN_DESCRIPTORS } from "./stock.js";

export { BUILTIN_DESCRIPTORS, STOCK_GLYPHS } from "./stock.js";
export * from "./builders.js";

// API-stable aliases — each is the SAME object the JSON source holds (zero duplication).
export const JET_STREAM_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.jetStream!;
export const CB_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.cb!;
export const ICING_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.icing!;
export const TURBULENCE_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.turbulence!;
export const TROPOPAUSE_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.tropopause!;
export const VOLCANO_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.volcano!;
export const TROPICAL_CYCLONE_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.tropicalCyclone!;
export const RADIOACTIVE_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.radioactive!;
export const FRONT_COLD_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.frontCold!;
export const FRONT_WARM_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.frontWarm!;
export const FRONT_OCCLUDED_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.frontOccluded!;
export const FRONT_STATIONARY_DESCRIPTOR: PhenomenonDescriptor = BUILTIN_DESCRIPTORS.frontStationary!;
export const FRONT_DESCRIPTORS: PhenomenonDescriptor[] = [
  FRONT_COLD_DESCRIPTOR, FRONT_WARM_DESCRIPTOR, FRONT_OCCLUDED_DESCRIPTOR, FRONT_STATIONARY_DESCRIPTOR,
];

/** Resolve one profile `objects` entry to a full descriptor (stock / patch / inline). */
export function resolveObjectSpec(
  spec: string | ({ extends: string } & Record<string, unknown>) | PhenomenonDescriptor,
  merge: (base: PhenomenonDescriptor, patch: Record<string, unknown>) => PhenomenonDescriptor,
): PhenomenonDescriptor {
  const stock = (name: string): PhenomenonDescriptor => {
    const d = BUILTIN_DESCRIPTORS[name];
    if (!d) throw new Error(`Unknown stock descriptor "${name}". Available: ${Object.keys(BUILTIN_DESCRIPTORS).sort().join(", ")}`);
    return d;
  };
  if (typeof spec === "string") return stock(spec);
  if ("extends" in spec && typeof spec.extends === "string") return merge(stock(spec.extends), spec);
  return spec as PhenomenonDescriptor;
}
