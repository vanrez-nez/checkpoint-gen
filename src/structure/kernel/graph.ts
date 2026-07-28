import type { Rect, Vec3 } from "./frame";
import type { Patch, PatchRole } from "./patch";
import { resolvedSeeds, type SeedSet, type SeedSubsystem } from "./seed";
import type { Diagnostic } from "./validate";

/**
 * The resolved semantic description of one structure.
 *
 * This is the artefact every later phase reads and no later phase mutates. The
 * schema is authored ahead of the systems that fill it: containers for cells,
 * frames, roofs, attachments and damage exist and serialize as empty arrays, so
 * adding those systems changes what is inside the graph without changing its
 * shape — and the committed fixtures stay readable diffs rather than wholesale
 * rewrites. Connectors were the first container to be filled, by the stair
 * system.
 */
export const STRUCTURE_SCHEMA_VERSION = "1.0";

/**
 * Placeholder element type for a subsystem that has not been implemented yet.
 * Later phases replace it with the real record; the container and its serialized
 * shape do not move.
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

export interface SummitRecord {
  readonly y: number;
  readonly rect: Rect;
  /** `rect` minus the no-build margin: where superstructures may be placed. */
  readonly buildable: Rect;
  readonly treatment: string;
  readonly patchId: string;
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
  readonly direction: "front";
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
  readonly parapet: { readonly width: number; readonly height: number } | null;
  readonly termination: { readonly lower: string; readonly upper: string };
  readonly patchIds: readonly string[];
}

/**
 * Stairs are the only connector so far; ramps, passages and portals will widen
 * this union rather than getting containers of their own.
 */
export type ConnectorRecord = StairConnectorRecord;

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
  readonly schemaVersion: string;
  readonly id: string;
  readonly units: "meters";
  readonly seeds: Readonly<Record<SeedSubsystem, number>>;
  readonly site: SiteRecord;
  readonly masses: readonly MassRecord[];
  readonly patches: readonly Patch[];
  readonly connectors: readonly ConnectorRecord[];
  readonly cells: readonly ReservedEntity[];
  readonly frames: readonly ReservedEntity[];
  readonly roofs: readonly ReservedEntity[];
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

    return {
      schemaVersion: STRUCTURE_SCHEMA_VERSION,
      id: this.id,
      units: "meters",
      seeds: resolvedSeeds(this.seeds),
      site: this.site,
      masses: this.masses,
      patches,
      connectors: this.connectors,
      cells: [],
      frames: [],
      roofs: [],
      attachments: [],
      damage: [],
      diagnostics,
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
