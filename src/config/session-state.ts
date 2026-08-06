import {
  MATERIAL_SURFACE_IDS,
  cloneMaterialPalette,
  validateMaterialPalette,
  type StructureMaterialPalette,
} from "./material-palette";
import {
  DEFAULT_ILLUMINATION_CONFIG,
  DEFAULT_VIEW_CONFIG,
  validateIlluminationConfig,
  validateViewConfig,
} from "./sections";
import { listStructures } from "../structure/registry";
import type { StructureConfig } from "./structure-config";

/**
 * The half of the configuration the geometry code does not carry.
 *
 * `encodeStructureHash` is an exact reconstruction of *generated geometry* and
 * says so — surface dressing, lighting and the debug overlays are all outside
 * that boundary on purpose, because a code is meant to be pasted to someone
 * else and describe the same building when it lands. Which stone the walls wear
 * and where the sun sits are how you were looking at it, not what it is.
 *
 * That boundary is right and this does not move it. It only stops the excluded
 * half from being *lost*: a reload used to reset the palette, the lighting and
 * every debug toggle to defaults, so the cost of refreshing was re-dressing the
 * whole model. The hash stays the portable artefact; this is the desk you left
 * things on.
 *
 * `sessionStorage` rather than `localStorage` deliberately. This is working
 * state for one tab: two tabs on two designs keep their own lighting, and
 * closing the tab is what clears it. A palette that outlived the browser would
 * make a fresh visit inherit choices from a session nobody remembers, and the
 * defaults are what the families were authored against.
 */
const STORAGE_KEY = "checkpoint-gen.session";

/**
 * The stored shape, which is the excluded set and nothing else.
 *
 * Named JSON rather than the dense mixed radix the geometry code uses, because
 * the two are answering different questions. A code is typed, shared and has to
 * be short, so field *order* carries the schema and a change to the order
 * invalidates every existing code. Nothing here is ever transcribed, so it can
 * afford to be self-describing — and being self-describing is what lets a
 * schema change cost one section instead of the whole blob.
 */
interface SessionState {
  materialPalettes?: Record<string, unknown>;
  illumination?: unknown;
  view?: unknown;
}

/**
 * Restores the excluded set onto the live config, in place.
 *
 * In place for the same reason `applyStructureHash` is: the pane binds these
 * objects by identity, so replacing one would leave its controls writing to an
 * object nothing reads.
 *
 * Section by section, and each section validated on its own. Stored state can
 * outlive the schema that wrote it — a surface retired, a slider's range
 * tightened, a document removed from the catalog — and the honest response to
 * one bad section is to drop that section, not the sitting. Losing the lighting
 * because a palette named a stone that no longer ships would be the storage
 * doing more damage than not having it.
 */
export function applySessionState(config: StructureConfig): void {
  const state = readState();

  if (!state) {
    return;
  }

  applyPalettes(config, state.materialPalettes);
  applySection(
    config.illumination,
    state.illumination,
    DEFAULT_ILLUMINATION_CONFIG,
    validateIlluminationConfig,
    "lighting",
  );
  applySection(
    config.view,
    state.view,
    DEFAULT_VIEW_CONFIG,
    validateViewConfig,
    "view",
  );
}

/**
 * Records the excluded set.
 *
 * Called after a change has already been validated and applied, so what is
 * written is by construction a state the app was just running. Never called
 * with a rejected value: the pane rolls those back before it dispatches.
 */
export function writeSessionState(config: StructureConfig): void {
  const state: SessionState = {
    materialPalettes: config.materialPalettes,
    illumination: config.illumination,
    view: config.view,
  };

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Storage can be unavailable outright — private modes, embeddings, a
    // disabled cookie policy — and can also be full. Neither is worth a broken
    // frame over: the app is fully usable without persistence, it just forgets.
    console.warn("Session settings could not be saved.", error);
  }
}

function readState(): SessionState | null {
  let raw: string | null = null;

  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Session settings could not be read.", error);
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed as SessionState : null;
  } catch (error) {
    console.warn("Ignoring unreadable session settings.", error);
    return null;
  }
}

/**
 * Copies a section's stored values in, then validates, then keeps or rolls back
 * the whole section.
 */
function applySection<T extends object>(
  live: T,
  stored: unknown,
  shape: Readonly<T>,
  validate: (value: T) => void,
  label: string,
): void {
  if (!isRecord(stored)) {
    return;
  }

  const rollback = { ...live };
  copyKnownKeys(live, stored, shape);

  try {
    validate(live);
  } catch (error) {
    Object.assign(live, rollback);
    console.warn(`Ignoring stored ${label} settings.`, error);
  }
}

/**
 * Copies only the fields `shape` declares, and only those the blob carries.
 *
 * Both halves of that matter. Reading through a known shape means a stored blob
 * can neither introduce a field the config does not have nor resurrect one that
 * was removed — the validators guard ranges, but nothing else would stop an
 * unknown key from being written onto a live object the whole app holds. And
 * leaving absent keys alone means a section stored before a field existed still
 * restores, with the new field at its default, rather than setting it undefined
 * and failing validation for a reason that has nothing to do with what the user
 * chose.
 */
function copyKnownKeys<T extends object>(
  live: T,
  stored: Record<string, unknown>,
  shape: Readonly<T>,
): void {
  for (const key of Object.keys(shape) as (keyof T & string)[]) {
    if (key in stored) {
      live[key] = stored[key] as T[keyof T & string];
    }
  }
}

/**
 * Restores each structure's dressing independently.
 *
 * Per structure because that is how the palettes are held: every registered
 * family gets its own live palette up front so the pane can bind all of them
 * once, and the pane keeps those bindings across a structure switch. A stored
 * id the registry no longer knows is skipped rather than added, since an
 * unregistered palette is one nothing would ever read.
 */
function applyPalettes(config: StructureConfig, stored: unknown): void {
  if (!isRecord(stored)) {
    return;
  }

  for (const definition of listStructures()) {
    const live = config.materialPalettes[definition.id];
    const restored = stored[definition.id];

    if (!live || !isRecord(restored)) {
      continue;
    }

    const rollback = cloneMaterialPalette(live);

    for (const surface of MATERIAL_SURFACE_IDS) {
      const surfaceState = restored[surface];

      if (isRecord(surfaceState)) {
        // Each surface's own live object is the shape: a palette is a full
        // record of every surface by construction, so what it already holds is
        // exactly the field list worth reading.
        copyKnownKeys(live[surface], surfaceState, live[surface]);
      }
    }

    // Validated as a whole rather than per surface, because that is the unit
    // the pane and the scene both take. A palette half restored would dress
    // some surfaces from storage and some from defaults, which is a state
    // nobody chose and nothing would explain.
    try {
      validateMaterialPalette(live);
    } catch (error) {
      assignPalette(live, rollback);
      console.warn(`Ignoring stored ${definition.id} materials.`, error);
    }
  }
}

/** Writes one palette's values over another's, keeping the target's identity. */
function assignPalette(
  target: StructureMaterialPalette,
  source: Readonly<StructureMaterialPalette>,
): void {
  for (const surface of MATERIAL_SURFACE_IDS) {
    Object.assign(target[surface], source[surface]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
