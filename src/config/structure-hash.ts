import { defineCodec, type Codec, type CodecField } from "proc-seed";
import type {
  BezierValue,
  ControlSpec,
} from "./control-spec";
import {
  createBevelControls,
  createStoneControls,
} from "./sections";
import {
  createDefaultStructureConfig,
  validateActiveStructureGeometryConfig,
  type StructureConfig,
} from "./structure-config";
import {
  FIRE_BOWL_CONTROLS,
} from "../props/fire-bowl/config";
import { FIRE_CONTROLS } from "../props/fire/config";
import { OFFERING_CONTROLS } from "../props/offering/config";
import {
  PILLAR_BEVEL_CONTROLS,
  PILLAR_LAYOUT_CONTROLS,
  PILLAR_STONE_CONTROLS,
} from "../props/pillar/config";
import {
  getStructure,
  listStructures,
} from "../structure/registry";
import { engravingControls } from "../engravings/config";
import {
  slotFeatureControls,
  type PropId,
  type StructureDefinition,
} from "../structure/definition";

/**
 * Dense current-schema encoding. There is deliberately no version marker or
 * migration layer: field order is the schema, and codes from older layouts may
 * stop decoding when the generator contract changes.
 */

/**
 * The structure-type selector is encoded on its own, ahead of the active
 * structure's own field payload, because different structures have entirely
 * different field lists — one dense codec cannot describe both at once. It is
 * always exactly one base62 character: `defineCodec` never emits a leading
 * digit for a value that fits in one, and `assertStructureCapacity` keeps the
 * registry within the 62 values one digit can hold.
 */
const TYPE_DIGITS = 1;
const TYPE_RADIX = 62;

/** One cubic-bezier control's four components, in wire order. */
const BEZIER_COMPONENTS = ["x1", "y1", "x2", "y2"] as const;
/** `x1`/`x2` are validated to this range elsewhere; `y1`/`y2` are not
 * constrained at all today, so this codec grid gives them generous headroom
 * rather than reusing the x range. A value outside it is clamped on encode,
 * rather than rejected — the one field pair in the whole schema where that is
 * true, since every other field's range is already enforced before a code is
 * ever built. */
const BEZIER_X_RANGE = { min: 0, max: 1, step: 1 / 1024 } as const;
const BEZIER_Y_RANGE = { min: -1, max: 2, step: 1 / 1024 } as const;

interface HashField {
  readonly label: string;
  readonly spec: ControlSpec<object>;
  readonly target: Record<string, unknown>;
}

interface DecodedGeometry {
  readonly config: StructureConfig;
  readonly code: string;
}

/**
 * Encodes the selected structure and every control on its own tabs. Scene,
 * camera, debug and tool state are outside this boundary.
 */
export function encodeStructureHash(config: StructureConfig): string {
  validateActiveStructureGeometryConfig(config);

  const definitions = listStructures();
  assertStructureCapacity(definitions.length);
  const structureIndex = definitions.findIndex(
    (definition) => definition.id === config.typeId,
  );

  if (structureIndex < 0) {
    throw new RangeError(`Structure "${config.typeId}" is not registered.`);
  }

  const fields = collectFields(config);
  const form: Record<string, number> = {};

  for (const field of fields) {
    writeFieldValue(field, form);
  }

  return typeCodec(definitions.length).encode({ type: structureIndex })
    + fieldsCodec(fields).encode(form);
}

/**
 * Restores one geometry code into the existing live config objects.
 *
 * Only the decoded structure's geometry-owned objects are overwritten. Inactive
 * structure values and all Scene/tool objects keep both their values and object
 * identities, which keeps existing Tweakpane bindings valid.
 */
export function applyStructureHash(
  config: StructureConfig,
  fragment: string,
): string {
  const decoded = decodeStructureHash(fragment);
  const definition = getStructure(decoded.config.typeId);
  config.typeId = definition.id;

  overwriteObject(
    requireRecord(config.layouts, definition.id, "layout"),
    requireRecord(decoded.config.layouts, definition.id, "decoded layout"),
  );

  // In place, like the layout above: the pane binds each assignment object
  // directly, so replacing one would leave every engraving control writing to
  // an object nothing reads.
  const live = config.engravings[definition.id];
  const restored = decoded.config.engravings[definition.id];

  if (live && restored) {
    overwriteObject(live, restored);
  }

  for (const prop of definition.props) {
    overwriteProp(config, decoded.config, definition, prop);
  }

  validateActiveStructureGeometryConfig(config);
  return decoded.code;
}

/** Returns whether a fragment is a canonical, supported geometry code. */
export function isStructureHash(fragment: string): boolean {
  try {
    decodeStructureHash(fragment);
    return true;
  } catch {
    return false;
  }
}

function decodeStructureHash(fragment: string): DecodedGeometry {
  const code = fragment.startsWith("#") ? fragment.slice(1) : fragment;

  if (code.length <= TYPE_DIGITS) {
    throw new Error("Geometry code payload is empty.");
  }

  const definitions = listStructures();
  assertStructureCapacity(definitions.length);
  const typeForm = typeCodec(definitions.length).decode(
    code.slice(0, TYPE_DIGITS),
  );

  if (!typeForm) {
    throw new Error("Geometry code has an invalid structure selector.");
  }

  const definition = definitions[typeForm.type];

  if (!definition) {
    throw new RangeError(
      `Geometry code selects unknown structure index ${typeForm.type}.`,
    );
  }

  const decoded = createDefaultStructureConfig();
  decoded.typeId = definition.id;
  const fields = collectFields(decoded);
  const form = fieldsCodec(fields).decode(code.slice(TYPE_DIGITS));

  if (!form) {
    throw new Error("Geometry code payload is invalid or corrupted.");
  }

  for (const field of fields) {
    readFieldValue(field, form);
    field.spec.onChange?.(field.target);
  }

  validateActiveStructureGeometryConfig(decoded);

  return { config: decoded, code: encodeStructureHash(decoded) };
}

function assertStructureCapacity(count: number): void {
  if (count > TYPE_RADIX) {
    throw new RangeError(
      `${count} registered structures exceed the ${TYPE_RADIX} the `
      + "selector supports. Widen TYPE_DIGITS.",
    );
  }
}

function typeCodec(structureCount: number): Codec<{ type: number }> {
  return defineCodec<{ type: number }>([
    { key: "type", min: 0, max: Math.max(structureCount - 1, 0), step: 1 },
  ]);
}

/** Built fresh per call from the active structure's own field list, exactly
 * like `collectFields` itself — there is nothing here worth caching. */
function fieldsCodec(fields: readonly HashField[]): Codec<Record<string, number>> {
  return defineCodec<Record<string, number>>(fields.flatMap(codecFieldsFor));
}

function codecFieldsFor(field: HashField): readonly CodecField[] {
  const { spec, label } = field;

  switch (spec.kind) {
    case "boolean":
      return [{ key: label, min: 0, max: 1, step: 1 }];
    case "list":
      return [{
        key: label,
        min: 0,
        max: Object.values(spec.options).length - 1,
        step: 1,
      }];
    case "number":
      return [{ key: label, min: spec.min, max: spec.max, step: spec.step }];
    case "bezier":
      return BEZIER_COMPONENTS.map((component, index) => ({
        key: `${label}.${component}`,
        ...(index % 2 === 0 ? BEZIER_X_RANGE : BEZIER_Y_RANGE),
      }));
    case "text":
      if (spec.codec) {
        return [{ key: label, min: 0, max: spec.codec.max, step: 1 }];
      }

      throw new TypeError(unencodableText(label, spec.kind));
    case "color":
      throw new TypeError(unencodableText(label, spec.kind));
  }
}

/**
 * Named rather than skipped.
 *
 * The codec is a mixed radix over each control's own grid, so a field with no
 * finite set of values has no radix and cannot be carried. Both kinds that hit
 * this describe an engraving, which never reaches `collectFields` at all — so
 * this is a guard against a future layout field, and it has to be a refusal
 * rather than a silent omission or the code would decode into a structure that
 * is not the one it was written from.
 */
function unencodableText(label: string, kind: string): string {
  return `${label} is a ${kind} control, which a geometry code cannot carry.`;
}

/** Reads one field's live value into the codec's flat numeric form. */
function writeFieldValue(field: HashField, form: Record<string, number>): void {
  const { spec, label } = field;
  const value = field.target[spec.key];

  switch (spec.kind) {
    case "boolean":
      form[label] = value === true ? 1 : 0;
      return;
    case "list": {
      const options = Object.values(spec.options);
      const index = options.indexOf(value as string);

      if (index < 0) {
        throw new RangeError(`${field.label} has an unsupported value.`);
      }

      form[label] = index;
      return;
    }
    case "number": {
      const number = value as number;
      assertAligned(field, number);
      form[label] = number;
      return;
    }
    case "bezier": {
      const bezier = value as BezierValue;

      BEZIER_COMPONENTS.forEach((component, index) => {
        form[`${label}.${component}`] = bezier[index] ?? 0;
      });
      return;
    }
    // This switch returns void, so an unhandled kind would fall through and
    // write nothing rather than fail to compile. Say so out loud.
    case "text":
      if (spec.codec) {
        form[label] = spec.codec.encode(value as string);
        return;
      }

      throw new TypeError(unencodableText(label, spec.kind));
    case "color":
      throw new TypeError(unencodableText(label, spec.kind));
  }
}

/** Writes one field's decoded numeric form back into its live target. */
function readFieldValue(field: HashField, form: Record<string, number>): void {
  const { spec, label } = field;

  switch (spec.kind) {
    case "boolean":
      field.target[spec.key] = form[label] === 1;
      return;
    case "list": {
      const options = Object.values(spec.options);
      const value = options[form[label] ?? -1];

      if (value === undefined) {
        throw new RangeError(`${field.label} contains an invalid option.`);
      }

      field.target[spec.key] = value;
      return;
    }
    case "number":
      field.target[spec.key] = form[label];
      return;
    case "bezier": {
      const [x1, y1, x2, y2] = BEZIER_COMPONENTS.map(
        (component) => form[`${label}.${component}`] ?? 0,
      );
      field.target[spec.key] = [x1!, y1!, x2!, y2!] satisfies BezierValue;
      return;
    }
    case "text":
      if (spec.codec) {
        field.target[spec.key] = spec.codec.decode(form[label] ?? 0);
        return;
      }

      throw new TypeError(unencodableText(label, spec.kind));
    case "color":
      throw new TypeError(unencodableText(label, spec.kind));
  }
}

/**
 * `defineCodec`'s own quantisation silently rounds and clamps an off-grid
 * number to its nearest step instead of rejecting it. Every other field's
 * range is already enforced before a code is built, but step alignment for a
 * plain number control is not — `validateControls` only checks it for
 * integer steps — so this guard is the one thing worth keeping from the old
 * codec's stricter behaviour: a value that does not sit on its control's grid
 * is a caller bug, not something to silently reinterpret.
 */
function assertAligned(field: HashField, value: number): void {
  if (field.spec.kind !== "number") {
    return;
  }

  const { min, step } = field.spec;
  const ticks = Math.round((value - min) / step);
  const quantized = min + ticks * step;

  if (Math.abs(value - quantized) > step * 1e-6) {
    throw new RangeError(
      `${field.label}=${value} does not align to its ${step} control step.`,
    );
  }
}

function collectFields(config: StructureConfig): HashField[] {
  const definition = getStructure(config.typeId);
  const fields: HashField[] = [];
  addFields(
    fields,
    `${definition.id}.layout`,
    requireRecord(config.layouts, definition.id, "layout"),
    definition.layoutControls,
  );

  // Each slot feature's settings live in their own sub-object, addressed the
  // same way `pillar.stone` is below.
  const layout = requireRecord(config.layouts, definition.id, "layout");
  for (const feature of definition.slotFeatures ?? []) {
    addFields(
      fields,
      `${definition.id}.slots.${feature.id}`,
      feature.select(layout),
      slotFeatureControls(feature.label, feature.framed, feature.relief),
    );
  }

  // An engraving used to be excluded here, on the grounds that it dresses a
  // slot without changing the stone it is cut into and so could not affect
  // whether a structure is encodable. That held while an engraving was one
  // motif on a face. A grid with a pool, a cell range and an arrangement is
  // most of what a design *is*, and a code that dropped it was not describing
  // what was on screen.
  const engravings = config.engravings[definition.id];

  if (engravings) {
    for (const feature of definition.slotFeatures ?? []) {
      const assignment = engravings[feature.id];

      if (assignment) {
        addFields(
          fields,
          `${definition.id}.engraving.${feature.id}`,
          assignment,
          engravingControls(feature.label),
        );
      }
    }
  }

  for (const prop of definition.props) {
    switch (prop) {
      case "stone":
        addFields(
          fields,
          `${definition.id}.stone`,
          requireRecord(config.stones, definition.id, "stone"),
          createStoneControls([]),
        );
        break;
      case "bevel":
        addFields(
          fields,
          `${definition.id}.bevel`,
          requireRecord(config.bevels, definition.id, "bevel"),
          createBevelControls([]),
        );
        break;
      case "pillar":
        addFields(fields, "pillar", config.pillar, PILLAR_LAYOUT_CONTROLS);
        addFields(fields, "pillar.stone", config.pillar.stone, PILLAR_STONE_CONTROLS);
        addFields(fields, "pillar.bevel", config.pillar.bevel, PILLAR_BEVEL_CONTROLS);
        break;
      case "fireBowl":
        addFields(
          fields,
          `${definition.id}.fireBowl`,
          requireRecord(config.fireBowls, definition.id, "fire bowl"),
          FIRE_BOWL_CONTROLS,
        );
        break;
      case "fire":
        addFields(
          fields,
          `${definition.id}.fire`,
          requireRecord(config.fires, definition.id, "fire"),
          FIRE_CONTROLS,
        );
        break;
      case "offering":
        addFields(fields, "offering", config.offering, OFFERING_CONTROLS);
        break;
      // Surface assignment changes rendering only. The geometry code is an
      // exact reconstruction of generated geometry, not scene presentation.
      case "materialPalette":
        break;
    }
  }

  return fields;
}

function addFields<T extends object>(
  fields: HashField[],
  prefix: string,
  target: T,
  specs: readonly ControlSpec<T>[],
): void {
  for (const spec of specs) {
    fields.push({
      label: `${prefix}.${spec.key}`,
      spec: spec as unknown as ControlSpec<object>,
      target: target as Record<string, unknown>,
    });
  }
}

function overwriteProp(
  target: StructureConfig,
  source: StructureConfig,
  definition: StructureDefinition,
  prop: PropId,
): void {
  switch (prop) {
    case "stone":
      overwriteObject(
        requireRecord(target.stones, definition.id, "stone"),
        requireRecord(source.stones, definition.id, "decoded stone"),
      );
      return;
    case "bevel":
      overwriteObject(
        requireRecord(target.bevels, definition.id, "bevel"),
        requireRecord(source.bevels, definition.id, "decoded bevel"),
      );
      return;
    case "pillar":
      overwriteObject(target.pillar, source.pillar);
      return;
    case "fireBowl":
      overwriteObject(
        requireRecord(target.fireBowls, definition.id, "fire bowl"),
        requireRecord(source.fireBowls, definition.id, "decoded fire bowl"),
      );
      return;
    case "fire":
      overwriteObject(
        requireRecord(target.fires, definition.id, "fire"),
        requireRecord(source.fires, definition.id, "decoded fire"),
      );
      return;
    case "offering":
      overwriteObject(target.offering, source.offering);
      return;
    case "materialPalette":
      return;
  }
}

function overwriteObject(
  targetObject: object,
  sourceObject: object,
): void {
  const target = targetObject as Record<string, unknown>;
  const source = sourceObject as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    const current = target[key];

    if (isPlainRecord(current) && isPlainRecord(value)) {
      overwriteObject(current, value);
    } else if (Array.isArray(value)) {
      target[key] = [...value];
    } else {
      target[key] = value;
    }
  }
}

function requireRecord<T extends object>(
  records: Record<string, T>,
  id: string,
  label: string,
): T & Record<string, unknown> {
  const record = records[id];

  if (!record) {
    throw new Error(`Missing ${label} config for structure "${id}".`);
  }

  return record as T & Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
