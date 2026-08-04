import type { LocalFrame, Orientation } from "./frame";

/**
 * The semantic rectangular surface every structure system resolves into.
 *
 * A patch is not a mesh. It is a bounded surface with a stable parametric domain
 * (`u`, `v` in [0, 1] plus `d` along the normal), an architectural role, named
 * edges, and the neighbours it shares boundaries with. Tessellation, masonry,
 * materials and damage are all readers of patches; none of them writes back.
 * That direction is what keeps an art change from invalidating the topology it
 * was applied to.
 */

/**
 * Patch roles are open strings rather than a closed union, because rules query
 * roles and tags rather than switching on a fixed list, and every later phase
 * introduces roles this one has never heard of. The names below are the ones the
 * mass system emits; treat them as vocabulary, not as an exhaustive type.
 */
export type PatchRole = string;

/**
 * The complete surface-operation vocabulary from the architecture spec.
 *
 * A typed name is not a promise that a tessellator can execute it yet. The
 * feature compiler reports a named error for operations outside
 * `IMPLEMENTED_PATCH_OPERATIONS`, preserving the project's existing rule that
 * authored-but-unimplemented vocabulary never falls back silently.
 */
export const PATCH_OPERATIONS = [
  "inset",
  "extrude",
  "cut",
  "replace",
  "subdivide",
  "repeat",
  "step",
  "slope",
  "frame",
  "cap",
  "border",
  "displace",
  "clip",
  "remove",
  "attach",
] as const;

export type PatchOperation = (typeof PATCH_OPERATIONS)[number];

/** Operations with a concrete reader in the current Surface phase. */
export const IMPLEMENTED_PATCH_OPERATIONS: readonly PatchOperation[] = [
  "cut",
  "inset",
  "extrude",
];

export const FEATURE_CONFLICT_POLICIES = [
  "clip",
  "skip",
  "replace",
  "error",
] as const;

export type FeatureConflictPolicy =
  (typeof FEATURE_CONFLICT_POLICIES)[number];

export const PATCH_ROLES = {
  groundInterface: "ground_interface",
  basePlinth: "base_plinth",
  verticalFacade: "vertical_facade",
  batteredFacade: "battered_facade",
  terrace: "terrace",
  transitionBand: "transition_band",
  summitFloor: "summit_floor",
  /** The walkable crown of a raised summit pad. */
  summitPad: "summit_pad",
  /** One of the four exposed vertical faces of a raised summit pad. */
  summitPadSide: "summit_pad_side",
  /** The existing summit surface used as the interior floor of a cell. */
  cellFloor: "cell_floor",
  /** Public face of an enclosed cell wall. */
  cellWallExterior: "cell_wall_exterior",
  /** Room-facing surface of an enclosed cell wall. */
  cellWallInterior: "cell_wall_interior",
  /** Portal jamb or soffit spanning the wall thickness. */
  cellOpeningReveal: "cell_opening_reveal",
  /** Walkable or exposed upper surface of an independent roof assembly. */
  roof: "roof",
  /** Interior ceiling or exterior overhang beneath a roof. */
  roofSoffit: "roof_soffit",
  /** Exposed vertical edge of a roof slab. */
  roofEdge: "roof_edge",
  /** The pier face a panel's raised rails enclose. */
  pierPanel: "pier_panel",
  /** One elevation of a member spanning between piers. */
  lintel: "lintel",
  /** Projected molding at the top of a roof assembly. */
  roofCornice: "cornice",
  /**
   * One whole flight as a single stepped surface, not a patch per tread. The
   * spec's `stair_tread`/`stair_riser` roles are the granularity the feature
   * pipeline will address individual steps at; until that pipeline exists, a
   * patch per tread would be sixty entries no rule can do anything with.
   */
  stairFlight: "stair_flight",
  /** The outer face of a stair side treatment — a parapet's public elevation. */
  stairSide: "stair_side",
  /** One vertical face of a free-standing stela body. */
  stelaFace: "stela_face",
  /** One vertical face of a stela's base courses. */
  stelaBaseFace: "stela_base_face",
  /** The usable plane a stela crown exposes, when its treatment has one. */
  stelaCrownTop: "stela_crown_top",
} as const;

/**
 * How `u`, `v` and `d` map to world space. `planar` is a flat rectangle;
 * `battered` leans the surface back along its normal as `v` rises; `stepped`
 * resolves `v` to discrete levels. Later phases add evaluators without changing
 * how features address the surface.
 */
export type PatchEvaluator = "planar" | "battered" | "stepped" | "custom";

/** A named patch boundary, first-class because trims follow boundaries. */
export interface PatchEdge {
  readonly id: string;
  readonly orientation: Orientation;
  /** Set by later phases; a plinth, coping, cornice or parapet along this edge. */
  readonly treatment: string | null;
}

export interface PatchEdges {
  readonly uMin: PatchEdge;
  readonly uMax: PatchEdge;
  readonly vMin: PatchEdge;
  readonly vMax: PatchEdge;
}

/** A normalised subdomain a feature or a child system is allowed to occupy. */
export interface PatchRegion {
  readonly id: string;
  readonly uRange: readonly [number, number];
  readonly vRange: readonly [number, number];
  /** Higher wins when two regions want the same ground. */
  readonly priority: number;
  /** Operations permitted to target this region. Empty means reservation only. */
  readonly allowedOperations: readonly PatchOperation[];
  /** Region ids on this patch that may not overlap this region. */
  readonly exclusions: readonly string[];
  readonly tags: readonly string[];
}

/**
 * An operation applied to a region of a patch. The current planar reader
 * executes cuts and signed-depth wall profiles; the remaining authored
 * vocabulary still fails explicitly until it gains a reader.
 */
export interface PatchFeature {
  readonly id: string;
  readonly operation: PatchOperation;
  /** Positive real depth for inset/extrude; zero for operations without depth. */
  readonly depth: number;
  /**
   * Semantic material owned by the surfaces this operation exposes. Null keeps
   * the target patch's base material. Geometry readers must reject a named role
   * they cannot map rather than silently falling back.
   */
  readonly materialRole: string | null;
  readonly regionId: string | null;
  readonly order: number;
  /** Hard prerequisites on the same patch. */
  readonly dependsOn: readonly string[];
  /** Additional same-patch ordering constraints. */
  readonly runsBefore: readonly string[];
  readonly runsAfter: readonly string[];
  /** How this feature resolves overlap with an already accepted feature. */
  readonly conflictPolicy: FeatureConflictPolicy;
}

/** A placement point a child entity can attach to. */
export interface PatchAnchor {
  readonly id: string;
  readonly kind: string;
  readonly u: number;
  readonly v: number;
  readonly d: number;
  /** The patch region whose placement constraints this anchor represents. */
  readonly regionId?: string;
  /** The default facing for an attached child. */
  readonly orientation?: Orientation;
}

export interface Patch {
  readonly id: string;
  readonly role: PatchRole;
  readonly frame: LocalFrame;
  readonly dimensions: {
    readonly u: number;
    readonly v: number;
    readonly thickness: number;
  };
  readonly evaluator: PatchEvaluator;
  readonly edges: PatchEdges;
  /** Ids of patches sharing a boundary. Always symmetric — see `linkPatches`. */
  readonly adjacency: readonly string[];
  readonly regions: readonly PatchRegion[];
  readonly features: readonly PatchFeature[];
  readonly anchors: readonly PatchAnchor[];
  readonly tags: readonly string[];
}
