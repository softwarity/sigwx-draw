# What's tested

Concise map of the test suite. **164 tests, 5 files**, all headless (Vitest, no browser): the
controller runs against a `MockAdapter` with a trivial linear projection, so even map interactions
(drag, draw, erase) are exercised without a real engine.

```bash
npx vitest run                 # the whole suite
npx vitest run test/<file>     # one file
```

The suite is layered the way the code is — pure `core/` units first, the controller on top:

| File | Layer | What it pins down |
|---|---|---|
| `test/geometry.test.ts` | `core/decorate` (pure) | Ring/vertex **flat outer+hole indexing** (the eraser/holes invariant), plus `segDist` / `zoneSpanRatio` / `nearestArea`. |
| `test/fl-layers.test.ts` | `core/fl` (pure) | **Multi-layer FL band math**: bottom-up slices, centred default, butt-against-the-stack, snap-to-5 & clamp. |
| `test/decorate.test.ts` | `core` decorators (pure) | Each phenomenon's geometry output: wind barbs, scallops, jet break-points / change-bars / depth, CB & turbulence call-outs, tropopause spot vs contour, fronts (hemisphere pips), FL `beyond` (XXX vs clamp), metadata defaults & validation. |
| `test/descriptor.test.ts` | `core/descriptor` framework | Profile `objects` resolution (stock name / inline, no `extends`), descriptor validation (unknown glyph/action fails fast), the profile JSONs ARE the source (glyphs are `svgs/` references), movable line label, tropopause box shapes. |
| `test/controller.test.ts` | `map/sigwx-draw` (the controller, via `MockAdapter`) | End-to-end behaviour: draw/select/drag, call-out anti-collision & declutter, multi-area, eraser/holes, marker widgets, the multi-layer GAUGES editor, `setProfile` live re-ingestion, tropopause gesture (spot vs contour), per-profile symbol sprites. |

## Conventions

- **Pure-first**: a behaviour that can be a `core/` unit (geometry, FL math, descriptor compile)
  is tested there, NOT through the controller — faster, and it documents the invariant in isolation.
  The two newest files (`geometry`, `fl-layers`) exist because that logic was extracted OUT of the
  controller for exactly this reason.
- **`MockAdapter`** (in `test/controller.test.ts`) is the seam: a linear lon/lat→pixel projection +
  in-memory overlays/widgets, so controller logic is verified with zero engine coupling. Real-mouse,
  real-engine behaviour (sprite rasterization, 3-engine parity) is checked separately with a
  Playwright smoke against the demo (`--use-gl=angle --use-angle=swiftshader`), not in this suite.

## Beyond Vitest (build-time guards)

- `npm run build` → `tsc` strict (the type contract) + `build-atlas.mjs`, which **validates** every
  `atlas:<name>` an object wires is declared in `glyphs`, and reports any unreferenced `svgs/` bank file.
- `cd demo && npx tsc -p tsconfig.app.json --noEmit` → the Angular demo still type-checks against the lib.
