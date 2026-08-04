import type { MaterialSlot } from "../../../geometry/part";
import {
  createFacadeFrame,
  createHorizontalFrame,
  rectDepth,
  rectEdge,
  rectFromSize,
  rectWidth,
  type HorizontalOrientation,
  type Rect,
} from "../../kernel/frame";
import { ordinalSegment, structurePath } from "../../kernel/ids";
import type { Patch } from "../../kernel/patch";
import {
  MIN_FIELD_EXTENT,
  MIN_RIBBON_LENGTH,
  MIN_RIBBON_WIDTH,
  aspectOf,
  boundaryExtent,
  faceBoundary,
  inscribedRect,
  resolveSlotFrame,
  slotAnchor,
  slotRegion,
  unitBoundary,
} from "../../kernel/slot";
import type { StelaLayoutConfig } from "./config";
import {
  IMPLEMENTED_STELA_BASE_TREATMENTS,
  IMPLEMENTED_STELA_CONDITION_STAGES,
  IMPLEMENTED_STELA_CROWN_TREATMENTS,
  IMPLEMENTED_STELA_FRAME_STYLES,
  IMPLEMENTED_STELA_GROUND_CONTACTS,
  IMPLEMENTED_STELA_TAPERS,
  type StelaAppliqueRecord,
  type StelaBandRecord,
  type StelaBandRole,
  type StelaBaseCourseRecord,
  type StelaBaseRecord,
  type StelaBayRecord,
  type StelaCrownRecord,
  type StelaDamageRecord,
  type StelaFaceRecord,
  type StelaFaceRole,
  type StelaFrameRecord,
  type StelaPocketRecord,
  type StelaRecord,
  type StelaSlotRecord,
  type StelaTrunkRecord,
  type StelaUvRect,
} from "./types";

/**
 * Resolves one stela into semantics.
 *
 * The order here is the generation order from `docs/stelae-system.md`: the
 * stack is established first, then bands, then bays and frames, then slots, and
 * only then condition. Slot emission before damage is what makes "damage never
 * deletes the slot table" mechanical — the table is complete before anything is
 * allowed to be lost, so a ruined stela and its intact twin address the same
 * ornament by the same ids.
 */

const EPS = 1e-9;

/** Stone that must survive between two opposed recessed faces. */
const CORE_THICKNESS_RATIO = 0.35;

const ORIENTATION_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "front",
  rear: "rear",
  sidePositiveU: "side_positive_u",
  sideNegativeU: "side_negative_u",
};

const BODY_FACES: readonly HorizontalOrientation[] = [
  "front",
  "rear",
  "sidePositiveU",
  "sideNegativeU",
];

/** Course profiles as ratios of base height and body width, never absolute metres. */
const BASE_PROFILES: Readonly<
  Record<string, readonly { readonly heightRatio: number; readonly widthRatio: number }[]>
> = {
  simple_plinth: [{ heightRatio: 1, widthRatio: 1.24 }],
  double_plinth: [
    { heightRatio: 0.58, widthRatio: 1.34 },
    { heightRatio: 0.42, widthRatio: 1.16 },
  ],
  stepped_pedestal: [
    { heightRatio: 0.34, widthRatio: 1.45 },
    { heightRatio: 0.44, widthRatio: 1.3 },
    { heightRatio: 0.22, widthRatio: 1.12 },
  ],
  socket_block: [
    { heightRatio: 0.72, widthRatio: 1.5 },
    { heightRatio: 0.28, widthRatio: 1.18 },
  ],
};

/** Widest and narrowest course of a stepped apron, as ratios of body width. */
const APRON_FOOT_RATIO = 2.4;
const APRON_NECK_RATIO = 1.12;

/**
 * A receding stepped plinth, generated rather than tabulated.
 *
 * The other treatments are authored stacks of two or three named courses, which
 * is why they sit in a table. An apron is the one whose whole character is how
 * many times it steps, so its course count is a control and its profile follows
 * from it: equal rises, widths receding evenly from foot to neck.
 */
function apronProfile(
  tiers: number,
): readonly { readonly heightRatio: number; readonly widthRatio: number }[] {
  const count = Math.max(Math.round(tiers), 2);
  return Array.from({ length: count }, (_, index) => ({
    heightRatio: 1 / count,
    widthRatio: APRON_FOOT_RATIO
      - (APRON_FOOT_RATIO - APRON_NECK_RATIO) * (index / (count - 1)),
  }));
}

const CAPITAL_PROFILE: readonly {
  readonly heightRatio: number;
  readonly widthRatio: number;
}[] = [
  { heightRatio: 0.18, widthRatio: 1 },
  { heightRatio: 0.52, widthRatio: 1.24 },
  { heightRatio: 0.3, widthRatio: 1.42 },
];

export interface ResolvedStela {
  readonly record: StelaRecord;
  readonly patches: readonly Patch[];
}

export function resolveStela(
  structureId: string,
  layout: StelaLayoutConfig,
): ResolvedStela {
  requireImplemented(
    IMPLEMENTED_STELA_GROUND_CONTACTS,
    layout.groundContact,
    "ground_contact",
  );
  requireImplemented(
    IMPLEMENTED_STELA_BASE_TREATMENTS,
    layout.baseTreatment,
    "base_treatment",
  );
  requireImplemented(
    IMPLEMENTED_STELA_CROWN_TREATMENTS,
    layout.crownTreatment,
    "crown_treatment",
  );
  requireImplemented(IMPLEMENTED_STELA_TAPERS, layout.taper, "taper");
  requireImplemented(
    IMPLEMENTED_STELA_FRAME_STYLES,
    layout.frameStyle,
    "frame_style",
  );
  requireImplemented(
    IMPLEMENTED_STELA_CONDITION_STAGES,
    layout.conditionStage,
    "condition_stage",
  );

  const id = structurePath(structureId, "stela_01");
  const groundY = 0;
  const burialDepth = layout.burialDepth;

  // --- Phase 2-4: the stack ------------------------------------------------
  const stackBottomY = groundY - burialDepth;
  const base = resolveBase(id, layout, stackBottomY);
  const bodyBottomY = base ? base.topY : stackBottomY;
  const bodyTopY = bodyBottomY + layout.bodyHeight;

  if (burialDepth >= layout.bodyHeight + (base ? base.topY - base.bottomY : 0) - EPS) {
    throw new RangeError(
      "The burial depth swallows the whole stela. (stela.burial_exceeds_height)",
    );
  }

  const lower = rectFromSize(layout.bodyWidth, layout.bodyThickness);
  const upper = taperedRect(lower, layout.taper, layout.taperRatio);
  if (rectWidth(upper) <= EPS || rectDepth(upper) <= EPS) {
    throw new RangeError(
      "The taper ratio inverts the body's top plane. (stela.taper_inverted)",
    );
  }
  if (base && !contains(base.footprint, lower)) {
    throw new RangeError(
      "The base footprint does not contain the body. (stela.base_smaller_than_body)",
    );
  }

  const body = {
    crossSection: layout.crossSection,
    taper: layout.taper,
    taperRatio: layout.taperRatio,
    edgeTreatment: "square" as const,
    lower,
    upper,
    bottomY: bodyBottomY,
    topY: bodyTopY,
    minCoreThickness: Math.min(layout.bodyWidth, layout.bodyThickness)
      * CORE_THICKNESS_RATIO,
  };

  const crown = resolveCrown(layout, body.upper, bodyTopY);

  // --- Phase 6: face roles -------------------------------------------------
  const faces = BODY_FACES.map((orientation): StelaFaceRecord => ({
    id: structurePath(id, `face_${ORIENTATION_SEGMENT[orientation]}`),
    orientation,
    role: faceRole(layout.crossSection, orientation),
    patchId: structurePath(id, `face_${ORIENTATION_SEGMENT[orientation]}`),
    widthBottom: faceWidth(lower, orientation),
    widthTop: faceWidth(upper, orientation),
  }));

  // --- Phase 7: bands ------------------------------------------------------
  const bands = resolveBands(id, layout, body.bottomY, body.topY);

  // --- Phase 8-9: bays and frames -----------------------------------------
  const bays: StelaBayRecord[] = [];
  const frames: StelaFrameRecord[] = [];
  const pockets: StelaPocketRecord[] = [];
  for (const band of bands) {
    if (band.role !== "register") {
      continue;
    }
    for (const face of faces) {
      if (face.role === "return" || face.role === "none") {
        continue;
      }
      const faceBays = resolveBays(band, face, layout.bayCount);
      bays.push(...faceBays);
      if (layout.frameStyle === "none") {
        continue;
      }
      for (const bay of faceBays) {
        const frame = resolveFrame(layout, band, face, bay);
        if (!frame) {
          continue;
        }
        const pocket = resolvePocket(frame, band, face, bay);
        if (!pocket) {
          continue;
        }
        frames.push(frame);
        pockets.push(pocket);
      }
    }
  }

  // --- Phase 10-11: trunk, appliques and slots ----------------------------
  const trunk = resolveTrunk(id, base, body, bands, crown, pockets);
  const appliques = resolveAppliques(id, layout, faces, bands);
  const slots = resolveSlots(
    id,
    layout,
    body,
    base,
    crown,
    faces,
    bands,
    bays,
    frames,
    pockets,
    appliques,
    groundY,
  );

  // --- Phase 13-14: condition ---------------------------------------------
  const condition = applyCondition(id, layout, body, trunk, bands, slots, crown);

  // --- Phase 15: publication ----------------------------------------------
  const patches = resolvePatches(
    id,
    layout,
    body,
    base,
    condition.crown,
    faces,
    condition.slots,
    groundY,
  );

  return {
    record: {
      id,
      kind: "stela",
      archetype: layout.archetype,
      ground: {
        contact: layout.groundContact,
        burialDepth,
        groundY,
      },
      base,
      body,
      crown: condition.crown,
      faces,
      bands: condition.bands,
      bays,
      frames,
      slots: condition.slots,
      damage: condition.damage,
      conditionStage: layout.conditionStage,
      trunk: condition.trunk,
      appliques: condition.appliques(appliques),
      patchIds: patches.map((patch) => patch.id),
    },
    patches,
  };
}

function requireImplemented<T extends string>(
  implemented: readonly T[],
  value: T,
  field: string,
): void {
  if (!implemented.includes(value)) {
    throw new RangeError(
      `"${value}" is authored vocabulary without a reader yet. (stela.${field}_unimplemented)`,
    );
  }
}

// --- stack ----------------------------------------------------------------

function resolveBase(
  id: string,
  layout: StelaLayoutConfig,
  bottomY: number,
): StelaBaseRecord | null {
  if (layout.baseTreatment === "none") {
    return null;
  }
  const profile = layout.baseTreatment === "stepped_apron"
    ? apronProfile(layout.baseTierCount)
    : BASE_PROFILES[layout.baseTreatment];
  if (!profile) {
    throw new RangeError(
      `No course profile for base treatment "${layout.baseTreatment}". (stela.base_profile_missing)`,
    );
  }

  const topY = bottomY + layout.baseHeight;
  let cursor = bottomY;
  const courses = profile.map((course, index) => {
    const courseTop = index === profile.length - 1
      ? topY
      : cursor + layout.baseHeight * course.heightRatio;
    const record: StelaBaseCourseRecord = {
      id: structurePath(id, "base", ordinalSegment("course", index)),
      index,
      footprint: rectFromSize(
        layout.bodyWidth * course.widthRatio,
        layout.bodyThickness * course.widthRatio,
      ),
      bottomY: cursor,
      topY: courseTop,
    };
    cursor = courseTop;
    return record;
  });

  const widest = Math.max(...profile.map((course) => course.widthRatio));
  return {
    treatment: layout.baseTreatment,
    footprint: rectFromSize(
      layout.bodyWidth * widest,
      layout.bodyThickness * widest,
    ),
    bottomY,
    topY,
    courses,
  };
}

/**
 * The one base course a slot can sit on: the tallest, and only when it stands
 * clear of the ground. A stepped pedestal has no single plane spanning its
 * whole height, so publishing one would describe a surface that is not there.
 */
function slotBearingCourse(
  base: StelaBaseRecord,
  groundY: number,
): StelaBaseCourseRecord | null {
  const exposed = base.courses.filter((course) => course.bottomY >= groundY - EPS);
  return exposed.reduce<StelaBaseCourseRecord | null>(
    (tallest, course) =>
      !tallest || course.topY - course.bottomY > tallest.topY - tallest.bottomY
        ? course
        : tallest,
    null,
  );
}

function resolveCrown(
  layout: StelaLayoutConfig,
  bodyTop: Rect,
  bottomY: number,
): StelaCrownRecord | null {
  if (layout.crownHeight <= EPS) {
    return null;
  }
  const treatment = layout.crownTreatment;
  const spread = treatment === "t_shaped"
    ? 1.38
    : treatment === "flared_cap" || treatment === "corbel_cap"
      ? 1.22
      : treatment === "capital_and_capstone"
        ? 1.42
        : treatment === "stepped_cap"
          ? 1.14
          : 1;
  return {
    treatment,
    footprint: scaleRect(bodyTop, treatment === "tenon" ? 0.55 : spread),
    bottomY,
    topY: bottomY + layout.crownHeight,
    // A rounded or tenon top presents no usable plane; everything else does.
    exposesFace: treatment !== "rounded"
      && treatment !== "smooth"
      && treatment !== "tenon",
  };
}

// --- bands ----------------------------------------------------------------

function resolveBands(
  id: string,
  layout: StelaLayoutConfig,
  bottomY: number,
  topY: number,
): StelaBandRecord[] {
  const height = topY - bottomY;
  const ribbonCount = layout.ribbonsBetweenRegisters
    ? Math.max(layout.registerCount - 1, 0)
    : 0;

  interface BandRule {
    readonly role: StelaBandRole;
    readonly height?: number;
    readonly weight?: number;
    readonly projection: number;
    readonly materialRole: MaterialSlot;
  }

  // Every wrapping ribbon takes the same height, wherever in the stack it sits.
  // Splitting that into three controls made the one named "ribbon height" the
  // only one that did not govern the ribbons an author could actually see.
  const ribbon = (role: StelaBandRole): BandRule => ({
    role,
    height: layout.ribbonHeight,
    projection: layout.ribbonProjection,
    materialRole: "frieze",
  });

  const rules: BandRule[] = [];
  if (layout.baseRibbon) {
    rules.push(ribbon("base_return"));
  }
  for (let index = 0; index < layout.registerCount; index += 1) {
    if (index > 0 && ribbonCount > 0) {
      rules.push(ribbon("ribbon"));
    }
    rules.push({ role: "register", weight: 1, projection: 0, materialRole: "stelaBody" });
  }
  if (layout.crownRibbon) {
    rules.push(ribbon("crown_return"));
  }

  // Fixed dimensions are allocated before the weighted remainder, which is the
  // facade grammar's order. Doing it the other way leaves the last register
  // absorbing every rounding error in the stack.
  const fixed = rules.reduce((sum, rule) => sum + (rule.height ?? 0), 0);
  const weight = rules.reduce((sum, rule) => sum + (rule.weight ?? 0), 0);
  const remainder = height - fixed;

  if (remainder <= EPS || weight <= EPS) {
    throw new RangeError(
      "Fixed bands leave no height for a register. (stela.band_allocation_mismatch)",
    );
  }
  if (remainder / weight < MIN_FIELD_EXTENT) {
    throw new RangeError(
      "The register count and ribbon heights leave no usable register. (stela.register_density)",
    );
  }

  let cursor = bottomY;
  const counters = new Map<StelaBandRole, number>();
  return rules.map((rule, index) => {
    const ordinal = counters.get(rule.role) ?? 0;
    counters.set(rule.role, ordinal + 1);
    const bandHeight = rule.height ?? remainder * (rule.weight ?? 0) / weight;
    const bandBottom = cursor;
    const bandTop = index === rules.length - 1 ? topY : cursor + bandHeight;
    cursor = bandTop;

    return {
      id: structurePath(id, ordinalSegment(rule.role, ordinal)),
      index,
      role: rule.role,
      continuity: rule.role === "register" ? "per_face" : "wrapping",
      bottomY: bandBottom,
      topY: bandTop,
      height: bandTop - bandBottom,
      projection: rule.projection,
      materialRole: rule.materialRole,
      condition: "intact",
    } satisfies StelaBandRecord;
  });
}

function resolveBays(
  band: StelaBandRecord,
  face: StelaFaceRecord,
  count: number,
): StelaBayRecord[] {
  // Equal weighted bays. The rule table is the same shape the facade grammar
  // uses; only the roles this family needs are exercised.
  return Array.from({ length: count }, (_, index) => ({
    id: structurePath(band.id, face.id.split("/").slice(-1)[0]!, ordinalSegment("bay", index)),
    bandId: band.id,
    faceId: face.id,
    index,
    role: "field" as const,
    uRange: [index / count, (index + 1) / count] as readonly [number, number],
    hierarchy: face.role === "primary" ? 3 : 2,
  }));
}

function resolveFrame(
  layout: StelaLayoutConfig,
  band: StelaBandRecord,
  face: StelaFaceRecord,
  bay: StelaBayRecord,
): StelaFrameRecord | null {
  // A frame whose borders would consume its field is omitted, and the band
  // keeps its unframed rectangle. This is a normal omission, not an error.
  const frame = resolveSlotFrame({
    id: structurePath(bay.id, "frame"),
    style: layout.frameStyle,
    bandId: band.id,
    bayId: bay.id,
    faceId: face.id,
    width: (bay.uRange[1] - bay.uRange[0]) * face.widthTop,
    height: band.height,
    insetU: layout.slots.bayField.insetU,
    insetV: layout.slots.bayField.insetV,
    borderWidth: layout.slots.bayField.borderWidth,
    recessDepth: layout.frameRecessDepth,
    returnProfile: "square",
  });

  return frame === null
    ? null
    : {
      ...frame,
      style: layout.frameStyle,
      bandId: band.id,
      bayId: bay.id,
      returnProfile: "square",
    };
}

/**
 * The recess a frame cuts into its band, in the face's own normalised span.
 *
 * Returns null when the frame leaves no field worth cutting, which is the same
 * normal omission `resolveFrame` reports by returning null.
 */
function resolvePocket(
  frame: StelaFrameRecord,
  band: StelaBandRecord,
  face: StelaFaceRecord,
  bay: StelaBayRecord,
): StelaPocketRecord | null {
  const inset = (frame.insetU + frame.borderWidth) / Math.max(face.widthBottom, EPS);
  const uMin = bay.uRange[0] + inset;
  const uMax = bay.uRange[1] - inset;
  const bottomY = band.bottomY + frame.insetV + frame.borderWidth;
  const topY = band.topY - frame.insetV - frame.borderWidth;

  if (uMax - uMin <= EPS || topY - bottomY <= MIN_FIELD_EXTENT) {
    return null;
  }

  return {
    id: structurePath(frame.id, "pocket"),
    frameId: frame.id,
    face: face.orientation,
    uRange: [uMin, uMax],
    bottomY,
    topY,
    depth: frame.recessDepth,
  };
}

// --- solid ----------------------------------------------------------------

function resolveTrunk(
  id: string,
  base: StelaBaseRecord | null,
  body: StelaRecord["body"],
  bands: readonly StelaBandRecord[],
  crown: StelaCrownRecord | null,
  pockets: readonly StelaPocketRecord[],
): StelaTrunkRecord[] {
  const trunk: StelaTrunkRecord[] = [];

  for (const course of base?.courses ?? []) {
    trunk.push({
      id: structurePath(course.id, "solid"),
      kind: "base_course",
      part: "base",
      bandId: null,
      lower: course.footprint,
      upper: course.footprint,
      bottomY: course.bottomY,
      topY: course.topY,
      materialRole: "pedestal",
      pockets: [],
    });
  }

  for (const band of bands) {
    const lower = expandRect(bodyRectAt(body, band.bottomY), band.projection);
    const upper = expandRect(bodyRectAt(body, band.topY), band.projection);
    trunk.push({
      id: structurePath(band.id, "solid"),
      kind: "band",
      part: "body",
      bandId: band.id,
      lower,
      upper,
      bottomY: band.bottomY,
      topY: band.topY,
      materialRole: band.materialRole,
      pockets: pockets.filter((pocket) =>
        pocket.bottomY >= band.bottomY - EPS && pocket.topY <= band.topY + EPS),
    });
  }

  if (crown) {
    trunk.push(...crownCourses(id, crown, body));
  }

  return trunk;
}

function crownCourses(
  id: string,
  crown: StelaCrownRecord,
  body: StelaRecord["body"],
): StelaTrunkRecord[] {
  const height = crown.topY - crown.bottomY;
  const top = body.upper;

  switch (crown.treatment) {
    case "capital_and_capstone": {
      let cursor = crown.bottomY;
      return CAPITAL_PROFILE.map((section, index) => {
        const sectionTop = index === CAPITAL_PROFILE.length - 1
          ? crown.topY
          : cursor + height * section.heightRatio;
        const rect = scaleRect(top, section.widthRatio);
        const record: StelaTrunkRecord = {
          id: structurePath(id, "crown", ordinalSegment("course", index)),
          kind: "crown_course",
          part: "crown",
          bandId: null,
          lower: rect,
          upper: rect,
          bottomY: cursor,
          topY: sectionTop,
          materialRole: index === CAPITAL_PROFILE.length - 1 ? "cornice" : "stelaCrown",
          pockets: [],
        };
        cursor = sectionTop;
        return record;
      });
    }
    case "rounded":
    case "smooth": {
      // Lofted, not stacked. Each course rises from the arc width at its foot to
      // the arc width at its head, so consecutive courses share an outline and
      // the surface is continuous. Courses of constant width would meet in a
      // horizontal ledge apiece and read as a staircase, which is what this
      // replaced.
      const steps = crown.treatment === "smooth" ? 14 : 9;
      const dome = crown.treatment === "smooth";
      const arc = (t: number) => Math.max(Math.sqrt(Math.max(1 - t * t, 0)), 0.06);
      const outline = (t: number): Rect => {
        const scale = arc(t);
        return {
          minX: top.minX * scale,
          maxX: top.maxX * scale,
          // A rounded tablet top keeps its thickness; a smooth dome rounds both
          // plan axes, which is the whole difference between the two.
          minZ: dome ? top.minZ * scale : top.minZ,
          maxZ: dome ? top.maxZ * scale : top.maxZ,
        };
      };
      return Array.from({ length: steps }, (_, index) => {
        const t0 = index / steps;
        const t1 = (index + 1) / steps;
        return {
          id: structurePath(id, "crown", ordinalSegment("course", index)),
          kind: "crown_course" as const,
          part: "crown" as const,
          bandId: null,
          lower: outline(t0),
          upper: outline(t1),
          bottomY: crown.bottomY + height * t0,
          topY: crown.bottomY + height * t1,
          materialRole: "stelaCrown" as MaterialSlot,
          pockets: [],
        };
      });
    }
    case "stepped_cap": {
      const steps = 3;
      const spread = rectWidth(crown.footprint) / Math.max(rectWidth(top), EPS);
      return Array.from({ length: steps }, (_, index) => {
        const scale = 1 + (spread - 1) * (steps - index) / steps;
        return {
          id: structurePath(id, "crown", ordinalSegment("course", index)),
          kind: "crown_course" as const,
          part: "crown" as const,
          bandId: null,
          lower: scaleRect(top, scale),
          upper: scaleRect(top, scale),
          bottomY: crown.bottomY + height * index / steps,
          topY: crown.bottomY + height * (index + 1) / steps,
          materialRole: (index === 0 ? "cornice" : "stelaCrown") as MaterialSlot,
          pockets: [],
        };
      });
    }
    default: {
      // flat, corbel_cap, flared_cap, t_shaped and tenon are all one course;
      // they differ only in how far the course spreads past the body.
      return [{
        id: structurePath(id, "crown", ordinalSegment("course", 0)),
        kind: "crown_course",
        part: "crown",
        bandId: null,
        lower: crown.treatment === "flared_cap" ? scaleRect(top, 1.02) : crown.footprint,
        upper: crown.footprint,
        bottomY: crown.bottomY,
        topY: crown.topY,
        materialRole: crown.treatment === "flat" || crown.treatment === "tenon"
          ? "stelaCrown"
          : "cornice",
        pockets: [],
      }];
    }
  }
}

/**
 * Ribbons laid on a return face.
 *
 * Frames produce no appliques at all: a recessed frame is the part of the band
 * that was never cut away, so there is nothing to lay over anything.
 */
function resolveAppliques(
  id: string,
  layout: StelaLayoutConfig,
  faces: readonly StelaFaceRecord[],
  bands: readonly StelaBandRecord[],
): StelaAppliqueRecord[] {
  if (!layout.returnRibbons) {
    return [];
  }

  const registers = bands.filter((band) => band.role === "register");
  const first = registers[0];
  const last = registers[registers.length - 1];
  if (!first || !last) {
    return [];
  }

  const appliques: StelaAppliqueRecord[] = [];
  for (const face of faces.filter((entry) => entry.role === "return")) {
    const width = face.widthBottom;
    const ribbonWidth = Math.min(layout.ribbonWidth, width * 0.6);
    if (ribbonWidth < MIN_RIBBON_WIDTH || last.topY - first.bottomY < MIN_RIBBON_LENGTH) {
      continue;
    }
    const half = ribbonWidth / width / 2;
    appliques.push({
      id: structurePath(id, `ribbon_${ORIENTATION_SEGMENT[face.orientation]}`),
      kind: "ribbon_strip",
      face: face.orientation,
      bandId: first.id,
      uRange: [0.5 - half, 0.5 + half],
      bottomY: first.bottomY,
      topY: last.topY,
      depth: layout.ribbonProjection,
      // It runs between the projecting return bands at the same depth, so both
      // ends are a contact rather than an exposed edge.
      capBottom: false,
      capTop: false,
      host: null,
      materialRole: "frieze",
    });
  }

  return appliques;
}

// --- slots ----------------------------------------------------------------

function resolveSlots(
  id: string,
  layout: StelaLayoutConfig,
  body: StelaRecord["body"],
  base: StelaBaseRecord | null,
  crown: StelaCrownRecord | null,
  faces: readonly StelaFaceRecord[],
  bands: readonly StelaBandRecord[],
  bays: readonly StelaBayRecord[],
  frames: readonly StelaFrameRecord[],
  pockets: readonly StelaPocketRecord[],
  appliques: readonly StelaAppliqueRecord[],
  groundY: number,
): StelaSlotRecord[] {
  const slots: StelaSlotRecord[] = [];
  const bandById = new Map(bands.map((band) => [band.id, band]));
  const frameByBay = new Map(frames.map((frame) => [frame.bayId, frame]));
  const pocketByFrame = new Map(pockets.map((pocket) => [pocket.frameId, pocket]));
  const bodyHeight = body.topY - body.bottomY;
  const toV = (y: number) => (y - body.bottomY) / bodyHeight;
  const { slots: features } = layout;

  for (const bay of bays) {
    if (!features.bayField.enabled) {
      break;
    }
    const band = bandById.get(bay.bandId);
    const face = faces.find((entry) => entry.id === bay.faceId);
    if (!band || !face) {
      continue;
    }
    const frame = frameByBay.get(bay.id) ?? null;
    const pocket = pocketByFrame.get(frame?.id ?? "") ?? null;

    // A framed field is the recess itself, so the frame is subtracted before
    // the field is measured rather than described alongside it. An unframed bay
    // is its whole band face.
    const fieldBottomY = pocket ? pocket.bottomY : band.bottomY;
    const fieldTopY = pocket ? pocket.topY : band.topY;
    const uMin = pocket ? pocket.uRange[0] : bay.uRange[0];
    const uMax = pocket ? pocket.uRange[1] : bay.uRange[1];
    if (
      fieldTopY - fieldBottomY < MIN_FIELD_EXTENT
      || fieldBottomY < groundY
      || uMax - uMin <= EPS
    ) {
      continue;
    }

    const vMin = toV(fieldBottomY);
    const vMax = toV(fieldTopY);

    const boundary = faceBoundary(face.widthBottom, face.widthTop, uMin, uMax, vMin, vMax);
    const inscribed = inscribedRect(boundary);
    const extent = boundaryExtent(face.widthBottom, face.widthTop, uMin, uMax, vMin, vMax, bodyHeight);
    if (extent.uTop < MIN_FIELD_EXTENT || extent.v < MIN_FIELD_EXTENT) {
      continue;
    }

    const slotId = structurePath(bay.id, "field");
    slots.push({
      id: slotId,
      kind: "field",
      part: "body",
      face: face.orientation,
      faceRole: face.role,
      bandId: band.id,
      bayId: bay.id,
      frameId: frame?.id ?? null,
      patchId: face.patchId,
      regionId: structurePath(slotId, "region"),
      anchorId: structurePath(slotId, "anchor"),
      boundary,
      inscribed,
      extent,
      aspect: aspectOf(inscribed, face.widthBottom, bodyHeight),
      depthBudget: depthBudget(layout, body, face, band, frame, bands),
      flow: "none",
      continuity: "per_face",
      hierarchy: bay.hierarchy,
      condition: "intact",
      tags: ["stela", "field", face.role],
    });
  }

  for (const band of bands.filter((entry) => entry.role !== "register")) {
    for (const face of faces) {
      if (!features.bandRibbon.enabled) {
        break;
      }
      const vMin = toV(band.bottomY);
      const vMax = toV(band.topY);
      const boundary = faceBoundary(face.widthBottom, face.widthTop, 0, 1, vMin, vMax);
      const inscribed = inscribedRect(boundary);
      const extent = boundaryExtent(face.widthBottom, face.widthTop, 0, 1, vMin, vMax, bodyHeight);
      if (extent.v < MIN_RIBBON_WIDTH
        || extent.uTop < MIN_RIBBON_LENGTH
        || band.bottomY < groundY) {
        continue;
      }
      const slotId = structurePath(
        band.id,
        ORIENTATION_SEGMENT[face.orientation],
        "ribbon",
      );
      slots.push({
        id: slotId,
        kind: "ribbon",
        part: "body",
        face: face.orientation,
        faceRole: face.role,
        bandId: band.id,
        bayId: null,
        frameId: null,
        patchId: face.patchId,
        regionId: structurePath(slotId, "region"),
        anchorId: structurePath(slotId, "anchor"),
        boundary,
        inscribed,
        extent,
        aspect: aspectOf(inscribed, face.widthBottom, bodyHeight),
        depthBudget: {
          relief: Math.max(Math.min(layout.maxRelief, band.projection), 0),
          recess: recessBudget(body, face, (band.bottomY + band.topY) / 2),
        },
        flow: "horizontal",
        continuity: "wrapping",
        hierarchy: 1,
        condition: "intact",
        tags: ["stela", "ribbon", "wrapping"],
      });
    }
  }

  // A ribbon laid on a return face is a slot exactly as a wrapping band is.
  // Drawing one without publishing it would put ornament-bearing stone on the
  // monument that no ornament system can address, which is the one failure this
  // family exists to prevent.
  for (const strip of appliques.filter((entry) => entry.kind === "ribbon_strip")) {
    const face = faces.find((entry) => entry.orientation === strip.face);
    if (!face || strip.bottomY < groundY) {
      continue;
    }
    const vMin = toV(strip.bottomY);
    if (!features.returnRibbon.enabled) {
      break;
    }
    const vMax = toV(strip.topY);
    const boundary = faceBoundary(face.widthBottom, face.widthTop, strip.uRange[0], strip.uRange[1], vMin, vMax);
    const inscribed = inscribedRect(boundary);
    const extent = boundaryExtent(
      face.widthBottom,
      face.widthTop,
      strip.uRange[0],
      strip.uRange[1],
      vMin,
      vMax,
      bodyHeight,
    );
    if (extent.uTop < MIN_RIBBON_WIDTH || extent.v < MIN_RIBBON_LENGTH) {
      continue;
    }
    const slotId = structurePath(strip.id, "slot");
    slots.push({
      id: slotId,
      kind: "ribbon",
      part: "body",
      face: face.orientation,
      faceRole: face.role,
      bandId: strip.bandId,
      bayId: null,
      frameId: null,
      patchId: face.patchId,
      regionId: structurePath(slotId, "region"),
      anchorId: structurePath(slotId, "anchor"),
      boundary,
      inscribed,
      extent,
      aspect: aspectOf(inscribed, face.widthBottom, bodyHeight),
      depthBudget: {
        relief: Math.max(Math.min(layout.maxRelief, strip.depth), 0),
        recess: recessBudget(body, face, (strip.bottomY + strip.topY) / 2),
      },
      flow: "vertical",
      continuity: "per_face",
      hierarchy: 1,
      condition: "intact",
      tags: ["stela", "ribbon", "return"],
    });
  }

  if (crown?.exposesFace && features.crownFace.enabled) {
    const slotId = structurePath(id, "crown", "face_top");
    const width = rectWidth(crown.footprint);
    const depth = rectDepth(crown.footprint);
    if (Math.min(width, depth) >= MIN_FIELD_EXTENT) {
      slots.push({
        id: slotId,
        kind: "crown_face",
        part: "crown",
        face: "top",
        faceRole: "none",
        bandId: null,
        bayId: null,
        frameId: null,
        patchId: structurePath(id, "crown", "top"),
        regionId: structurePath(slotId, "region"),
        anchorId: structurePath(slotId, "anchor"),
        boundary: unitBoundary(),
        inscribed: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
        extent: { uBottom: width, uTop: width, v: depth },
        aspect: width / depth,
        depthBudget: {
          relief: Math.max(layout.maxRelief, 0),
          recess: Math.max((crown.topY - crown.bottomY) * 0.3, 0),
        },
        flow: "none",
        continuity: "per_face",
        hierarchy: 2,
        condition: "intact",
        tags: ["stela", "crown"],
      });
    }
  }

  const bearing = base ? slotBearingCourse(base, groundY) : null;
  if (bearing) {
    const projection = (rectWidth(bearing.footprint) - rectWidth(body.lower)) / 2;
    const height = bearing.topY - bearing.bottomY;
    if (
      features.baseFace.enabled
      && projection >= MIN_RIBBON_WIDTH
      && height >= MIN_FIELD_EXTENT
    ) {
      for (const face of faces) {
        const width = faceWidth(bearing.footprint, face.orientation);
        if (width < MIN_FIELD_EXTENT) {
          continue;
        }
        const slotId = structurePath(
          id,
          "base",
          ORIENTATION_SEGMENT[face.orientation],
          "face",
        );
        slots.push({
          id: slotId,
          kind: "base_face",
          part: "base",
          face: face.orientation,
          faceRole: "none",
          bandId: null,
          bayId: null,
          frameId: null,
          patchId: structurePath(id, "base", `face_${ORIENTATION_SEGMENT[face.orientation]}`),
          regionId: structurePath(slotId, "region"),
          anchorId: structurePath(slotId, "anchor"),
          boundary: unitBoundary(),
          inscribed: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
          extent: { uBottom: width, uTop: width, v: height },
          aspect: width / height,
          depthBudget: {
            relief: Math.max(Math.min(layout.maxRelief, projection), 0),
            recess: Math.max(projection * 0.5, 0),
          },
          flow: "none",
          continuity: "per_face",
          hierarchy: 1,
          condition: "intact",
          tags: ["stela", "base"],
        });
      }
    }
  }

  return slots;
}

/**
 * The family's guarantee to its consumers, computed from resolved geometry and
 * never authored. Ornament that overtops its own frame stops the frame reading
 * as a frame, and ornament that reaches a projecting ribbon collides with it.
 */
function depthBudget(
  layout: StelaLayoutConfig,
  body: StelaRecord["body"],
  face: StelaFaceRecord,
  band: StelaBandRecord,
  frame: StelaFrameRecord | null,
  bands: readonly StelaBandRecord[],
): { readonly relief: number; readonly recess: number } {
  const neighbours = bands
    .filter((entry) => entry.index === band.index - 1 || entry.index === band.index + 1)
    .map((entry) => entry.projection)
    .filter((projection) => projection > EPS);
  const caps = [layout.maxRelief];
  if (frame) {
    // Ornament may rise back to the border plane and no further: past that the
    // frame stops reading as a frame.
    caps.push(frame.recessDepth);
  }
  if (neighbours.length > 0) {
    caps.push(Math.min(...neighbours));
  }

  return {
    relief: Math.max(Math.min(...caps), 0),
    recess: recessBudget(body, face, (band.bottomY + band.topY) / 2),
  };
}

/**
 * Opposed faces split their axis, so two deeply carved sides still leave a core.
 */
function recessBudget(
  body: StelaRecord["body"],
  face: StelaFaceRecord,
  y: number,
): number {
  const rect = bodyRectAt(body, y);
  const thickness = face.orientation === "front" || face.orientation === "rear"
    ? rectDepth(rect)
    : rectWidth(rect);
  return Math.max((thickness - body.minCoreThickness) / 2, 0);
}

// --- condition ------------------------------------------------------------

interface ConditionResult {
  readonly bands: readonly StelaBandRecord[];
  readonly slots: readonly StelaSlotRecord[];
  readonly trunk: readonly StelaTrunkRecord[];
  readonly crown: StelaCrownRecord | null;
  readonly damage: readonly StelaDamageRecord[];
  readonly appliques: (
    source: readonly StelaAppliqueRecord[],
  ) => readonly StelaAppliqueRecord[];
}

function applyCondition(
  id: string,
  layout: StelaLayoutConfig,
  body: StelaRecord["body"],
  trunk: readonly StelaTrunkRecord[],
  bands: readonly StelaBandRecord[],
  slots: readonly StelaSlotRecord[],
  crown: StelaCrownRecord | null,
): ConditionResult {
  const damage: StelaDamageRecord[] = [];
  if (layout.burialDepth > EPS) {
    damage.push({
      id: structurePath(id, "damage_burial"),
      type: "partial_burial",
      severity: Math.min(layout.burialDepth / Math.max(layout.bodyHeight, EPS), 1),
      y: 0,
    });
  }

  if (layout.truncation <= EPS) {
    return {
      bands,
      slots,
      trunk,
      crown,
      damage,
      appliques: (source) => source,
    };
  }

  const cutY = body.topY - (body.topY - body.bottomY) * layout.truncation;
  damage.push({
    id: structurePath(id, "damage_truncation"),
    type: "truncated_body",
    severity: layout.truncation,
    y: cutY,
  });

  const cutBands = bands.map((band): StelaBandRecord => ({
    ...band,
    condition: band.bottomY >= cutY - EPS
      ? "lost"
      : band.topY > cutY + EPS
        ? "partial"
        : "intact",
  }));

  // The slot table survives intact. A lost slot keeps its id, its plane and its
  // extent and reports that nothing can be placed there; a partial slot narrows
  // its inscribed rectangle to what is left.
  const bodyHeight = body.topY - body.bottomY;
  const cutV = (cutY - body.bottomY) / bodyHeight;
  const cutSlots = slots.map((slot): StelaSlotRecord => {
    if (slot.part === "crown") {
      return { ...slot, condition: "lost", depthBudget: { relief: 0, recess: 0 } };
    }
    if (slot.part !== "body") {
      return slot;
    }
    if (slot.inscribed.vMin >= cutV - EPS) {
      return { ...slot, condition: "lost", depthBudget: { relief: 0, recess: 0 } };
    }
    if (slot.inscribed.vMax <= cutV + EPS) {
      return slot;
    }
    const inscribed: StelaUvRect = { ...slot.inscribed, vMax: cutV };
    const survivingV = (cutV - slot.inscribed.vMin) * bodyHeight;
    return {
      ...slot,
      condition: "partial",
      inscribed,
      extent: { ...slot.extent, v: survivingV },
      aspect: slot.extent.uTop / Math.max(survivingV, EPS),
    };
  });

  // A recess is cut into an element, so it has to be clipped with it. Leaving a
  // pocket that reaches above the break would carve a face into stone the break
  // already took away.
  const clipPockets = (
    pockets: readonly StelaPocketRecord[],
  ): readonly StelaPocketRecord[] =>
    pockets.flatMap((pocket) => {
      if (pocket.bottomY >= cutY - EPS) {
        return [];
      }
      if (pocket.topY <= cutY + EPS) {
        return [pocket];
      }
      const topY = cutY - pocket.depth;
      return topY - pocket.bottomY > MIN_FIELD_EXTENT ? [{ ...pocket, topY }] : [];
    });

  const cutTrunk = trunk.flatMap((element): StelaTrunkRecord[] => {
    if (element.part === "crown" || element.bottomY >= cutY - EPS) {
      return [];
    }
    if (element.topY <= cutY + EPS) {
      return [element];
    }
    const t = (cutY - element.bottomY) / (element.topY - element.bottomY);
    return [{
      ...element,
      upper: lerpRect(element.lower, element.upper, t),
      topY: cutY,
      pockets: clipPockets(element.pockets),
    }];
  });

  return {
    bands: cutBands,
    slots: cutSlots,
    trunk: cutTrunk,
    crown: null,
    damage,
    appliques: (source) => source.flatMap((applique) => {
      if (applique.bottomY >= cutY - EPS) {
        return [];
      }
      return [applique.topY <= cutY + EPS
        ? applique
        : { ...applique, topY: cutY }];
    }),
  };
}

// --- patches --------------------------------------------------------------

function resolvePatches(
  id: string,
  layout: StelaLayoutConfig,
  body: StelaRecord["body"],
  base: StelaBaseRecord | null,
  crown: StelaCrownRecord | null,
  faces: readonly StelaFaceRecord[],
  slots: readonly StelaSlotRecord[],
  groundY: number,
): Patch[] {
  const patches: Patch[] = [];
  const groundRect = base?.footprint ?? body.lower;
  patches.push({
    id: structurePath(id, "ground_interface"),
    role: "ground_interface",
    frame: createHorizontalFrame(groundRect, groundY),
    dimensions: {
      u: rectWidth(groundRect),
      v: rectDepth(groundRect),
      thickness: 0,
    },
    evaluator: "planar",
    edges: horizontalEdges(structurePath(id, "ground_interface")),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["stela", "ground"],
  });

  for (const face of faces) {
    const edge = rectEdge(body.lower, face.orientation);
    const topEdge = rectEdge(body.upper, face.orientation);
    const frame = createFacadeFrame(edge, body.bottomY, body.topY, topEdge.start);
    const faceSlots = slots.filter(
      (slot) => slot.patchId === face.patchId,
    );
    patches.push({
      id: face.patchId,
      role: "stela_face",
      frame,
      dimensions: {
        u: frame.uLength,
        v: frame.vLength,
        thickness: 0,
      },
      evaluator: layout.taper === "none" ? "planar" : "battered",
      edges: verticalEdges(face.patchId),
      adjacency: [],
      regions: faceSlots.map(slotRegion),
      features: [],
      anchors: faceSlots.map(slotAnchor(face.orientation)),
      tags: ["stela", "body", face.role],
    });
  }

  if (crown?.exposesFace) {
    const patchId = structurePath(id, "crown", "top");
    const crownSlots = slots.filter((slot) => slot.patchId === patchId);
    patches.push({
      id: patchId,
      role: "stela_crown_top",
      frame: createHorizontalFrame(crown.footprint, crown.topY),
      dimensions: {
        u: rectWidth(crown.footprint),
        v: rectDepth(crown.footprint),
        thickness: 0,
      },
      evaluator: "planar",
      edges: horizontalEdges(patchId),
      adjacency: [],
      regions: crownSlots.map(slotRegion),
      features: [],
      anchors: crownSlots.map(slotAnchor("top")),
      tags: ["stela", "crown"],
    });
  }

  const bearing = base ? slotBearingCourse(base, groundY) : null;
  if (bearing) {
    for (const face of faces) {
      const patchId = structurePath(
        id,
        "base",
        `face_${ORIENTATION_SEGMENT[face.orientation]}`,
      );
      const baseSlots = slots.filter((slot) => slot.patchId === patchId);
      if (baseSlots.length === 0) {
        continue;
      }
      const edge = rectEdge(bearing.footprint, face.orientation);
      const frame = createFacadeFrame(edge, bearing.bottomY, bearing.topY, edge.start);
      patches.push({
        id: patchId,
        role: "stela_base_face",
        frame,
        dimensions: { u: frame.uLength, v: frame.vLength, thickness: 0 },
        evaluator: "planar",
        edges: verticalEdges(patchId),
        adjacency: [],
        regions: baseSlots.map(slotRegion),
        features: [],
        anchors: baseSlots.map(slotAnchor(face.orientation)),
        tags: ["stela", "base"],
      });
    }
  }

  return patches;
}

// --- geometry helpers -----------------------------------------------------

/** Plan outline of the body at a world elevation. */
export function bodyRectAt(body: StelaRecord["body"], y: number): Rect {
  const height = body.topY - body.bottomY;
  const t = height <= EPS ? 0 : clamp((y - body.bottomY) / height, 0, 1);
  return lerpRect(body.lower, body.upper, t);
}

function taperedRect(lower: Rect, taper: string, ratio: number): Rect {
  switch (taper) {
    case "tapered":
      return scaleRect(lower, ratio);
    case "battered":
      // Only the width narrows, so the primary faces stay flat planes and the
      // returns are what lean. A carved tablet wants exactly that.
      return {
        minX: lower.minX * ratio,
        maxX: lower.maxX * ratio,
        minZ: lower.minZ,
        maxZ: lower.maxZ,
      };
    default:
      return lower;
  }
}

function faceWidth(rect: Rect, orientation: HorizontalOrientation): number {
  return orientation === "front" || orientation === "rear"
    ? rectWidth(rect)
    : rectDepth(rect);
}

function faceRole(
  crossSection: string,
  orientation: HorizontalOrientation,
): StelaFaceRole {
  const broad = orientation === "front" || orientation === "rear";
  switch (crossSection) {
    case "square":
      return "primary";
    case "rectangular":
      return broad ? "primary" : "secondary";
    default:
      return broad ? (orientation === "front" ? "primary" : "secondary") : "return";
  }
}

function scaleRect(rect: Rect, scale: number): Rect {
  return {
    minX: rect.minX * scale,
    maxX: rect.maxX * scale,
    minZ: rect.minZ * scale,
    maxZ: rect.maxZ * scale,
  };
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    minX: rect.minX - amount,
    maxX: rect.maxX + amount,
    minZ: rect.minZ - amount,
    maxZ: rect.maxZ + amount,
  };
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    minX: a.minX + (b.minX - a.minX) * t,
    maxX: a.maxX + (b.maxX - a.maxX) * t,
    minZ: a.minZ + (b.minZ - a.minZ) * t,
    maxZ: a.maxZ + (b.maxZ - a.maxZ) * t,
  };
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.minX <= inner.minX + EPS
    && outer.maxX >= inner.maxX - EPS
    && outer.minZ <= inner.minZ + EPS
    && outer.maxZ >= inner.maxZ - EPS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function horizontalEdges(patchId: string) {
  return {
    uMin: { id: structurePath(patchId, "edge_u_min"), orientation: "sideNegativeU" as const, treatment: null },
    uMax: { id: structurePath(patchId, "edge_u_max"), orientation: "sidePositiveU" as const, treatment: null },
    vMin: { id: structurePath(patchId, "edge_v_min"), orientation: "rear" as const, treatment: null },
    vMax: { id: structurePath(patchId, "edge_v_max"), orientation: "front" as const, treatment: null },
  };
}

function verticalEdges(patchId: string) {
  return {
    uMin: { id: structurePath(patchId, "edge_u_min"), orientation: "sideNegativeU" as const, treatment: null },
    uMax: { id: structurePath(patchId, "edge_u_max"), orientation: "sidePositiveU" as const, treatment: null },
    vMin: { id: structurePath(patchId, "edge_v_min"), orientation: "bottom" as const, treatment: null },
    vMax: { id: structurePath(patchId, "edge_v_max"), orientation: "top" as const, treatment: null },
  };
}
