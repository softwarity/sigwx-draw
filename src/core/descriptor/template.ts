/**
 * `{field|format:arg}` template bindings — the descriptor's ONLY interpolation
 * mechanism. A template is a plain string mixing literals and bindings:
 * `"{coverage|stack}"`, `"CB"`, `"Jet max {speed}KT"`, `"{topFL|flx:top}"`.
 * Formats are NAMED extensions (`fl`, `flx`, `stack`, `pad3`, `raw`, …).
 */
import type { Metadata } from "../phenomenon.js";
import { getFormat, type FormatContext } from "./extensions.js";

const BINDING = /\{([^}|]+)(?:\|([^}:]+)(?::([^}]+))?)?\}/g;

/** Interpolate a template over the metadata. `{#}` is the 1-based index (list items);
 *  `{value}` reads `extra.value` first (carousel option labels). */
export function evalTemplate(
  template: string,
  metadata: Metadata,
  ctx: FormatContext,
  extra?: Record<string, unknown>,
): string {
  return template.replace(BINDING, (_, key: string, fmt?: string, arg?: string) => {
    const value = extra && key in extra ? extra[key] : metadata[key];
    const format = getFormat(fmt ?? "raw");
    return format(value, ctx, arg);
  });
}

/** Does the template reference any binding at all (vs a pure literal)? */
export function hasBindings(template: string): boolean {
  BINDING.lastIndex = 0;
  return BINDING.test(template);
}
