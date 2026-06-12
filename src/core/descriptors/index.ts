/**
 * The stock descriptors — the eight WAFS phenomena as PURE JSON, the living
 * documentation of the descriptor format. A profile references them by name in
 * its `objects` (`"cb"`), patches them (`{ "extends": "cb", … }`), or ships its
 * own inline descriptors next to them.
 */
import type { PhenomenonDescriptor } from "../descriptor/types.js";
import { CB_DESCRIPTOR } from "./cb.js";
import { ICING_DESCRIPTOR } from "./icing.js";
import { JET_STREAM_DESCRIPTOR } from "./jet-stream.js";
import { RADIOACTIVE_DESCRIPTOR, TROPICAL_CYCLONE_DESCRIPTOR, VOLCANO_DESCRIPTOR } from "./markers.js";
import { TROPOPAUSE_DESCRIPTOR } from "./tropopause.js";
import { TURBULENCE_DESCRIPTOR } from "./turbulence.js";

export { CB_DESCRIPTOR, cbDescriptor, makeCb, DEFAULT_CB_COVERAGE, CB_CLOUD_TYPE_BUFR } from "./cb.js";
export type { CbCoverage } from "./cb.js";
export { ICING_DESCRIPTOR, icingDescriptor, makeIcing, DEFAULT_ICING_SYMBOLS } from "./icing.js";
export type { IcingSymbol } from "./icing.js";
export { JET_STREAM_DESCRIPTOR } from "./jet-stream.js";
export { RADIOACTIVE_DESCRIPTOR, TROPICAL_CYCLONE_DESCRIPTOR, VOLCANO_DESCRIPTOR } from "./markers.js";
export { TROPOPAUSE_DESCRIPTOR } from "./tropopause.js";
export { TURBULENCE_DESCRIPTOR, turbulenceDescriptor, makeTurbulence, DEFAULT_TURBULENCE_SYMBOLS } from "./turbulence.js";
export type { TurbulenceSymbol } from "./turbulence.js";

/** Stock descriptors by type — what a profile's `objects` strings/`extends` resolve to. */
export const BUILTIN_DESCRIPTORS: Record<string, PhenomenonDescriptor> = {
  jetStream: JET_STREAM_DESCRIPTOR,
  cb: CB_DESCRIPTOR,
  icing: ICING_DESCRIPTOR,
  turbulence: TURBULENCE_DESCRIPTOR,
  tropopause: TROPOPAUSE_DESCRIPTOR,
  volcano: VOLCANO_DESCRIPTOR,
  tropicalCyclone: TROPICAL_CYCLONE_DESCRIPTOR,
  radioactive: RADIOACTIVE_DESCRIPTOR,
};

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
