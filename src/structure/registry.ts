import { circularStructure } from "./families/circular";
import { massStructure } from "./families/mass";
import { pillarHallStructure } from "./families/pillar-hall";
import { stelaStructure } from "./families/stelae";
import type { StructureDefinition } from "./definition";

/**
 * Every selectable structure. Adding one is a single entry here plus its own
 * folder under ./families — the composer, the scene and the pane all read the
 * definition rather than knowing about specific structures.
 */
export const STRUCTURES: readonly StructureDefinition[] = [
  circularStructure,
  massStructure,
  pillarHallStructure,
  stelaStructure,
];

export const DEFAULT_STRUCTURE_ID = "circular";

const BY_ID = new Map(STRUCTURES.map((structure) => [structure.id, structure]));

if (BY_ID.size !== STRUCTURES.length) {
  throw new Error("Structure ids must be unique.");
}

export function getStructure(id: string): StructureDefinition {
  const definition = BY_ID.get(id);

  if (!definition) {
    throw new RangeError(`Unknown structure "${id}".`);
  }

  return definition;
}

export function listStructures(): readonly StructureDefinition[] {
  return STRUCTURES;
}

/** Tweakpane dropdown options: display text mapped to structure id. */
export function structureOptions(): Record<string, string> {
  return Object.fromEntries(
    STRUCTURES.map((structure) => [structure.label, structure.id]),
  );
}
