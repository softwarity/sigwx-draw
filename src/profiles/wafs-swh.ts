/**
 * WAFS Significant Weather (SWH) — guide WAFC v2.01, 2025 style. THE DEFAULT PROFILE:
 * a `SigwxDraw` built without `profile` applies this one (the source of truth for
 * chart-specific numbers is always a profile, never scattered values), and `save()`
 * tags the document `profile: "wafs-swh"`. It is also the forkable template: a TEMSI
 * profile is this object with different numbers. The symbol catalogues (OCNL/FRQ CB
 * coverage — EMBD retired Jan 2025 — MOD/SEV turbulence & icing) live in the phenomenon
 * defs as the WMO/WAFS sets, extendable via `phenomena.cb.extraCoverages` / the
 * `turbulenceTypes` option.
 *
 * A profile is plain JSON (no functions) — storable, servable, host-editable.
 */
import type { SigwxProfile } from "../map/sigwx-draw.js";

export const WAFS_SWH: SigwxProfile = {
  id: "wafs-swh",
  tools: ["jetStream", "cb", "icing", "turbulence", "tropopause", "volcano", "tropicalCyclone", "radioactive"],
  // SWH charts span FL250–630; the working clamp is FL250–600 with the off-chart "XXX"
  // sentinel beyond (a base below the floor / a top above the ceiling reads "XXX").
  vertical: { min: 250, max: 600, unit: "fl" },
  phenomena: {
    // Jet: 80 kt depiction floor (the speed dial spans 80–250 kt), core FL default 300.
    jetStream: { speed: { min: 80, max: 250 }, flightLevel: { min: 250, max: 600, default: 300 } },
    // Areas: FL250–600 with XXX beyond both bounds; lightning-bolt leaders are the
    // convective (CB) and icing conventions on WAFC charts.
    cb: { flightLevel: { min: 250, max: 600, default: [250, 400], beyond: ["xxx", "xxx"] }, leaderThunderbolt: true },
    turbulence: { flightLevel: { min: 250, max: 600, default: [250, 360], beyond: ["xxx", "xxx"] } },
    icing: { flightLevel: { min: 250, max: 600, default: [250, 360], beyond: ["xxx", "xxx"] }, leaderThunderbolt: true },
    // Tropopause: one FL per feature (contour or spot), default FL380.
    tropopause: { flightLevel: { min: 250, max: 600, default: 380 } },
  },
};

export default WAFS_SWH;
