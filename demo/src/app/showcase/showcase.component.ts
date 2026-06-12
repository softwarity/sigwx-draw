import {
  AfterViewInit,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";
import { registerInteractiveCode } from "@softwarity/interactive-code";
import { DEFAULT_STYLE, defaultRegistry, SigwxDraw } from "@softwarity/sigwx-draw";
import type { SigwxProfile, SigwxStyleInput, SnapshotDelivery, SnapshotQuality, ToolbarPosition } from "@softwarity/sigwx-draw";
// Adapters live on dedicated subpaths so the root entry stays peer-free.
import { MapLibreAdapter } from "@softwarity/sigwx-draw/maplibre";
import { OpenLayersAdapter } from "@softwarity/sigwx-draw/openlayers";
// Leaflet is an OPTIONAL peer — reached via its own subpath.
import { LeafletAdapter } from "@softwarity/sigwx-draw/leaflet";
import type { FeatureCollection } from "geojson";
// Each engine is created DIRECTLY with its own idiomatic basemap (host pattern) so the three
// are instantly distinguishable — see CENTER/basemap constants below.
import * as L from "leaflet";
import type { Map as LeafletMap } from "leaflet";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import OlMap from "ol/Map";
import TileLayer from "ol/layer/Tile";
import { fromLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import View from "ol/View";

import { ICONS } from "./icons";

registerInteractiveCode();

/** The default phenomenon registry — so the cards' header icons are the SAME as the toolbar's. */
const REGISTRY = defaultRegistry();

type Engine = "maplibre" | "openlayers" | "leaflet";

/** One editable attribute of the live profile, surfaced as an inline `<code-binding>`. */
interface ProfileBinding {
  key: string;
  type: "color" | "number";
  value: string;
  min?: number;
  max?: number;
  step?: number;
}

const ADAPTER_NAME: Record<Engine, string> = {
  maplibre: "MapLibreAdapter",
  openlayers: "OpenLayersAdapter",
  leaflet: "LeafletAdapter",
};
const MAP_IMPORT: Record<Engine, string> = {
  maplibre: 'import { Map } from "maplibre-gl";',
  openlayers: 'import Map from "ol/Map";',
  leaflet: 'import L from "leaflet";',
};
const ENGINE_BY_ADAPTER: Record<string, Engine> = {
  MapLibreAdapter: "maplibre",
  OpenLayersAdapter: "openlayers",
  LeafletAdapter: "leaflet",
};
type Phenomenon = "jetStream" | "cb" | "turbulence" | "icing" | "tropopause" | "volcano" | "tropicalCyclone" | "radioactive";

interface PhenomenonButton {
  type: Phenomenon;
  label: string;
  desc: string;
}

const PHENOMENA: PhenomenonButton[] = [
  { type: "jetStream", label: "Jet stream", desc: "Jet stream — draw freehand, drag the orange break points, dial the speed & FL" },
  { type: "turbulence", label: "Turbulence", desc: "Turbulence — draw an area; dashed edge, MOD/SEV symbol, drag the FL gauge, click the badge to toggle MOD↔SEV" },
  // CB exists in the registry but is hidden for now:
  // { type: "cb", label: "CB", desc: "Cumulonimbus — draw a closed area; the edge is scalloped" },
];

/** Europe-centred default view. */
const CENTER: [number, number] = [2.3, 46.6];
const ZOOM = 5;
// MapLibre uses 512px tiles; OpenLayers/Leaflet use 256px → at the same zoom value the raster
// engines sit ~1 level WIDER. Bump them by 1 so all three frame the same area as MapLibre.
const RASTER_ZOOM = ZOOM + 1;
// Each engine keeps its OWN idiomatic basemap so the three are instantly distinguishable:
//  MapLibre → its demo vector style (no key) · OpenLayers → canonical OSM raster · Leaflet → CARTO Positron.
const MAPLIBRE_DEMO_STYLE = "https://demotiles.maplibre.org/style.json";
const LEAFLET_POSITRON = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const CARTO_ATTR = "© OpenStreetMap contributors © CARTO";

/** The selectable profiles — one static `import()` per entry so esbuild bundles each
 *  profile JSON as its own chunk (a templated `import(`…${name}…`)` won't resolve). */
const PROFILE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  wafs: () => import("@softwarity/sigwx-draw/profiles/wafs.json"),
  "temsi-euroc": () => import("@softwarity/sigwx-draw/profiles/temsi-euroc.json"),
  "temsi-france": () => import("@softwarity/sigwx-draw/profiles/temsi-france.json"),
};

@Component({
  selector: "app-showcase",
  imports: [],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: "./showcase.component.html",
  styleUrl: "./showcase.component.scss",
})
export class ShowcaseComponent implements AfterViewInit, OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>("map");

  protected readonly phenomena = PHENOMENA;
  protected readonly icon = (m: string): SafeHtml =>
    this.sanitizer.bypassSecurityTrustHtml(REGISTRY.has(m) ? REGISTRY.get(m).icon ?? ICONS[m] ?? "" : ICONS[m] ?? "");

  protected readonly engine = signal<Engine>("maplibre");
  protected readonly adapterName = signal("MapLibreAdapter");
  protected readonly mapImport = signal('import { Map } from "maplibre-gl";');
  /** Pretty-printed GeoJSON from the latest `change` event. */
  protected readonly geojson = signal("// draw a phenomenon — the FeatureCollection appears here");
  /** The LIVE profile (the single source of truth) — the editor below mutates THIS object
   *  and calls `setProfile`; the new mechanism, no per-phenomenon runtime API. */
  private profile?: SigwxProfile;
  /** The profile rendered AS editable code: the JSON with `${key}` markers at the
   *  pertinent attributes (colours, opacities), bound to the `<code-binding>` list. */
  protected readonly profileCode = signal("// the chart profile (JSON) appears here once loaded");
  protected readonly profileBindings = signal<ProfileBinding[]>([]);
  /** The right-hand profile editor drawer (opened by the `✎ edit` button in the config). */
  protected readonly drawerOpen = signal(false);
  /** Lock the page scroll while the drawer is open (modal pattern) — kills the second
   *  scrollbar (the page's, behind the drawer); only the drawer's own scroll remains. */
  private readonly _lockScroll = effect(() => {
    document.body.style.overflow = this.drawerOpen() ? "hidden" : "";
  });
  /** The chosen chart profile (the carousel at the top of the config). One for now — `wafs`;
   *  HL/ML/LL (and TEMSI) join the list as their JSON files land. */
  protected readonly profileName = signal("wafs");
  /** marker key → path into the profile (e.g. `e3` → ["objects",1,"style","color"]). */
  private readonly editorPaths = new Map<string, (string | number)[]>();

  /** Live GENERAL style edits (chrome: selection / handles / slider / dial / tooltip). */
  private genStyle?: SigwxStyleInput;
  /** Whether the native toolbar is rendered (toggled via the block comment). */
  private toolbarOn = true;
  /** Live toolbar position edited in the panel. Its row/column flow is DERIVED from this
   *  (the `orientation` option was removed in draw-adapter 0.2.7). */
  private tbPos: ToolbarPosition = "bottom";
  /** Show the built-in "lock map" toggle button (draw-adapter 0.2.7 `toolbar.lock`, default on). */
  private tbLock = true;
  /** Snapshot ("capture map" PNG button) config. The `snapshot: {}` block is always present
   *  (the button always shows); each field is opt-in via its comment toggle, else the lib
   *  default applies (native / download / shutter on). `onClick` is the plain-click delivery;
   *  ⌘/Ctrl-click always does the other one. */
  private snapQOn = false;
  private snapQuality = "native";
  private snapClickOn = false;
  private snapClickVal = "clipboard";
  private snapShutterVal = true;

  private sigwx?: SigwxDraw;
  private mlMap?: MapLibreMap;
  private olMap?: OlMap;
  private lfMap?: LeafletMap;
  /** The 2D/globe toggle button injected into MapLibre's nav control group. */
  private globeBtn?: HTMLButtonElement;
  private mlGlobe = true; // MapLibre defaults to the globe projection

  async ngAfterViewInit(): Promise<void> {
    await this.rebuild();
  }

  ngOnDestroy(): void {
    document.body.style.overflow = ""; // restore page scroll if destroyed with the drawer open
    this.teardown();
  }

  protected setEngine(engine: Engine): void {
    if (engine === this.engine()) return;
    this.engine.set(engine);
    this.adapterName.set(ADAPTER_NAME[engine]);
    this.mapImport.set(MAP_IMPORT[engine]);
    void this.rebuild();
  }

  /** Flip the MapLibre projection live (globe ↔ mercator) — no rebuild. */
  protected toggleGlobe(): void {
    this.mlGlobe = !this.mlGlobe;
    this.mlMap?.setProjection({ type: this.mlGlobe ? "globe" : "mercator" });
    this.updateGlobeBtn();
  }

  /** Icon shows the *current* view (globe in globe, flat map in 2D); tooltip = the action. */
  private updateGlobeBtn(): void {
    const g = this.globeBtn;
    if (!g) return;
    g.innerHTML = this.mlGlobe ? ICONS["globe"]! : ICONS["flat"]!;
    const t = this.mlGlobe ? "Switch to 2D (Mercator)" : "Switch to globe";
    g.title = t;
    g.setAttribute("aria-label", t);
  }

  protected draw(type: Phenomenon): void {
    this.sigwx?.draw(type);
  }

  protected clear(): void {
    this.sigwx?.clear();
  }

  /**
   * Single `change` handler for the right-hand code panel. Routes the adapter
   * `select` (→ switch engine, synced with the toggle above the map), the toolbar
   * bindings and the style bindings (→ live `setStyle`).
   */
  protected onPanelChange(ev: Event): void {
    const t = ev.target as { key?: string; value?: unknown } | null;
    // The `edit` button binding (interactive-code 1.1.0 `type="button"`) opens the drawer.
    if (t?.key === "editProfile") {
      this.drawerOpen.set(true);
      return;
    }
    // The `profile` carousel switches the chart definition (one profile today: `wafs`).
    if (t?.key === "profileName") {
      this.profileName.set(String(t.value));
      void this.loadProfile(String(t.value));
      return;
    }
    if (t?.key === "adapter") {
      this.setEngine(ENGINE_BY_ADAPTER[String(t.value)] ?? "maplibre");
      return;
    }
    if (t?.key === "tbOff") {
      this.toolbarOn = t.value === true || t.value === "true";
      void this.rebuild(); // toolbar is a construction-time option
      return;
    }
    if (t?.key === "tbPosition") {
      this.tbPos = String(t.value) as ToolbarPosition;
      void this.rebuild(); // re-place the native toolbar (its flow follows the position)
      return;
    }
    if (t?.key === "tbLock") {
      this.tbLock = t.value === true || t.value === "true";
      void this.rebuild(); // the lock button is a toolbar construction-time option
      return;
    }
    // Snapshot fields — each is a toolbar construction-time option → rebuild.
    if (t?.key === "snapQ" || t?.key === "snapQuality" || t?.key === "snapClick" || t?.key === "snapClickVal" || t?.key === "snapShutterVal") {
      if (t.key === "snapQ") this.snapQOn = t.value === true || t.value === "true";
      else if (t.key === "snapQuality") this.snapQuality = String(t.value);
      else if (t.key === "snapClick") this.snapClickOn = t.value === true || t.value === "true";
      else if (t.key === "snapClickVal") this.snapClickVal = String(t.value);
      else this.snapShutterVal = t.value === true || t.value === "true";
      void this.rebuild();
      return;
    }
    if (t?.key === "mapImport") return; // readonly, engine-driven
    this.onStyleChange(ev);
  }

  /**
   * Live style editor: read every `<code-binding>` in the editor panel and push
   * a full style to the map (commented-out groups revert to the defaults).
   */
  protected onStyleChange(ev: Event): void {
    const host = ev.currentTarget as HTMLElement;
    const val = (k: string): unknown =>
      (host.querySelector(`code-binding[key="${k}"]`) as { value?: unknown } | null)?.value;
    const on = (k: string): boolean => val(k) === true || val(k) === "true";
    const D = DEFAULT_STYLE;
    const style: SigwxStyleInput = {
      selection: on("selection")
        ? { ...D.selection, color: String(val("selColor")), width: Number(val("selWidth")) }
        : D.selection,
      handle: on("handle")
        ? { ...D.handle, fill: String(val("handleFill")), stroke: String(val("handleStroke")) }
        : D.handle,
      control: on("control")
        ? {
            line: { ...D.control.line, color: String(val("ctlLineColor")), width: Number(val("ctlLineW")) },
            handle: { ...D.control.handle, fill: String(val("ctlFill")), stroke: String(val("ctlStroke")) },
            text: { color: String(val("ctlTextColor")), halo: String(val("ctlHalo")) },
          }
        : D.control,
      tooltip: on("tooltip")
        ? {
            ...D.tooltip,
            color: String(val("tipColor")),
            background: String(val("tipBg")),
            fontSize: Number(val("tipSize")),
          }
        : D.tooltip,
    };
    this.genStyle = style;
    this.sigwx?.setStyle(style);
  }

  /**
   * Build the EDITABLE profile view: serialize the live profile, then surface its
   * pertinent attributes (every style colour + the fill opacities) as inline
   * `<code-binding>` markers. Editing one fires `onProfileEdit` → patches the profile →
   * `setProfile`. THIS is the new mechanism made visible: the JSON below is the source
   * of truth, the controls live inside it, the Download button hands you the file.
   */
  private buildProfileEditor(): void {
    this.editorPaths.clear();
    if (!this.profile) return;
    const bindings: ProfileBinding[] = [];
    const clone = structuredClone(this.profile) as Record<string, any>;
    const SENT = (k: string): string => "@@SIGWX_BIND_" + k + "@@";
    let n = 0;
    const color = (host: any, key: string, path: (string | number)[]): void => {
      if (typeof host?.[key] !== "string") return;
      const k = "e" + n++;
      this.editorPaths.set(k, [...path, key]);
      bindings.push({ key: k, type: "color", value: host[key] as string });
      host[key] = SENT(k);
    };
    const opacity = (host: any, key: string, path: (string | number)[]): void => {
      if (typeof host?.[key] !== "number") return;
      const k = "e" + n++;
      this.editorPaths.set(k, [...path, key]);
      bindings.push({ key: k, type: "number", value: String(host[key]), min: 0, max: 1, step: 0.02 });
      host[key] = SENT(k);
    };
    const objects = (clone["objects"] as Record<string, any>[] | undefined) ?? [];
    objects.forEach((o, i) => {
      const st = o?.["style"] as Record<string, any> | undefined;
      if (!st) return;
      const p: (string | number)[] = ["objects", i, "style"];
      color(st, "color", p);
      for (const sub of ["edge", "area", "text", "mod", "sev", "arrow"]) {
        if (st[sub]) { color(st[sub], "color", [...p, sub]); color(st[sub], "halo", [...p, sub]); }
      }
      if (st["area"]) opacity(st["area"], "opacity", [...p, "area"]);
    });
    // Serialize, then turn the sentinels into ${key} markers — a colour stays quoted
    // ("${e0}"), a number is unquoted (${e1}).
    let code = JSON.stringify(clone, null, 2);
    for (const b of bindings) {
      const marker = "${" + b.key + "}";
      code = b.type === "number"
        ? code.replace('"' + SENT(b.key) + '"', marker)
        : code.replace(SENT(b.key), marker);
    }
    // Fold the structural / verbose sections by default — the glyph atlas and each
    // object's gesture/fields/render/card/satellites. Only `style` (the editable colours)
    // stays open, so opening the drawer shows what's tweakable. interactive-code 1.1.1
    // `${fold}` … `${/fold}` markers (collapsed; the marker lines are stripped from the
    // copy/download, so the exported JSON stays complete and valid).
    const FOLDABLE = new Set(["glyphs", "gesture", "fields", "render", "card", "satellites"]);
    const src = code.split("\n");
    const folded: string[] = [];
    let openIndent: string | null = null;
    for (const line of src) {
      if (openIndent === null) {
        const m = /^(\s*)"(\w+)":\s*[{[]\s*$/.exec(line);
        if (m && FOLDABLE.has(m[2])) {
          folded.push(line, "${fold}");
          openIndent = m[1];
          continue;
        }
      } else if (new RegExp(`^${openIndent}[}\\]],?\\s*$`).test(line)) {
        folded.push("${/fold}", line);
        openIndent = null;
        continue;
      }
      folded.push(line);
    }
    this.profileCode.set(folded.join("\n"));
    this.profileBindings.set(bindings);
  }

  /** Switch the live chart to another profile (the `profile:` carousel). Load its JSON,
   *  rebuild the editor view + the toolbar palette. The drawing is cleared — different
   *  profiles expose different objects, so kept features could reference a missing type. */
  private async loadProfile(name: string): Promise<void> {
    const load = PROFILE_LOADERS[name];
    if (!load) return;
    const base = (await load()).default as unknown as SigwxProfile;
    this.sigwx?.clear();
    this.profile = structuredClone(base);
    this.buildProfileEditor();
    await this.rebuild(); // the toolbar palette is a construction-time option
  }

  /** A `<code-binding>` edit inside the profile view → write the value at its path,
   *  re-ingest the whole profile (`setProfile`), keep the drawn features. */
  protected onProfileEdit(ev: Event): void {
    const t = ev.target as { key?: string; value?: unknown } | null;
    const path = t?.key ? this.editorPaths.get(t.key) : undefined;
    if (!path || !this.profile) return;
    let host = this.profile as Record<string, any>;
    for (let i = 0; i < path.length - 1; i++) host = host[path[i]] as Record<string, any>;
    const last = path[path.length - 1];
    host[last] = typeof host[last] === "number" ? Number(t!.value) : String(t!.value);
    this.sigwx?.setProfile(this.profile);
  }

  /** Download the LIVE profile as a `.json` — drop it in your app and inject it as-is. */
  protected downloadProfile(): void {
    if (!this.profile) return;
    const blob = new Blob([JSON.stringify(this.profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.profile.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private teardown(): void {
    try { this.sigwx?.destroy(); } catch (e) { console.error("[showcase] destroy", e); }
    this.sigwx = undefined;
    try { this.mlMap?.remove(); } catch (e) { console.error("[showcase] ml remove", e); }
    try { this.olMap?.setTarget(undefined); } catch (e) { console.error("[showcase] ol detach", e); }
    try { this.lfMap?.remove(); } catch (e) { console.error("[showcase] lf remove", e); }
    this.mlMap = undefined;
    this.olMap = undefined;
    this.lfMap = undefined;
    this.globeBtn = undefined;
    const el = this.mapEl().nativeElement;
    el.innerHTML = "";
    el.className = "map";
  }

  private async rebuild(): Promise<void> {
    try {
      const el = this.mapEl().nativeElement;
      const eng = this.engine();
      // Keep the current drawing across an engine switch / rebuild — capture before teardown,
      // re-`load` it once the fresh instance is ready (same as sigmet-draw's demo).
      const keep = this.sigwx?.save();
      // The chart is driven by ONE profile (the source of truth) — load an editable copy
      // of the default JSON once; the editor panel mutates it and calls setProfile.
      if (!this.profile) {
        const base = (await PROFILE_LOADERS[this.profileName()]()).default as unknown as SigwxProfile;
        this.profile = structuredClone(base);
        this.buildProfileEditor();
      }

      this.teardown();

      let adapter: MapLibreAdapter | OpenLayersAdapter | LeafletAdapter;
      if (eng === "maplibre") {
        const map = new MapLibreMap({ container: el, style: MAPLIBRE_DEMO_STYLE, center: CENTER, zoom: ZOOM });
        map.on("load", () => map.setProjection({ type: this.mlGlobe ? "globe" : "mercator" }));
        this.mlMap = map;
        map.addControl(new NavigationControl());
        // 2D/globe toggle lives with zoom/compass (it's a view control, not a tool).
        const navGroup = el.querySelector<HTMLElement>(".maplibregl-ctrl-top-right .maplibregl-ctrl-group");
        if (navGroup) {
          const g = document.createElement("button");
          g.type = "button";
          g.style.color = "#24292f"; // visible on the white native button
          g.addEventListener("click", () => this.toggleGlobe());
          navGroup.appendChild(g);
          this.globeBtn = g;
          this.updateGlobeBtn();
        }
        adapter = new MapLibreAdapter({ map });
      } else if (eng === "openlayers") {
        const map = new OlMap({
          target: el,
          layers: [new TileLayer({ source: new OSM() })],
          view: new View({ center: fromLonLat(CENTER), zoom: RASTER_ZOOM }),
        });
        this.olMap = map;
        adapter = new OpenLayersAdapter({ map });
      } else {
        const map = L.map(el).setView([CENTER[1], CENTER[0]], RASTER_ZOOM);
        L.tileLayer(LEAFLET_POSITRON, { attribution: CARTO_ATTR, subdomains: "abcd" }).addTo(map);
        this.lfMap = map;
        adapter = new LeafletAdapter({ map });
      }

      this.sigwx = new SigwxDraw({
        adapter,
        // Turnkey native toolbar — the PROFILE drives the palette (its `tools`, with the
        // Fronts / Markers groups). No hard-coded `tools` here: switching profile switches
        // the buttons (that's the single-ingestion-unit model).
        toolbar: this.toolbarOn
          ? {
              position: this.tbPos,
              lock: this.tbLock,
              snapshot: {
                ...(this.snapQOn ? { quality: this.snapQuality as SnapshotQuality } : {}),
                ...(this.snapClickOn ? { onClick: this.snapClickVal as SnapshotDelivery } : {}),
                shutter: this.snapShutterVal,
              },
            }
          : undefined,
        // Global chrome only (selection / handles / slider / dial / tooltip).
        style: this.genStyle,
        // THE single ingestion unit — a pure-JSON chart profile (the cards edit it live).
        profile: this.profile,
      });
      this.sigwx.on("change", (fc: FeatureCollection) => {
        this.geojson.set(
          fc.features.length ? JSON.stringify(fc, null, 2) : "// (empty FeatureCollection)",
        );
      });
      await this.sigwx.ready();
      if (keep?.features.length) this.sigwx.load(keep); // restore the drawing on the new engine
    } catch (e) {
      console.error("[showcase] rebuild failed", e);
    }
  }
}
