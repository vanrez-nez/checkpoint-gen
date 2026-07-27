import {
  insetRect,
  rectDepth,
  rectIsValid,
  rectWidth,
  type Rect,
  type Setbacks,
} from "../kernel/frame";
import { distributeByCurve, type ShapingCurve } from "../kernel/curve";
import { ordinalSegment, structurePath } from "../kernel/ids";
import { PATCH_ROLES } from "../kernel/patch";
import type { ElevationBandRecord } from "../kernel/graph";
import type { DiagnosticCollector } from "../kernel/validate";

/**
 * Elevation profiles: the vertical half of the mass grammar.
 *
 * A platform, a terraced platform and a stepped pyramid are the same generator
 * with different band counts and setbacks — the distinction between them is a
 * classification read off the result, not a separate geometry path.
 *
 * The vocabularies below are complete as specified. Only the members listed in
 * the matching `IMPLEMENTED_` array can actually be built; anything else is a
 * named error rather than a silent fallback, so a profile authored today cannot
 * quietly come to mean something different once the rest is implemented.
 */

export const WALL_PROFILES = [
  "vertical",
  "battered",
  "stepped",
  "terraced",
  "concave",
  "convex",
  "compound",
  "alternating",
  "custom_section",
] as const;

export type WallProfile = (typeof WALL_PROFILES)[number];

export const IMPLEMENTED_WALL_PROFILES: readonly WallProfile[] = [
  "vertical",
  "battered",
];

/**
 * The profile a batter angle implies.
 *
 * `vertical` and `battered` are not two choices, they are the ends of one: a
 * battered wall at zero degrees is a vertical wall. Asking for both a profile
 * and an angle made it possible to select "battered" and see nothing happen, so
 * the angle alone decides. The other members of the vocabulary are genuinely
 * different shapes and will be authored, not derived, when they arrive.
 */
export function wallProfileForBatter(batterDegrees: number): WallProfile {
  return batterDegrees > 0 ? "battered" : "vertical";
}

export const BAND_TRANSITIONS = [
  "none",
  "flush_joint",
  "ledge",
  "walkable_terrace",
  "simple_slab",
  "beveled_molding",
  "rounded_molding",
  "double_molding",
  "triple_molding",
  "inset_band",
  "projected_coping",
  "drainage_channel",
  "ruined_break",
] as const;

export type BandTransition = (typeof BAND_TRANSITIONS)[number];

export const BASE_TREATMENTS = [
  "none",
  "simple_plinth",
  "double_plinth",
  "projected_footing",
  "beveled_footing",
  "rounded_footing",
  "stepped_apron",
  "buried_foundation",
  "irregular_ground_transition",
] as const;

export type BaseTreatment = (typeof BASE_TREATMENTS)[number];

export const IMPLEMENTED_BASE_TREATMENTS: readonly BaseTreatment[] = [
  "none",
  "projected_footing",
];

export const SUMMIT_TREATMENTS = [
  "open_floor",
  "low_curb",
  "parapet",
  "drain_channel",
  "stylobate",
  "raised_pad",
  "multiple_building_pads",
  "courtyard",
  "altar_pad",
  "roofed_superstructure",
] as const;

export type SummitTreatment = (typeof SUMMIT_TREATMENTS)[number];

export const IMPLEMENTED_SUMMIT_TREATMENTS: readonly SummitTreatment[] = [
  "open_floor",
];

/** A terrace narrower than this is a ledge: visible, but not somewhere to walk. */
export const WALKABLE_TERRACE_WIDTH = 0.6;

export interface ElevationProfileInput {
  readonly massId: string;
  readonly footprint: Rect;
  readonly groundY: number;
  readonly bandCount: number;
  readonly totalHeight: number;
  /** Cumulative height against band position; a straight line gives equal rises. */
  readonly heightCurve: ShapingCurve;
  /** Target summit extent as a fraction of the footprint. */
  readonly summitRatio: number;
  readonly setbackScales: Setbacks;
  readonly batterDegrees: number;
  readonly wallProfile: WallProfile;
}

export interface ResolvedElevation {
  readonly bands: readonly ElevationBandRecord[];
  readonly summitRect: Rect;
  readonly summitY: number;
}

/**
 * Resolves an elevation profile into stacked bands.
 *
 * Two separate things narrow a mass, and keeping them separate is what makes
 * both tunable: the wall profile leans a band's own faces inward over its rise,
 * while the setback steps the next band in from the crown of the one below.
 * The requested summit ratio is met by the setback, after whatever the batter
 * already took. When the batter alone overshoots, the setback goes to zero and
 * the shortfall is reported rather than being silently absorbed.
 */
export function resolveElevation(
  input: ElevationProfileInput,
  diagnostics: DiagnosticCollector,
): ResolvedElevation | null {
  const {
    massId,
    footprint,
    groundY,
    bandCount,
    totalHeight,
    heightCurve,
    summitRatio,
    setbackScales,
    batterDegrees,
    wallProfile,
  } = input;

  if (!IMPLEMENTED_WALL_PROFILES.includes(wallProfile)) {
    diagnostics.error(
      "band.wall_profile_unimplemented",
      massId,
      `Wall profile "${wallProfile}" is declared but not implemented in this phase.`,
    );
    return null;
  }

  if (!rectIsValid(footprint)) {
    diagnostics.error(
      "mass.footprint_degenerate",
      massId,
      "Footprint has no positive extent.",
    );
    return null;
  }

  const distribution = distributeByCurve(bandCount, totalHeight, heightCurve);
  const rises = distribution.values;

  if (distribution.nonMonotonic) {
    diagnostics.notice(
      "mass.height_curve_falls",
      massId,
      "The height curve falls somewhere along its span, which asks for a band of "
      + "negative height; those bands were given a minimum rise instead.",
      `${bandCount} bands over ${totalHeight}m`,
    );
  }

  const batter = wallProfile === "battered"
    ? Math.tan((batterDegrees * Math.PI) / 180)
    : 0;

  // How far each side must come in, in total, to hit the requested summit.
  const halfWidth = rectWidth(footprint) * 0.5;
  const halfDepth = rectDepth(footprint) * 0.5;
  const targetShrink = {
    x: halfWidth * (1 - summitRatio),
    z: halfDepth * (1 - summitRatio),
  };
  const batterShrink = batter * totalHeight;
  const setbackBudget = {
    x: Math.max(targetShrink.x - batterShrink, 0),
    z: Math.max(targetShrink.z - batterShrink, 0),
  };

  if (batterShrink > targetShrink.x || batterShrink > targetShrink.z) {
    const achieved = Math.min(
      1 - batterShrink / halfWidth,
      1 - batterShrink / halfDepth,
    );
    diagnostics.notice(
      "mass.summit_smaller_than_requested",
      massId,
      `Batter alone narrows the mass past the requested summit ratio ${summitRatio}.`,
      achieved.toFixed(4),
    );
  }

  const bands: ElevationBandRecord[] = [];
  let lower = footprint;
  let bottomY = groundY;

  for (let index = 0; index < bandCount; index += 1) {
    const rise = rises[index] ?? 0;
    const topY = bottomY + rise;
    const bandId = structurePath(massId, ordinalSegment("band", index));
    const upper = insetRect(lower, {
      front: batter * rise,
      rear: batter * rise,
      sidePositiveU: batter * rise,
      sideNegativeU: batter * rise,
    });

    if (!rectIsValid(upper)) {
      diagnostics.error(
        "band.batter_inverts_footprint",
        bandId,
        `A ${batterDegrees}° batter over ${rise.toFixed(3)}m leaves no positive extent.`,
      );
      return null;
    }

    const isLast = index === bandCount - 1;
    // The last band has no successor to step in from, so its crown is the summit.
    const setback = isLast
      ? { front: 0, rear: 0, sidePositiveU: 0, sideNegativeU: 0 }
      : scaledSetback(setbackBudget, setbackScales, bandCount - 1);
    const next = insetRect(upper, setback);

    if (!isLast && !rectIsValid(next)) {
      diagnostics.error(
        "band.setback_inverts_footprint",
        bandId,
        "Setbacks leave the next band no positive extent.",
      );
      return null;
    }

    const ringWidth = isLast
      ? 0
      : Math.min(
        setback.front,
        setback.rear,
        setback.sidePositiveU,
        setback.sideNegativeU,
      );
    const walkable = !isLast && ringWidth >= WALKABLE_TERRACE_WIDTH;
    // A crown wide enough to stand on is a terrace; anything narrower is a
    // ledge, which is a visual band rather than a surface anything can use.
    const upperTransition: BandTransition = isLast
      ? "none"
      : (walkable ? "walkable_terrace" : "ledge");

    bands.push({
      id: bandId,
      index,
      bottomY,
      topY,
      rise,
      lower,
      upper,
      wallProfile,
      surfaceRole: wallProfile === "battered"
        ? PATCH_ROLES.batteredFacade
        : PATCH_ROLES.verticalFacade,
      upperTransition,
      walkable,
    });

    lower = next;
    bottomY = topY;
  }

  const top = bands[bands.length - 1];

  if (!top) {
    diagnostics.error("mass.no_bands", massId, "An elevation profile needs at least one band.");
    return null;
  }

  return { bands, summitRect: top.upper, summitY: top.topY };
}

function scaledSetback(
  budget: { readonly x: number; readonly z: number },
  scales: Setbacks,
  steps: number,
): Setbacks {
  const perStepX = steps > 0 ? budget.x / steps : 0;
  const perStepZ = steps > 0 ? budget.z / steps : 0;

  return {
    front: perStepZ * scales.front,
    rear: perStepZ * scales.rear,
    sidePositiveU: perStepX * scales.sidePositiveU,
    sideNegativeU: perStepX * scales.sideNegativeU,
  };
}
