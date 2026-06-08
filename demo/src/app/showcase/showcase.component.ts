import {
  AfterViewInit,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";
import { registerInteractiveCode } from "@softwarity/interactive-code";
import { DEFAULT_STYLE, defaultRegistry, SigwxDraw } from "@softwarity/sigwx-draw";
import type { PhenomenonConfig, SigwxStyleInput, SnapshotDelivery, SnapshotQuality, ToolbarPosition } from "@softwarity/sigwx-draw";
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
type Phenomenon = "jetStream" | "cb" | "turbulence";

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

  /** Live GENERAL style edits (chrome: selection / handles / slider / dial / tooltip). */
  private genStyle?: SigwxStyleInput;
  /** Per-phenomenon config (speed/flightLevel + style + extra CB coverages) from the bottom cards. */
  private phenoCfg: Record<string, PhenomenonConfig> = {};
  /** Whether the native toolbar is rendered (toggled via the block comment). */
  private toolbarOn = true;
  /** Live toolbar position edited in the panel. */
  private tbPos: ToolbarPosition = "bottom";
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
      void this.rebuild(); // re-place the native toolbar
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
   * Per-phenomenon card (the optional row below the map) — the `phenomena[type]`
   * option node: `speed` (jet dial bounds) / `flightLevel` (turbulence FL range) +
   * `style` (shape ink, FL text, glyph, dashed-edge width/dash). All live in comment
   * blocks (off → default look). Jet speed rebuilds; FL range + style apply live.
   */
  protected onPhenoChange(type: Phenomenon, ev: Event): void {
    const host = ev.currentTarget as HTMLElement;
    const val = (k: string): unknown =>
      (host.querySelector(`code-binding[key="${k}"]`) as { value?: unknown } | null)?.value;
    const col = (k: string): string => String(val(k));
    const on = (k: string): boolean => val(k) === true || val(k) === "true";
    const changed = (ev.target as { key?: string } | null)?.key;

    const cfg: PhenomenonConfig = {};
    if (type === "jetStream") {
      if (on("jLim")) cfg.speed = { min: Number(val("jMin")), max: Number(val("jMax")) };
      if (on("jFL")) cfg.flightLevel = { min: Number(val("jFLMin")), max: Number(val("jFLMax")), default: Number(val("jFLDef")) };
      if (on("jOn")) {
        cfg.style = {
          arrow: { color: col("jColor"), width: Number(val("jWidth")) },
          text: { color: col("jText"), halo: col("jHalo") },
        };
      }
    } else if (type === "turbulence") {
      if (on("tLim")) {
        cfg.flightLevel = {
          min: Number(val("tMin")),
          max: Number(val("tMax")),
          default: [Number(val("tBase")), Number(val("tTop"))],
          beyond: [col("tBeyLo"), col("tBeyHi")] as ["clamp" | "xxx", "clamp" | "xxx"],
        };
      }
      if (on("tOn")) {
        cfg.style = {
          mod: { color: col("tMod") },
          sev: { color: col("tSev") },
          edge: { width: Number(val("tEdgeW")), dash: [Number(val("tDashOn")), Number(val("tDashGap"))] },
          area: { opacity: Number(val("tAreaOp")) },
          text: { halo: col("tHalo") },
        };
      }
    } else if (type === "cb") {
      cfg.leaderThunderbolt = on("cBolt");
      // Extra coverage amounts appended to the OCNL/FRQ carousel (a construction-time catalogue).
      if (on("cExtra")) cfg.extraCoverages = ["ISOL EMBD", "OCNL EMBD"];
      if (on("cFL")) {
        cfg.flightLevel = {
          min: Number(val("cMin")),
          max: Number(val("cMax")),
          default: [Number(val("cBase")), Number(val("cTop"))],
          beyond: [col("cBeyLo"), col("cBeyHi")] as ["clamp" | "xxx", "clamp" | "xxx"],
        };
      }
      if (on("cOn")) {
        cfg.style = {
          edge: { color: col("cEdge") },
          area: { opacity: Number(val("cAreaOp")) },
        };
      }
    }
    this.phenoCfg = { ...this.phenoCfg, [type]: cfg };

    // Jet SPEED range is a construction-time option → rebuild. Every flightLevel field
    // (jet + turbulence) applies live (gauge cursors re-clamp at once); style applies live too.
    const flKeys = ["jFL", "jFLMin", "jFLMax", "jFLDef", "tLim", "tMin", "tMax", "tBase", "tTop", "tBeyLo", "tBeyHi", "cFL", "cMin", "cMax", "cBase", "cTop", "cBeyLo", "cBeyHi"];
    // Jet speed + CB leaderThunderbolt/coverages are construction-time → rebuild (geometry preserved).
    if (changed === "jMin" || changed === "jMax" || changed === "jLim" || changed === "cBolt" || changed === "cExtra") void this.rebuild();
    else if (changed && flKeys.includes(changed)) this.sigwx?.setPhenomenonFlightLevel(type, cfg.flightLevel ?? {});
    else this.sigwx?.setPhenomenonStyle(type, cfg.style ?? {});
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
        // Turnkey native toolbar; `tools` restricts it to jet + turbulence for now
        // (CB exists in the registry but is hidden for the 0.0.1).
        toolbar: this.toolbarOn
          ? {
              position: this.tbPos,
              tools: ["jetStream", "cb", "turbulence"],
              snapshot: {
                ...(this.snapQOn ? { quality: this.snapQuality as SnapshotQuality } : {}),
                ...(this.snapClickOn ? { onClick: this.snapClickVal as SnapshotDelivery } : {}),
                shutter: this.snapShutterVal,
              },
            }
          : undefined,
        // Global chrome only (selection / handles / slider / dial / tooltip).
        style: this.genStyle,
        // Per-phenomenon config (speed/flightLevel + style) — re-applied across an engine switch.
        phenomena: this.phenoCfg,
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
