/**
 * `<sigwx-metadata-form>` — optional, framework-agnostic web component rendering
 * the schema-driven metadata form for the selected SIGWX feature. It handles the
 * two-level model: **global** fields, plus an optional **list** of sub-records
 * (e.g. a jet's break points) with an item selector and the selected item's
 * fields. Feed it a {@link FormSpec} via `spec`; it emits:
 *  - `change`     — a field edit (global, or list-item via `detail.list`);
 *  - `selectitem` — select/clear a list item (`detail.index`);
 *  - `additem` / `removeitem` — add / remove a list item.
 * The host wires these to `SigwxDraw` (`updateMetadata` / `updateListItem` /
 * `selectSubItem` / `addListItem` / `removeListItem`). Hosts may ignore it and
 * render their own form from the same `FormSpec`.
 */
import type { FormSpec, ResolvedField } from "../map/sigwx-draw.js";

export interface MetadataChangeDetail {
  featureId: string;
  key: string;
  value: unknown;
  /** Present when the edit targets a list item rather than a global field. */
  list?: { key: string; index: number };
}

const STYLE = `
:host { display:block; font: 13px/1.4 system-ui, sans-serif; color: var(--sigwx-fg, #e6edf3); }
.empty { opacity:.6; padding:8px 0; }
.field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
.field label { font-weight:600; font-size:12px; }
.field input, .field select { padding:5px 7px; border:1px solid var(--sigwx-border,#30363d); border-radius:6px; background:var(--sigwx-input-bg,#0d1117); color:inherit; }
.row { display:flex; align-items:center; gap:8px; }
.err { color:#f85149; font-size:11px; }
.list { border-top:1px solid var(--sigwx-border,#30363d); margin-top:6px; padding-top:10px; }
.list h3 { font-size:12px; margin:0 0 6px; text-transform:uppercase; letter-spacing:.04em; opacity:.7; }
.items { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
.items button { padding:4px 8px; border:1px solid var(--sigwx-border,#30363d); border-radius:6px; background:#0d1117; color:inherit; cursor:pointer; font-size:12px; }
.items button.on { border-color: var(--sigwx-accent,#58a6ff); color: var(--sigwx-accent,#58a6ff); }
.itembar { display:flex; gap:8px; margin-bottom:8px; }
.itembar button { padding:4px 10px; border:1px solid var(--sigwx-border,#30363d); border-radius:6px; background:#0d1117; color:inherit; cursor:pointer; }
.sub { border-left:2px solid var(--sigwx-border,#30363d); padding-left:10px; }
`;

export class SigwxMetadataForm extends HTMLElement {
  private _spec: FormSpec | null = null;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  set spec(spec: FormSpec | null) {
    this._spec = spec;
    this.render();
  }
  get spec(): FormSpec | null {
    return this._spec;
  }

  connectedCallback(): void {
    this.render();
  }

  private fire<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private emitChange(key: string, value: unknown, list?: { key: string; index: number }): void {
    if (!this._spec) return;
    const detail: MetadataChangeDetail = { featureId: this._spec.featureId, key, value, ...(list ? { list } : {}) };
    this.fire("change", detail);
  }

  private render(): void {
    const spec = this._spec;
    this.root.innerHTML = `<style>${STYLE}</style>`;
    if (!spec) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Select a phenomenon to edit its properties.";
      this.root.appendChild(empty);
      return;
    }
    for (const field of spec.fields) {
      if (field.visible) this.root.appendChild(this.renderField(field, spec.values[field.key], spec.errors[field.key]));
    }
    if (spec.list) this.renderList(spec);
  }

  private renderList(spec: FormSpec): void {
    const list = spec.list!;
    const box = document.createElement("div");
    box.className = "list";
    const h = document.createElement("h3");
    h.textContent = list.label;
    box.appendChild(h);

    const items = document.createElement("div");
    items.className = "items";
    for (const it of list.items) {
      const b = document.createElement("button");
      b.textContent = it.label;
      if (it.index === list.selectedIndex) b.classList.add("on");
      b.addEventListener("click", () => this.fire("selectitem", { index: it.index === list.selectedIndex ? null : it.index }));
      items.appendChild(b);
    }
    box.appendChild(items);

    const bar = document.createElement("div");
    bar.className = "itembar";
    const add = document.createElement("button");
    add.textContent = "+ Add";
    add.addEventListener("click", () => this.fire("additem", {}));
    bar.appendChild(add);
    if (list.selectedIndex != null) {
      const rm = document.createElement("button");
      rm.textContent = "− Remove";
      rm.addEventListener("click", () => this.fire("removeitem", { index: list.selectedIndex }));
      bar.appendChild(rm);
    }
    box.appendChild(bar);

    if (list.selectedIndex != null && list.itemFields) {
      const sub = document.createElement("div");
      sub.className = "sub";
      for (const field of list.itemFields) {
        if (field.visible) sub.appendChild(this.renderField(field, list.itemValues?.[field.key], undefined, { key: list.key, index: list.selectedIndex }));
      }
      box.appendChild(sub);
    }
    this.root.appendChild(box);
  }

  private renderField(field: ResolvedField, value: unknown, error: string | undefined, list?: { key: string; index: number }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "field";

    if (field.type === "bool") {
      const row = document.createElement("label");
      row.className = "row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value === true;
      input.addEventListener("change", () => this.emitChange(field.key, input.checked, list));
      row.append(input, document.createTextNode(field.label));
      wrap.appendChild(row);
      return wrap;
    }

    const label = document.createElement("label");
    label.textContent = field.label + (field.type === "number" && field.unit ? ` (${field.unit})` : field.type === "fl" ? " (FL)" : "");
    wrap.appendChild(label);

    if (field.type === "enum") {
      const select = document.createElement("select");
      for (const opt of field.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener("change", () => this.emitChange(field.key, select.value, list));
      wrap.appendChild(select);
    } else if (field.type === "number" || field.type === "fl") {
      const input = document.createElement("input");
      input.type = "number";
      if (field.type === "number") {
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        if (field.step !== undefined) input.step = String(field.step);
      }
      input.value = value === undefined || value === null ? "" : String(value);
      input.addEventListener("input", () => this.emitChange(field.key, input.value === "" ? null : Number(input.value), list));
      wrap.appendChild(input);
    } else if (field.type === "text") {
      const input = document.createElement("input");
      input.type = "text";
      if (field.maxLength !== undefined) input.maxLength = field.maxLength;
      input.value = value === undefined || value === null ? "" : String(value);
      input.addEventListener("input", () => this.emitChange(field.key, input.value, list));
      wrap.appendChild(input);
    }

    if (error) {
      const e = document.createElement("div");
      e.className = "err";
      e.textContent = error;
      wrap.appendChild(e);
    }
    return wrap;
  }
}

export function registerSigwxMetadataForm(tag = "sigwx-metadata-form"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, SigwxMetadataForm);
}
