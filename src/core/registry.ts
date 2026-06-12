/** The built-in phenomenon registry (jet, CB, icing, turbulence, tropopause, markers),
 *  compiled from the JSON-source descriptors. */
import { registerExtensions } from "./descriptor/extensions.js";
import { defFromDescriptor } from "./descriptor/interpret.js";
import { BUILTIN_DESCRIPTORS, STOCK_GLYPHS } from "./descriptors/stock.js";
import { frontSymbols } from "./extensions/front-symbols.js";
import { jetBarbs } from "./extensions/jet-barbs.js";
import type { PhenomenonDef } from "./phenomenon.js";
import { PhenomenonRegistry } from "./phenomenon.js";

// The ONLY code the stock descriptors need: the two NAMED rendering decorators (the jet's
// barbs, the fronts' pips) + the métier glyphs (toolbar / card / canvas). Registered
// EXPLICITLY before any compilation — the package is `sideEffects: false`, so a bare
// side-effect import would be pruned; these bindings are USED, so the module always ships.
// A preset profile re-inlines the same `glyphs` for self-sufficiency.
registerExtensions({
  decorators: { "jet-barbs": jetBarbs, "front-symbols": frontSymbols },
  glyphs: STOCK_GLYPHS,
});

const compile = (type: string): PhenomenonDef => defFromDescriptor(BUILTIN_DESCRIPTORS[type]!);

export const jetStream: PhenomenonDef = compile("jetStream");
export const cb: PhenomenonDef = compile("cb");
export const icing: PhenomenonDef = compile("icing");
export const turbulence: PhenomenonDef = compile("turbulence");
export const tropopause: PhenomenonDef = compile("tropopause");
export const volcano: PhenomenonDef = compile("volcano");
export const tropicalCyclone: PhenomenonDef = compile("tropicalCyclone");
export const radioactive: PhenomenonDef = compile("radioactive");

/** All built-in phenomenon defs, in toolbar order. */
export const BUILTIN_PHENOMENA = [jetStream, cb, icing, turbulence, tropopause, volcano, tropicalCyclone, radioactive];

/** A fresh registry preloaded with the built-in phenomena. */
export function defaultRegistry(): PhenomenonRegistry {
  return new PhenomenonRegistry(BUILTIN_PHENOMENA);
}
