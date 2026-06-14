#!/usr/bin/env node
/**
 * Normalise the OFFICIAL WMO/ICAO significant-weather symbols into the `svgs/wmo/<family>/`
 * bank, READ FROM A LOCAL CLONE of the source of truth (no network):
 *
 *   OGCMetOceanDWG/WorldWeatherSymbols  —  symbols/ICAO_SigWx/*.svg
 *   Publisher: WMO/ICAO · Creator: WMO CAeM · Source: WMO-No.49 Vol II, Appendix 1
 *   (= ICAO Annex 3, Appendix 1) · Registry: codes.wmo.int/49/3/1/* · Licence: CC-BY 3.0
 *
 * Clone path (override: arg 1 or $SYMBOLS_SRC):
 *   /Users/francois/Workspaces/Externals/WorldWeatherSymbols/symbols
 *
 * Run manually: `node scripts/fetch-symbols.mjs [clone/symbols]`. NOT part of `npm run build`.
 * The drawings are the official spec — re-running pins their origin, it does NOT restyle them.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { optimize } from "svgo";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WMO = join(ROOT, "svgs", "wmo");
const SRC = process.argv[2] ?? process.env["SYMBOLS_SRC"]
  ?? "/Users/francois/Workspaces/Externals/WorldWeatherSymbols/symbols";
const ICAO = join(SRC, "ICAO_SigWx");

// ICAO filename stem (after WeatherSymbol_ICAO_) → [family folder, kebab name].
const MAP = {
  Rain: ["precipitation", "rain"], Drizzle: ["precipitation", "drizzle"],
  FreezingPrecipitation: ["precipitation", "freezing-precipitation"], Snow: ["precipitation", "snow"],
  Shower: ["precipitation", "shower"], Hail: ["precipitation", "hail"],
  Thunderstorms: ["convective", "thunderstorms"], SevereSquallLine: ["convective", "severe-squall-line"],
  ModerateTurbulence: ["turbulence", "moderate-turbulence"], SevereTurbulence: ["turbulence", "severe-turbulence"],
  AreaOfCAT: ["turbulence", "area-of-cat"],
  ModerateAircraftIcing: ["icing", "moderate-aircraft-icing"], SevereAircraftIcing: ["icing", "severe-aircraft-icing"],
  WidespreadFog: ["visibility", "widespread-fog"], WidespreadMist: ["visibility", "widespread-mist"],
  WidespreadHaze: ["visibility", "widespread-haze"], WidespreadSmoke: ["visibility", "widespread-smoke"],
  SevereSandOrDustHaze: ["visibility", "severe-sand-or-dust-haze"],
  WidespreadSandstormOrDuststorm: ["visibility", "widespread-sandstorm-or-duststorm"],
  WidespreadBlowingSnow: ["visibility", "widespread-blowing-snow"],
  MountainWaves: ["relief", "mountain-waves"], MoutainObscuration: ["relief", "mountain-obscuration"],
  PositionOfJetStreamAxis: ["wind-jet", "position-of-jet-stream-axis"],
  WindArrowNH_01: ["wind-jet", "wind-arrow-nh-01"], WindArrowSH_01: ["wind-jet", "wind-arrow-sh-01"],
  WindArrowOrFlightLevelDoubleBar: ["wind-jet", "wind-arrow-or-flight-level-double-bar"],
  TropicalCyclone: ["cyclone-pressure", "tropical-cyclone"], PressureCentreLocation: ["cyclone-pressure", "pressure-centre-location"],
  Front_Cold_at_surface: ["fronts", "front-cold-at-surface"], Front_Warm_at_surface: ["fronts", "front-warm-at-surface"],
  Front_Occluded_at_surface: ["fronts", "front-occluded-at-surface"],
  "Front_Quasi-stationary_at_surface": ["fronts", "front-quasi-stationary-at-surface"],
  Front_Convergence_Line: ["fronts", "front-convergence-line"], Front_Intertropical_Convergence_Zone: ["fronts", "front-intertropical-convergence-zone"],
  AltitudeOf0CIsotherm: ["levels", "altitude-0c-isotherm"],
  VolcanicEruption: ["hazards", "volcanic-eruption"], VisibleVolcanicAshCloud: ["hazards", "visible-volcanic-ash-cloud"],
  RadioactiveMaterialsInTheAtmosphere: ["hazards", "radioactive-materials-in-the-atmosphere"],
  AreaOfSignificantWeather: ["areas", "area-of-significant-weather"],
};

/** Normalise one official SVG to atlas form via svgo (robust XML parse — handles the
 *  `svg:` namespace prefix, strips metadata/title/desc/editor cruft, KEEPS defs/use,
 *  KEEPS viewBox, drops width/height, minifies). Then: black → `currentColor`, and a
 *  viewBox fallback for the few originals shipped without one. */
function normalise(text) {
  // The clone uses the `svg:` namespace prefix on every tag (`<svg:path>`, `<svg:metadata>`)
  // with NO default xmlns — svgo doesn't normalise that. De-prefix to standard SVG first.
  text = text.replace(/<(\/?)svg:/g, "<$1").replace(/xmlns:svg=/g, "xmlns=");

  // CONSERVATIVE plugin list — ONLY removal/cleanup, NEVER geometry: paths `d=`, `transform=`,
  // shapes and `id`s stay BYTE-IDENTICAL to the official source (no convertPathData /
  // convertTransform / mergePaths / collapseGroups / cleanupIds). We only strip metadata,
  // editor cruft, comments and the width/height (viewBox kept). Color is handled below.
  let out = optimize(text, {
    multipass: false,
    plugins: [
      "removeDoctype",
      "removeXMLProcInst",
      "removeComments",
      "removeMetadata",
      "removeEditorsNSData",
      "removeTitle",
      { name: "removeDesc", params: { removeAny: true } },
      "cleanupAttrs",
      "removeEmptyAttrs",
      "removeEmptyContainers",
      "removeDimensions", // strip width/height (viewBox present ⇒ atlas form)
    ],
  }).data;

  // Official symbols ship in pure black → atlas convention is `currentColor` (themed by the slot).
  out = out.replace(/#000000\b/gi, "currentColor").replace(/#000\b/gi, "currentColor");
  out = out.replace(/(stroke|fill):\s*black\b/g, "$1:currentColor").replace(/(stroke|fill)="black"/g, '$1="currentColor"');

  // viewBox fallback (a few originals have width/height but no viewBox).
  if (!/viewBox=/.test(out)) {
    const w = out.match(/\swidth="([0-9.]+)"/)?.[1] ?? "55";
    const h = out.match(/\sheight="([0-9.]+)"/)?.[1] ?? "55";
    out = out.replace(/<svg /, `<svg viewBox="0 0 ${w} ${h}" `).replace(/\s(width|height)="[0-9.]+"/g, "");
  }
  return out.trim() + "\n";
}

if (!existsSync(ICAO)) {
  console.error(`✗ clone introuvable: ${ICAO}\n  passe le chemin: node scripts/fetch-symbols.mjs <clone>/symbols`);
  process.exit(1);
}

rmSync(WMO, { recursive: true, force: true }); // repart de l'officiel uniquement
let n = 0, skipped = [];
for (const file of readdirSync(ICAO)) {
  if (!file.endsWith(".svg")) continue;
  const stem = file.slice("WeatherSymbol_ICAO_".length, -4);
  const dest = MAP[stem];
  if (!dest) { skipped.push(stem); continue; }
  const dir = join(WMO, dest[0]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${dest[1]}.svg`), normalise(readFileSync(join(ICAO, file), "utf8")));
  n++;
}
console.log(`✓ ${n} symboles officiels OMM/OACI normalisés depuis le clone → svgs/wmo/`);
if (skipped.length) console.warn("⚠ non mappés (ignorés):", skipped.join(", "));
