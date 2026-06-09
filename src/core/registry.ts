/** The built-in phenomenon registry (jet, CB, icing, turbulence, tropopause). */
import { cb } from "./phenomena/cb.js";
import { icing } from "./phenomena/icing.js";
import { tropopause } from "./phenomena/tropopause.js";
import { turbulence } from "./phenomena/turbulence.js";
import { jetStream } from "./phenomena/jet-stream.js";
import { PhenomenonRegistry } from "./phenomenon.js";

export { cb, icing, jetStream, tropopause, turbulence };

/** All built-in phenomenon defs, in toolbar order. */
export const BUILTIN_PHENOMENA = [jetStream, cb, icing, turbulence, tropopause];

/** A fresh registry preloaded with the built-in phenomena. */
export function defaultRegistry(): PhenomenonRegistry {
  return new PhenomenonRegistry(BUILTIN_PHENOMENA);
}
