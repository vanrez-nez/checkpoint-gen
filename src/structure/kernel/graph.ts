import type { HorizontalOrientation, Rect, Vec3 } from "./frame";
import type { Patch, PatchRole } from "./patch";
import { resolvedSeeds, type SeedSet, type SeedSubsystem } from "./seed";
import type { Diagnostic } from "./validate";
import type { FacadeRecord } from "../facade/types";
import type { PillarHallRecord } from "../families/pillar-hall/types";
import type { StelaRecord } from "../families/stelae/types";
import {
  compilePatchFeatures,
  compiledCutWorldBounds,
  type CompiledPatchFeatures,
  type CutWorldBounds,
} from "../surface/features";

/**
 * The resolved semantic description of one structure.
 *
 * This is the artefact every later phase reads and no later phase mutates. The
 * schema is authored ahead of the systems that fill it: containers for cells,
 * Pillar Halls, stelae, roofs, attachments and damage exist from the start, so
 * adding those systems fills known positions rather than reshaping the graph.
 * Attachments and damage are the two still waiting for theirs.
 */
/**
 * Placeholder element type for a subsystem that has not been implemented yet.
 * Later phases replace it with the real record while the container stays put.
 */
export interface ReservedEntity {
  readonly id: string;
  readonly kind: string;
}

export interface SiteRecord {
  readonly upAxis: Vec3;
  /** The primary approach direction. Front faces this way. */
  readonly frontAxis: Vec3;
  readonly groundY: number;
}

/**
 * A projecting molding crowning a band.
 *
 * Semantic rather than decorative: it changes the silhouette and the extents,
 * and later systems ask where a band's crown actually is before placing anything
 * on it. It is recorded per band because that is the scale it belongs to — which
 * bands carry one is a composition decision, not a global switch.
 */
export interface CorniceRecord {
  /** Outward projection beyond the wall, measured at the springing. */
  readonly projection: number;
  /** How much of the band's rise the cornice occupies. */
  readonly height: number;
  /** Elevation the cornice starts at; it finishes at the band's `topY`. */
  readonly bottomY: number;
  /** The wall's outline where the cornice springs from it. */
  readonly springing: Rect;
  /** The cornice's own outline — `springing` pushed out by `projection`. */
  readonly outline: Rect;
}

/** One resolved horizontal layer of a mass. */
export interface ElevationBandRecord {
  readonly id: string;
  readonly index: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly rise: number;
  /** Outline at the band's base. */
  readonly lower: Rect;
  /** Outline at the band's crown, narrower than `lower` when battered. */
  readonly upper: Rect;
  readonly wallProfile: string;
  readonly surfaceRole: PatchRole;
  readonly upperTransition: string;
  /** True when the ring exposed above this band is wide enough to stand on. */
  readonly walkable: boolean;
  /** The molding crowning this band, when it carries one. */
  readonly cornice: CorniceRecord | null;
}

export interface SummitPlacementRecord {
  /** World-space rectangle available to the child assembly. */
  readonly rect: Rect;
  /** Horizontal patch the child stands on. */
  readonly patchId: string;
  /** Elevation of that placement surface. */
  readonly y: number;
  /** Anchor on `patchId` representing the centre of `rect`. */
  readonly anchorId: string;
}

export interface SummitPadRecord {
  readonly id: string;
  readonly kind: "raised_pad";
  readonly band: ElevationBandRecord;
  readonly topPatchId: string;
  readonly patchIds: readonly string[];
}

export interface SummitRecord {
  readonly y: number;
  readonly rect: Rect;
  /** The summit surface available before resolving its placement footprint. */
  readonly buildable: Rect | null;
  /** Authoritative footprint shared by a raised pad and summit building. */
  readonly buildingPad: Rect | null;
  readonly treatment: string;
  readonly patchId: string;
  /** Authoritative child-placement surface, or null when no pad fits. */
  readonly placement: SummitPlacementRecord | null;
  /** Raised geometry occupying the building pad, when requested. */
  readonly pad: SummitPadRecord | null;
}

/**
 * A resolved stair: a traversable connector between two horizontal surfaces,
 * not a decorative pattern on a facade.
 *
 * Everything here is in resolved real units. The step rule the stair was asked
 * for lives in the spec; what this records is the integer count and the riser
 * and tread that count actually produced, because those are the numbers every
 * later reader — tessellation, navigation, damage — places things against.
 */
export interface StairConnectorRecord {
  readonly id: string;
  readonly kind: "stair";
  readonly layout: string;
  readonly elevationMode: string;
  readonly landingRule: string;
  /** The traversable patches this connector joins. */
  readonly lowerPatchId: string;
  readonly upperPatchId: string;
  readonly direction: HorizontalOrientation;
  readonly bottomY: number;
  readonly topY: number;
  readonly stepCount: number;
  /** Resolved rise of one step: exactly `(topY - bottomY) / stepCount`. */
  readonly riser: number;
  readonly tread: number;
  /** Horizontal length of the flight: exactly `stepCount * tread`. */
  readonly run: number;
  /** Flight width between side treatments. */
  readonly width: number;
  /**
   * Plan rectangle of the flight alone. Its low-z edge is where the top riser
   * meets the upper surface; its high-z edge is the projecting foot of the
   * bottom step. Side treatments sit outside it.
   */
  readonly flightRect: Rect;
  readonly sideTreatment: string;
  /** Resolved side-treatment dimensions, or null when the sides are open. */
  readonly parapet: {
    readonly width: number;
    readonly height: number;
    /**
     * A molding that takes over the parapet's top band. It follows the
     * continuous rake on a sloped parapet and repeats as horizontal blocks on
     * a stepped parapet.
     */
    readonly cornice?: {
      readonly projection: number;
      readonly height: number;
    };
  } | null;
  readonly termination: { readonly lower: string; readonly upper: string };
  readonly patchIds: readonly string[];
}

/**
 * Stairs are the only connector so far; ramps, passages and portals will widen
 * this union rather than getting containers of their own.
 */
export type ConnectorRecord = StairConnectorRecord;

export interface CellWallRecord {
  readonly orientation: HorizontalOrientation;
  readonly outerPatchId: string;
  readonly innerPatchId: string;
}

export interface CellOpeningRecord {
  readonly id: string;
  readonly kind: "portal";
  readonly direction: HorizontalOrientation;
  readonly width: number;
  readonly height: number;
  readonly bottomY: number;
  readonly topY: number;
  /** Walkable rectangle through the wall thickness beneath the opening. */
  readonly threshold: Rect;
  readonly exteriorPatchId: string;
  readonly interiorPatchId: string;
  /** Rooms reached directly from the threshold. */
  readonly destinationRoomIds: readonly string[];
  readonly revealPatchIds: readonly string[];
}

/** One usable room inside a cell assembly. */
export interface CellRoomRecord {
  readonly id: string;
  readonly role: "chamber" | "front_chamber" | "rear_chamber" | "side_chamber" | "central_hall";
  readonly footprint: Rect;
  readonly floorPatchId: string;
}

/** A traversable cut through one interior partition. */
export interface CellConnectionRecord {
  readonly id: string;
  readonly kind: "door";
  readonly sourceRoomId: string;
  readonly destinationRoomId: string;
  readonly width: number;
  readonly height: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly threshold: Rect;
  readonly revealPatchIds: readonly string[];
}

/** One physical partition, owned once regardless of the rooms on either side. */
export interface CellInteriorWallRecord {
  readonly id: string;
  /** Direction in which the partition runs in plan. */
  readonly axis: "x" | "z";
  readonly rect: Rect;
  readonly negativeRoomId: string;
  readonly positiveRoomId: string;
  readonly negativePatchId: string;
  readonly positivePatchId: string;
  readonly connectionIds: readonly string[];
}

/** One resolved enclosed or partially enclosed cell assembly. */
export interface CellRecord {
  readonly id: string;
  readonly kind: "cell";
  readonly layout: "single_chamber" | "twin_chamber" | "three_bay";
  readonly occupancy: "room";
  readonly footprint: Rect;
  readonly interior: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly height: number;
  readonly wallThickness: number;
  readonly supportPatchId: string;
  readonly placementAnchorId: string;
  readonly floorPatchId: string;
  readonly walls: readonly CellWallRecord[];
  readonly openings: readonly CellOpeningRecord[];
  readonly rooms: readonly CellRoomRecord[];
  readonly interiorWalls: readonly CellInteriorWallRecord[];
  readonly connections: readonly CellConnectionRecord[];
  readonly patchIds: readonly string[];
}

export interface RoofCorniceRecord {
  readonly projection: number;
  readonly height: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly outline: Rect;
  readonly edgePatchIds: readonly string[];
  readonly soffitPatchIds: readonly string[];
}

/** One roof assembly resolved independently from the cell it covers. */
export interface CellRoofRecord {
  readonly id: string;
  readonly kind: "roof";
  readonly roofType: "flat_slab";
  readonly coversCellIds: readonly string[];
  /** Room range treated as one supported roof group. */
  readonly coversRoomIds: readonly string[];
  /** Cell wall patches whose crown edges carry this roof. */
  readonly bearingPatchIds: readonly string[];
  /** Wall footprint beneath the slab. */
  readonly bearingFootprint: Rect;
  /** Interior ceiling exposed beneath the slab. */
  readonly ceilingFootprint: Rect;
  /** Complete slab outline, including its configured projection. */
  readonly slabFootprint: Rect;
  readonly bottomY: number;
  readonly slabTopY: number;
  readonly topY: number;
  readonly thickness: number;
  readonly projection: number;
  readonly cornice: RoofCorniceRecord | null;
  readonly topPatchId: string;
  readonly ceilingPatchId: string;
  readonly edgePatchIds: readonly string[];
  readonly soffitPatchIds: readonly string[];
  readonly patchIds: readonly string[];
}

export type RoofRecord = CellRoofRecord;

export interface MassRecord {
  readonly id: string;
  readonly footprint: Rect;
  readonly baseTreatment: string;
  readonly bands: readonly ElevationBandRecord[];
  readonly summit: SummitRecord;
  readonly totalHeight: number;
  readonly patchIds: readonly string[];
}

export interface StructureGraph {
  readonly id: string;
  readonly units: "meters";
  readonly seeds: Readonly<Record<SeedSubsystem, number>>;
  readonly site: SiteRecord;
  readonly masses: readonly MassRecord[];
  readonly patches: readonly Patch[];
  readonly connectors: readonly ConnectorRecord[];
  readonly cells: readonly CellRecord[];
  readonly facades: readonly FacadeRecord[];
  readonly pillarHalls: readonly PillarHallRecord[];
  readonly stelae: readonly StelaRecord[];
  readonly roofs: readonly RoofRecord[];
  readonly attachments: readonly ReservedEntity[];
  readonly damage: readonly ReservedEntity[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Assembles a graph.
 *
 * Adjacency is recorded here rather than by each subsystem writing into its own
 * patches, so it cannot end up asserted from one side only — `link` always
 * writes both directions, and the invariant test checks it.
 */
export class StructureGraphBuilder {
  private readonly patches = new Map<string, Patch>();
  private readonly order: string[] = [];
  private readonly adjacency = new Map<string, Set<string>>();
  private readonly masses: MassRecord[] = [];
  private readonly connectors: ConnectorRecord[] = [];
  private readonly cells: CellRecord[] = [];
  private readonly facades: FacadeRecord[] = [];
  private readonly pillarHalls: PillarHallRecord[] = [];
  private readonly stelae: StelaRecord[] = [];
  private readonly roofs: RoofRecord[] = [];

  constructor(
    private readonly id: string,
    private readonly seeds: SeedSet,
    private readonly site: SiteRecord,
  ) {}

  addPatch(patch: Patch): void {
    if (this.patches.has(patch.id)) {
      throw new Error(`Duplicate patch id "${patch.id}".`);
    }

    this.patches.set(patch.id, patch);
    this.order.push(patch.id);
  }

  /** Records that two patches share a boundary. Symmetric by construction. */
  link(a: string, b: string): void {
    if (a === b) {
      return;
    }

    edgeSet(this.adjacency, a).add(b);
    edgeSet(this.adjacency, b).add(a);
  }

  addMass(mass: MassRecord): void {
    this.masses.push(mass);
  }

  addConnector(connector: ConnectorRecord): void {
    this.connectors.push(connector);
  }

  addCell(cell: CellRecord): void {
    this.cells.push(cell);
  }

  addFacade(facade: FacadeRecord): void {
    this.facades.push(facade);
  }

  addPillarHall(hall: PillarHallRecord): void {
    this.pillarHalls.push(hall);
  }

  addStela(stela: StelaRecord): void {
    this.stelae.push(stela);
  }

  addRoof(roof: RoofRecord): void {
    this.roofs.push(roof);
  }

  has(patchId: string): boolean {
    return this.patches.has(patchId);
  }

  build(diagnostics: readonly Diagnostic[]): StructureGraph {
    const patches = this.order.map((patchId) => {
      const patch = this.patches.get(patchId);

      if (!patch) {
        throw new Error(`Patch "${patchId}" vanished between registration and build.`);
      }

      // Sorted so the serialized graph does not depend on the order links
      // happened to be recorded in.
      const neighbours = [...(this.adjacency.get(patchId) ?? [])].sort();
      return { ...patch, adjacency: neighbours };
    });

    const compiledFeatures = new Map<string, CompiledPatchFeatures>();
    for (const patch of patches) {
      compiledFeatures.set(patch.id, compilePatchFeatures(patch));
    }
    const featureDiagnostics = [...compiledFeatures.values()].flatMap(
      (compiled) => compiled.diagnostics,
    );
    const pairedCutDiagnostics = validatePairedCellCuts(
      this.cells,
      new Map(patches.map((patch) => [patch.id, patch])),
      compiledFeatures,
    );

    return {
      id: this.id,
      units: "meters",
      seeds: resolvedSeeds(this.seeds),
      site: this.site,
      masses: this.masses,
      patches,
      connectors: this.connectors,
      cells: this.cells,
      facades: this.facades,
      pillarHalls: this.pillarHalls,
      stelae: this.stelae,
      roofs: this.roofs,
      attachments: [],
      damage: [],
      diagnostics: [
        ...diagnostics,
        ...featureDiagnostics,
        ...pairedCutDiagnostics,
      ],
    };
  }
}

export function patchIndex(graph: StructureGraph): Map<string, Patch> {
  return new Map(graph.patches.map((patch) => [patch.id, patch]));
}

/**
 * The graph as JSON, for golden fixtures.
 *
 * Numbers are rounded to micrometre precision. Generation is fully
 * deterministic, so exact doubles would also be reproducible — but a setback
 * that resolves to 0.7999999999999999 makes a fixture unreadable, and the point
 * of committing these is that a change in resolved proportions shows up as a
 * diff someone can actually read.
 */
export function serializeGraph(graph: StructureGraph): string {
  return `${JSON.stringify(graph, roundNumbers, 2)}\n`;
}

const PRECISION = 1e6;

function roundNumbers(_key: string, value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }

  const rounded = Math.round(value * PRECISION) / PRECISION;
  // Negative zero serializes as `-0` and would diff against a plain `0`.
  return rounded === 0 ? 0 : rounded;
}

function edgeSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);

  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function validatePairedCellCuts(
  cells: readonly CellRecord[],
  patches: ReadonlyMap<string, Patch>,
  compiled: ReadonlyMap<string, CompiledPatchFeatures>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const cell of cells) {
    const pairs = [
      ...cell.walls.map((wall) => ({
        id: `${cell.id}/${wall.orientation}`,
        first: wall.outerPatchId,
        second: wall.innerPatchId,
      })),
      ...cell.interiorWalls.map((wall) => ({
        id: wall.id,
        first: wall.negativePatchId,
        second: wall.positivePatchId,
      })),
    ];

    for (const pair of pairs) {
      const first = patches.get(pair.first);
      const second = patches.get(pair.second);
      const firstCompiled = compiled.get(pair.first);
      const secondCompiled = compiled.get(pair.second);

      if (!first || !second || !firstCompiled || !secondCompiled) {
        continue;
      }
      if (
        firstCompiled.diagnostics.some((entry) => entry.severity === "error")
        || secondCompiled.diagnostics.some((entry) => entry.severity === "error")
      ) {
        continue;
      }

      const firstCuts = compiledCutWorldBounds(first, firstCompiled);
      const secondCuts = compiledCutWorldBounds(second, secondCompiled);
      if (!sameCutBounds(firstCuts, secondCuts, first.frame.normal)) {
        diagnostics.push({
          severity: "error",
          code: "feature.paired_cut_mismatch",
          entityId: pair.id,
          message: `Paired wall patches "${pair.first}" and "${pair.second}" resolve different world-space cuts.`,
        });
      }
    }
  }

  return diagnostics;
}

function sameCutBounds(
  first: readonly CutWorldBounds[],
  second: readonly CutWorldBounds[],
  normal: Vec3,
): boolean {
  const dominant = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)]
    .indexOf(Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)));
  const canonical = (bounds: readonly CutWorldBounds[]) => bounds
    .map((entry) => [
      dominant === 0 ? [] : [entry.minX, entry.maxX],
      dominant === 1 ? [] : [entry.minY, entry.maxY],
      dominant === 2 ? [] : [entry.minZ, entry.maxZ],
    ].flat().map((value) => Math.round(value * 1e9) / 1e9).join(","))
    .sort();

  const a = canonical(first);
  const b = canonical(second);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
