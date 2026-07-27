/**
 * Stable semantic identifiers.
 *
 * Every entity gets a path that reads as its place in the composition —
 * `structure/mass_main/band_02/facade_front`. Rules address entities by id and
 * by role rather than by array position, so an id must survive a material
 * change, a condition regeneration, or a sibling being added, as long as the
 * topology it names has not changed.
 */

/** One path segment: lowercase, starting with a letter, words joined by `_`. */
const SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const ID_SEPARATOR = "/";

/**
 * Joins path parts. Parts may themselves be paths, since ids are built by
 * extending a parent's — `structurePath(bandId, "facade_front")` is the normal
 * shape rather than the exception.
 */
export function structurePath(...parts: readonly string[]): string {
  for (const part of parts) {
    if (!isValidId(part)) {
      throw new Error(
        `"${part}" is not a valid id path (lowercase segments, digits and single underscores).`,
      );
    }
  }

  return parts.join(ID_SEPARATOR);
}

export function isValidId(id: string): boolean {
  const segments = id.split(ID_SEPARATOR);
  return segments.length > 0 && segments.every((segment) => SEGMENT_PATTERN.test(segment));
}

/**
 * A one-based, zero-padded ordinal, so ids sort the way a reader expects and
 * `band_02` stays `band_02` when a tenth band is added.
 */
export function ordinalSegment(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(2, "0")}`;
}
