/**
 * The phenomenon DESCRIPTOR vocabulary — the third level of the framework:
 * adapter (pixels/DOM) → lib (engine + named vocabulary + interpreter) → CONFIG.
 *
 * A descriptor is PURE JSON (storable, servable, CDN-publishable): it references
 * behaviour by NAME only (glyphs, decorators, actions, formats, conditions,
 * generators — see `extensions.ts`); it never embeds code. The interpreter
 * (`defFromDescriptor`) compiles a descriptor into a {@link PhenomenonDef} —
 * indistinguishable at runtime from a hand-written def.
 *
 * See PROFILES.md for the authoring guide.
 */
import type { FlMode } from "../phenomenon.js";
import type { PhenomenonStyle } from "../style.js";

// ── Glyphs ────────────────────────────────────────────────────────────────────

/** A glyph reference: `"atlas:name"` (named atlas entry) or inline `"<svg…>"`. */
export type GlyphRef = string;

/** A declarative glyph variant (resolved per feature state by the engine). */
export interface GlyphVariants {
  /** Hemisphere-dependent art (tropical cyclone): chosen from the point's latitude. */
  byHemisphere?: { n: GlyphRef; s: GlyphRef };
  /** Parametric TEXT glyph (the CB coverage stack): template lines over the value. */
  text?: string[];
}

export type GlyphSpec = GlyphRef | GlyphVariants;

// ── Conditions (declarative `visibleWhen`) ────────────────────────────────────

/** A declarative predicate over the feature's metadata (or a registered name). */
export interface FieldCondition {
  field: string;
  gte?: number;
  lte?: number;
  eq?: unknown;
  /** Item-scoped (list fields): the condition reads the ITEM's metadata. */
  named?: never;
}

export type DescriptorCondition = FieldCondition | { named: string };

// ── Metadata fields ───────────────────────────────────────────────────────────

interface DescriptorFieldBase {
  key: string;
  /** UI label; defaults to the key. */
  label?: string;
  required?: boolean;
  /** Hidden (and skipped by validation) unless this passes. */
  when?: DescriptorCondition;
}

export interface NumberFieldDescriptor extends DescriptorFieldBase {
  kind: "number";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default?: number;
}

/** A flight level. NO chart min/max here — bounds resolve from the PROFILE
 *  (`phenomena[type].flightLevel`, else the chart `vertical`); a descriptor only
 *  carries the métier default. */
export interface FlFieldDescriptor extends DescriptorFieldBase {
  kind: "fl";
  default?: number;
}

export interface EnumOptionDescriptor {
  value: string;
  label?: string;
  /** Carousel/symbol glyph; defaults to `atlas:{value}` (code-is-the-sprite-id). */
  glyph?: GlyphSpec;
  /** Opaque host data carried as-is (e.g. WMO BUFR figures for IWXXM export). */
  meta?: Record<string, unknown>;
}

export interface EnumFieldDescriptor extends DescriptorFieldBase {
  kind: "enum";
  options: EnumOptionDescriptor[];
  default?: string;
  /** Conditional option SET: the live options depend on ANOTHER field's value (e.g. a cloud
   *  layer's `amount` depends on its `type` — CB ⇒ ISOL/OCNL/FRQ/EMBD, else ⇒ FEW/SCT/BKN/OVC).
   *  `map[<other value>]` (or `map["*"]`) replaces `options`. Resolved LIB-side at each render;
   *  the adapter only ever receives the already-resolved option list. */
  optionsBy?: { field: string; map: Record<string, EnumOptionDescriptor[]> };
}

export interface BoolFieldDescriptor extends DescriptorFieldBase {
  kind: "bool";
  default?: boolean;
}

export interface TextFieldDescriptor extends DescriptorFieldBase {
  kind: "text";
  maxLength?: number;
  default?: string;
}

/** An ordered list of sub-records along the geometry (the jet's break points). */
export interface ListFieldDescriptor extends DescriptorFieldBase {
  kind: "list";
  item: DescriptorField[];
  /** One-line item label TEMPLATE (`{#}` = 1-based index, `{field|format}` = item fields). */
  itemLabel?: string;
  default?: Record<string, unknown>[];
}

export type DescriptorField =
  | NumberFieldDescriptor
  | FlFieldDescriptor
  | EnumFieldDescriptor
  | BoolFieldDescriptor
  | TextFieldDescriptor
  | ListFieldDescriptor;

// ── Gesture (how it is drawn) ─────────────────────────────────────────────────

export interface GestureSpec {
  primitive: "point" | "polyline" | "polygon";
  /** `lasso` = freehand stroke; `drop` = default geometry at the centre (placed at once); `click` =
   *  the tool ARMS, then a single map click drops a POINT where you click (a WMO symbol — point on
   *  the map, not at the centre); `click-path` = click-laid vertices; `lasso-or-spot` = freehand, a
   *  too-short stroke commits a POINT. */
  draw?: "lasso" | "drop" | "click" | "click-path" | "lasso-or-spot";
  smooth?: boolean;
  /** The path has a direction (arrow at the downstream end). */
  directional?: boolean;
  /** Enables the `draw_and_link` flow (the card's `+` button). */
  multiArea?: boolean;
  /** Enables the `erase` flow (the card's `−` button; polygon only). */
  erasable?: boolean;
  /** Named geometry generator for drop mode / draw fallback (e.g. `regular-polygon`). */
  default?: string;
  minVertices?: number;
}

// ── Render (unselected) ───────────────────────────────────────────────────────

export interface EdgeSpec {
  /** Treatments apply to EVERY ring; a hole's treatment inverts geometrically. */
  treatment?: "scallop" | "dash" | "ticks" | "plain" | "none";
  width?: number;
  dash?: number[];
}

/** Per-state ink: maps a field's value to a STYLE SUBKEY (e.g. `mod`/`sev`) whose
 *  colour drives edge + fill tint + glyph + text — so host style overrides keep working. */
export interface InkSpec {
  byField: string;
  map: Record<string, string>;
}

export interface CalloutSpec {
  /** Named anchor strategy. Default `largest-area-centroid` for areas. */
  anchor?: "largest-area-centroid" | "geometry-mid";
  leader?: "lightning" | "straight" | "none";
  /** Arrowhead at the anchor end (tip clamped in-area, hole-aware — engine). */
  arrow?: boolean;
  /** Box content: template lines (`{field|format}`). */
  content: string[];
  /** Single-layer override for a `repeat` (layer-stack) area: when the stack holds exactly ONE
   *  layer, the rest cartouche uses THESE lines (the "normal" centered column — e.g. amount /
   *  type / top / base — each on its own line) instead of stacking the compact `content` line.
   *  ≥2 layers fall back to `content` (one block per layer). Ignored for non-repeat areas. */
  contentSingle?: string[];
  /** Stable label id (defaults to the phenomenon type). */
  id?: string;
  /** `true` ⇒ framed white box (panel); `false` ⇒ bare text+halo (turbulence). */
  box?: boolean;
  /** Call-out ink: `"text"` = `style.text.color` (b&w panel); `"ink"` = the resolved
   *  per-state ink (turbulence). Default `"text"` when boxed, `"ink"` otherwise. */
  ink?: "text" | "ink";
  /** Symbol over the box from a field's value (the code IS the sprite id). */
  symbol?: { byField: string; inside?: boolean };
  detachable?: boolean;
}

/** A plain placed label (tropopause: the FL at the contour middle / the boxed spot). */
export interface LabelSpec {
  /** Named anchor strategy (`geometry-mid` = spot point / contour arc-middle). */
  anchor: "geometry-mid";
  content: string[];
  /** Boxed (white rectangle + border) vs bare text + halo. */
  box?: boolean;
  /** Box border width preset (`small` ≈ 0.8px / `medium` ≈ 1.4px / `large`). Default `medium`. */
  borderWidth?: "small" | "medium" | "large";
  /** LINE labels only: the label can be slid ALONG the line while selected (a drag
   *  handle appears on it). Its position rides `metadata.labelT` (fraction 0–1, default 0.5). */
  movable?: boolean;
}

export interface RenderSpec {
  edge?: EdgeSpec;
  /** `false` ⇒ no fill. Colour resolves from the ink; only the opacity is métier. */
  fill?: { opacity?: number } | false;
  ink?: InkSpec;
  /** Named decorators for the hard cases (the jet): `{ "use": "jet-barbs", …params }`. */
  decorations?: ({ use: string } & Record<string, unknown>)[];
  callout?: CalloutSpec;
  label?: LabelSpec;
}

/** Geometry-keyed render branches (tropopause: spot point vs contour line). */
export interface RenderByGeometry {
  point?: RenderSpec;
  line?: RenderSpec;
}

// ── Cards (selected): the panel + satellites ──────────────────────────────────

export interface PickerItemSpec {
  field: string;
  /** Option label TEMPLATE (`{value}` = the option's value); omitted ⇒ the options'
   *  GLYPHS (resolved from the atlas via each option's `glyph`, default `atlas:{value}`). */
  label?: string;
  /** How the picker presents its options (adapter `picker` control): `carousel` (≤5),
   *  `flower` (6–10), `grid` (>10) — each degrades to the next past its threshold.
   *  Omitted ⇒ adapter default (carousel with auto-degradation). */
  mode?: "carousel" | "flower" | "grid";
  /** Quick-pick. `open: true` makes a "stamp" picker (the WMO symbol):
   *  (1) OPEN its menu (flower/grid) as soon as the card appears — emitted as the widget node's
   *      `autofocus` (the adapter opens a picker on autofocus, as it focuses an input);
   *  (2) DESELECT the feature once an option is picked — pick the symbol and you're done
   *      (`PhenomenonDef.closeOnPick`, handled by the controller's onWidgetEdit). */
  open?: boolean;
}
/** @deprecated renamed to {@link PickerItemSpec} (the `carousel` control is now `picker`). */
export type CarouselItemSpec = PickerItemSpec;

export interface GaugeItemSpec {
  /** 1–2 cursor field keys (list-scoped names are engine-routed on a break point). */
  cursors: string[];
  /** Off-chart notch per side (`"xxx"` = the XXX sentinel); resolves with the profile FL. */
  beyond?: [string, string];
  /** Break-point gauges: EXTENT cursors `[below, above]` around the core cursor,
   *  shown only when their fields are visible (the item schema's `when`), seeded
   *  core ∓ 40 until a drag persists them (the jet's isotach depth, fig 9). */
  extent?: [string, string];
}

export interface DialItemSpec {
  field: string;
}

/** One content/control item of a card. Exactly ONE of the keys is set. */
export interface CardItemSpec {
  /** Static text (template over the metadata). */
  text?: string;
  /** Static glyph. */
  glyph?: GlyphSpec;
  size?: number;
  /** Inline-editable text input bound to a field (markers' name). */
  input?: { field: string };
  /** The auto lat/long line (adapter-filled). */
  coord?: boolean;
  /** An option picker bound to a field (adapter `picker` control: carousel/flower/grid). */
  picker?: PickerItemSpec;
  /** @deprecated alias of {@link picker}. */
  carousel?: PickerItemSpec;
  gauge?: GaugeItemSpec;
  dial?: DialItemSpec;
}

export interface CardButtonSpec {
  /** Card-edge slot, OR `"anchor"` = relocate the button OFF the card to the feature's
   *  arrow-tip anchor (a floating badge on the map, emitted by the controller). */
  place: "left" | "right" | "h-edges" | "top" | "bottom" | "anchor";
  /** Named action: `draw_and_link`, `erase`, `delete`, `detach`… (+ host-registered). */
  action: string;
  svg?: GlyphRef;
  title?: string;
}

export interface CardSpec {
  /** `true` | `false` | `"when-named"` (markers: bare until the input field is set). */
  framed?: boolean | "when-named";
  /** Card pinning on the anchor (markers: volcano pins its base dot). */
  origin?: "center" | "bottom";
  /** Card item layout: `"v"` column (default) | `"h"` row (e.g. the isotherm's inline `temp` picker
   *  alongside the FL, on one line). */
  dir?: "v" | "h";
  /** This card is the inline editor for a LINE-or-spot phenomenon's render LABEL: WHILE SELECTED it
   *  overlays the label on the LINE too (anchored at the label position, riding `labelT`), not just
   *  the Point spot. Default `false` ⇒ the card is the spot's own representation (Point only — the
   *  tropopause `kind` shape). The decorated label box is suppressed under the card when shown. */
  onLine?: boolean;
  /** Inner padding preset of a FRAMED panel (adapter presets: small=[3,5] /
   *  medium=[6,8] / large=[10,13] px). Default `"small"`. */
  pad?: "small" | "medium" | "large";
  /** Vertical gap (px) between stacked card items. Default `0`. */
  gap?: number;
  /** Unitless line-height for the card text (multi-line labels). Default `1.2`; lower (≈1)
   *  to tighten a compact label like the tropopause `H`/FL stack. */
  lineHeight?: number;
  /** Show a delete ✕ while selected. */
  deletable?: boolean;
  /** Frame OUTLINE driven by an enum field: maps each value to a `boxShape` (adapter presets
   *  `rect`/`pentagon-up`/`pentagon-down` or a custom normalized contour). E.g. the tropopause
   *  spot: `{ field:"kind", map:{ fl:"rect", high:"pentagon-up", low:"pentagon-down" } }`. */
  boxShapeBy?: { field: string; map: Record<string, string> };
  items: CardItemSpec[];
  buttons?: CardButtonSpec[];
}

// ── Repeat (a multi-layer list editor: the TEMSI cloud-layer area) ─────────────

/** Turns a LIST field into the multi-layer cloud-area editor: the PANEL shows just the ACTIVE
 *  layer's flat card (its pickers + FL text, so 1 or N layers look identical), and the side
 *  satellite carries ONE multi-range FL gauge — every layer's `[base, top]` band on a shared axis,
 *  a distinct colour each, all visible/editable at once, with a `+` at each end to add a layer and
 *  a fling-off-axis to delete one. Touching a band makes it the active (edited) layer. The lib keeps
 *  the list SORTED (highest layer on top), re-sorting ONLY on discrete actions (add / remove /
 *  select) — never mid-drag. The unselected cartouche stacks one call-out `content` block PER layer. */
export interface RepeatSpec {
  /** The LIST field whose items are the layers. */
  listField: string;
  /** One-line peek TEMPLATE for a layer (`{field|format}` over the item). */
  preview: string;
  /** Minimum layer count (the `−`/fling-delete hides at this floor). */
  min: number;
  /** Maximum layer count (the `+` hides at this ceiling). */
  max: number;
  /** Per-layer accent palette (band/handle/panel-frame colours), cycled by layer index.
   *  Omitted ⇒ the lib's default palette. */
  layerColors?: string[];
}

/** A zone-level composite (the non-convective cloud's icing / turbulence). Its data lives at
 *  `metadata[key]` ({ symbol, baseFL, topFL }); its editing card/picker/gauge are those of the
 *  referenced stock phenomenon (`ref`), glued to the zone card on the given `place`. */
export interface CompositeSpec {
  /** Metadata sub-object key (`"icing"` / `"turb"`). */
  key: string;
  /** Registry type whose fields/card/style this composite reuses (`"icing"` / `"turbulence"`). */
  ref: string;
  /** Which edge of the zone card its own card glues to. */
  place: "top" | "bottom";
}

export interface SatelliteSpec {
  /** Card id suffix (`featureId#part`) — engine-routed. */
  part: string;
  /** Named anchor strategy: `callout` = the placed box anchor; `geometry-mid` = spot
   *  point / contour arc-middle; `break-point` = the selected list item ON the path. */
  anchor: "callout" | "geometry-mid" | "break-point";
  /** `flRef` pins the selection-time level at the anchor's screen height (drag-stable). */
  pin?: "flRef";
  /** Origin policy relative to the anchor. */
  side?: "right" | "center";
  items: CardItemSpec[];
}

// ── Declutter (zoom visibility policy) ────────────────────────────────────────

export type DeclutterSpec =
  | { chrome?: boolean; late?: string[] }
  | "never";

// ── The descriptor ────────────────────────────────────────────────────────────

export interface PhenomenonDescriptor {
  schemaVersion: 1;
  /** Registry key. */
  type: string;
  label: string;
  /** Toolbar glyph; defaults to `atlas:{type}`. */
  icon?: GlyphRef;
  gesture: GestureSpec;
  fields?: DescriptorField[];
  /** Off-chart FL behaviour `[below-min, above-max]` (areas → `["xxx","xxx"]`). */
  flBeyond?: [FlMode, FlMode];
  render?: RenderSpec | RenderByGeometry;
  card?: CardSpec;
  /** Stack a LIST field as repeated layer cards (the TEMSI cloud-layer area): the `card`
   *  describes ONE layer's body, edited as the adapter `stack` control. */
  repeat?: RepeatSpec;
  satellites?: SatelliteSpec[];
  /** Optional zone-level COMPOSITES (the non-convective cloud's icing/turbulence): each is a
   *  symbol+FL sub-object stored at `metadata[key]`, edited on its OWN card glued to the zone card
   *  (icing above, turb below). Its fields/picker/gauge REUSE the referenced phenomenon's
   *  descriptor (`ref` → the stock `icing`/`turbulence` def), so there's no data duplication. */
  composites?: CompositeSpec[];
  /** Plain JSON style (the same shape host overrides patch). */
  style: PhenomenonStyle;
  /** One-line summary TEMPLATE (`{field|format}`). */
  summary?: string;
  declutter?: DeclutterSpec;
}

// ── Profile composition (§2b) ─────────────────────────────────────────────────

/** One entry of a profile's `objects`: a stock type name or a full inline
 *  descriptor. There is no cross-profile inheritance — a derived chart is a
 *  duplicated, self-contained profile file. */
export type ObjectSpec = string | PhenomenonDescriptor;

/** A toolbar entry: a phenomenon type, or a named GROUP. A group's `items` may themselves
 *  be groups → NESTED submenus (toolbar → submenu → sub-submenu, any depth). */
export interface ToolGroupSpec {
  group: string;
  icon?: GlyphRef;
  /** A submenu opener defaults to a "split button" that mirrors the last-picked child and
   *  re-draws it on parent-click (`toggle` omitted ⇒ true). Set `false` for a PURE dropdown:
   *  fixed icon (never mirrors a child), opens the menu only, never draws. */
  toggle?: boolean;
  items: ToolSpec[];
}
export type ToolSpec = string | ToolGroupSpec;
