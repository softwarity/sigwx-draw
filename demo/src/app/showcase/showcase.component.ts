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
import {
  createMapLibreMap,
  createOpenLayersMap,
  DEFAULT_STYLE,
  MapLibreAdapter,
  OpenLayersAdapter,
  SigwxDraw,
} from "@softwarity/sigwx-draw";
import type { SigwxStyleInput, ToolbarPosition } from "@softwarity/sigwx-draw";
import type { FeatureCollection } from "geojson";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import OlMap from "ol/Map";

import { ICONS } from "./icons";

registerInteractiveCode();

type Engine = "maplibre" | "openlayers";
type Phenomenon = "jetStream" | "cb" | "turbulence";

interface PhenomenonButton {
  type: Phenomenon;
  label: string;
  desc: string;
}

const PHENOMENA: PhenomenonButton[] = [
  { type: "jetStream", label: "Jet stream", desc: "Jet stream — draw freehand, drag the orange break points, dial the speed & FL" },
  // CB / turbulence exist in the registry but are hidden for the 0.0.1 (jet only):
  // { type: "cb", label: "CB", desc: "Cumulonimbus — draw a closed area; the edge is scalloped" },
  // { type: "turbulence", label: "Turbulence", desc: "Turbulence — draw an area; the edge is dashed" },
];

/** Europe-centred default view. */
const CENTER: [number, number] = [2.3, 46.6];
const ZOOM = 5;

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
    this.sanitizer.bypassSecurityTrustHtml(ICONS[m] ?? "");

  protected readonly engine = signal<Engine>("maplibre");
  protected readonly adapterName = signal("MapLibreAdapter");
  protected readonly mapImport = signal('import { Map } from "maplibre-gl";');
  /** Pretty-printed GeoJSON from the latest `change` event. */
  protected readonly geojson = signal("// draw a phenomenon — the FeatureCollection appears here");

  /** Live style edits from the editor panel — re-applied across engine switches. */
  private styleOverride?: SigwxStyleInput;
  /** Whether the native toolbar is rendered (toggled via the block comment). */
  private toolbarOn = true;
  /** Live toolbar position edited in the panel. */
  private tbPos: ToolbarPosition = "top";
  /** Construction-time jet-speed limits (rebuild on change). */
  private spMin = 80;
  private spMax = 250;

  private sigwx?: SigwxDraw;
  private mlMap?: MapLibreMap;
  private olMap?: OlMap;

  async ngAfterViewInit(): Promise<void> {
    await this.rebuild();
  }

  ngOnDestroy(): void {
    this.teardown();
  }

  protected setEngine(engine: Engine): void {
    if (engine === this.engine()) return;
    this.engine.set(engine);
    this.adapterName.set(engine === "maplibre" ? "MapLibreAdapter" : "OpenLayersAdapter");
    this.mapImport.set(
      engine === "maplibre"
        ? 'import { Map } from "maplibre-gl";'
        : 'import Map from "ol/Map";',
    );
    void this.rebuild();
  }

  protected addPhenomenon(type: Phenomenon): void {
    this.sigwx?.addPhenomenon(type);
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
      this.setEngine(String(t.value) === "OpenLayersAdapter" ? "openlayers" : "maplibre");
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
    if (t?.key === "spMin" || t?.key === "spMax") {
      if (t.key === "spMin") this.spMin = Number(t.value);
      else this.spMax = Number(t.value);
      void this.rebuild(); // limits are a construction-time option
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
        ? { ...D.handle, color: String(val("handleColor")), strokeColor: String(val("handleStroke")) }
        : D.handle,
      slider: on("slider")
        ? { ...D.slider, color: String(val("sliderColor")) }
        : D.slider,
      controlHandle: on("control")
        ? { ...D.controlHandle, color: String(val("controlColor")) }
        : D.controlHandle,
      tooltip: on("tooltip")
        ? {
            ...D.tooltip,
            color: String(val("tipColor")),
            background: String(val("tipBg")),
            fontSize: Number(val("tipSize")),
          }
        : D.tooltip,
    };
    this.styleOverride = style;
    this.sigwx?.setStyle(style);
  }

  private teardown(): void {
    try { this.sigwx?.destroy(); } catch (e) { console.error("[showcase] destroy", e); }
    this.sigwx = undefined;
    try { this.mlMap?.remove(); } catch (e) { console.error("[showcase] ml remove", e); }
    try { this.olMap?.setTarget(undefined); } catch (e) { console.error("[showcase] ol detach", e); }
    this.mlMap = undefined;
    this.olMap = undefined;
    const el = this.mapEl().nativeElement;
    el.innerHTML = "";
    el.className = "map";
  }

  private async rebuild(): Promise<void> {
    try {
      const el = this.mapEl().nativeElement;
      const eng = this.engine();

      this.teardown();

      let adapter: MapLibreAdapter | OpenLayersAdapter;
      if (eng === "maplibre") {
        const map = createMapLibreMap({ container: el, center: CENTER, zoom: ZOOM });
        this.mlMap = map;
        map.addControl(new NavigationControl());
        adapter = new MapLibreAdapter({ map });
      } else {
        const map = createOpenLayersMap({ container: el, center: CENTER, zoom: ZOOM });
        this.olMap = map;
        adapter = new OpenLayersAdapter({ map });
      }

      this.sigwx = new SigwxDraw({
        adapter,
        // Turnkey native toolbar; `tools` restricts it to the jet stream for now
        // (CB / turbulence exist in the registry but are hidden for the 0.0.1).
        toolbar: this.toolbarOn ? { position: this.tbPos, tools: ["jetStream"] } : undefined,
        // Re-apply any live style edits so they survive an engine switch.
        style: this.styleOverride,
        // Per-phenomenon numeric bounds (here the jet wind-speed dial).
        limits: { jetStream: { speed: { min: this.spMin, max: this.spMax } } },
      });
      this.sigwx.on("change", (fc: FeatureCollection) => {
        this.geojson.set(
          fc.features.length ? JSON.stringify(fc, null, 2) : "// (empty FeatureCollection)",
        );
      });
      await this.sigwx.ready();
    } catch (e) {
      console.error("[showcase] rebuild failed", e);
    }
  }
}
