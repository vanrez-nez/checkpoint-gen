/**
 * The optimized runtime export of the Geometry Engravings editor.
 *
 * That editor keeps two export formats. The editable one carries vector shapes,
 * editor state and a migration chain across four schema versions; the optimized
 * one carries nothing but the resolved answer — a grid of depth levels, one
 * value per logical cell, bit-packed. This project reads only the second, which
 * is why none of the editor's geometry, contour clipping or SVG rasterisation
 * had to come with it: the optimized file already is the height field, at the
 * resolution the artist authored it.
 *
 * The format is deliberately treated as an interface with another program.
 * Future documents will be exported into `public/engravings/` by that editor
 * without this project being consulted, so the decoder validates what it is
 * handed and names what it rejects rather than guessing.
 */

/** Written into every optimized export by `buildOptimizedDocumentExport`. */
export const OPTIMIZED_ENGRAVING_FORMAT = "geometry-engravings-optimized";

/**
 * The only encoding this build understands.
 *
 * Deliberately an equality test rather than an upper bound. A later version is
 * free to repack the cells, and reading a repacked file as version 1 yields a
 * plausible grid of wrong depths — worse than a layer that simply does not
 * appear, because nothing about it looks like a failure.
 */
export const OPTIMIZED_ENGRAVING_VERSION = 1;

/**
 * The editor clamps an engraving to 2-32 depth levels, so that is the range a
 * version 1 file can contain. One level has no depth to describe and the
 * rasteriser rejects it; beyond 32 the file was not written by a producer this
 * decoder has seen.
 */
const MIN_LEVELS = 2;
const MAX_LEVELS = 32;

/** The wire shape of one layer, exactly as the editor writes it. */
export interface EngravingLayerDocument {
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  /** Base64 of the bit-packed cell depths. */
  readonly data: string;
  readonly pixelCornerRadius?: number;
  readonly moisture?: number;
}

/** The wire shape of the whole file. */
export interface EngravingCatalogDocument {
  readonly format: string;
  readonly version: number;
  readonly layers: Readonly<Record<string, EngravingLayerDocument>>;
}

/**
 * One decoded layer, ready for the rasteriser. Nothing here is a string any
 * more, and `invert` is already resolved — the editor applies it when it writes
 * the file, so a decoder that applied it again would carve the negative.
 */
export interface EngravingLayer {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  /** `width * height` values in `0..levels - 1`, row-major from the top-left. */
  readonly cellLevels: Uint8Array;
  /** Grey value per level: 255 at the surface, 0 at the deepest cut. */
  readonly heightByLevel: Uint8Array;
  readonly pixelCornerRadius: number;
  readonly moisture: number;
}

/**
 * Every layer the loaded project offers.
 *
 * `options` is carried alongside the layers because the control pane needs a
 * label-to-id map and building one at every dispatch would rebuild it on every
 * slider drag.
 */
export interface EngravingCatalog {
  /** Document order, which is the order the editor listed the engravings in. */
  readonly ids: readonly string[];
  readonly layers: ReadonlyMap<string, EngravingLayer>;
  /** Label to id, in the shape `ListControlSpec.options` wants. */
  readonly options: Readonly<Record<string, string>>;
}

export const EMPTY_ENGRAVING_CATALOG: EngravingCatalog = {
  ids: [],
  layers: new Map(),
  options: {},
};

/** How many bits one cell occupies. Mirrors the exporter's own `bitsPerCell`. */
export function bitsPerCell(levels: number): number {
  return Math.max(1, Math.ceil(Math.log2(levels)));
}

export function packedByteLength(cells: number, levels: number): number {
  return Math.ceil((cells * bitsPerCell(levels)) / 8);
}

/**
 * The exact inverse of the exporter's `packDepthValues`.
 *
 * Values are written least-significant-bit first and run straight across byte
 * boundaries, so a cell can straddle two bytes and the last byte's unused bits
 * are zero. That convention is the whole contract with the other program, and
 * it is the one thing here worth a test of its own.
 */
export function unpackCellLevels(
  packed: Uint8Array,
  cells: number,
  levels: number,
): Uint8Array {
  const bits = bitsPerCell(levels);
  const expected = packedByteLength(cells, levels);

  if (packed.length !== expected) {
    throw new RangeError(
      `Engraving layer data is ${packed.length} bytes; `
      + `${cells} cells at ${levels} levels need ${expected}.`,
    );
  }

  const values = new Uint8Array(cells);
  let bitOffset = 0;

  for (let cell = 0; cell < cells; cell += 1) {
    let value = 0;

    for (let bit = 0; bit < bits; bit += 1) {
      if ((packed[bitOffset >> 3]! & (1 << (bitOffset & 7))) !== 0) {
        value |= 1 << bit;
      }

      bitOffset += 1;
    }

    if (value >= levels) {
      throw new RangeError(
        `Engraving cell ${cell} decoded to level ${value}, `
        + `outside 0..${levels - 1}.`,
      );
    }

    values[cell] = value;
  }

  return values;
}

/**
 * The grey the height field carries at each level.
 *
 * Level 0 is the untouched surface and the last level is the deepest cut, so
 * this runs 255 down to 0. It reproduces the editor's `depthGray` with
 * inversion off, because inversion was already resolved into the packed cells.
 */
export function heightByLevel(levels: number): Uint8Array {
  return Uint8Array.from(
    { length: levels },
    (_, level) => Math.round(255 * (1 - level / (levels - 1))),
  );
}

/**
 * A readable name for a layer id.
 *
 * The optimized format drops the engraving's authored name and keeps only the
 * kebab-case id derived from it, so the pane label is reconstructed rather than
 * read. A later format version could carry the real name, at which point this
 * becomes a fallback rather than the only source.
 */
export function engravingLabel(id: string): string {
  const words = id.split("-").filter((word) => word.length > 0);

  if (words.length === 0) {
    return id;
  }

  return words
    .map((word, index) => (
      // A lone character is an ordinal or a variant letter — "pattern-a",
      // "glyph-ollin-2" — and reads as a designation rather than a word.
      word.length === 1 || index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word
    ))
    .join(" ");
}

export function decodeEngravingLayer(
  id: string,
  source: EngravingLayerDocument,
): EngravingLayer {
  const { width, height, levels } = source;

  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new RangeError(
      `Engraving layer "${id}" has a ${width} by ${height} grid.`,
    );
  }

  if (
    !Number.isInteger(levels)
    || levels < MIN_LEVELS
    || levels > MAX_LEVELS
  ) {
    throw new RangeError(
      `Engraving layer "${id}" declares ${levels} depth levels, `
      + `outside ${MIN_LEVELS}..${MAX_LEVELS}.`,
    );
  }

  if (typeof source.data !== "string") {
    throw new TypeError(`Engraving layer "${id}" carries no packed data.`);
  }

  const pixelCornerRadius = source.pixelCornerRadius ?? 0;
  const moisture = source.moisture ?? 0;

  if (!inRange(pixelCornerRadius, 0, 0.5)) {
    throw new RangeError(
      `Engraving layer "${id}" rounds its cells by ${pixelCornerRadius}, `
      + "outside 0..0.5.",
    );
  }

  if (!inRange(moisture, 0, 1)) {
    throw new RangeError(
      `Engraving layer "${id}" declares ${moisture} moisture, outside 0..1.`,
    );
  }

  return {
    id,
    label: engravingLabel(id),
    width,
    height,
    levels,
    cellLevels: unpackCellLevels(base64ToBytes(source.data), width * height, levels),
    heightByLevel: heightByLevel(levels),
    pixelCornerRadius,
    moisture,
  };
}

/**
 * Reads a whole project file.
 *
 * The two failure levels are deliberately different. A wrong format or version
 * rejects the file outright, because nothing in it can be trusted. A single
 * malformed layer is skipped and reported, because one bad engraving must not
 * empty the dropdown for the twenty-seven good ones — the same posture the
 * material palette already takes when one document fails to load.
 */
export function parseEngravingCatalog(source: unknown): EngravingCatalog {
  if (!isRecord(source)) {
    throw new TypeError("Engraving catalog is not an object.");
  }

  if (source.format !== OPTIMIZED_ENGRAVING_FORMAT) {
    throw new TypeError(
      `Engraving catalog format ${JSON.stringify(source.format)} `
      + `is not "${OPTIMIZED_ENGRAVING_FORMAT}".`,
    );
  }

  if (source.version !== OPTIMIZED_ENGRAVING_VERSION) {
    throw new TypeError(
      `Engraving catalog version ${JSON.stringify(source.version)} is not the `
      + `version ${OPTIMIZED_ENGRAVING_VERSION} encoding this build reads.`,
    );
  }

  if (!isRecord(source.layers)) {
    throw new TypeError("Engraving catalog carries no layer table.");
  }

  const ids: string[] = [];
  const layers = new Map<string, EngravingLayer>();
  const options: Record<string, string> = {};

  for (const [id, layerSource] of Object.entries(source.layers)) {
    if (!isRecord(layerSource)) {
      console.error(`Engraving layer "${id}" is not an object; skipping it.`);
      continue;
    }

    try {
      const layer = decodeEngravingLayer(id, layerSource as unknown as EngravingLayerDocument);
      ids.push(layer.id);
      layers.set(layer.id, layer);
      options[layer.label] = layer.id;
    } catch (error) {
      console.error(`Engraving layer "${id}" could not be read; skipping it.`, error);
    }
  }

  return { ids, layers, options };
}

export function engravingCatalogUrl(): string {
  return `${import.meta.env.BASE_URL}engravings/engravings.json`;
}

export async function loadEngravingCatalog(
  url: string = engravingCatalogUrl(),
): Promise<EngravingCatalog> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to load the engraving catalog: ${response.status} ${response.statusText}`,
    );
  }

  return parseEngravingCatalog(await response.json());
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function inRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
