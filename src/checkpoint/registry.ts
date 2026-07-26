import { circularCheckpointType } from "./types/circular";
import type { CheckpointTypeDefinition } from "./type";

/**
 * Every selectable checkpoint type. Adding one is a single entry here plus its
 * own folder under ./types — the composer, the scene and the pane all read the
 * definition rather than knowing about specific types.
 */
export const CHECKPOINT_TYPES: readonly CheckpointTypeDefinition[] = [
  circularCheckpointType,
];

export const DEFAULT_CHECKPOINT_TYPE_ID = "circular";

const BY_ID = new Map(CHECKPOINT_TYPES.map((type) => [type.id, type]));

if (BY_ID.size !== CHECKPOINT_TYPES.length) {
  throw new Error("Checkpoint type ids must be unique.");
}

export function getCheckpointType(id: string): CheckpointTypeDefinition {
  const definition = BY_ID.get(id);

  if (!definition) {
    throw new RangeError(`Unknown checkpoint type "${id}".`);
  }

  return definition;
}

export function listCheckpointTypes(): readonly CheckpointTypeDefinition[] {
  return CHECKPOINT_TYPES;
}

/** Tweakpane dropdown options: display text mapped to type id. */
export function checkpointTypeOptions(): Record<string, string> {
  return Object.fromEntries(
    CHECKPOINT_TYPES.map((type) => [type.label, type.id]),
  );
}
