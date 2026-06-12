# Writing your own profile

A **profile** is the single way to configure a SIGWX chart. It is one self-contained
JSON file — the whole chart definition — and it is the only thing you feed the library:

```ts
import { SigwxDraw } from "@softwarity/sigwx-draw";
import profile from "./my-chart.json" with { type: "json" };

new SigwxDraw({ adapter, profile });          // or, live: sigwx.setProfile(profile)
```

Because it is plain JSON it is storable, **CDN-publishable**, and editable by a backend —
`new SigwxDraw({ adapter, profile: await (await fetch(url)).json() })`. No code travels in
it: behaviour is referenced **by name only** (see *Named extensions*).

The fastest start is to **clone the bundled `wafs.json`** (`@softwarity/sigwx-draw/profiles/wafs.json`),
change what you need, and inject it.

---

## 1. The shape of a profile

```jsonc
{
  "schemaVersion": 1,
  "id": "my-chart",                                  // tagged onto save()'s FeatureCollection
  "vertical": { "min": 250, "max": 600, "unit": "fl" }, // THE flight-level bounds (see §2)
  "callouts": { "minZoneFraction": 0.15 },           // chrome-declutter threshold

  "glyphs": {                                        // inline icon atlas (see §5)
    "cb": "<svg viewBox='0 0 24 24'>…</svg>"
  },

  "objects": [ /* the tools — §3 */ ],
  "tools":   [ /* the palette — §4 */ ]
}
```

`vertical` is the **source of the FL bounds**: a phenomenon's `fl` fields carry only a
métier *default*; the chart clamp comes from here. That is what lets a HL chart (FL250–600)
and a ML chart (FL100–450) share the same descriptors untouched — only `vertical` differs.

Validate the whole file against the shipped JSON Schema (`PROFILE_JSON_SCHEMA`,
exported from the package) before serving it.

---

## 2. `objects` — the tools, three forms

Each entry is a tool (phenomenon). One composition rule, three forms:

```jsonc
"objects": [
  "cb",                                              // (a) a STOCK descriptor, as-is
  { "extends": "cb",                                 // (b) stock ref + deep-merge PATCH
    "style": { "color": "#0a7d22" },                 //     (patch wins; keyed-array patches
    "fields": { "baseFL": { "default": 30 } } },     //      address fields/options/satellites by id)
  { "schemaVersion": 1, "type": "fog", "…": "…" }    // (c) a FULL inline descriptor (yours)
]
```

- **Stock name** — the eight built-ins: `jetStream`, `cb`, `icing`, `turbulence`,
  `tropopause`, `volcano`, `tropicalCyclone`, `radioactive`.
- **`extends` patch** — deep-merge over a stock descriptor. Plain objects merge key by key
  (patch wins); **keyed arrays** (fields by `key`, enum options by `value`, satellites by
  `part`) take an object patch keyed by those ids; anything else is replaced.
- **Inline descriptor** — a full object (see §3). The bundled `wafs.json` inlines all eight,
  so it is a complete worked example.

> A profile WITH `objects` defines the **whole** palette: the registry becomes exactly its
> objects. Removing a tool from `objects` removes it from the chart.

---

## 3. Anatomy of a descriptor

```jsonc
{
  "schemaVersion": 1,
  "type": "cb",                         // registry key
  "label": "Cumulonimbus (CB)",
  "icon": "atlas:cb",                   // a glyph ref (§5) — defaults to atlas:{type}

  "gesture": {                          // how it is drawn
    "primitive": "polygon",             // point | polyline | polygon
    "draw": "lasso",                    // lasso | drop | click-path | lasso-or-spot
    "smooth": true,
    "multiArea": true,                  // the card's + button (draw a linked area)
    "erasable": true,                   // the card's − button (rub a hole)
    "default": "regular-polygon"        // named geometry generator (drop/fallback)
  },

  "fields": [                           // the metadata schema (métier DEFAULTS only)
    { "key": "coverage", "kind": "enum",
      "options": [ { "value": "OCNL", "label": "OCNL — occasional", "meta": { "bufr": 10 } } ] },
    { "key": "baseFL", "kind": "fl", "default": 250 },
    { "key": "topFL",  "kind": "fl", "default": 400 }
    // a field may carry  "when": { "field": "speed", "gte": 120 }  (declarative visibility)
  ],
  "flBeyond": ["xxx", "xxx"],           // off-chart → the "XXX" sentinel per bound

  "render": {                           // UNSELECTED rendering
    "edge": { "treatment": "scallop", "width": 2 },  // scallop | dash | ticks | plain | none
    "fill": { "opacity": 0.12 },
    "callout": {
      "anchor": "largest-area-centroid",
      "leader": "lightning",            // lightning | straight | none
      "arrow": true,
      "content": ["{coverage|stack}", "CB", "{topFL|flx:top}", "{baseFL|flx:base}"]
    }
    // areas can carry  "ink": { "byField": "symbol", "map": { "SEV": "sev", "*": "mod" } }
    // a polyline tool's rendering is a NAMED decorator: "decorations": [{ "use": "jet-barbs", … }]
  },

  "card": {                             // the SELECTED panel (replaces the call-out)
    "framed": true,                     // true | false | "when-named"
    "items": [
      { "carousel": { "field": "coverage", "label": "{value|stack}\nCB" } },
      { "text": "{topFL|flx:top}" }, { "text": "{baseFL|flx:base}" }
    ],
    "buttons": [
      { "place": "h-edges", "action": "draw_and_link", "svg": "atlas:plus" },
      { "place": "left",    "action": "erase",         "svg": "atlas:minus" }
    ]
  },
  "satellites": [                       // floating control cards (ids featureId#part)
    { "part": "gauge", "anchor": "callout", "pin": "flRef", "side": "right",
      "items": [ { "gauge": { "cursors": ["baseFL", "topFL"] } } ] }
  ],

  "style":   { "color": "#d1242f", "area": { "opacity": 0.12 }, "text": { "halo": "#ffffff" } },
  "summary": "{coverage} CB {topFL|fl}/{baseFL|fl}",
  "declutter": { "chrome": true }       // or { "late": ["arrowhead"] } / "never"
}
```

### Bindings & formats
`{field|format:arg}` interpolates metadata. Built-in formats: `fl` (FLnnn), `flx:base|top`
(off-chart → `XXX`), `stack` (spaces→newlines), `strip:PREFIX`, `round`, `pad3`,
`maxof:field` (max of a list field), `raw`.

### Card items
`text` · `glyph` · `input` (a bound `<input>`, e.g. a marker name) · `coord` (auto lat/long)
· `carousel` (cycles an enum field) · `gauge` (1–2 FL cursors at feature level, or a
break-point gauge: a core cursor + an `extent` pair → up to 3) · `dial` (a numeric
break-point field). Satellites anchor at `callout` /
`geometry-mid` / `break-point`.

---

## 4. `tools` — the palette

```jsonc
"tools": [
  "jetStream", "cb", "icing", "turbulence", "tropopause",
  { "group": "Markers", "icon": "atlas:volcano",
    "items": ["volcano", "tropicalCyclone", "radioactive"] }
]
```

A string is a flat toolbar button; a `{ group, icon?, items }` entry is a split-button
submenu (the trigger mirrors the last-picked child). Order is the toolbar order.

---

## 5. Glyphs — the inline atlas

Every icon is referenced by name (`"atlas:cb"`) and resolved from the merged atlas:
the engine chrome (`plus`/`minus`) + your profile's `glyphs` section + any host
`registerExtensions({ glyphs })`. So **your icons travel inside the profile**:

```jsonc
"glyphs": {
  "cb": "<svg viewBox='0 0 24 24'>…</svg>",        // single-quoted attributes → escape-free JSON
  "fog": "<svg viewBox='0 0 24 24'>…</svg>"
}
```

Art is normalized inner SVG (`viewBox`, `currentColor`, no width/height — the slot dresses
it). Declarative variants exist: `"glyph": { "byHemisphere": { "n": "atlas:tc-nh", "s": "atlas:tc-sh" } }`.
A reference may also be an inline `"<svg…>"` (host prototyping).

---

## 6. Named extensions — when JSON isn't enough

A profile references behaviour **by name, never code** (CSP-safe, CDN-servable). The few
truly-custom cases (a bespoke decorator like the jet's barbs, a host action, a new format)
are registered **before** ingestion and referenced by name:

```ts
import { registerExtensions, SigwxDraw } from "@softwarity/sigwx-draw";

registerExtensions({
  decorators: { "my-decorator": (input, params) => [ /* render features */ ] },
  actions:    { "open-briefing": (feature) => myApp.open(feature) },
  formats:    { "kt": (v) => `${Math.round(Number(v))} kt` },
  glyphs:     { "fog": "<svg …>" },
  generators: { "blob": (center, span) => ({ /* geometry */ }) },
  conditions: { "is-embedded": (m) => m.coverage === "EMBD" },
});
```

An unknown name fails at compile/ingest time, listing the available ones. 7 of the 8 WAFS
phenomena need **zero** custom code; only the jet uses one decorator.

---

## 7. Inject & iterate

```ts
new SigwxDraw({ adapter, profile });   // at construction (omit ⇒ the bundled `wafs` preset)
sigwx.setProfile(profile);             // live: recompiles + re-renders, keeps the drawing
```

The demo's **✎ edit drawer** is exactly this loop: it mutates the profile object and calls
`setProfile` on every change, then hands you the file via **Download**.

---

## See also

- `PROFILE_JSON_SCHEMA` / `DESCRIPTOR_JSON_SCHEMA` — exported from the package for editor
  autocompletion and backend validation.
- `BUILTIN_DESCRIPTORS` — the eight stock descriptors as data (the living reference).
