#!/usr/bin/env node
/**
 * Atlas build — `svgs/**\/*.svg` is the SINGLE SOURCE of glyph art (viewable files, also
 * readable by JS), organised by ROLE/family in subfolders (`buttons/`, `wmo/<family>/`).
 *
 * A profile in `src/profiles/` only REFERENCES glyphs by name (`atlas:<name>`, or an
 * object's type = its default `atlas:<type>` icon) — the source carries NO inline SVG.
 * This build:
 *   • `--dist` : writes `dist/profiles/*.json` with each profile's glyphs EMBEDDED
 *     used-only (autoportant, light), pulled from the bank. `src/` is never touched.
 *   • always   : writes `src/core/descriptors/stock-glyphs.json` = the glyphs the BUILT-IN
 *     default profile (`wafs.json`) references — exactly what the lib compiles at load, no
 *     more (the TEMSI button icons and the 39 WMO map symbols stay out of the lib until a
 *     profile embeds them). NB: "stock" is defined by `wafs.json`, NOT by the `buttons/`
 *     folder — adding a TEMSI button icon there does NOT bloat the lib.
 *
 * `npm run build:stock` (no --dist) refreshes stock-glyphs; `npm run build:profiles`
 * (--dist) produces the shipped dist profiles. `npm run build` runs stock, then tsc (which
 * copies the source profiles verbatim = references), then profiles (--dist) to inline them.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVGS = join(ROOT, "svgs");
const SRC_PROFILES = join(ROOT, "src", "profiles");
const DIST_PROFILES = join(ROOT, "dist", "profiles");
const STOCK_JSON_SRC = join(ROOT, "src", "core", "descriptors", "stock-glyphs.json");
const STOCK_JSON_DIST = join(ROOT, "dist", "core", "descriptors", "stock-glyphs.json");
const WRITE_DIST = process.argv.includes("--dist");

/** Write only when the content actually differs — so re-running the build is mtime-idempotent
 *  (a `tsc -w` watching `stock-glyphs.json` won't loop, and the demo isn't bounced for nothing). */
function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content);
  return true;
}

// 1) Load the bank by NAME (basename). The subfolder gives the ROLE/family (folder-driven):
//    svgs/buttons/<n>.svg → button ; svgs/wmo/<family>/<n>.svg → WMO map symbol ; else other.
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".svg")) out.push(p);
  }
  return out;
}
/** Normalize a glyph SVG for inlining: collapse whitespace AND ensure the `xmlns` namespace.
 *  Inline SVG renders fine WITHOUT `xmlns` (the HTML parser is lenient), but a read-only marker
 *  SPRITE is rasterized by loading the SVG as a `data:image/svg+xml` image — parsed as STRICT XML,
 *  which FAILS without `xmlns` (→ blank volcano / TC / radioactive / pressure-centre sprites once
 *  unselected). Adding it is harmless for the inline path. */
const normalizeSvg = (s) => {
  const t = s.trim().replace(/\s*\n\s*/g, " ");
  return /<svg[^>]*\bxmlns=/.test(t) ? t : t.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
};

const bank = {}; // name -> { svg, ref }  (ref = path under svgs/, e.g. "buttons/cb.svg")
for (const p of walk(SVGS)) {
  const name = basename(p, ".svg");
  const ref = relative(SVGS, p).split(sep).join("/");
  if (bank[name]) console.warn(`⚠ name collision: "${name}" (two .svg files)`);
  bank[name] = { svg: normalizeSvg(readFileSync(p, "utf8")), ref };
}

// Engine chrome (`atlas:plus`/`atlas:minus`) lives in the core atlas — never from the bank.
const ENGINE = new Set(["plus", "minus"]);

/** The `atlas:<name>` glyphs an object actually wires (for validation): explicit `atlas:X`
 *  + each object's default `atlas:<type>` icon (a raw inline `icon` opts out). */
function wiredNames(profile) {
  const names = new Set();
  for (const m of JSON.stringify(profile).matchAll(/atlas:([A-Za-z0-9_-]+)/g)) names.add(m[1]);
  for (const o of profile.objects ?? []) {
    if (o && typeof o === "object" && o.type && !o.icon) names.add(o.type);
  }
  for (const e of ENGINE) names.delete(e);
  return names;
}

/** Resolve a `{ name: ref }` map to `{ name: inline-SVG }`: a raw `<svg…>` stays (normalized),
 *  else the ref is a PATH under svgs/ (recorded as referenced for the unused report). Missing
 *  files are reported. Shared by the `glyphs` atlas, the `sprites` atlas and the stock glyphs. */
function resolveRefs(refs, id) {
  const out = {};
  for (const [name, ref] of Object.entries(refs)) {
    if (typeof ref === "string" && ref.trim().startsWith("<svg")) {
      out[name] = normalizeSvg(ref); // inline custom art — keep, but ensure xmlns
    } else {
      const file = join(SVGS, ref);
      if (existsSync(file)) {
        out[name] = normalizeSvg(readFileSync(file, "utf8"));
        referenced.add(typeof ref === "string" ? ref : "");
      } else missing.push(`${id} → "${name}": svgs/${ref} not found`);
    }
  }
  return out;
}

// 2) Per source profile: its `glyphs` section holds REFERENCES (name -> path in svgs/). The
//    build RESOLVES each reference to the inline SVG and writes it into the dist profile.
//    `src/` is never modified; the references stay the editable source.
const referenced = new Set(); // every bank ref used by some profile (for the unused report)
const missing = [];
if (WRITE_DIST) mkdirSync(DIST_PROFILES, { recursive: true });

for (const f of readdirSync(SRC_PROFILES)) {
  if (!f.endsWith(".json")) continue;
  const profile = JSON.parse(readFileSync(join(SRC_PROFILES, f), "utf8"));
  const id = profile.id ?? f.slice(0, -5);
  const refs = profile.glyphs ?? {}; // name -> "buttons/cb.svg" | raw "<svg…>" (custom inline)

  // Validate: every glyph an object wires must be declared in `glyphs` (a reference).
  for (const name of wiredNames(profile)) {
    if (!(name in refs)) missing.push(`${id} → object wires "atlas:${name}" but it's missing from "glyphs"`);
  }

  // Resolve references → inline SVG. `glyphs` = button/marker ATLAS (atlas:<name>); `sprites` =
  // the recolourable SYMBOL atlas (the code IS the sprite id: MOD/SEV/ICE_*/coverage), registered
  // per-profile so a chart only ships the symbols it actually draws.
  const glyphs = resolveRefs(refs, id);
  const sprites = resolveRefs(profile.sprites ?? {}, `${id} sprite`);
  if (WRITE_DIST) {
    const out = Object.keys(sprites).length ? { ...profile, glyphs, sprites } : { ...profile, glyphs };
    writeIfChanged(join(DIST_PROFILES, f), JSON.stringify(out, null, 2) + "\n");
    console.log(`${id.padEnd(14)} → dist (${Object.keys(glyphs).length} glyphs + ${Object.keys(sprites).length} sprites → inline SVG)`);
  }
}

// 3) Stock glyphs for the lib = what the BUILT-IN default profile (wafs.json) references —
//    exactly the icons the lib compiles at load (no bloat from TEMSI-only button icons).
const wafs = JSON.parse(readFileSync(join(SRC_PROFILES, "wafs.json"), "utf8"));
const stockGlyphs = {};
for (const [name, ref] of Object.entries(wafs.glyphs ?? {})) {
  if (typeof ref === "string" && ref.trim().startsWith("<svg")) stockGlyphs[name] = normalizeSvg(ref);
  else {
    const file = join(SVGS, ref);
    if (existsSync(file)) stockGlyphs[name] = normalizeSvg(readFileSync(file, "utf8"));
    else missing.push(`wafs (stock) → "${name}": svgs/${ref} not found`);
  }
}
const stockJson = JSON.stringify(stockGlyphs, Object.keys(stockGlyphs).sort(), 2) + "\n";
writeIfChanged(STOCK_JSON_SRC, stockJson);
if (WRITE_DIST && existsSync(dirname(STOCK_JSON_DIST))) writeIfChanged(STOCK_JSON_DIST, stockJson);

// 4) Report: bank files NOT referenced by any profile (candidates to delete — the bank is
//    meant to hold only the used set).
const unused = Object.values(bank).map((g) => g.ref).filter((r) => !referenced.has(r)).sort();

console.log(`\nbanque ${Object.keys(bank).length} · référencés ${referenced.size} · non utilisés ${unused.length} · stock (lib) ${Object.keys(stockGlyphs).length}`);
if (unused.length) console.warn("⚠ non utilisés (à supprimer):\n  " + unused.join("\n  "));
if (missing.length) console.warn("⚠ références manquantes:\n  " + missing.join("\n  "));
console.log(`→ stock-glyphs.json (${Object.keys(stockGlyphs).length})${WRITE_DIST ? " · dist/profiles/*.json" : ""}`);
