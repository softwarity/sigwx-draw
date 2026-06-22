/**
 * The descriptor framework — pure-JSON phenomenon descriptors, the named-extension
 * registries and the interpreter (`defFromDescriptor`). See
 * PROFILES.md (the authoring guide).
 */
export type {
  PhenomenonDescriptor,
  DescriptorField,
  NumberFieldDescriptor,
  FlFieldDescriptor,
  EnumFieldDescriptor,
  EnumOptionDescriptor,
  BoolFieldDescriptor,
  TextFieldDescriptor,
  ListFieldDescriptor,
  DescriptorCondition,
  FieldCondition,
  GestureSpec,
  EdgeSpec,
  InkSpec,
  CalloutSpec,
  LabelSpec,
  RenderSpec,
  RenderByGeometry,
  CardSpec,
  CardItemSpec,
  CardButtonSpec,
  CarouselItemSpec,
  GaugeItemSpec,
  DialItemSpec,
  SatelliteSpec,
  DeclutterSpec,
  GlyphRef,
  GlyphSpec,
  GlyphVariants,
  ObjectSpec,
  ToolSpec,
} from "./types.js";
export {
  registerExtensions,
  resolveGlyph,
  compileCondition,
} from "./extensions.js";
export type {
  SigwxExtensions,
  DecoratorExtension,
  FormatExtension,
  FormatContext,
  ConditionExtension,
  GeneratorExtension,
  ActionExtension,
} from "./extensions.js";
export { defFromDescriptor, validateDescriptor } from "./interpret.js";
export { evalTemplate } from "./template.js";
export { BUILTIN_GLYPHS } from "./atlas.js";
export { DESCRIPTOR_JSON_SCHEMA, PROFILE_JSON_SCHEMA } from "./schema.js";
