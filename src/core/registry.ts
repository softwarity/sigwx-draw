/** The built-in phenomenon registry (v1 demonstrator: jet, CB, turbulence). */
import { cb } from "./phenomena/cb.js";
import { jetStream } from "./phenomena/jet-stream.js";
import { turbulence } from "./phenomena/turbulence.js";
import { PhenomenonRegistry } from "./phenomenon.js";

export { cb, jetStream, turbulence };

/** All built-in phenomenon defs, in toolbar order. */
export const BUILTIN_PHENOMENA = [jetStream, cb, turbulence];

/** A fresh registry preloaded with the built-in phenomena. */
export function defaultRegistry(): PhenomenonRegistry {
  return new PhenomenonRegistry(BUILTIN_PHENOMENA);
}
