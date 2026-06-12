/**
 * Runtime catalogue builders — the ONLY descriptor-shaped code left, and it carries NO
 * data. Each `make*` reads its BASE descriptor from the JSON source ({@link BUILTIN_DESCRIPTORS})
 * and merely swaps ONE enum field's options for a host-supplied catalogue (a host adding
 * a turbulence type / CB coverage at runtime). The default catalogues are READ BACK from
 * the JSON too — so OCNL/FRQ, MOD/SEV, ICE_* exist exactly ONCE, in the profile JSON.
 */
import { defFromDescriptor } from "../descriptor/interpret.js";
import type { EnumFieldDescriptor, EnumOptionDescriptor, PhenomenonDescriptor } from "../descriptor/types.js";
import type { PhenomenonDef } from "../phenomenon.js";
import { BUILTIN_DESCRIPTORS } from "./stock.js";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Read an enum field's options off a stock descriptor (the JSON IS the source). */
function enumOptions(type: string, field: string): EnumOptionDescriptor[] {
  const f = BUILTIN_DESCRIPTORS[type]?.fields?.find(
    (x): x is EnumFieldDescriptor => x.kind === "enum" && x.key === field,
  );
  return f?.options ?? [];
}

/** Clone a stock descriptor, swapping ONE enum field's options + the default sprite. */
function withCatalogue(type: string, field: string, options: EnumOptionDescriptor[], sprite: string): PhenomenonDescriptor {
  const d = clone(BUILTIN_DESCRIPTORS[type]!);
  const f = d.fields?.find((x): x is EnumFieldDescriptor => x.kind === "enum" && x.key === field);
  if (f) f.options = options;
  if (d.style.symbol) d.style.symbol = { ...d.style.symbol, sprite };
  return d;
}

// ── Cumulonimbus (CB) coverage catalogue ──────────────────────────────────────

/** One CB coverage amount: `code` (stored in metadata), `label`, and the WMO BUFR
 *  0-20-008 figure for IWXXM export. The cloud type is always CB ({@link CB_CLOUD_TYPE_BUFR}). */
export interface CbCoverage {
  code: string;
  label: string;
  /** WMO BUFR table 0-20-008 "Cloud Distribution for Aviation" figure (IWXXM export). */
  bufr?: number;
}

/** WMO BUFR table 0-20-012 "Cloud Type" figure for Cumulonimbus — fixed (IWXXM export). */
export const CB_CLOUD_TYPE_BUFR = 9;

/** Current WAFC high-level CB coverage amounts, READ from the `cb` descriptor's JSON. */
export const DEFAULT_CB_COVERAGE: CbCoverage[] = enumOptions("cb", "coverage").map((o) => ({
  code: o.value,
  label: o.label ?? o.value,
  ...(typeof o.meta?.bufr === "number" ? { bufr: o.meta.bufr } : {}),
}));

/** The CB descriptor for a coverage catalogue (`coverages[0]` is the default). */
export function cbDescriptor(coverages: CbCoverage[] = DEFAULT_CB_COVERAGE): PhenomenonDescriptor {
  return withCatalogue(
    "cb", "coverage",
    coverages.map((c) => ({ value: c.code, label: c.label, ...(c.bufr !== undefined ? { meta: { bufr: c.bufr } } : {}) })),
    coverages[0]?.code ?? "OCNL",
  );
}

/** Build the CB phenomenon for a coverage catalogue (compiled descriptor). */
export function makeCb(coverages: CbCoverage[] = DEFAULT_CB_COVERAGE): PhenomenonDef {
  return defFromDescriptor(cbDescriptor(coverages));
}

// ── Turbulence symbol catalogue ───────────────────────────────────────────────

/** One entry of the turbulence symbol catalogue: a `code` (also the sprite id) + label. */
export interface TurbulenceSymbol {
  code: string;
  label: string;
}

/** The charted turbulence intensities (MOD / SEV), READ from the `turbulence` JSON. */
export const DEFAULT_TURBULENCE_SYMBOLS: TurbulenceSymbol[] = enumOptions("turbulence", "symbol").map((o) => ({
  code: o.value,
  label: o.label ?? o.value,
}));

/** The turbulence descriptor for a symbol catalogue (`symbols[0]` is the default). */
export function turbulenceDescriptor(symbols: TurbulenceSymbol[] = DEFAULT_TURBULENCE_SYMBOLS): PhenomenonDescriptor {
  return withCatalogue(
    "turbulence", "symbol",
    symbols.map((s) => ({ value: s.code, label: s.label })),
    symbols[0]?.code ?? "MOD",
  );
}

/** Build the turbulence phenomenon for a symbol catalogue (compiled descriptor). */
export function makeTurbulence(symbols: TurbulenceSymbol[] = DEFAULT_TURBULENCE_SYMBOLS): PhenomenonDef {
  return defFromDescriptor(turbulenceDescriptor(symbols));
}

// ── Icing intensity catalogue ─────────────────────────────────────────────────

/** One icing intensity: a `code` (which IS the sprite id, e.g. `ICE_MOD`) + a label. */
export interface IcingSymbol {
  code: string;
  label: string;
}

/** The charted icing intensities (MOD / SEV), READ from the `icing` descriptor's JSON. */
export const DEFAULT_ICING_SYMBOLS: IcingSymbol[] = enumOptions("icing", "symbol").map((o) => ({
  code: o.value,
  label: o.label ?? o.value,
}));

/** The icing descriptor for an intensity catalogue (`symbols[0]` is the default). */
export function icingDescriptor(symbols: IcingSymbol[] = DEFAULT_ICING_SYMBOLS): PhenomenonDescriptor {
  return withCatalogue(
    "icing", "symbol",
    symbols.map((s) => ({ value: s.code, label: s.label })),
    symbols[0]?.code ?? "ICE_MOD",
  );
}

/** Build the icing phenomenon for an intensity catalogue (compiled descriptor). */
export function makeIcing(symbols: IcingSymbol[] = DEFAULT_ICING_SYMBOLS): PhenomenonDef {
  return defFromDescriptor(icingDescriptor(symbols));
}
