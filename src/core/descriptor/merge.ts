/**
 * The ONE composition rule of profile `objects` (§2b): reference + PATCH —
 * deep-merge, patch wins. Pure data in, pure data out (no functions ever ride a
 * descriptor), so the merge is a plain structural recursion:
 *
 * - plain objects merge key by key (patch wins on conflicts);
 * - ARRAYS OF KEYED ITEMS (fields by `key`, enum options by `value`, satellites
 *   by `part`) accept an OBJECT patch keyed by those ids — each entry deep-merges
 *   into its matching item (`"fields": { "baseFL": { "default": 30 } }`); items
 *   not named stay as-is;
 * - anything else (scalars, arrays patched by arrays) is REPLACED wholesale.
 */
import type { PhenomenonDescriptor } from "./types.js";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The id an array item is addressed by in a keyed-object patch. */
const itemId = (item: unknown): string | undefined => {
  if (!isPlainObject(item)) return undefined;
  const id = item["key"] ?? item["value"] ?? item["part"];
  return typeof id === "string" ? id : undefined;
};

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(base) && isPlainObject(patch)) {
    // Keyed-array patch: merge each named entry into its matching item.
    return base.map((item) => {
      const id = itemId(item);
      const p = id !== undefined ? patch[id] : undefined;
      return p !== undefined ? deepMerge(item, p) : item;
    });
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch;
}

/** Apply an `extends` patch onto a stock descriptor (deep-merge, patch wins). */
export function mergeDescriptor(base: PhenomenonDescriptor, patch: Record<string, unknown>): PhenomenonDescriptor {
  const { extends: _ext, ...rest } = patch as { extends?: string } & Record<string, unknown>;
  return deepMerge(base, rest) as PhenomenonDescriptor;
}
