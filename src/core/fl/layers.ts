/**
 * Multi-layer FL band ARITHMETIC — pure, map-free (the TEMSI cloud-layer stack, WP #171-173).
 *
 * A layer-stack area (`repeat`) partitions the resolved flight-level range `[min, max]` into up
 * to `n = repeat.max` bands, all 5-FL snapped (ICAO 500-ft steps). The controller owns the
 * RESOLUTION (which `[min, max]` a phenomenon uses, via the profile `vertical` / per-phenomenon
 * bounds) and the document plumbing; these functions own only the band MATH, so the load-bearing
 * placement rules (bottom-up slices, centred default, butt-against-the-stack, snap & clamp) are
 * unit-testable without a controller or a map. All callers pass an already-resolved `(min, max, n)`
 * with `min < max` and `n >= 1`.
 */
import type { FieldSchema, Metadata } from "../phenomenon.js";

/** A layer's altitude for sorting the stack highest-on-top: its top FL, else its base, else 0. */
export function layerAltitude(item: Metadata): number {
  const top = typeof item["topFL"] === "number" ? (item["topFL"] as number) : undefined;
  const base = typeof item["baseFL"] === "number" ? (item["baseFL"] as number) : undefined;
  return top ?? base ?? 0;
}

/** The bottom/top FL field keys of a stack layer: base = the FL field matching /base/, top = /top/
 *  (falling back to schema order). `null` when the item schema has fewer than two FL fields, or both
 *  resolve to the same key. */
export function layerFlKeys(itemSchema: FieldSchema[]): [string, string] | null {
  const fls = itemSchema.filter((s) => s.type === "fl");
  if (fls.length < 2) return null;
  const base = fls.find((s) => /base/i.test(s.key)) ?? fls[0]!;
  const top = fls.find((s) => /top/i.test(s.key)) ?? fls[1]!;
  return base.key === top.key ? null : [base.key, top.key];
}

/** The `index`-th of `n` equal 5-FL-snapped slices of `[min, max]`, bottom-up: the FIRST layer takes
 *  the bottom 1/n and leaves the rest of the axis free instead of spanning it all. `null` when a slice
 *  would round to zero height. */
export function sliceBand(min: number, max: number, n: number, index: number): { base: number; top: number } | null {
  const h = Math.round((max - min) / n / 5) * 5;
  if (h <= 0) return null;
  const k = Math.max(0, Math.min(n - 1, index));
  const base = min + k * h;
  return { base, top: k === n - 1 ? max : Math.min(max, base + h) };
}

/** One 1/n-tall (≥ 5 FL) slice CENTRED on the mid-altitude of `[min, max]` — leaving room above AND
 *  below so either `+` works straight away. */
export function centeredBand(min: number, max: number, n: number): { base: number; top: number } {
  const h = Math.max(5, Math.round((max - min) / n / 5) * 5);
  const base = Math.max(min, Math.min(max - h, Math.round(((min + max) / 2 - h / 2) / 5) * 5));
  return { base, top: base + h };
}

/** A default-height (1/n, ≥ 5 FL) band CENTRED on `fl`, 5-FL snapped and clamped wholly inside
 *  `[min, max]` (shifted in if `fl` sits near a bound). */
export function bandAround(min: number, max: number, n: number, fl: number): { base: number; top: number } {
  const h = Math.min(max - min, Math.max(5, Math.round((max - min) / n / 5) * 5));
  const c = Math.round(Math.max(min, Math.min(max, fl)) / 5) * 5;
  let base = Math.round((c - h / 2) / 5) * 5;
  if (base < min) base = min;
  if (base + h > max) base = max - h;
  return { base, top: base + h };
}

/** The FL band a NEW layer takes when added on `side`: a 1/n (≥ 5 FL) slice butting against the
 *  current stack — ABOVE its highest `top` (`"top"`) or BELOW its lowest `base` (`"bottom"`), clamped
 *  into `[min, max]`. `tops`/`bases` are the existing layers' resolved top/base FLs (empty = first
 *  layer ⇒ a bottom slice). */
export function adjacentBand(
  min: number,
  max: number,
  n: number,
  tops: number[],
  bases: number[],
  side: "top" | "bottom",
): { base: number; top: number } {
  const h = Math.max(5, Math.round((max - min) / n / 5) * 5);
  if (!tops.length) return { base: min, top: Math.min(max, min + h) };
  if (side === "top") {
    const base = Math.min(max - 5, Math.max(...tops));
    return { base, top: Math.min(max, base + h) };
  }
  const top = Math.max(min + 5, Math.min(...bases));
  return { base: Math.max(min, top - h), top };
}
