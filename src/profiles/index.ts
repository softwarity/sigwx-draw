/**
 * OPTIONAL chart-profile presets — `@softwarity/sigwx-draw/profiles`.
 *
 * A {@link SigwxProfile} is plain-JSON DATA (tool palette + per-phenomenon
 * catalogues/bounds + vertical reference) for ONE chart type; the engine and the
 * phenomenon defs stay profile-agnostic. ONE FILE PER PROFILE, each importable on its
 * own (so an app ships only the profile it uses, even without a bundler):
 *
 *   import WAFS_SWH from "@softwarity/sigwx-draw/profiles/wafs-swh"; // just this one
 *   import { WAFS_SWH } from "@softwarity/sigwx-draw/profiles";      // the catalogue
 *
 * A host-defined profile is simply an object conforming to {@link SigwxProfile} —
 * start from a preset and change the numbers. Coming next (see OBJECTS-ROADMAP.md):
 * TEMSI EUROC (SFC→FL450) and TEMSI France (SFC→FL150, hundreds of feet AMSL) once
 * their object families (composable zones, fronts, isotherms, the WMO atlas) land.
 */
export type { SigwxProfile } from "../map/sigwx-draw.js";

export { WAFS_SWH } from "./wafs-swh.js";
