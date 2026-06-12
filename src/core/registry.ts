/** The built-in phenomenon registry (jet, CB, icing, turbulence, tropopause, markers). */
import { registerExtensions } from "./descriptor/extensions.js";
import { defFromDescriptor } from "./descriptor/interpret.js";
import { CB_DESCRIPTOR } from "./descriptors/cb.js";
import { STOCK_GLYPHS } from "./descriptors/glyphs.js";
import { ICING_DESCRIPTOR } from "./descriptors/icing.js";
import { JET_STREAM_DESCRIPTOR } from "./descriptors/jet-stream.js";
import { RADIOACTIVE_DESCRIPTOR, TROPICAL_CYCLONE_DESCRIPTOR, VOLCANO_DESCRIPTOR } from "./descriptors/markers.js";
import { TROPOPAUSE_DESCRIPTOR } from "./descriptors/tropopause.js";
import { TURBULENCE_DESCRIPTOR } from "./descriptors/turbulence.js";
import type { PhenomenonDef } from "./phenomenon.js";
import { PhenomenonRegistry } from "./phenomenon.js";

// The stock descriptors' métier glyphs are NOT in the core atlas — register them
// EXPLICITLY before compiling, so the stock defs (and `extends: "cb"`) resolve their
// `atlas:` icons. A preset profile inlines the same `glyphs` for self-sufficiency.
registerExtensions({ glyphs: STOCK_GLYPHS });

// ALL EIGHT built-ins are pure-JSON descriptors compiled by the interpreter
// (see PROFILES.md) — runtime-identical to the old hand-written
// defs, and the living documentation of the descriptor format. Only the jet needs
// code: its `jet-barbs` decorator, the flagship NAMED EXTENSION (pre-registered
// by its descriptor module through the same registry a host would use).
export const volcano: PhenomenonDef = defFromDescriptor(VOLCANO_DESCRIPTOR);
export const tropicalCyclone: PhenomenonDef = defFromDescriptor(TROPICAL_CYCLONE_DESCRIPTOR);
export const radioactive: PhenomenonDef = defFromDescriptor(RADIOACTIVE_DESCRIPTOR);
export const tropopause: PhenomenonDef = defFromDescriptor(TROPOPAUSE_DESCRIPTOR);
export const turbulence: PhenomenonDef = defFromDescriptor(TURBULENCE_DESCRIPTOR);
export const icing: PhenomenonDef = defFromDescriptor(ICING_DESCRIPTOR);
export const cb: PhenomenonDef = defFromDescriptor(CB_DESCRIPTOR);
export const jetStream: PhenomenonDef = defFromDescriptor(JET_STREAM_DESCRIPTOR);

/** All built-in phenomenon defs, in toolbar order. */
export const BUILTIN_PHENOMENA = [jetStream, cb, icing, turbulence, tropopause, volcano, tropicalCyclone, radioactive];

/** A fresh registry preloaded with the built-in phenomena. */
export function defaultRegistry(): PhenomenonRegistry {
  return new PhenomenonRegistry(BUILTIN_PHENOMENA);
}
