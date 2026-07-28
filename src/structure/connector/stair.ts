import {
  rectWidth,
  type LocalFrame,
  type Rect,
} from "../kernel/frame";
import type {
  ElevationBandRecord,
  StairConnectorRecord,
} from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import { PATCH_ROLES, type Patch, type PatchEdges } from "../kernel/patch";
import type { DiagnosticCollector } from "../kernel/validate";

/**
 * The stair connector: the circulation half of the mass grammar.
 *
 * A stair is not a surface pattern. It is a traversable connector between two
 * horizontal patches — here the ground interface and the summit floor — and it
 * is resolved from a step rule rather than drawn to fit: the generator settles
 * an integer step count first, and the flight's length falls out of that count
 * and the tread it can afford. Everything a later system needs — navigation,
 * damage that must preserve the walkable route, the facade features that may
 * not sit under the flight — reads the resolved record, not the geometry.
 *
 * The vocabularies below are complete as specified in the doc. Only the members
 * listed in the matching `IMPLEMENTED_` array can actually be built; anything
 * else is a named error rather than a silent fallback, exactly as with wall
 * profiles and treatments.
 */

export const STAIR_LAYOUTS = [
  "front_centered",
  "front_offset",
  "twin_parallel",
  "split",
  "return",
  "corner",
  "side",
  "rear",
  "four_sided",
  "wrapped",
  "switchback",
  "cross_axial",
  "hidden_service",
] as const;

export type StairLayout = (typeof STAIR_LAYOUTS)[number];

export const IMPLEMENTED_STAIR_LAYOUTS: readonly StairLayout[] = [
  "front_centered",
];

export const STAIR_ELEVATION_MODES = [
  "band_local",
  "continuous",
  "terrace_interrupted",
  "offset_flights",
  "split_approach",
] as const;

export type StairElevationMode = (typeof STAIR_ELEVATION_MODES)[number];

export const IMPLEMENTED_STAIR_ELEVATION_MODES: readonly StairElevationMode[] = [
  "continuous",
];

export const STAIR_SIDE_TREATMENTS = [
  "none",
  "low_curb",
  "projecting_stringer",
  "solid_parapet",
  "stepped_parapet",
  "sloped_parapet",
  "tapered_parapet",
  "terraced_parapet",
  "sculptural_terminal",
  "serpent_like_profile",
  "ruined_sidewall",
] as const;

export type StairSideTreatment = (typeof STAIR_SIDE_TREATMENTS)[number];

export const IMPLEMENTED_STAIR_SIDE_TREATMENTS: readonly StairSideTreatment[] = [
  "none",
  "stepped_parapet",
];

export const STAIR_LANDING_RULES = [
  "none",
  "at_every_terrace",
  "at_selected_bands",
  "periodic_after_n_steps",
  "ceremonial_deep_landing",
  "split_landing",
  "summit_forecourt",
] as const;

export type StairLandingRule = (typeof STAIR_LANDING_RULES)[number];

export const IMPLEMENTED_STAIR_LANDING_RULES: readonly StairLandingRule[] = [
  "none",
];

/** A flight narrower than this is a ladder; the build refuses rather than lay it. */
export const MIN_STAIR_WIDTH = 0.4;

/**
 * How far in front of every face the flight must stay. Flush would be exact
 * coplanarity — two surfaces at the same depth, fighting — so the clearance is
 * small but never zero.
 */
export const STAIR_FACE_CLEARANCE = 0.01;

/** Riser drift beyond this share of the target is worth reporting. */
const RISER_DEVIATION_NOTICE = 0.2;

export interface StairSpec {
  readonly id: string;
  readonly layout: StairLayout;
  readonly elevationMode: StairElevationMode;
  readonly landingRule: StairLandingRule;
  /** Flight width as a fraction of the facade the stair climbs. */
  readonly widthRatio: number;
  readonly targetRiser: number;
  readonly targetTread: number;
  readonly sideTreatment: StairSideTreatment;
  readonly parapetWidth: number;
  readonly parapetHeight: number;
}

/**
 * The first vocabulary member of `spec` that is declared but not implemented,
 * as the diagnostic it should raise, or null when everything is buildable.
 * Checked before anything else is generated so a refused stair refuses the
 * whole build, like every other unimplemented treatment.
 */
export function unimplementedStairMember(
  spec: StairSpec,
): { readonly code: string; readonly message: string } | null {
  if (!IMPLEMENTED_STAIR_LAYOUTS.includes(spec.layout)) {
    return {
      code: "stair.layout_unimplemented",
      message: `Stair layout "${spec.layout}" is declared but not implemented in this phase.`,
    };
  }

  if (!IMPLEMENTED_STAIR_ELEVATION_MODES.includes(spec.elevationMode)) {
    return {
      code: "stair.elevation_mode_unimplemented",
      message: `Stair elevation mode "${spec.elevationMode}" is declared but not implemented in this phase.`,
    };
  }

  if (!IMPLEMENTED_STAIR_SIDE_TREATMENTS.includes(spec.sideTreatment)) {
    return {
      code: "stair.side_treatment_unimplemented",
      message: `Stair side treatment "${spec.sideTreatment}" is declared but not implemented in this phase.`,
    };
  }

  if (!IMPLEMENTED_STAIR_LANDING_RULES.includes(spec.landingRule)) {
    return {
      code: "stair.landing_rule_unimplemented",
      message: `Stair landing rule "${spec.landingRule}" is declared but not implemented in this phase.`,
    };
  }

  return null;
}

export interface StairResolutionInput {
  readonly structureId: string;
  readonly spec: StairSpec;
  readonly groundY: number;
  /** The mass outline at the ground, including any projecting base. */
  readonly groundRect: Rect;
  readonly summitRect: Rect;
  readonly summitY: number;
  /** Every band of the mass, plinth included, for the clearance profile. */
  readonly bands: readonly ElevationBandRecord[];
  readonly lowerPatchId: string;
  readonly upperPatchId: string;
}

export interface ResolvedStair {
  readonly record: StairConnectorRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
  /** World-x span the whole stair occupies, for facade reserve regions. */
  readonly spanX: readonly [number, number];
}

/**
 * Resolves one continuous, front-centred stair from the ground to the summit.
 *
 * The order of decisions matters and is the doc's: width first, clamped to what
 * the facade and the summit can take; then the integer step count from the
 * target riser; then the tread, widened if the flight at its natural pitch
 * would sink into the mass it climbs. Every repair records the value it used.
 */
export function resolveStair(
  input: StairResolutionInput,
  diagnostics: DiagnosticCollector,
): ResolvedStair | null {
  const { spec, groundY, groundRect, summitRect, summitY, bands } = input;
  const stairId = structurePath(input.structureId, spec.id);
  const parapetWidth = spec.sideTreatment === "stepped_parapet"
    ? spec.parapetWidth
    : 0;
  const parapetHeight = spec.sideTreatment === "stepped_parapet"
    ? spec.parapetHeight
    : 0;
  const hasParapet = parapetWidth > 0 && parapetHeight > 0;

  // Width. The ratio is measured against the facade the stair climbs, and the
  // whole assembly — flight plus side treatments — must fit that facade and
  // must arrive within the summit's width.
  const facadeWidth = rectWidth(groundRect);
  const available = Math.min(facadeWidth, rectWidth(summitRect));
  const sideWidth = hasParapet ? parapetWidth * 2 : 0;
  let width = spec.widthRatio * facadeWidth;

  if (width + sideWidth > available) {
    width = available - sideWidth;

    if (width >= MIN_STAIR_WIDTH) {
      diagnostics.notice(
        "stair.width_reduced",
        stairId,
        "The requested stair does not fit the summit it arrives on; its width was reduced.",
        width.toFixed(4),
      );
    }
  }

  if (width < MIN_STAIR_WIDTH) {
    diagnostics.error(
      "stair.does_not_fit",
      stairId,
      `No stair at least ${MIN_STAIR_WIDTH}m wide fits between the side treatments and the summit.`,
    );
    return null;
  }

  // Steps. The count is the integer nearest the target riser; the riser is then
  // exact by construction. A count of one is a single monumental step, not an
  // error.
  const rise = summitY - groundY;
  const stepCount = Math.max(1, Math.round(rise / spec.targetRiser));
  const riser = rise / stepCount;

  if (Math.abs(riser - spec.targetRiser) > spec.targetRiser * RISER_DEVIATION_NOTICE) {
    diagnostics.notice(
      "stair.riser_off_target",
      stairId,
      `Resolving ${rise.toFixed(3)}m of rise into whole steps left the riser far from its target.`,
      riser.toFixed(4),
    );
  }

  // The flight's upper end. A crown cornice projects past the summit edge at
  // exactly the elevation the stair arrives at, and no pitch can duck under a
  // molding — so the stair lands on the cornice's outer lip instead, and the
  // molding's top course becomes the last surface before the summit floor.
  const crown = bands[bands.length - 1]?.cornice ?? null;
  const topZ = Math.max(summitRect.maxZ, crown?.outline.maxZ ?? -Infinity);

  // Tread. The target is only a floor: the flight must also clear every face it
  // passes on the way down. The profile is piecewise linear between the corners
  // of the bands (and their cornices), and the flight is a straight line, so
  // clearing every corner clears the whole profile.
  let tread = spec.targetTread;

  for (const band of bands) {
    const corners: readonly (readonly [number, number])[] = [
      [band.bottomY, band.lower.maxZ],
      [band.topY, band.upper.maxZ],
      ...(band.cornice
        ? [
          [band.cornice.bottomY, band.cornice.outline.maxZ] as const,
          [band.topY, band.cornice.outline.maxZ] as const,
        ]
        : []),
    ];

    for (const [y, z] of corners) {
      const drop = summitY - y;

      if (drop <= 1e-9) {
        continue;
      }

      const needed = ((z + STAIR_FACE_CLEARANCE - topZ) * riser) / drop;
      tread = Math.max(tread, needed);
    }
  }

  if (tread > spec.targetTread + 1e-9) {
    diagnostics.notice(
      "stair.tread_increased",
      stairId,
      "At its requested pitch the flight would sink into the faces it climbs; the tread was widened until it clears them.",
      tread.toFixed(4),
    );
  }

  const run = stepCount * tread;
  const centerX = (groundRect.minX + groundRect.maxX) * 0.5;
  const flightRect: Rect = {
    minX: centerX - width * 0.5,
    maxX: centerX + width * 0.5,
    minZ: topZ,
    maxZ: topZ + run,
  };

  const parapet = hasParapet
    ? { width: parapetWidth, height: parapetHeight }
    : null;
  const flightPatch = stairFlightPatch(stairId, flightRect, groundY, rise, run, width);
  const sidePatches = parapet
    ? stairSidePatches(stairId, flightRect, groundY, rise + parapet.height, parapet.width)
    : [];
  const patches = [flightPatch, ...sidePatches];

  const links: (readonly [string, string])[] = [
    [flightPatch.id, input.lowerPatchId],
    [flightPatch.id, input.upperPatchId],
  ];

  for (const side of sidePatches) {
    links.push([flightPatch.id, side.id], [side.id, input.lowerPatchId]);
  }

  return {
    record: {
      id: stairId,
      kind: "stair",
      layout: spec.layout,
      elevationMode: spec.elevationMode,
      landingRule: spec.landingRule,
      lowerPatchId: input.lowerPatchId,
      upperPatchId: input.upperPatchId,
      direction: "front",
      bottomY: groundY,
      topY: summitY,
      stepCount,
      riser,
      tread,
      run,
      width,
      flightRect,
      sideTreatment: spec.sideTreatment,
      parapet,
      // The foot projects onto open ground; the last riser is flush with the
      // summit floor. Both live on the record and on the flight's v edges.
      termination: { lower: "projecting", upper: "flush" },
      patchIds: patches.map((patch) => patch.id),
    },
    patches,
    links,
    spanX: [flightRect.minX - parapetWidth, flightRect.maxX + parapetWidth],
  };
}

/**
 * The flight as one semantic surface: `u` across its width, `v` up the slope
 * from the projecting foot to the summit edge. The frame is the ideal incline;
 * the `stepped` evaluator is what resolves a `v` on it to a discrete tread, so
 * a feature at v 0.5 sits mid-flight whatever the step count resolved to.
 */
function stairFlightPatch(
  stairId: string,
  flightRect: Rect,
  groundY: number,
  rise: number,
  run: number,
  width: number,
): Patch {
  const id = structurePath(stairId, "flight");
  const slope = Math.hypot(rise, run);
  const frame: LocalFrame = {
    origin: { x: flightRect.minX, y: groundY, z: flightRect.maxZ },
    uAxis: { x: 1, y: 0, z: 0 },
    vAxis: { x: 0, y: rise / slope, z: -run / slope },
    normal: { x: 0, y: run / slope, z: rise / slope },
    uLength: width,
    vLength: slope,
  };

  return {
    id,
    role: PATCH_ROLES.stairFlight,
    frame,
    dimensions: { u: width, v: slope, thickness: 0 },
    evaluator: "stepped",
    edges: {
      uMin: edge(id, "u_min", "sideNegativeU"),
      uMax: edge(id, "u_max", "sidePositiveU"),
      vMin: edge(id, "v_min", "bottom", "projecting"),
      vMax: edge(id, "v_max", "top", "flush"),
    },
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["traversable", "exterior", "circulation"],
  };
}

/**
 * The outer elevations of the two side treatments. The domain is the bounding
 * rectangle of the silhouette — run along `u`, full height at the summit end
 * along `v` — with the stepped boundary a fact of the treatment, not of the
 * domain. `u` follows the same convention as the mass's side facades: along
 * the edge with the outward normal on the right.
 */
function stairSidePatches(
  stairId: string,
  flightRect: Rect,
  groundY: number,
  height: number,
  parapetWidth: number,
): Patch[] {
  const run = flightRect.maxZ - flightRect.minZ;

  const negative: Patch = {
    id: structurePath(stairId, "side_negative_u"),
    role: PATCH_ROLES.stairSide,
    frame: {
      origin: { x: flightRect.minX - parapetWidth, y: groundY, z: flightRect.minZ },
      uAxis: { x: 0, y: 0, z: 1 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
      uLength: run,
      vLength: height,
    },
    dimensions: { u: run, v: height, thickness: parapetWidth },
    evaluator: "planar",
    edges: sideEdges(structurePath(stairId, "side_negative_u"), "rear", "front"),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["exterior", "sideNegativeU"],
  };

  const positive: Patch = {
    id: structurePath(stairId, "side_positive_u"),
    role: PATCH_ROLES.stairSide,
    frame: {
      origin: { x: flightRect.maxX + parapetWidth, y: groundY, z: flightRect.maxZ },
      uAxis: { x: 0, y: 0, z: -1 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      uLength: run,
      vLength: height,
    },
    dimensions: { u: run, v: height, thickness: parapetWidth },
    evaluator: "planar",
    edges: sideEdges(structurePath(stairId, "side_positive_u"), "front", "rear"),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["exterior", "sidePositiveU"],
  };

  return [negative, positive];
}

function sideEdges(
  patchId: string,
  uMinOrientation: PatchEdges["uMin"]["orientation"],
  uMaxOrientation: PatchEdges["uMin"]["orientation"],
): PatchEdges {
  return {
    uMin: edge(patchId, "u_min", uMinOrientation),
    uMax: edge(patchId, "u_max", uMaxOrientation),
    vMin: edge(patchId, "v_min", "bottom"),
    vMax: edge(patchId, "v_max", "top", "stepped_cap"),
  };
}

function edge(
  patchId: string,
  segment: string,
  orientation: PatchEdges["uMin"]["orientation"],
  treatment: string | null = null,
) {
  return {
    id: structurePath(patchId, `edge_${segment}`),
    orientation,
    treatment,
  };
}

/** One step of a resolved flight, as the z-slice its blocks occupy. */
export interface StairStep {
  readonly index: number;
  readonly topY: number;
  /** The riser face the step presents to the approach. */
  readonly zFront: number;
  readonly zBack: number;
}

/**
 * The steps of a flight, foot first. Shared by tessellation and by anything
 * that needs to know where a particular tread actually is, so the two cannot
 * disagree about the arithmetic. The last step's back lands exactly on the
 * flight's upper edge because it is computed as `minZ + 0 * tread`.
 */
export function stairSteps(record: StairConnectorRecord): StairStep[] {
  const steps: StairStep[] = [];

  for (let index = 0; index < record.stepCount; index += 1) {
    steps.push({
      index,
      topY: record.bottomY + (index + 1) * record.riser,
      zFront: record.flightRect.minZ + (record.stepCount - index) * record.tread,
      zBack: record.flightRect.minZ + (record.stepCount - index - 1) * record.tread,
    });
  }

  return steps;
}
