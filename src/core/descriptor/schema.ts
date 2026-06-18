/**
 * The JSON Schema of a {@link PhenomenonDescriptor} (draft 2020-12) — ships with
 * the lib for editor autocompletion and backend validation (a profile server
 * validates descriptors BEFORE serving them; the interpreter re-validates names
 * against the LIVE registries at compile time, listing the available ones).
 *
 * Kept in sync with `types.ts` (the TypeScript view of the same vocabulary).
 */

const glyphRef = { type: "string", description: 'Glyph reference: "atlas:name" or inline "<svg…>".' };

const glyphSpec = {
  oneOf: [
    glyphRef,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        byHemisphere: {
          type: "object",
          additionalProperties: false,
          required: ["n", "s"],
          properties: { n: glyphRef, s: glyphRef },
        },
        text: { type: "array", items: { type: "string" } },
      },
    },
  ],
};

const condition = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["field"],
      properties: {
        field: { type: "string" },
        gte: { type: "number" },
        lte: { type: "number" },
        eq: {},
      },
    },
    { type: "object", additionalProperties: false, required: ["named"], properties: { named: { type: "string" } } },
  ],
};

const fieldBase = {
  key: { type: "string" },
  label: { type: "string" },
  required: { type: "boolean" },
  when: condition,
};

const field: Record<string, unknown> = {
  type: "object",
  required: ["key", "kind"],
  properties: {
    ...fieldBase,
    kind: { enum: ["number", "fl", "enum", "bool", "text", "list"] },
    // number
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number" },
    unit: { type: "string" },
    // enum
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          glyph: glyphSpec,
          meta: { type: "object" },
        },
      },
    },
    // enum: conditional option SET (live options depend on another field's value)
    optionsBy: {
      type: "object",
      additionalProperties: false,
      required: ["field", "map"],
      properties: {
        field: { type: "string" },
        map: {
          type: "object",
          description: 'Other-field value (or "*") → its option list.',
          additionalProperties: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "string" }, label: { type: "string" }, glyph: glyphSpec, meta: { type: "object" } },
            },
          },
        },
      },
    },
    // text
    maxLength: { type: "number" },
    // list
    item: { type: "array", items: { $ref: "#/$defs/field" } },
    itemLabel: { type: "string" },
    default: {},
  },
};

/** A picker (option control) bound to an enum field: `carousel` (≤5) / `flower` (6–10) / `grid`
 *  (>10), each degrading to the next past its threshold (omit ⇒ adapter default). */
const picker = {
  type: "object",
  additionalProperties: false,
  required: ["field"],
  properties: { field: { type: "string" }, label: { type: "string" }, mode: { enum: ["carousel", "flower", "grid"] } },
};

const cardItem = {
  type: "object",
  additionalProperties: false,
  description: "Exactly ONE of text/glyph/input/coord/picker/gauge/dial.",
  properties: {
    text: { type: "string" },
    glyph: glyphSpec,
    size: { type: "number" },
    input: { type: "object", additionalProperties: false, required: ["field"], properties: { field: { type: "string" } } },
    coord: { type: "boolean" },
    picker,
    carousel: picker, // deprecated alias of `picker`
    gauge: {
      type: "object",
      additionalProperties: false,
      required: ["cursors"],
      properties: {
        cursors: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        beyond: { type: "array", items: { enum: ["xxx", "clamp"] }, minItems: 2, maxItems: 2 },
        extent: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
      },
    },
    dial: { type: "object", additionalProperties: false, required: ["field"], properties: { field: { type: "string" } } },
  },
  minProperties: 1,
};

const edge = {
  type: "object",
  additionalProperties: false,
  properties: {
    treatment: { enum: ["scallop", "dash", "ticks", "plain", "none"] },
    width: { type: "number" },
    dash: { type: "array", items: { type: "number" } },
  },
};

const callout = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    anchor: { enum: ["largest-area-centroid", "geometry-mid"] },
    leader: { enum: ["lightning", "straight", "none"] },
    arrow: { type: "boolean" },
    content: { type: "array", items: { type: "string" } },
    contentSingle: { type: "array", items: { type: "string" } },
    id: { type: "string" },
    box: { type: "boolean" },
    ink: { enum: ["text", "ink"] },
    symbol: {
      type: "object",
      additionalProperties: false,
      required: ["byField"],
      properties: { byField: { type: "string" }, inside: { type: "boolean" } },
    },
    detachable: { type: "boolean" },
  },
};

const renderSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    edge,
    fill: {
      oneOf: [
        { const: false },
        { type: "object", additionalProperties: false, properties: { opacity: { type: "number" } } },
      ],
    },
    ink: {
      type: "object",
      additionalProperties: false,
      required: ["byField", "map"],
      properties: {
        byField: { type: "string" },
        map: { type: "object", additionalProperties: { type: "string" }, description: 'Field value → style subkey; "*" = wildcard.' },
      },
    },
    decorations: {
      type: "array",
      items: { type: "object", required: ["use"], properties: { use: { type: "string" } } },
    },
    callout,
    label: {
      type: "object",
      additionalProperties: false,
      required: ["anchor", "content"],
      properties: {
        anchor: { const: "geometry-mid" },
        content: { type: "array", items: { type: "string" } },
        box: { type: "boolean" },
      },
    },
  },
};

/** JSON Schema (draft 2020-12) for a single phenomenon descriptor. */
export const DESCRIPTOR_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://softwarity.io/sigwx-draw/phenomenon-descriptor.schema.json",
  title: "SIGWX phenomenon descriptor",
  type: "object",
  required: ["schemaVersion", "type", "label", "gesture", "style"],
  properties: {
    schemaVersion: { const: 1 },
    type: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    icon: glyphRef,
    gesture: {
      type: "object",
      additionalProperties: false,
      required: ["primitive"],
      properties: {
        primitive: { enum: ["point", "polyline", "polygon"] },
        draw: { enum: ["lasso", "drop", "click-path", "lasso-or-spot"] },
        smooth: { type: "boolean" },
        directional: { type: "boolean" },
        multiArea: { type: "boolean" },
        erasable: { type: "boolean" },
        default: { type: "string", description: "Named geometry generator." },
        minVertices: { type: "number" },
      },
    },
    fields: { type: "array", items: { $ref: "#/$defs/field" } },
    flBeyond: { type: "array", items: { enum: ["xxx", "clamp"] }, minItems: 2, maxItems: 2 },
    render: {
      oneOf: [
        renderSpec,
        {
          type: "object",
          additionalProperties: false,
          properties: { point: renderSpec, line: renderSpec },
        },
      ],
    },
    card: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        framed: { oneOf: [{ type: "boolean" }, { const: "when-named" }] },
        origin: { enum: ["center", "bottom"] },
        deletable: { type: "boolean" },
        items: { type: "array", items: cardItem },
        buttons: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["place", "action"],
            properties: {
              place: { enum: ["left", "right", "h-edges"] },
              action: { type: "string", description: "Named action (draw_and_link, erase, … + host-registered)." },
              svg: glyphRef,
              title: { type: "string" },
            },
          },
        },
      },
    },
    repeat: {
      type: "object",
      additionalProperties: false,
      required: ["listField", "preview", "min", "max"],
      description: "Edit a LIST field as the multi-layer cloud-area (the TEMSI cloud-layer area).",
      properties: {
        listField: { type: "string", minLength: 1 },
        preview: { type: "string" },
        min: { type: "number" },
        max: { type: "number" },
      },
    },
    satellites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["part", "anchor", "items"],
        properties: {
          part: { type: "string", minLength: 1 },
          anchor: { enum: ["callout", "geometry-mid", "break-point"] },
          pin: { const: "flRef" },
          side: { enum: ["right", "center"] },
          items: { type: "array", items: cardItem, minItems: 1 },
        },
      },
    },
    style: { type: "object", required: ["color"], properties: { color: { type: "string" } } },
    summary: { type: "string" },
    declutter: {
      oneOf: [
        { const: "never" },
        {
          type: "object",
          additionalProperties: false,
          properties: { chrome: { type: "boolean" }, late: { type: "array", items: { type: "string" } } },
        },
      ],
    },
  },
  $defs: { field },
} as const;

/** JSON Schema (draft 2020-12) for a WHOLE chart profile — the single ingestion
 *  unit (§2b): vertical + thresholds + inline glyphs + objects + grouped tools.
 *  A backend validates the file before serving it; `extends` patches are
 *  free-form by nature (any descriptor subset), so they validate structurally. */
export const PROFILE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://softwarity.io/sigwx-draw/profile.schema.json",
  title: "SIGWX chart profile",
  type: "object",
  required: ["id"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1 },
    vertical: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      properties: {
        min: { type: "number" },
        max: { type: "number" },
        unit: { enum: ["fl", "hft-amsl"] },
      },
    },
    callouts: {
      type: "object",
      additionalProperties: false,
      properties: { minZoneFraction: { type: "number" } },
    },
    glyphs: {
      type: "object",
      additionalProperties: { type: "string", pattern: "^<svg" },
      description: "Inline atlas additions (normalized `<svg viewBox=…>` art, currentColor).",
    },
    objects: {
      type: "array",
      items: {
        oneOf: [
          { type: "string", description: "A stock descriptor, as-is." },
          {
            type: "object",
            required: ["extends"],
            properties: { extends: { type: "string" } },
            description: "A stock reference + deep-merge patch (patch wins; keyed-array patches address fields/options/satellites by id).",
          },
          { $ref: "phenomenon-descriptor.schema.json", description: "A full inline descriptor." },
        ],
      },
    },
    tools: {
      type: "array",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            additionalProperties: false,
            required: ["group", "items"],
            properties: {
              group: { type: "string", minLength: 1 },
              icon: { type: "string" },
              toggle: { type: "boolean" },
              items: { type: "array", items: { type: ["string", "object"] }, minItems: 1 },
            },
          },
        ],
      },
    },
    phenomena: { type: "object", description: "TRANSITIONAL per-phenomenon overrides — converges into `objects` patches." },
  },
} as const;
