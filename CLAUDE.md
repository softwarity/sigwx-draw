# sigwx-draw — working notes

Headless lib for drawing aeronautical SIGWX charts (WAFS SWH now, TEMSI next) on top of
`@softwarity/draw-adapter` (3 engines: MapLibre / OpenLayers / Leaflet).
**Talk to François in French**; code / comments / UI in English. (Self-note: terse English + abbrev.)

## Non-negotiable rules

- **Scope sigwx-only**: NEVER touch `../sigmet-draw` (not even its dep) unless told explicitly.
- **Adapter changes don't happen here**: write a spec+acceptance request for François (he has a
  dedicated adapter agent), `pbcopy` it AND print it.
- **No form** (removed): all metadata editing is INLINE on the map (card widgets, gauges, pickers).
  Never re-propose a form.
- **Demo playground**: always non-default values (else the effect is invisible).
- **Deps**: bump via `npm install pkg@ver` — NEVER `npm pkg set` (desyncs lock → CI `npm ci` fails).
  Verify with `npm ci`.
- **Release**: François pushes/releases (`.github/workflows/`). I maintain `RELEASE_NOTES.md`
  "NEXT RELEASE" section.

## Dev loop & verify

```bash
npm run build                                       # build:stock → tsc strict → build:profiles
npx vitest run                                      # suite (see TESTING.md = 1-screen map of what's tested)
cd demo && npx tsc -p tsconfig.app.json --noEmit   # Angular demo type-check
```
- **Demo** = Angular app in `demo/` (port **4211**, `cd demo && npm start`), NOT Vite. Stale bundle →
  `touch demo/src/app/showcase/showcase.component.ts`, wait ~8-10 s.
- **Adapter under dev**: no copy into node_modules. `tsconfig` (lib + demo) already map
  `@softwarity/draw-adapter` (+subpaths) → `../draw-adapter/dist` first (node_modules = fallback).
  So an adapter rebuild is picked up directly. ⚠️ Angular watch does NOT watch `../../draw-adapter/dist`
  → after an adapter rebuild, force re-bundle (`touch showcase.component.ts` or restart dev server).
- **Headless smoke**: Playwright (`playwright-core`, `channel:"msedge"`,
  `--use-gl=angle --use-angle=swiftshader`), viewport **1400×1000** (720 cuts buttons → clicks in the
  void), use **real** `p.mouse.click/move` (`dispatchEvent` lies, esp. on MapLibre).
  Controller: `window.ng.getComponent(document.querySelector("app-showcase")).sigwx`.
- ⚠️ Never `perl -i` on template-literal code (`${}` silently eaten) → use Edit or python heredoc.
  `save()` returns the **LIVE** geometry (capture before a drag in tests).

## Architecture

⚠️⚠️ **GOLDEN RULE: JSON is the source, TS holds ONLY extensions.** No business data (descriptor,
glyph, catalog) lives in TS — it lives in `.json` profiles. TS may only contain: the engine, the
**named render decorators** (`src/core/extensions/jet-barbs.ts`, `…/front-symbols.ts` — drawing the
JSON can't carry), and **dataless** runtime builders (they READ the base from JSON). Before creating
a phenomenon `.ts`: **STOP**, it's a JSON profile.

- `src/core/` pure (testable mapless): `phenomenon.ts` (PhenomenonDef, FieldSchema, WidgetInput),
  `registry.ts` (registers decorators+glyphs, compiles builtins FROM JSON — registers
  `jet-barbs`+`front-symbols`), `decorate/` (pure geometry: scallop/ticks/barbs/geo + `rings.ts` =
  ring/vertex flat outer+hole indexing for the eraser), `fl/layers.ts` (pure multi-layer FL band
  math), `descriptor/` (the framework: types/extensions/atlas/template/interpret/schema), `descriptors/` = **3 MECHANICS
  files, zero data**: `stock.ts` (reads `wafs.json`+`temsi-euroc.json` via `with {type:"json"}`,
  DERIVES `BUILTIN_DESCRIPTORS`/`STOCK_GLYPHS`), `builders.ts` (`makeCb`/`makeTurbulence`/`makeIcing`
  — clone the JSON base, swap only options; `DEFAULT_*` re-read from JSON), `index.ts` (barrel +
  `*_DESCRIPTOR` aliases pointing at JSON + `resolveObjectSpec`). `phenomena/util.ts` (helpers).
- `src/map/sigwx-draw.ts` = THE controller (collection, selection, drags, call-out placement +
  anti-collision, declutter, multi-area, eraser, widgets).
- `src/profiles/` : one PURE `.json` per profile = **THE source** (not a copy), all self-contained:
  `wafs.json` (8 WAFS), `temsi-france.json` (ground→FL150), `temsi-euroc.json` (ground→FL450).
  Each inlines its full descriptors + `glyphs` atlas + `sprites` atlas + grouped `tools` + `vertical`.
  Cloning the file is enough to edit buttons/styles/fields or add a phenomenon; CDN-servable alone.
  Duplication BETWEEN json profiles (cb rewritten in each) is ASSUMED & DELIBERATE — **inheritance =
  file duplication, there is NO `extends`** (an integrator ships only the one profile it needs);
  TS↔JSON duplication is FORBIDDEN. Subpaths `./profiles/<id>` and `./profiles/<id>.json` → same file.
  Default loaded dynamically in `ready()`. FL bounds resolution: `flightLevel` → fallback `vertical` →
  engine default (in `flResolved`). Profile ingestion: `SigwxProfile` carries `objects` (stock NAME /
  full inline — `resolveObjectSpec`, no patch/merge), `glyphs` (button/marker atlas, merged BEFORE
  compilation), `sprites` (the recolourable SYMBOL atlas — code → SVG: turbulence MOD/SEV, icing ICE_*,
  CB coverage — registered per profile, none baked in the lib), grouped `tools`, `callouts.minZoneFraction`.
  ⚠️ `sideEffects:false` — extension registration is ALWAYS explicit.

### Glyph atlas `svgs/`
- `svgs/**/*.svg` = **THE source** of glyph SVGs (viewable AND JS-readable; ICAO Annex 3 set + project
  glyphs; `currentColor`). By role: `svgs/buttons/` (toolbar/selection icons) and `svgs/wmo/<family>/`
  (WMO MAP symbols). ⚠️ **button ≠ map symbol** (two distinct uses, not duplicates).
- Build scans **recursively** → folder is cosmetic, reference by **bare name**. A profile references by
  name (`atlas:<name>`, or an object's `type` → its default icon `atlas:<type>`).
  ⚠️ **NO inline `icon`/`glyphs` SVG in `src/profiles/*.json`** — ALL references. The `glyphs` section
  holds bank PATHS, not SVG: `"glyphs":{"cb":"buttons/cb.svg","rain":"wmo/precipitation/rain.svg"}`.
  Colored fronts/pressure/isotherm = referenced bank files too (e.g. `buttons/frontCold.svg`).
- `scripts/build-atlas.mjs --dist` (= `npm run build:profiles`, after tsc) inlines each ref as SVG into
  `dist/profiles/*.json` (self-contained) — `src/` is NEVER modified. It also validates every
  object-wired `atlas:X` has its ref declared in `glyphs` (else warning) and lists unreferenced bank
  files (bank must hold ONLY what's used). Edit an icon = edit the `.svg` in `svgs/`.
- **Stock**: `npm run build:stock` (before tsc) generates `src/core/descriptors/stock-glyphs.json` =
  exactly the glyphs `wafs.json` (default profile) references → imported by `stock.ts` (`STOCK_GLYPHS`).
  ⚠️ "stock" is defined by `wafs.json`, NOT by `svgs/buttons/`: adding a TEMSI button icon there does
  NOT bloat the lib. WMO + TEMSI icons stay OUT of the lib (embedded in a profile only if referenced).
  Engine chrome `plus`/`minus` comes from core (`descriptor/atlas.ts`), never from `svgs/`.
- **Build chain**: `build:stock` → `rm -rf dist && tsc` (copies `src/profiles/*.json` VERBATIM = refs)
  → `build:profiles` (`--dist`, inlines dist profiles + copies stock-glyphs.json). ⚠️ An orphan `tsc`
  leaves `dist/profiles` as refs → demo with NO icons; always run full `npm run build` (or
  `npm run build:profiles` to re-inline fast). `catalog.json` + `usage.html` removed.
  Bank source: OGCMetOceanDWG/WorldWeatherSymbols (CC-BY 3.0) in
  `/Users/francois/Workspaces/Externals/WorldWeatherSymbols`; re-sync `scripts/fetch-symbols.mjs`.

### Widgets & interaction
- **WMO point palette (family C)**: in temsi profiles = 9 `wmo-<family>` category markers
  (visibility/convective/turbulence/icing/relief/precipitation/cyclone-pressure/fronts/hazards), each
  = point/drop + `symbol` enum + a **picker** in the card → drop the category, pick the symbol ON the
  map (glyph folded when unselected, picker on selection). Button `{group:"WMO", items:[...]}`.
  Picker replaces carousel: **`control:"picker"` + `mode`** (carousel ≤5 / flower 6–10 / grid >10,
  auto-degrading); descriptor `{picker:{field, mode?}}` (`carousel` alias kept; `interpret` no longer
  emits `control:"carousel"`). `ToolSpec` is recursive (`ToolGroupSpec.items: ToolSpec[]`), nested
  submenus available. NB: turbulence/icing/cb/fronts also exist as rich ZONES/lines (top buttons) —
  WMO point versions are extra stamps.
- **Multi-card widgets**: `def.widget(WidgetInput)` returns `MarkerWidget | MarkerWidget[] | null`;
  satellite ids suffixed `featureId#part` (strip via `widgetFeatureId()` in ALL handlers). Panel
  (replaces the canvas call-out when selected, via the `replaced` set) + satellites (FL gauge pinned
  by `flRef` frozen at selection; jet: `#dial` on the break point + `#gauge`). Gauges/dial = ADAPTER
  controls (gauge 1-3 sliders with `beyond` XXX, dial with counter label); chrome
  `SigwxStyle.control` {line,text,handle} → `color/labelColor/labelHalo/knobFill/knobStroke`.
- **onWidgetEdit routing**: coercion by schema type (fl → clamp `flGaugeRange` + pairing base≤fl≤top,
  step 5); list-scoped names `points.N.field` → regex → `updateListItem` (same clamp/pairing).
- **Holes & eraser** (shipped): inner rings = clear zones; eraser = `erase` action (cards `−` button),
  analytic capsules + `polyclip-ts` difference in REAL TIME, brush ∝ projected area; bite/split handled
  (MultiPolygon = multi-area); hole vertices editable (flat indexing `flatRings`/`ringOfFlat`);
  scallop/tick orientation by normalized CCW winding (concavity-proof); flip-scallop REMOVED;
  `clampInArea` = arrowhead mid-corridor outside holes.
- **Declutter**: render gate (zone-extent / view-span ratio, threshold 0.05 — LOW so a framed sector
  keeps its drawn areas, hysteresis ±10%, selection disables); `declutter:"late"` (jet arrowhead
  survives half the threshold).
- **Multi-area**: `+` (h-edges) → `appendTo` consumed at commit; `selectedAreas` (shift-click); box
  never follows a partial drag; per-area deletion. **N arrows = N areas** (a surplus arrow = unexpected
  MultiPolygon). Anti-micro-polygon guard: lasso < 24 screen px = cancelled.

## Status & next

Declarative framework + JSON profile = **SHIPPED** (steps 1-5 done): `defFromDescriptor` + registries
+ `DESCRIPTOR_JSON_SCHEMA`; the 8 phenomena are JSON descriptors; named decorators (`jet-barbs`,
`front-symbols`) are the only render extensions; JSON is the single source (`BUILTIN_DESCRIPTORS`/
`STOCK_GLYPHS` derived). Profile = the single ingestion unit (self-contained JSON, npm/CDN-publishable,
`new SigwxDraw({profile})` and the lib does the rest). Absolute rule: **names, never code, in JSON.**

**Next**: TEMSI objects — always JSON, a `.ts` extension ONLY if a render can't be expressed in JSON.
Multi-layer cloud editor (multi-band FL gauge) = SHIPPED (OpenProject WP #171-173). Known gap: on-map
render of "above surface" fronts (`frontXAloft` — buttons OK, render KO).

## Domain knowledge (hard-won, NOT in code; ICAO Annex 3 Model SN, confirmed by met agent)

- **Scallop = GENERIC envelope** of a "significant weather area" — NOT "a CB". The edge encodes only
  the broad family (scallop = SW/CB; dashed = turbulence/CAT/icing/visibility/sand/obscuration; solid =
  ash). **What distinguishes a zone = the embedded symbol + FL label + color** (TEMSI convention),
  not the edge.
- **CB = a COMPOSITION**: `amount × type × base/top FL`. Cloud amount = FEW/SCT/BKN/OVC; CB amount =
  ISOL/OCNL/FRQ/EMBD (EMBD = "embedded" qualifier, NOT a phenomenon); type =
  CI/CC/CS/AC/AS/NS/SC/ST/CU/CB. ⚠️ "TS" doesn't exist (thunder implied by CB; squall line = LINE).
- **`sigwxArea` (temsi)** = one scalloped layer: `type` (CI…CB, picker) + `amount` (picker) + base/top
  FL. ⚠️ `amount` is a **conditional-options enum `optionsBy`**:
  `{field:"type", map:{CB:[ISOL,OCNL,FRQ,EMBD], "*":[FEW,SCT,BKN,OVC]}}`. Resolved **lib-side** at
  render (`liveOptions` in `interpret.ts`), value coerced if invalid; controller **resets** the
  dependent when `type` changes (`onWidgetEdit`). Adapter sees only resolved options.
  `EnumField.optionsBy` is in the compiled schema.
- **Multi-layer (SHIPPED)**: param `layers=N` → a `list` field of layers, edited as the active layer's
  flat card + a side multi-band FL gauge (one band per layer); `repeat`/`listField` route
  add/remove/select. Nesting via `WidgetBox ∈ WidgetNode`; list routing `points.N.field`. (Built on the
  existing list + gauge, NOT a new adapter "accordion".)

## References

- **Adapter specs are EPHEMERAL**: I write `../<TOPIC>-SPEC.md`, `pbcopy` + print it; François
  implements then DELETES it. So NEVER link a spec file here (the link rots) — track pending adapter
  work as PROSE. Pending now: (1) blur/dim AROUND a chart-area frame (`highlightArea` +
  `blurOutside`/`dimOutside`); (2) sticky `viewArea` — re-frame the area on fullscreen / container
  resize instead of zooming to fill.
- WAFC reference PDFs (the full guide §4 = phenomena roadmap) — read via `pdftotext`; under
  `~/Workspaces/Documents/Weather/sigwx/`.
- Eraser icon still provisional (the `−`); definitive TBD.
