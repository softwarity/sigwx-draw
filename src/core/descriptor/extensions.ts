/**
 * Named-extension registries — the ONLY way code plugs into descriptors. A
 * descriptor references behaviour by NAME (never embeds code: a CDN-served
 * profile must stay inert data); the lib's built-ins are pre-registered through
 * the same mechanism, and hosts add theirs via {@link registerExtensions}
 * BEFORE ingesting a profile. Unknown names fail fast, listing the available
 * ones (the JSON-Schema-style error the spec mandates).
 */
import type { Geometry } from "geojson";

import type { LatLng } from "../coord.js";
import type { DecorationInput, Metadata, RenderFeature } from "../phenomenon.js";
import { regularPolygon } from "../phenomena/util.js";
import { BUILTIN_GLYPHS } from "./atlas.js";
import type { DescriptorCondition } from "./types.js";

// ── Extension shapes ──────────────────────────────────────────────────────────

/** A named decorator: the descriptor's `decorations[].use` (the jet's barbs). */
export type DecoratorExtension = (input: DecorationInput, params: Record<string, unknown>) => RenderFeature[];

/** A named value format for `{field|name}` bindings. `arg` is the optional
 *  `{field|name:arg}` suffix; `ctx` carries the resolved chart FL bounds. */
export type FormatExtension = (value: unknown, ctx: FormatContext, arg?: string) => string;

export interface FormatContext {
  metadata: Metadata;
  flightLevel?: { min?: number; max?: number; beyond?: [string, string] } | undefined;
}

/** A named condition (beyond the declarative field comparisons). */
export type ConditionExtension = (metadata: Metadata) => boolean;

/** A named default-geometry generator (drop mode / draw fallback). */
export type GeneratorExtension = (center: LatLng, viewSpan: number) => Geometry;

/** A named card action: the WIDGET EVENT it emits (engine actions are built in;
 *  a host action's event reaches the host through `onWidgetAction`). */
export type ActionExtension = string;

export interface SigwxExtensions {
  decorators?: Record<string, DecoratorExtension>;
  actions?: Record<string, ActionExtension>;
  formats?: Record<string, FormatExtension>;
  /** Atlas entries: normalized `<svg viewBox=…>` art, `currentColor`. */
  glyphs?: Record<string, string>;
  conditions?: Record<string, ConditionExtension>;
  generators?: Record<string, GeneratorExtension>;
}

// ── The registries (module-level: one vocabulary per runtime) ─────────────────

const decorators = new Map<string, DecoratorExtension>();
const actions = new Map<string, ActionExtension>();
const formats = new Map<string, FormatExtension>();
const glyphs = new Map<string, string>(Object.entries(BUILTIN_GLYPHS));
const conditions = new Map<string, ConditionExtension>();
const generators = new Map<string, GeneratorExtension>();

/** Register host extensions (merged over the built-ins; the last write wins). */
export function registerExtensions(ext: SigwxExtensions): void {
  for (const [k, v] of Object.entries(ext.decorators ?? {})) decorators.set(k, v);
  for (const [k, v] of Object.entries(ext.actions ?? {})) actions.set(k, v);
  for (const [k, v] of Object.entries(ext.formats ?? {})) formats.set(k, v);
  for (const [k, v] of Object.entries(ext.glyphs ?? {})) glyphs.set(k, v);
  for (const [k, v] of Object.entries(ext.conditions ?? {})) conditions.set(k, v);
  for (const [k, v] of Object.entries(ext.generators ?? {})) generators.set(k, v);
}

function lookup<T>(map: Map<string, T>, name: string, what: string): T {
  const v = map.get(name);
  if (v === undefined) {
    throw new Error(`Unknown ${what} "${name}". Available: ${[...map.keys()].sort().join(", ") || "(none)"}`);
  }
  return v;
}

export const getDecorator = (name: string): DecoratorExtension => lookup(decorators, name, "decorator");
export const getAction = (name: string): ActionExtension => lookup(actions, name, "action");
export const getFormat = (name: string): FormatExtension => lookup(formats, name, "format");
export const getGenerator = (name: string): GeneratorExtension => lookup(generators, name, "geometry generator");
export const hasGlyph = (name: string): boolean => glyphs.has(name);

/** Resolve a glyph reference: `atlas:name` → the atlas entry; `<svg…>` → as-is. */
export function resolveGlyph(ref: string): string {
  if (ref.startsWith("<svg")) return ref;
  const name = ref.startsWith("atlas:") ? ref.slice(6) : ref;
  return lookup(glyphs, name, "atlas glyph");
}

// ── Conditions: declarative comparisons compiled, named ones looked up ────────

/** Compile a declarative condition into the `visibleWhen` predicate shape. */
export function compileCondition(c: DescriptorCondition): ConditionExtension {
  if ("named" in c) return lookup(conditions, c.named, "condition");
  const { field, gte, lte, eq } = c;
  return (m: Metadata): boolean => {
    const v = m[field];
    if (eq !== undefined) return v === eq;
    const n = typeof v === "number" ? v : Number(v ?? NaN);
    if (gte !== undefined && !(n >= gte)) return false;
    if (lte !== undefined && !(n <= lte)) return false;
    return gte !== undefined || lte !== undefined;
  };
}

// ── Built-in extensions (pre-registered: one mechanism, two origins) ──────────

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
const pad3 = (v: number): string => String(Math.round(v)).padStart(3, "0");

registerExtensions({
  actions: {
    // Engine actions: the widget EVENT the controller already routes.
    draw_and_link: "draw-more",
    erase: "erase",
    // Inert placeholder: a card button that emits an event the controller ignores
    // (used for "show the button now, wire its behaviour later").
    noop: "noop",
    // Zone-level composite add/focus (the non-convective cloud's icing/turbulence): the controller
    // creates the `metadata[key]` sub-object (if absent) and focuses its glued card. `composite:<key>`.
    addIcing: "composite:icing",
    addTurb: "composite:turb",
  },
  formats: {
    /** `FLnnn` (pad-3). */
    fl: (v) => `FL${pad3(num(v))}`,
    /** Pad-3 number (no FL prefix). */
    pad3: (v) => pad3(num(v)),
    /** Raw value as text. */
    raw: (v) => String(v ?? ""),
    /** Spaces → newlines (multi-word coverages stack onto their own lines). */
    stack: (v) => String(v ?? "").replace(/ /g, "\n"),
    /** Strip a prefix from the value (`{symbol|strip:ICE_}` → `MOD`). */
    strip: (v, _ctx, arg) => (arg ? String(v ?? "").replace(arg, "") : String(v ?? "")),
    /** Rounded number. */
    round: (v) => String(Math.round(num(v))),
    /** Max of a LIST field's numeric sub-field (`{points|maxof:speed}` → the jet peak). */
    maxof: (v, _ctx, arg) => {
      const list = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
      if (!list.length || !arg) return "0";
      return String(Math.round(Math.max(...list.map((it) => num(it[arg])))));
    },
    /** FL with the off-chart sentinel: a base below the chart floor / a top above the
     *  ceiling reads `XXX` when the resolved `beyond` side says so. `arg`: `base`|`top`. */
    flx: (v, ctx, arg) => {
      const n = num(v);
      const isBase = arg !== "top";
      const min = ctx.flightLevel?.min;
      const max = ctx.flightLevel?.max;
      const off = isBase ? (min !== undefined && n < min) : (max !== undefined && n > max);
      const xxx = (ctx.flightLevel?.beyond?.[isBase ? 0 : 1] ?? "xxx") === "xxx";
      return off && xxx ? "XXX" : `FL${pad3(n)}`;
    },
    /** Like `flx` but WITHOUT the `FL` prefix — so a compact range can print `FL` once:
     *  `FL{baseFL|flxn:base}/{topFL|flxn:top}` → `FL145/250` (off-chart side → `XXX`). */
    flxn: (v, ctx, arg) => {
      const n = num(v);
      const isBase = arg !== "top";
      const min = ctx.flightLevel?.min;
      const max = ctx.flightLevel?.max;
      const off = isBase ? (min !== undefined && n < min) : (max !== undefined && n > max);
      const xxx = (ctx.flightLevel?.beyond?.[isBase ? 0 : 1] ?? "xxx") === "xxx";
      return off && xxx ? "XXX" : pad3(n);
    },
  },
  generators: {
    /** A regular polygon (closed ring) sized to the view — the area drop/fallback. */
    "regular-polygon": (c, span) => regularPolygon(c, span),
  },
});
