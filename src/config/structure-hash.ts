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
import type {
  PropId,
  StructureDefinition,
} from "../structure/definition";
import {
  MASS_LAYOUT_G1_BASELINE,
  cloneMassLayout,
} from "../structure/families/mass/config";

/**
 * Geometry-code schema version. Field order comes from the registered control
 * tables; adding, removing or reordering a field requires a version bump.
 */
const PREFIX = "g1";
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const STRUCTURE_BITS = 4;
const FIELD_BITS = 6;
const END_FIELD = 2 ** FIELD_BITS - 1;
const MAX_FIELDS = END_FIELD;

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
 *
 * Values equal to the registered defaults are omitted. Each remaining entry is
 * a six-bit field id followed by the minimum bits its control range requires,
 * so the common default/small-edit case remains a short URL fragment.
 */
export function encodeStructureHash(config: StructureConfig): string {
  validateActiveStructureGeometryConfig(config);

  const definitions = listStructures();
  const structureIndex = definitions.findIndex(
    (definition) => definition.id === config.typeId,
  );

  if (structureIndex < 0 || structureIndex >= 2 ** STRUCTURE_BITS) {
    throw new RangeError(
      `Structure "${config.typeId}" cannot be represented by geometry code ${PREFIX}.`,
    );
  }

  const defaults = createGeometryCodeDefaults();
  defaults.typeId = config.typeId;
  const fields = collectFields(config);
  const defaultFields = collectFields(defaults);
  assertCompatibleFields(fields, defaultFields);

  const writer = new BitWriter();
  writer.write(structureIndex, STRUCTURE_BITS);

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const defaultField = defaultFields[index];

    if (!field || !defaultField) {
      continue;
    }

    const value = field.target[field.spec.key];
    const defaultValue = defaultField.target[defaultField.spec.key];

    if (!valuesEqual(value, defaultValue)) {
      writer.write(index, FIELD_BITS);
      writeFieldValue(writer, field, value);
      defaultField.target[defaultField.spec.key] = cloneValue(value);
      defaultField.spec.onChange?.(defaultField.target);
    }
  }

  writer.write(END_FIELD, FIELD_BITS);
  return PREFIX + writer.toBase64Url();
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

  if (!code.startsWith(PREFIX)) {
    throw new Error(`Geometry code must start with "${PREFIX}".`);
  }

  const payload = code.slice(PREFIX.length);

  if (payload.length === 0) {
    throw new Error("Geometry code payload is empty.");
  }

  const reader = BitReader.fromBase64Url(payload);
  const definitions = listStructures();
  const structureIndex = reader.read(STRUCTURE_BITS);
  const definition = definitions[structureIndex];

  if (!definition) {
    throw new RangeError(
      `Geometry code selects unknown structure index ${structureIndex}.`,
    );
  }

  const decoded = createGeometryCodeDefaults();
  decoded.typeId = definition.id;
  const fields = collectFields(decoded);
  let previousIndex = -1;

  while (true) {
    const index = reader.read(FIELD_BITS);

    if (index === END_FIELD) {
      break;
    }
    if (index <= previousIndex) {
      throw new Error("Geometry code fields must be unique and ordered.");
    }

    const field = fields[index];

    if (!field) {
      throw new RangeError(
        `Geometry code references unknown field ${index} for "${definition.id}".`,
      );
    }
    field.target[field.spec.key] = readFieldValue(reader, field);
    field.spec.onChange?.(field.target);
    previousIndex = index;
  }

  validateActiveStructureGeometryConfig(decoded);
  const canonical = encodeStructureHash(decoded);

  if (canonical !== code) {
    throw new Error("Geometry code is non-canonical or has trailing data.");
  }

  return { config: decoded, code: canonical };
}

/** The immutable defaults against which `g1` sparse entries are interpreted. */
function createGeometryCodeDefaults(): StructureConfig {
  const defaults = createDefaultStructureConfig();
  defaults.layouts.mass = cloneMassLayout(MASS_LAYOUT_G1_BASELINE);
  return defaults;
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
        addFields(fields, "fireBowl", config.fireBowl, FIRE_BOWL_CONTROLS);
        break;
      case "fire":
        addFields(fields, "fire", config.fire, FIRE_CONTROLS);
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

  if (fields.length > MAX_FIELDS) {
    throw new RangeError(
      `"${definition.id}" has ${fields.length} geometry fields; ${PREFIX} supports `
      + `at most ${MAX_FIELDS}. Bump the geometry-code schema.`,
    );
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
      overwriteObject(target.fireBowl, source.fireBowl);
      return;
    case "fire":
      overwriteObject(target.fire, source.fire);
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

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  }

  return Object.is(left, right);
}

function cloneValue(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function assertCompatibleFields(
  fields: readonly HashField[],
  defaults: readonly HashField[],
): void {
  if (
    fields.length !== defaults.length
    || fields.some((field, index) => field.label !== defaults[index]?.label)
  ) {
    throw new Error("Geometry code field schema does not match its defaults.");
  }
}

function writeFieldValue(
  writer: BitWriter,
  field: HashField,
  value: unknown,
): void {
  const { spec } = field;

  switch (spec.kind) {
    case "boolean":
      writer.write(value === true ? 1 : 0, 1);
      return;
    case "list": {
      const options = Object.values(spec.options);
      const index = options.indexOf(value as string);

      if (index < 0) {
        throw new RangeError(`${field.label} has an unsupported value.`);
      }

      writer.write(index, bitsFor(options.length));
      return;
    }
    case "number": {
      const number = value as number;
      const ticks = Math.round((number - spec.min) / spec.step);
      const count = tickCount(spec);
      const quantized = roundForStep(
        spec.min + ticks * spec.step,
        spec.step,
      );

      if (ticks < 0 || ticks >= count) {
        throw new RangeError(`${field.label} is outside its encodable range.`);
      }
      if (Math.abs(number - quantized) > spec.step * 1e-6) {
        throw new RangeError(
          `${field.label}=${number} does not align to its ${spec.step} control step.`,
        );
      }

      writer.write(ticks, bitsFor(count));
      return;
    }
    case "bezier": {
      const bezier = value as BezierValue;

      for (const component of bezier) {
        writer.writeFloat64(component);
      }
    }
  }
}

function readFieldValue(reader: BitReader, field: HashField): unknown {
  const { spec } = field;

  switch (spec.kind) {
    case "boolean":
      return reader.read(1) === 1;
    case "list": {
      const options = Object.values(spec.options);
      const index = reader.read(bitsFor(options.length));
      const value = options[index];

      if (value === undefined) {
        throw new RangeError(`${field.label} contains an invalid option.`);
      }

      return value;
    }
    case "number": {
      const count = tickCount(spec);
      const ticks = reader.read(bitsFor(count));

      if (ticks >= count) {
        throw new RangeError(`${field.label} contains an invalid number.`);
      }

      return roundForStep(spec.min + ticks * spec.step, spec.step);
    }
    case "bezier":
      return [
        reader.readFloat64(),
        reader.readFloat64(),
        reader.readFloat64(),
        reader.readFloat64(),
      ] satisfies BezierValue;
  }
}

function tickCount(
  spec: Extract<ControlSpec<object>, { kind: "number" }>,
): number {
  return Math.round((spec.max - spec.min) / spec.step) + 1;
}

function bitsFor(valueCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(valueCount)));
}

function roundForStep(value: number, step: number): number {
  const decimal = step.toString().split(".")[1]?.length ?? 0;
  return Number(value.toFixed(decimal));
}

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, width: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** width) {
      throw new RangeError(`Cannot write ${value} in ${width} bits.`);
    }

    for (let bit = 0; bit < width; bit += 1) {
      this.bits.push((value >>> bit) & 1);
    }
  }

  writeFloat64(value: number): void {
    if (!Number.isFinite(value)) {
      throw new RangeError("Geometry code cannot encode a non-finite curve value.");
    }

    const data = new DataView(new ArrayBuffer(8));
    data.setFloat64(0, value, true);
    this.write(data.getUint32(0, true), 32);
    this.write(data.getUint32(4, true), 32);
  }

  toBase64Url(): string {
    let encoded = "";

    for (let offset = 0; offset < this.bits.length; offset += 6) {
      let value = 0;

      for (let bit = 0; bit < 6; bit += 1) {
        value |= (this.bits[offset + bit] ?? 0) << bit;
      }

      encoded += ALPHABET[value];
    }

    return encoded;
  }
}

class BitReader {
  private offset = 0;

  private constructor(private readonly bits: readonly number[]) {}

  static fromBase64Url(payload: string): BitReader {
    const bits: number[] = [];

    for (const character of payload) {
      const value = ALPHABET.indexOf(character);

      if (value < 0) {
        throw new Error(`Geometry code contains invalid character "${character}".`);
      }

      for (let bit = 0; bit < 6; bit += 1) {
        bits.push((value >>> bit) & 1);
      }
    }

    return new BitReader(bits);
  }

  read(width: number): number {
    if (this.offset + width > this.bits.length) {
      throw new Error("Geometry code ended before its payload was complete.");
    }

    let value = 0;

    for (let bit = 0; bit < width; bit += 1) {
      value += (this.bits[this.offset + bit] ?? 0) * 2 ** bit;
    }

    this.offset += width;
    return value;
  }

  readFloat64(): number {
    const data = new DataView(new ArrayBuffer(8));
    data.setUint32(0, this.read(32), true);
    data.setUint32(4, this.read(32), true);
    const value = data.getFloat64(0, true);

    if (!Number.isFinite(value)) {
      throw new RangeError("Geometry code contains a non-finite curve value.");
    }

    return value;
  }
}
