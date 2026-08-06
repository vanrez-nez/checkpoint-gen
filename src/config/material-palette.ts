import { MATERIAL_SLOTS } from "../geometry/part";
import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "./control-spec";

export const MATERIAL_DOCUMENT_IDS = [
  "stone",
  "volcanic-stone",
  "cobblestone-setts",
  "dark-volcanic-stone",
  "eroded-rock",
  "flamed-basalt",
  "lichen-stone",
  "hammered-iron",
  "uv-checker",
] as const;

export type MaterialDocumentId = (typeof MATERIAL_DOCUMENT_IDS)[number];

/**
 * Everything a material can be assigned to: every semantic slot of the merged
 * geometry, plus the offering statue. The statue is a loaded model rather than a
 * generated part, so it owns no slot in that geometry, but it is a surface the
 * pane dresses exactly like the others and there is no reason for it to be
 * described anywhere else.
 */
export const MATERIAL_SURFACE_IDS = [...MATERIAL_SLOTS, "offering"] as const;

export type MaterialSurfaceId = (typeof MATERIAL_SURFACE_IDS)[number];

/**
 * One surface's dressing: which material document it uses, and how densely that
 * document tiles across it.
 *
 * Texture scale is per surface rather than per document, because one document
 * dresses surfaces of wildly different size — the same stone that reads right on
 * a 30-unit plate is far too coarse on a statue.
 */
export interface MaterialSurfaceConfig {
  document: MaterialDocumentId;
  textureScale: number;
}

export type StructureMaterialPalette = Record<
  MaterialSurfaceId,
  MaterialSurfaceConfig
>;

export const MATERIAL_DOCUMENT_OPTIONS: Readonly<
  Record<string, MaterialDocumentId>
> = {
  Stone: "stone",
  "Volcanic stone": "volcanic-stone",
  "Cobblestone setts": "cobblestone-setts",
  "Dark volcanic stone": "dark-volcanic-stone",
  "Eroded rock": "eroded-rock",
  "Flamed basalt": "flamed-basalt",
  "Lichen stone": "lichen-stone",
  "Hammered iron": "hammered-iron",
  "UV checker (debug)": "uv-checker",
};

/**
 * Pane folder title and validation subject for each surface. A structure exposes
 * only the surfaces it actually has, so the same slot can read as the whole body
 * of one family and as one of several dressed surfaces of another.
 */
export const MATERIAL_SURFACE_LABELS: Readonly<
  Record<MaterialSurfaceId, string>
> = {
  stone: "Main structure",
  trim: "Trim",
  stairs: "Stairs",
  // The stair's flanking parapets, named for what they read as rather than for
  // the `parapet` records and controls they are generated from.
  parapet: "Stair walls",
  summit: "Summit walls",
  interior: "Interior floors",
  roof: "Roof",
  pillar: "Pillars",
  iron: "Fire bowls",
  portalReveal: "Portal reveals",
  windowReveal: "Window reveals",
  niche: "Niches",
  panel: "Recessed panels",
  pilaster: "Pilasters",
  frieze: "Friezes",
  cornice: "Cornices",
  pedestal: "Pillar Hall pedestals",
  pier: "Pillar Hall piers",
  pierPanel: "Pillar Hall pier panels",
  lintel: "Pillar Hall lintels",
  stelaBody: "Stela bodies",
  stelaField: "Stela recessed fields",
  stelaCrown: "Stela crowns",
  slotDebug: "Slot debug tint",
  offering: "Offering",
};

/** Neutral tiling: the generated UVs at the density the builders authored. */
export const DEFAULT_TEXTURE_SCALE = 1;
const MIN_TEXTURE_SCALE = 0.1;
const MAX_TEXTURE_SCALE = 8;
const TEXTURE_SCALE_STEP = 0.05;

/**
 * The neutral baseline: plain stone everywhere at the generated density. A family
 * that declares no palette of its own is dressed from this, so it stays
 * deliberately untuned — each family's own look lives in its own constant.
 */
export const DEFAULT_STRUCTURE_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  stone: surface("stone"),
  trim: surface("stone"),
  stairs: surface("stone"),
  parapet: surface("stone"),
  summit: surface("stone"),
  interior: surface("stone"),
  roof: surface("stone"),
  pillar: surface("stone"),
  iron: surface("hammered-iron"),
  portalReveal: surface("stone"),
  windowReveal: surface("stone"),
  niche: surface("stone"),
  panel: surface("stone"),
  pilaster: surface("stone"),
  frieze: surface("stone"),
  cornice: surface("stone"),
  pedestal: surface("stone"),
  pier: surface("stone"),
  pierPanel: surface("stone"),
  lintel: surface("stone"),
  stelaBody: surface("stone"),
  stelaField: surface("stone"),
  stelaCrown: surface("stone"),
  slotDebug: surface("lichen-stone"),
  offering: surface("stone"),
};

/**
 * The circular checkpoint's tuned dressing. The statue tiles at twice the
 * generated density because it is a fraction of the plate's size, so the same
 * grain that reads right underfoot reads far too coarse on it.
 */
export const DEFAULT_CIRCULAR_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  ...DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  stone: surface("flamed-basalt"),
  pillar: surface("dark-volcanic-stone"),
  iron: surface("hammered-iron"),
  offering: surface("lichen-stone", 2),
};

/**
 * Mass's tuned dressing. Its surfaces tile well below the generated density
 * because a mass is an order of magnitude larger than the circular plate: the
 * same grain that reads as masonry at arm's length reads as noise across a
 * 24-unit elevation, and the coarser the surface's role, the further down it goes.
 */
export const DEFAULT_MASS_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  ...DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  stone: surface("eroded-rock", 0.6),
  trim: surface("flamed-basalt", 0.35),
  stairs: surface("lichen-stone", 0.25),
  parapet: surface("cobblestone-setts", 0.25),
  summit: surface("eroded-rock"),
  interior: surface("volcanic-stone"),
  roof: surface("lichen-stone"),
  portalReveal: surface("eroded-rock"),
  windowReveal: surface("eroded-rock"),
  niche: surface("eroded-rock"),
  panel: surface("eroded-rock"),
  pilaster: surface("eroded-rock"),
  frieze: surface("eroded-rock"),
  pillar: surface("eroded-rock"),
  cornice: surface("flamed-basalt", 0.35),
  iron: surface("hammered-iron", 0.75),
  pedestal: surface("eroded-rock"),
  pier: surface("eroded-rock"),
  pierPanel: surface("dark-volcanic-stone", 0.75),
  lintel: surface("flamed-basalt", 0.5),
};

/** Pillar Hall's deliberately high-contrast indexed surface assignment. */
export const DEFAULT_PILLAR_HALL_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  ...DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  stone: surface("eroded-rock", 0.55),
  stairs: surface("lichen-stone", 0.3),
  pedestal: surface("dark-volcanic-stone", 0.55),
  pier: surface("eroded-rock", 0.7),
  pierPanel: surface("flamed-basalt", 0.55),
  lintel: surface("dark-volcanic-stone", 0.55),
  frieze: surface("flamed-basalt", 0.45),
  cornice: surface("dark-volcanic-stone", 0.5),
  roof: surface("lichen-stone", 0.45),
};

/**
 * A stela is one carved stone, so its dressing is deliberately close-grained:
 * a monolith is read at arm's length, not across a plaza, and the grain that
 * suits a terrace wall reads as noise on a tablet face.
 */
export const DEFAULT_STELA_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  ...DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  stelaBody: surface("eroded-rock", 1.4),
  stelaField: surface("flamed-basalt", 1.6),
  stelaCrown: surface("eroded-rock", 1.4),
  pedestal: surface("dark-volcanic-stone", 1.1),
  frieze: surface("flamed-basalt", 1.6),
  cornice: surface("dark-volcanic-stone", 1.3),
  // Deliberately the loudest thing in the palette at the noisiest tiling: a
  // debug tint that can be mistaken for a material choice is not a debug tint.
  slotDebug: surface("lichen-stone", 4),
};

const control = controlsFor<MaterialSurfaceConfig>();

/**
 * One control table per surface, keyed by surface id. Each table binds that
 * surface's own config object, which is what gives the pane a folder per surface
 * holding a material and its texture scale together, rather than one flat list of
 * every material followed by one flat list of every scale.
 */
export const MATERIAL_SURFACE_CONTROLS: Readonly<
  Record<MaterialSurfaceId, readonly ControlSpec<MaterialSurfaceConfig>[]>
> = Object.fromEntries(
  MATERIAL_SURFACE_IDS.map((id) => [id, createSurfaceControls(id)]),
) as Record<MaterialSurfaceId, readonly ControlSpec<MaterialSurfaceConfig>[]>;

/**
 * Whether two palettes dress the surfaces differently — documents only.
 *
 * The question a decal has to ask before deciding whether it is stale. Its
 * material is cloned from the host surface's runtime, so a different *document*
 * means a different clone and a genuine rebuild: dispose every decal mesh,
 * re-derive the host-shading hierarchy, clone a node material per batch, and
 * pay a pipeline compile for each. A different *texture scale* means none of
 * that — scale is a UV concern, rewritten in place on the one buffer, and the
 * decals ride the same rescale.
 *
 * Answering "did anything at all change" instead is what made dragging the
 * texture-scale slider the most expensive control in the pane.
 *
 * A surface appearing or disappearing counts, since that is a structure type
 * changing underneath and every decal belongs to the outgoing family.
 */
export function dressingDiffers(
  previous: Readonly<StructureMaterialPalette>,
  next: Readonly<StructureMaterialPalette>,
  previousSurfaces: ReadonlySet<MaterialSurfaceId>,
  nextSurfaces: readonly MaterialSurfaceId[],
): boolean {
  if (nextSurfaces.length !== previousSurfaces.size) {
    return true;
  }

  return nextSurfaces.some((surface) => (
    !previousSurfaces.has(surface)
    || previous[surface]?.document !== next[surface]?.document
  ));
}

export function cloneMaterialPalette(
  source: Readonly<StructureMaterialPalette> =
    DEFAULT_STRUCTURE_MATERIAL_PALETTE,
): StructureMaterialPalette {
  return Object.fromEntries(
    MATERIAL_SURFACE_IDS.map((id) => [id, { ...requireSurface(source, id) }]),
  ) as StructureMaterialPalette;
}

export function validateMaterialPalette(
  palette: StructureMaterialPalette,
): void {
  for (const id of MATERIAL_SURFACE_IDS) {
    validateControls(
      requireSurface(palette, id),
      MATERIAL_SURFACE_CONTROLS[id],
    );
  }
}

export function materialDocumentUrl(id: MaterialDocumentId): string {
  return `${import.meta.env.BASE_URL}materials/${id}.json`;
}

function surface(
  document: MaterialDocumentId,
  textureScale: number = DEFAULT_TEXTURE_SCALE,
): MaterialSurfaceConfig {
  return { document, textureScale };
}

function createSurfaceControls(
  id: MaterialSurfaceId,
): readonly ControlSpec<MaterialSurfaceConfig>[] {
  const label = MATERIAL_SURFACE_LABELS[id];

  return [
    control.list({
      key: "document",
      label: "material",
      name: `${label} material`,
      group: label,
      scopes: ["material"],
      options: MATERIAL_DOCUMENT_OPTIONS,
    }),
    control.number({
      key: "textureScale",
      label: "texture scale",
      name: `${label} texture scale`,
      group: label,
      min: MIN_TEXTURE_SCALE,
      max: MAX_TEXTURE_SCALE,
      step: TEXTURE_SCALE_STEP,
      scopes: ["material"],
    }),
  ];
}

function requireSurface(
  palette: Readonly<StructureMaterialPalette>,
  id: MaterialSurfaceId,
): MaterialSurfaceConfig {
  const config = palette[id];

  if (!config) {
    throw new Error(`Missing material selection for the ${id} surface.`);
  }

  return config;
}
