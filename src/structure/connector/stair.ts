import {
  rectDepth,
  rectWidth,
  type HorizontalOrientation,
  type LocalFrame,
  type Rect,
  type Vec3,
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
  "side",
  "rear",
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
  "sloped_parapet",
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
/** Matches the mass cornice rule: a molding may take at most half its support. */
const MAX_PARAPET_CORNICE_HEIGHT_SHARE = 0.5;

export interface StairBasis {
  /** Along the facade, from its local u-min edge to u-max. */
  readonly across: Vec3;
  /** Horizontally away from the mass. */
  readonly outward: Vec3;
  readonly negativeSide: HorizontalOrientation;
  readonly positiveSide: HorizontalOrientation;
  readonly inward: HorizontalOrientation;
}

/** The axis-aligned local frame shared by resolution, patches and tessellation. */
export function stairBasis(direction: HorizontalOrientation): StairBasis {
  switch (direction) {
    case "front":
      return {
        across: { x: 1, y: 0, z: 0 },
        outward: { x: 0, y: 0, z: 1 },
        negativeSide: "sideNegativeU",
        positiveSide: "sidePositiveU",
        inward: "rear",
      };
    case "rear":
      return {
        across: { x: -1, y: 0, z: 0 },
        outward: { x: 0, y: 0, z: -1 },
        negativeSide: "sidePositiveU",
        positiveSide: "sideNegativeU",
        inward: "front",
      };
    case "sidePositiveU":
      return {
        across: { x: 0, y: 0, z: -1 },
        outward: { x: 1, y: 0, z: 0 },
        negativeSide: "front",
        positiveSide: "rear",
        inward: "sideNegativeU",
      };
    case "sideNegativeU":
      return {
        across: { x: 0, y: 0, z: 1 },
        outward: { x: -1, y: 0, z: 0 },
        negativeSide: "rear",
        positiveSide: "front",
        inward: "sidePositiveU",
      };
  }
}

/** Length of the facade edge a direction addresses. */
export function stairFacadeWidth(rect: Rect, direction: HorizontalOrientation): number {
  return direction === "front" || direction === "rear"
    ? rectWidth(rect)
    : rectDepth(rect);
}

/** Signed coordinate increasing away from the mass in `direction`. */
export function stairOutwardCoordinate(
  rect: Rect,
  direction: HorizontalOrientation,
): number {
  switch (direction) {
    case "front":
      return rect.maxZ;
    case "rear":
      return -rect.minZ;
    case "sidePositiveU":
      return rect.maxX;
    case "sideNegativeU":
      return -rect.minX;
  }
}

/** The physical interval shared by the ground and summit along the facade. */
function commonAcrossInterval(
  ground: Rect,
  summit: Rect,
  direction: HorizontalOrientation,
): readonly [number, number] {
  return direction === "front" || direction === "rear"
    ? [Math.max(ground.minX, summit.minX), Math.min(ground.maxX, summit.maxX)]
    : [Math.max(ground.minZ, summit.minZ), Math.min(ground.maxZ, summit.maxZ)];
}

/** World AABB of a canonical `u = width`, `v = run` stair flight. */
function orientedFlightRect(
  direction: HorizontalOrientation,
  centerAcross: number,
  arrivalOutward: number,
  width: number,
  run: number,
): Rect {
  const half = width * 0.5;

  switch (direction) {
    case "front":
      return {
        minX: centerAcross - half,
        maxX: centerAcross + half,
        minZ: arrivalOutward,
        maxZ: arrivalOutward + run,
      };
    case "rear":
      return {
        minX: centerAcross - half,
        maxX: centerAcross + half,
        minZ: -arrivalOutward - run,
        maxZ: -arrivalOutward,
      };
    case "sidePositiveU":
      return {
        minX: arrivalOutward,
        maxX: arrivalOutward + run,
        minZ: centerAcross - half,
        maxZ: centerAcross + half,
      };
    case "sideNegativeU":
      return {
        minX: -arrivalOutward - run,
        maxX: -arrivalOutward,
        minZ: centerAcross - half,
        maxZ: centerAcross + half,
      };
  }
}

/** Plan-space arrival centre from an oriented flight bounding box. */
function arrivalPlanCenter(
  direction: HorizontalOrientation,
  flightRect: Rect,
): { readonly x: number; readonly z: number } {

  switch (direction) {
    case "front":
      return {
        x: (flightRect.minX + flightRect.maxX) * 0.5,
        z: flightRect.minZ,
      };
    case "rear":
      return {
        x: (flightRect.minX + flightRect.maxX) * 0.5,
        z: flightRect.maxZ,
      };
    case "sidePositiveU":
      return {
        x: flightRect.minX,
        z: (flightRect.minZ + flightRect.maxZ) * 0.5,
      };
    case "sideNegativeU":
      return {
        x: flightRect.maxX,
        z: (flightRect.minZ + flightRect.maxZ) * 0.5,
      };
  }
}

/** World-space arrival centre from a record's oriented flight bounding box. */
export function stairArrivalCenter(record: StairConnectorRecord): Vec3 {
  return {
    ...arrivalPlanCenter(record.direction, record.flightRect),
    y: record.bottomY,
  };
}

/** Converts a world plan point into the stair's centred `(u, v)` domain. */
export function stairWorldToLocal(
  record: StairConnectorRecord,
  point: { readonly x: number; readonly z: number },
): { readonly u: number; readonly v: number } {
  const origin = stairArrivalCenter(record);
  const basis = stairBasis(record.direction);
  const dx = point.x - origin.x;
  const dz = point.z - origin.z;

  return {
    u: dx * basis.across.x + dz * basis.across.z,
    v: dx * basis.outward.x + dz * basis.outward.z,
  };
}

/** Converts a stair-local plan point back to world space. */
export function stairLocalVertex(
  record: StairConnectorRecord,
  u: number,
  y: number,
  v: number,
): Vec3 {
  const origin = stairArrivalCenter(record);
  const basis = stairBasis(record.direction);

  return {
    x: origin.x + basis.across.x * u + basis.outward.x * v,
    y,
    z: origin.z + basis.across.z * u + basis.outward.z * v,
  };
}

export interface StairSpec {
  readonly id: string;
  readonly direction: HorizontalOrientation;
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
  readonly parapetCorniceProjection: number;
  readonly parapetCorniceHeight: number;
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
  /** Signed facade-u span of the whole assembly, for facade reserve regions. */
  readonly spanU: readonly [number, number];
}

/**
 * Resolves one continuous, facade-centred stair from the ground to the summit.
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
  const { direction } = spec;
  const stairId = structurePath(input.structureId, spec.id);
  const supportsParapet = spec.sideTreatment === "stepped_parapet"
    || spec.sideTreatment === "sloped_parapet";
  const parapetWidth = supportsParapet
    ? spec.parapetWidth
    : 0;
  const parapetHeight = supportsParapet
    ? spec.parapetHeight
    : 0;
  const hasParapet = parapetWidth > 0 && parapetHeight > 0;
  const requestedCornice = hasParapet
    && (
      spec.sideTreatment === "stepped_parapet"
      || spec.sideTreatment === "sloped_parapet"
    )
    && spec.parapetCorniceProjection > 0
    && spec.parapetCorniceHeight > 0;
  const corniceHeight = requestedCornice
    ? Math.min(
      spec.parapetCorniceHeight,
      parapetHeight * MAX_PARAPET_CORNICE_HEIGHT_SHARE,
    )
    : 0;
  const corniceProjection = requestedCornice
    ? spec.parapetCorniceProjection
    : 0;

  if (requestedCornice && corniceHeight < spec.parapetCorniceHeight - 1e-9) {
    diagnostics.notice(
      "stair.parapet_cornice_height_reduced",
      stairId,
      "The requested parapet cornice occupied more than half the parapet; its height was reduced.",
      corniceHeight.toFixed(4),
    );
  }

  // Width. The ratio is measured against the facade the stair climbs, and the
  // whole assembly — flight plus side treatments — must fit that facade and
  // must arrive within the summit's width.
  const facadeWidth = stairFacadeWidth(groundRect, direction);
  const [acrossMin, acrossMax] = commonAcrossInterval(
    groundRect,
    summitRect,
    direction,
  );
  const available = acrossMax - acrossMin;
  const sideWidth = hasParapet
    ? (parapetWidth + corniceProjection) * 2
    : 0;
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
  const arrivalOutward = Math.max(
    stairOutwardCoordinate(summitRect, direction),
    crown
      ? stairOutwardCoordinate(crown.outline, direction)
      : -Infinity,
  );

  // Tread. The target is only a floor: the flight must also clear every face it
  // passes on the way down. The profile is piecewise linear between the corners
  // of the bands (and their cornices), and the flight is a straight line, so
  // clearing every corner clears the whole profile.
  let tread = spec.targetTread;

  for (const band of bands) {
    const corners: readonly (readonly [number, number])[] = [
      [band.bottomY, stairOutwardCoordinate(band.lower, direction)],
      [band.topY, stairOutwardCoordinate(band.upper, direction)],
      ...(band.cornice
        ? [
          [
            band.cornice.bottomY,
            stairOutwardCoordinate(band.cornice.outline, direction),
          ] as const,
          [
            band.topY,
            stairOutwardCoordinate(band.cornice.outline, direction),
          ] as const,
        ]
        : []),
    ];

    for (const [y, z] of corners) {
      const drop = summitY - y;

      if (drop <= 1e-9) {
        continue;
      }

      const needed = (
        (z + STAIR_FACE_CLEARANCE - arrivalOutward) * riser
      ) / drop;
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
  const centerAcross = (acrossMin + acrossMax) * 0.5;
  const flightRect = orientedFlightRect(
    direction,
    centerAcross,
    arrivalOutward,
    width,
    run,
  );

  const parapet = hasParapet
    ? {
      width: parapetWidth,
      height: parapetHeight,
      ...(requestedCornice
        ? {
          cornice: {
            projection: corniceProjection,
            height: corniceHeight,
          },
        }
        : {}),
    }
    : null;
  const flightPatch = stairFlightPatch(
    stairId,
    direction,
    flightRect,
    groundY,
    rise,
    run,
    width,
  );
  const sidePatches = parapet
    ? stairSidePatches(
      stairId,
      direction,
      flightRect,
      groundY,
      rise + parapet.height,
      parapet.width,
      parapet.cornice
        ? "cornice"
        : spec.sideTreatment === "sloped_parapet"
          ? "sloped_cap"
          : "stepped_cap",
    )
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
      direction,
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
    spanU: (() => {
      const basis = stairBasis(direction);
      const center = arrivalPlanCenter(direction, flightRect);
      const centerU = center.x * basis.across.x + center.z * basis.across.z;
      const half = width * 0.5 + parapetWidth + corniceProjection;
      return [centerU - half, centerU + half] as const;
    })(),
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
  direction: HorizontalOrientation,
  flightRect: Rect,
  groundY: number,
  rise: number,
  run: number,
  width: number,
): Patch {
  const id = structurePath(stairId, "flight");
  const slope = Math.hypot(rise, run);
  const basis = stairBasis(direction);
  const arrival = arrivalPlanCenter(direction, flightRect);
  const foot = {
    x: arrival.x + basis.outward.x * run,
    z: arrival.z + basis.outward.z * run,
  };
  const frame: LocalFrame = {
    origin: {
      x: foot.x - basis.across.x * width * 0.5,
      y: groundY,
      z: foot.z - basis.across.z * width * 0.5,
    },
    uAxis: basis.across,
    vAxis: {
      x: -basis.outward.x * run / slope,
      y: rise / slope,
      z: -basis.outward.z * run / slope,
    },
    normal: {
      x: basis.outward.x * rise / slope,
      y: run / slope,
      z: basis.outward.z * rise / slope,
    },
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
      uMin: edge(id, "u_min", basis.negativeSide),
      uMax: edge(id, "u_max", basis.positiveSide),
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
  direction: HorizontalOrientation,
  flightRect: Rect,
  groundY: number,
  height: number,
  parapetWidth: number,
  topTreatment: string,
): Patch[] {
  const basis = stairBasis(direction);
  const arrival = arrivalPlanCenter(direction, flightRect);
  const width = direction === "front" || direction === "rear"
    ? rectWidth(flightRect)
    : rectDepth(flightRect);
  const run = direction === "front" || direction === "rear"
    ? rectDepth(flightRect)
    : rectWidth(flightRect);
  const negativeOuter = {
    x: arrival.x - basis.across.x * (width * 0.5 + parapetWidth),
    z: arrival.z - basis.across.z * (width * 0.5 + parapetWidth),
  };
  const positiveFoot = {
    x: arrival.x
      + basis.across.x * (width * 0.5 + parapetWidth)
      + basis.outward.x * run,
    z: arrival.z
      + basis.across.z * (width * 0.5 + parapetWidth)
      + basis.outward.z * run,
  };

  const negative: Patch = {
    id: structurePath(stairId, "side_negative_u"),
    role: PATCH_ROLES.stairSide,
    frame: {
      origin: { x: negativeOuter.x, y: groundY, z: negativeOuter.z },
      uAxis: basis.outward,
      vAxis: { x: 0, y: 1, z: 0 },
      normal: {
        x: -basis.across.x,
        y: 0,
        z: -basis.across.z,
      },
      uLength: run,
      vLength: height,
    },
    dimensions: { u: run, v: height, thickness: parapetWidth },
    evaluator: "planar",
    edges: sideEdges(
      structurePath(stairId, "side_negative_u"),
      basis.inward,
      direction,
      topTreatment,
    ),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["exterior", basis.negativeSide],
  };

  const positive: Patch = {
    id: structurePath(stairId, "side_positive_u"),
    role: PATCH_ROLES.stairSide,
    frame: {
      origin: { x: positiveFoot.x, y: groundY, z: positiveFoot.z },
      uAxis: {
        x: -basis.outward.x,
        y: 0,
        z: -basis.outward.z,
      },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: basis.across,
      uLength: run,
      vLength: height,
    },
    dimensions: { u: run, v: height, thickness: parapetWidth },
    evaluator: "planar",
    edges: sideEdges(
      structurePath(stairId, "side_positive_u"),
      direction,
      basis.inward,
      topTreatment,
    ),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["exterior", basis.positiveSide],
  };

  return [negative, positive];
}

function sideEdges(
  patchId: string,
  uMinOrientation: PatchEdges["uMin"]["orientation"],
  uMaxOrientation: PatchEdges["uMin"]["orientation"],
  topTreatment: string,
): PatchEdges {
  return {
    uMin: edge(patchId, "u_min", uMinOrientation),
    uMax: edge(patchId, "u_max", uMaxOrientation),
    vMin: edge(patchId, "v_min", "bottom"),
    vMax: edge(patchId, "v_max", "top", topTreatment),
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

/** One step of a resolved flight, in its local outward-v domain. */
export interface StairStep {
  readonly index: number;
  readonly topY: number;
  /** The riser face the step presents to the approach. */
  readonly vFront: number;
  readonly vBack: number;
}

/**
 * The steps of a flight, foot first. Shared by tessellation and by anything
 * that needs to know where a particular tread actually is, so the two cannot
 * disagree about the arithmetic. Local v is zero at the summit arrival and
 * increases outward, so the last step's back lands exactly at v = 0.
 */
export function stairSteps(record: StairConnectorRecord): StairStep[] {
  const steps: StairStep[] = [];

  for (let index = 0; index < record.stepCount; index += 1) {
    steps.push({
      index,
      topY: record.bottomY + (index + 1) * record.riser,
      vFront: (record.stepCount - index) * record.tread,
      vBack: (record.stepCount - index - 1) * record.tread,
    });
  }

  return steps;
}
