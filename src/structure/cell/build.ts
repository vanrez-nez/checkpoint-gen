import { MATERIAL_SLOTS, type MaterialSlot } from "../../geometry/part";
import type {
  BlockFaceMaterials,
  SolidBuilder,
} from "../../geometry/solid-builder";
import {
  evaluateFrame,
  rectCorners,
  rectIsValid,
  type HorizontalOrientation,
  type Rect,
} from "../kernel/frame";
import type { CellRecord } from "../kernel/graph";
import type { Patch } from "../kernel/patch";
import {
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../kernel/masonry";
import {
  compiledCutFragments,
  compiledSurfaceFragments,
} from "../surface/features";
import { addFramedFace } from "../mass/shell";
import { preparedCellFields, type PreparedCellField } from "./slots";

const EPS = 1e-9;
type SideFlags = readonly [boolean, boolean, boolean, boolean];

interface CellPanel {
  readonly id: string;
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  /** Rect side order: left, front, right, rear. */
  readonly sides: SideFlags;
  readonly top: boolean;
  readonly bottom: boolean;
  readonly axis: "x" | "z";
  /** Per-face semantic material ownership; omitted faces inherit the Cell slot. */
  readonly materials?: BlockFaceMaterials;
  /**
   * An engraving field prepared on this panel's outward face. A panel carrying
   * one is laid flat instead of coursed, and its face is drawn as the border it
   * keeps plus the field it gives away.
   */
  readonly fields?: readonly PreparedCellField[];
}

export function buildCell(
  builder: SolidBuilder,
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
  masonry: MasonryRule | null,
  seed: number,
): void {
  const panels = cellPanels(cell, patches);

  if (!masonry) {
    for (const panel of panels) {
      addPanelBlock(builder, panel);
    }
    return;
  }

  const boundaries = courseBoundaries(cell, masonry, seed, panels);
  for (const panel of panels) {
    // A prepared wall keeps its plane. Coursing it would leave the engraving a
    // staircase of stone ends to sit on.
    if (panel.fields && panel.fields.length > 0) {
      addPanelBlock(builder, panel);
      continue;
    }
    layPanelStones(builder, panel, masonry, seed, boundaries);
  }
}

/**
 * Whether a horizontal support face is wholly beneath a cell wall panel.
 * Tessellation calls this before emitting the cell, so its own floor and wall
 * faces can never cull themselves.
 */
export function faceIsCoveredByCellWall(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
): boolean {
  if (
    face.length !== 4
    || face.some((point) => Math.abs(point.y - cell.bottomY) > EPS)
    || faceNormalY(face) < 0.99
  ) {
    return false;
  }

  return cellPanels(cell, patches)
    .filter((panel) => Math.abs(panel.bottomY - cell.bottomY) <= EPS)
    .some((panel) => face.every((point) => pointInsideRect(point, panel.rect)));
}

/** True for an upward support face wholly owned by a room or threshold floor. */
export function faceIsCellInteriorFloor(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  cell: CellRecord,
): boolean {
  if (
    face.length !== 4
    || face.some((point) => Math.abs(point.y - cell.bottomY) > EPS)
    || faceNormalY(face) < 0.99
  ) {
    return false;
  }

  const floors = [
    ...cell.rooms.map((room) => room.footprint),
    ...cell.openings.map((opening) => opening.threshold),
    ...cell.connections.map((connection) => connection.threshold),
  ];

  return floors.some((floor) =>
    face.every((point) => pointInsideRect(point, floor)));
}

/**
 * Exposed support surface when bare massing is used: outside the chamber,
 * inside the room, and through the portal threshold. The wall ring itself is
 * deliberately absent.
 */
export function addBareCellFloorSurface(
  builder: SolidBuilder,
  surface: Rect,
  cell: CellRecord,
  y: number,
): void {
  addHorizontalRing(builder, surface, cell.footprint, y);

  builder.withMaterial("interior", () => {
    for (const room of cell.rooms) {
      addHorizontalRect(builder, room.footprint, y);
    }

    for (const portal of cell.openings) {
      addHorizontalRect(builder, portal.threshold, y);
    }
    for (const connection of cell.connections) {
      addHorizontalRect(builder, connection.threshold, y);
    }
  });
}

function cellPanels(
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
): CellPanel[] {
  const prepared = preparedCellFields(cell, patches);
  const { footprint: outer, interior: inner, bottomY, topY } = cell;
  const panels: CellPanel[] = [
    // Corner blocks own the returns between adjacent wall spans. Their contact
    // faces stay closed, so adding portals to either neighbour cannot create
    // overlaps or expose the room through a corner joint.
    panel("corner_left_rear", {
      minX: outer.minX, maxX: inner.minX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [true, false, false, true], "z"),
    panel("corner_left_front", {
      minX: outer.minX, maxX: inner.minX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [true, true, false, false], "z"),
    panel("corner_right_rear", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [false, false, true, true], "z"),
    panel("corner_right_front", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [false, true, true, false], "z"),
  ];

  for (const direction of [
    "front",
    "rear",
    "sidePositiveU",
    "sideNegativeU",
  ] as const) {
    const wall = cell.walls.find((candidate) => candidate.orientation === direction);
    const patch = wall ? patches.get(wall.outerPatchId) : undefined;

    if (!wall || !patch) {
      throw new Error(`Cell "${cell.id}" is missing its ${direction} wall patch.`);
    }

    const axis = direction === "front" || direction === "rear" ? "x" : "z";
    const carried = prepared.get(direction) ?? [];
    const wallPanels = profileWallPanels({
      id: wallPanelId(direction),
      rect: wallCenterRect(outer, inner, direction),
      axis,
      direction,
      wallThickness: cell.wallThickness,
      bottomY,
      topY,
      features: worldSurfaceFeatures(patch, axis),
    });
    // A wall with an entry resolves to several panels, so each field goes to
    // the one that actually contains it rather than to the first.
    panels.push(...wallPanels.map((panel) => {
      const fields = carried.filter((field) => fieldFitsPanel(field, panel));
      return fields.length > 0 ? { ...panel, fields } : panel;
    }));
  }

  for (const wall of cell.interiorWalls) {
    panels.push(...interiorWallPanels(cell, wall, patches));
  }

  return panels.filter(
    (candidate) =>
      rectIsValid(candidate.rect) && candidate.topY > candidate.bottomY,
  );
}

function interiorWallPanels(
  cell: CellRecord,
  wall: CellRecord["interiorWalls"][number],
  patches: ReadonlyMap<string, Patch>,
): CellPanel[] {
  const axis = wall.axis;
  const patch = patches.get(wall.negativePatchId);

  if (!patch) {
    throw new Error(`Interior wall "${wall.id}" is missing patch "${wall.negativePatchId}".`);
  }

  const surfaces: SideFlags = axis === "x"
    ? [false, true, false, true]
    : [true, false, true, false];
  const boundaryCuts = {
    start: interiorBoundaryCuts(cell, patches, wall, "start"),
    end: interiorBoundaryCuts(cell, patches, wall, "end"),
  };
  return cutWallPanels({
    id: wall.id,
    rect: wall.rect,
    axis,
    bottomY: cell.bottomY,
    topY: cell.topY,
    surfaces,
    cuts: worldCuts(patch, axis),
    boundaryBreaks: [...boundaryCuts.start, ...boundaryCuts.end]
      .flatMap((cut) => [cut.bottomY, cut.topY]),
    boundaryExposed: (end, fromY, toY) => boundaryCuts[end].some((cut) =>
      fromY < cut.topY - EPS && toY > cut.bottomY + EPS),
  });
}

interface WallCut {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly bottomY: number;
  readonly topY: number;
}

interface WallSurfaceFeature extends WallCut {
  readonly operation: "cut" | "inset" | "extrude";
  readonly depth: number;
  readonly material: MaterialSlot | undefined;
}

interface ProfileSurfaceCell {
  readonly depth: number | null;
  readonly material: MaterialSlot | undefined;
  readonly operation: WallSurfaceFeature["operation"] | null;
}

interface ProfileWallInput {
  readonly id: string;
  readonly rect: Rect;
  readonly axis: "x" | "z";
  readonly direction: CellRecord["walls"][number]["orientation"];
  readonly wallThickness: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly features: readonly WallSurfaceFeature[];
}

/**
 * Resolves a facade as an occupied u/v/depth grid.
 *
 * The wall core occupies depth `[-wallThickness, 0]`. Insets stop before zero,
 * extrusions continue beyond it, and cuts occupy no depth at all. Since every
 * depth transition is another block boundary, a recess return or pilaster side
 * is owned once and the original public wall face does not survive underneath.
 */
function profileWallPanels(input: ProfileWallInput): CellPanel[] {
  const start = input.axis === "x" ? input.rect.minX : input.rect.minZ;
  const end = input.axis === "x" ? input.rect.maxX : input.rect.maxZ;
  const features = input.features
    .map((feature) => ({
      ...feature,
      from: clamp(feature.from, start, end),
      to: clamp(feature.to, start, end),
      bottomY: clamp(feature.bottomY, input.bottomY, input.topY),
      topY: clamp(feature.topY, input.bottomY, input.topY),
    }))
    .filter((feature) =>
      feature.to > feature.from + EPS && feature.topY > feature.bottomY + EPS);
  const along = uniqueSorted([
    start,
    end,
    ...features.flatMap((feature) => [feature.from, feature.to]),
  ]);
  const vertical = uniqueSorted([
    input.bottomY,
    input.topY,
    ...features.flatMap((feature) => [feature.bottomY, feature.topY]),
  ]);
  const depths = uniqueSorted([
    -input.wallThickness,
    0,
    ...features
      .filter((feature) => feature.operation !== "cut")
      .map((feature) => feature.operation === "inset" ? -feature.depth : feature.depth),
  ]);
  const surface: ProfileSurfaceCell[][] = Array.from(
    { length: along.length - 1 },
    (_, u) => Array.from({ length: vertical.length - 1 }, (_, v) => {
      const centre = {
        along: (along[u]! + along[u + 1]!) * 0.5,
        y: (vertical[v]! + vertical[v + 1]!) * 0.5,
      };
      let cell: ProfileSurfaceCell = {
        depth: 0,
        material: undefined,
        operation: null,
      };
      for (const feature of features) {
        if (
          centre.along > feature.from + EPS
          && centre.along < feature.to - EPS
          && centre.y > feature.bottomY + EPS
          && centre.y < feature.topY - EPS
        ) {
          cell = {
            depth: feature.operation === "cut"
              ? null
              : feature.operation === "inset" ? -feature.depth : feature.depth,
            material: feature.material,
            operation: feature.operation,
          };
        }
      }
      return cell;
    }),
  );
  const occupied = Array.from(
    { length: along.length - 1 },
    (_, u) => Array.from({ length: vertical.length - 1 }, (_, v) =>
      Array.from({ length: depths.length - 1 }, (_, d) => {
        const faceDepth = surface[u]?.[v]?.depth;
        const centreDepth = (depths[d]! + depths[d + 1]!) * 0.5;
        return faceDepth !== null
          && centreDepth >= -input.wallThickness - EPS
          && centreDepth <= faceDepth + EPS;
      })),
  );
  const panels: CellPanel[] = [];

  for (let u = 0; u < along.length - 1; u += 1) {
    for (let v = 0; v < vertical.length - 1; v += 1) {
      for (let d = 0; d < depths.length - 1; d += 1) {
        if (occupied[u]?.[v]?.[d] !== true) {
          continue;
        }
        const neighbours = {
          uMin: u > 0 && occupied[u - 1]?.[v]?.[d] === true,
          uMax: u < along.length - 2 && occupied[u + 1]?.[v]?.[d] === true,
          vMin: v > 0 && occupied[u]?.[v - 1]?.[d] === true,
          vMax: v < vertical.length - 2 && occupied[u]?.[v + 1]?.[d] === true,
          dMin: d > 0 && occupied[u]?.[v]?.[d - 1] === true,
          dMax: d < depths.length - 2 && occupied[u]?.[v]?.[d + 1] === true,
        };
        const sides = [...profileSides(input.direction, neighbours)] as [
          boolean,
          boolean,
          boolean,
          boolean,
        ];
        // Corner blocks own both ends of every exterior wall run. Only a gap
        // inside the run may expose a jamb; the run boundary itself stays shut.
        if (u === 0) {
          sides[input.axis === "x" ? 0 : 3] = false;
        }
        if (u === along.length - 2) {
          sides[input.axis === "x" ? 2 : 1] = false;
        }
        const materials = profileMaterials(
          input.direction,
          surface,
          u,
          v,
          neighbours,
        );
        panels.push(panel(
          `${input.id}_u${String(u).padStart(2, "0")}_v${String(v).padStart(2, "0")}_d${String(d).padStart(2, "0")}`,
          profileRect(
            input.rect,
            input.axis,
            input.direction,
            along[u]!,
            along[u + 1]!,
            depths[d]!,
            depths[d + 1]!,
          ),
          vertical[v]!,
          vertical[v + 1]!,
          sides,
          input.axis,
          !neighbours.vMax,
          v > 0 && !neighbours.vMin,
          materials,
        ));
      }
    }
  }
  return panels;
}

function profileRect(
  base: Rect,
  axis: "x" | "z",
  direction: CellRecord["walls"][number]["orientation"],
  from: number,
  to: number,
  depthMin: number,
  depthMax: number,
): Rect {
  const along = spanRect(base, axis, from, to);
  switch (direction) {
    case "front":
      return { ...along, minZ: base.maxZ + depthMin, maxZ: base.maxZ + depthMax };
    case "rear":
      return { ...along, minZ: base.minZ - depthMax, maxZ: base.minZ - depthMin };
    case "sidePositiveU":
      return { ...along, minX: base.maxX + depthMin, maxX: base.maxX + depthMax };
    case "sideNegativeU":
      return { ...along, minX: base.minX - depthMax, maxX: base.minX - depthMin };
  }
}

interface ProfileNeighbours {
  readonly uMin: boolean;
  readonly uMax: boolean;
  readonly vMin: boolean;
  readonly vMax: boolean;
  readonly dMin: boolean;
  readonly dMax: boolean;
}

function profileSides(
  direction: CellRecord["walls"][number]["orientation"],
  neighbours: ProfileNeighbours,
): SideFlags {
  const sides: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  if (direction === "front" || direction === "rear") {
    sides[0] = !neighbours.uMin;
    sides[2] = !neighbours.uMax;
  } else {
    sides[3] = !neighbours.uMin;
    sides[1] = !neighbours.uMax;
  }
  switch (direction) {
    case "front":
      sides[3] = !neighbours.dMin;
      sides[1] = !neighbours.dMax;
      break;
    case "rear":
      sides[1] = !neighbours.dMin;
      sides[3] = !neighbours.dMax;
      break;
    case "sidePositiveU":
      sides[0] = !neighbours.dMin;
      sides[2] = !neighbours.dMax;
      break;
    case "sideNegativeU":
      sides[2] = !neighbours.dMin;
      sides[0] = !neighbours.dMax;
      break;
  }
  return sides;
}

/**
 * Resolves which feature owns each exposed boundary of one wall-volume cell.
 *
 * An extrusion owns its occupied projection faces. A cut or inset owns the
 * boundary of the empty space it removed, so an adjacent solid cell yields its
 * face to that feature for jambs and recess returns. The room-facing depth
 * boundary always keeps the Cell's base material.
 */
function profileMaterials(
  direction: CellRecord["walls"][number]["orientation"],
  surface: readonly (readonly ProfileSurfaceCell[])[],
  u: number,
  v: number,
  neighbours: ProfileNeighbours,
): BlockFaceMaterials {
  const current = surface[u]?.[v] ?? {
    depth: 0,
    material: undefined,
    operation: null,
  };
  const boundaryMaterial = (adjacent: ProfileSurfaceCell | undefined) => {
    // Removed space owns its returns. A shallower extrusion does not: the
    // deeper occupied projection owns the side exposed above its neighbour.
    if (adjacent?.operation === "cut" || adjacent?.operation === "inset") {
      return adjacent.material ?? current.material;
    }
    return current.material ?? adjacent?.material;
  };
  const uMin = !neighbours.uMin
    ? boundaryMaterial(surface[u - 1]?.[v])
    : undefined;
  const uMax = !neighbours.uMax
    ? boundaryMaterial(surface[u + 1]?.[v])
    : undefined;
  const dMax = !neighbours.dMax ? current.material : undefined;
  const sides: (MaterialSlot | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
  ];

  if (direction === "front" || direction === "rear") {
    sides[0] = uMin;
    sides[2] = uMax;
  } else {
    sides[3] = uMin;
    sides[1] = uMax;
  }
  switch (direction) {
    case "front":
      sides[1] = dMax;
      break;
    case "rear":
      sides[3] = dMax;
      break;
    case "sidePositiveU":
      sides[2] = dMax;
      break;
    case "sideNegativeU":
      sides[0] = dMax;
      break;
  }

  return {
    sides,
    top: !neighbours.vMax
      ? boundaryMaterial(surface[u]?.[v + 1])
      : undefined,
    bottom: !neighbours.vMin
      ? boundaryMaterial(surface[u]?.[v - 1])
      : undefined,
  };
}

interface CutWallInput {
  readonly id: string;
  readonly rect: Rect;
  readonly axis: "x" | "z";
  readonly bottomY: number;
  readonly topY: number;
  readonly surfaces: SideFlags;
  readonly cuts: readonly WallCut[];
  /** Vertical divisions inherited from adjoining openings at the wall ends. */
  readonly boundaryBreaks?: readonly number[];
  readonly boundaryExposed: (
    end: "start" | "end",
    bottomY: number,
    topY: number,
  ) => boolean;
}

/**
 * Partitions one planar wall on every compiled cut boundary.
 *
 * Each occupied grid cell becomes one block. Faces between occupied cells stay
 * hidden; a solid-to-cut boundary becomes a jamb, sill or soffit. This supports
 * any number of rectangular openings, including openings above the floor,
 * without teaching the cell builder what a portal or window means.
 */
function cutWallPanels(input: CutWallInput): CellPanel[] {
  const start = input.axis === "x" ? input.rect.minX : input.rect.minZ;
  const end = input.axis === "x" ? input.rect.maxX : input.rect.maxZ;
  const cuts = input.cuts
    .map((cut) => ({
      ...cut,
      from: clamp(cut.from, start, end),
      to: clamp(cut.to, start, end),
      bottomY: clamp(cut.bottomY, input.bottomY, input.topY),
      topY: clamp(cut.topY, input.bottomY, input.topY),
    }))
    .filter((cut) => cut.to > cut.from + EPS && cut.topY > cut.bottomY + EPS);
  const along = uniqueSorted([
    start,
    end,
    ...cuts.flatMap((cut) => [cut.from, cut.to]),
  ]);
  const vertical = uniqueSorted([
    input.bottomY,
    input.topY,
    ...cuts.flatMap((cut) => [cut.bottomY, cut.topY]),
    ...(input.boundaryBreaks ?? []).map((value) =>
      clamp(value, input.bottomY, input.topY)),
  ]);
  const occupied = Array.from(
    { length: along.length - 1 },
    (_, u) => Array.from({ length: vertical.length - 1 }, (_, v) => {
      const centre = {
        along: ((along[u] ?? 0) + (along[u + 1] ?? 0)) * 0.5,
        y: ((vertical[v] ?? 0) + (vertical[v + 1] ?? 0)) * 0.5,
      };
      return !cuts.some((cut) =>
        centre.along > cut.from + EPS
        && centre.along < cut.to - EPS
        && centre.y > cut.bottomY + EPS
        && centre.y < cut.topY - EPS);
    }),
  );
  const panels: CellPanel[] = [];
  const startSide = input.axis === "x" ? 0 : 3;
  const endSide = input.axis === "x" ? 2 : 1;

  for (let u = 0; u < along.length - 1; u += 1) {
    for (let v = 0; v < vertical.length - 1; v += 1) {
      if (occupied[u]?.[v] !== true) {
        continue;
      }

      const from = along[u]!;
      const to = along[u + 1]!;
      const bottomY = vertical[v]!;
      const topY = vertical[v + 1]!;
      const atStart = u === 0;
      const atEnd = u === along.length - 2;
      const startVisible = atStart
        ? input.boundaryExposed("start", bottomY, topY)
        : occupied[u - 1]?.[v] === false;
      const endVisible = atEnd
        ? input.boundaryExposed("end", bottomY, topY)
        : occupied[u + 1]?.[v] === false;
      const belowVisible = v > 0 && occupied[u]?.[v - 1] === false;
      const aboveVisible = v === vertical.length - 2
        || occupied[u]?.[v + 1] === false;
      const sides: [boolean, boolean, boolean, boolean] = [...input.surfaces];
      sides[startSide] = startVisible;
      sides[endSide] = endVisible;

      panels.push(panel(
        `${input.id}_u${String(u).padStart(2, "0")}_v${String(v).padStart(2, "0")}`,
        spanRect(input.rect, input.axis, from, to),
        bottomY,
        topY,
        sides,
        input.axis,
        aboveVisible,
        belowVisible,
      ));
    }
  }

  return panels;
}

function worldCuts(patch: Patch, axis: "x" | "z"): WallCut[] {
  return compiledCutFragments(patch).map((fragment, index) => {
    const corners = [
      evaluateFrame(patch.frame, fragment.uMin, fragment.vMin),
      evaluateFrame(patch.frame, fragment.uMax, fragment.vMin),
      evaluateFrame(patch.frame, fragment.uMin, fragment.vMax),
      evaluateFrame(patch.frame, fragment.uMax, fragment.vMax),
    ];
    const along = corners.map((point) => axis === "x" ? point.x : point.z);
    const vertical = corners.map((point) => point.y);

    return {
      id: `${patch.id}/cut_${String(index + 1).padStart(2, "0")}`,
      from: Math.min(...along),
      to: Math.max(...along),
      bottomY: Math.min(...vertical),
      topY: Math.max(...vertical),
    };
  });
}

function worldSurfaceFeatures(
  patch: Patch,
  axis: "x" | "z",
): WallSurfaceFeature[] {
  return compiledSurfaceFragments(patch).flatMap((compiled) =>
    compiled.fragments.map((fragment, index) => {
      const corners = [
        evaluateFrame(patch.frame, fragment.uMin, fragment.vMin),
        evaluateFrame(patch.frame, fragment.uMax, fragment.vMin),
        evaluateFrame(patch.frame, fragment.uMin, fragment.vMax),
        evaluateFrame(patch.frame, fragment.uMax, fragment.vMax),
      ];
      const along = corners.map((point) => axis === "x" ? point.x : point.z);
      const vertical = corners.map((point) => point.y);

      return {
        id: `${compiled.feature.id}/fragment_${String(index + 1).padStart(2, "0")}`,
        operation: compiled.feature.operation as "cut" | "inset" | "extrude",
        depth: compiled.feature.depth,
        material: materialSlotForFeature(
          compiled.feature.id,
          compiled.feature.materialRole,
        ),
        from: Math.min(...along),
        to: Math.max(...along),
        bottomY: Math.min(...vertical),
        topY: Math.max(...vertical),
      };
    }));
}

function materialSlotForFeature(
  featureId: string,
  materialRole: string | null,
): MaterialSlot | undefined {
  if (materialRole === null) {
    return undefined;
  }
  if (!MATERIAL_SLOTS.includes(materialRole as MaterialSlot)) {
    throw new RangeError(
      `Feature "${featureId}" names unknown material role "${materialRole}".`,
    );
  }
  return materialRole as MaterialSlot;
}

function interiorBoundaryCuts(
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
  wall: CellRecord["interiorWalls"][number],
  end: "start" | "end",
): WallCut[] {
  const direction = wall.axis === "x"
    ? end === "start" ? "sideNegativeU" : "sidePositiveU"
    : end === "start" ? "rear" : "front";
  const exterior = cell.walls.find((candidate) => candidate.orientation === direction);
  const patch = exterior ? patches.get(exterior.outerPatchId) : undefined;

  if (!patch) {
    return [];
  }

  const boundaryAxis = wall.axis === "x" ? "z" : "x";
  const coordinate = boundaryAxis === "x"
    ? (wall.rect.minX + wall.rect.maxX) * 0.5
    : (wall.rect.minZ + wall.rect.maxZ) * 0.5;

  return worldCuts(patch, boundaryAxis).filter((cut) =>
    coordinate > cut.from - EPS
    && coordinate < cut.to + EPS);
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => value.toFixed(9)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function wallCenterRect(
  outer: Rect,
  inner: Rect,
  direction: CellRecord["walls"][number]["orientation"],
): Rect {
  switch (direction) {
    case "front":
      return {
        minX: inner.minX,
        maxX: inner.maxX,
        minZ: inner.maxZ,
        maxZ: outer.maxZ,
      };
    case "rear":
      return {
        minX: inner.minX,
        maxX: inner.maxX,
        minZ: outer.minZ,
        maxZ: inner.minZ,
      };
    case "sidePositiveU":
      return {
        minX: inner.maxX,
        maxX: outer.maxX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      };
    case "sideNegativeU":
      return {
        minX: outer.minX,
        maxX: inner.minX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      };
  }
}

function wallPanelId(
  direction: CellRecord["walls"][number]["orientation"],
): string {
  switch (direction) {
    case "front":
      return "front";
    case "rear":
      return "rear";
    case "sidePositiveU":
      return "right";
    case "sideNegativeU":
      return "left";
  }
}

function spanRect(
  rect: Rect,
  axis: CellPanel["axis"],
  from: number,
  to: number,
): Rect {
  return axis === "x"
    ? { ...rect, minX: from, maxX: to }
    : { ...rect, minZ: from, maxZ: to };
}

function panel(
  id: string,
  rect: Rect,
  bottomY: number,
  topY: number,
  sides: SideFlags,
  axis: "x" | "z",
  top = true,
  bottom = false,
  materials?: BlockFaceMaterials,
): CellPanel {
  return { id, rect, bottomY, topY, sides, axis, top, bottom, materials };
}

/** Whether a published field lies wholly on one panel's outward face. */
function fieldFitsPanel(field: PreparedCellField, panel: CellPanel): boolean {
  const alongX = field.orientation === "front" || field.orientation === "rear";
  const low = Math.min(field.minU, field.maxU);
  const high = Math.max(field.minU, field.maxU);
  const from = alongX ? panel.rect.minX : panel.rect.minZ;
  const to = alongX ? panel.rect.maxX : panel.rect.maxZ;

  return low >= from - EPS
    && high <= to + EPS
    && field.minV >= panel.bottomY - EPS
    && field.maxV <= panel.topY + EPS;
}

function addPanelBlock(builder: SolidBuilder, panel: CellPanel): void {
  const bottom = rectCorners(panel.rect).map((point) => ({
    x: point.x,
    y: panel.bottomY,
    z: point.z,
  }));
  const top = rectCorners(panel.rect).map((point) => ({
    x: point.x,
    y: panel.topY,
    z: point.z,
  }));
  const fields = panel.fields ?? [];
  const outward = fields.length > 0
    ? PANEL_SIDE_RING.indexOf(fields[0]!.orientation)
    : -1;

  builder.addBlock(
    { bottom, top },
    {
      // The prepared elevation is drawn below, split into its border and its
      // field, so the block itself must not also cover that side.
      sides: panel.sides.map(
        (shown, side) => shown && side !== outward,
      ) as unknown as CellPanel["sides"],
      top: panel.top,
      bottom: panel.bottom,
      materials: panel.materials,
    },
  );

  if (fields.length > 0 && outward >= 0) {
    addFramedFace(
      builder,
      {
        id: panel.id,
        label: "wall",
        bottomY: panel.bottomY,
        topY: panel.topY,
        lower: panel.rect,
        upper: panel.rect,
        overhang: 0,
      },
      fields[0]!.orientation,
      // A cell wall is plumb, so both edges are vertical and one sample does
      // for the whole height.
      fields.map((field) => ({
        face: field.orientation,
        left: [field.minU, field.minU] as const,
        right: [field.maxU, field.maxU] as const,
        relief: field.relief,
        textureScale: field.textureScale,
        bottomY: field.minV,
        topY: field.maxV,
        rowBottomY: panel.bottomY,
        rowTopY: panel.topY,
      })),
    );
  }
}

/** Rect side order, matching `CellPanel.sides`: left, front, right, rear. */
const PANEL_SIDE_RING: readonly HorizontalOrientation[] = [
  "sideNegativeU",
  "front",
  "sidePositiveU",
  "rear",
];

function courseBoundaries(
  cell: CellRecord,
  rule: MasonryRule,
  seed: number,
  panels: readonly CellPanel[],
): number[] {
  const courses = divideCourses(
    cell.height,
    rule,
    masonrySeed(seed, cell.id, "courses"),
  );
  const boundaries = [cell.bottomY];

  for (const course of courses) {
    boundaries.push(cell.bottomY + course.bottom + course.height);
  }
  for (const panel of panels) {
    boundaries.push(panel.bottomY, panel.topY);
  }

  return [...new Set(boundaries.map((value) => value.toFixed(9)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function layPanelStones(
  builder: SolidBuilder,
  panel: CellPanel,
  rule: MasonryRule,
  seed: number,
  boundaries: readonly number[],
): void {
  const spans = boundaries
    .filter((value) =>
      value >= panel.bottomY - EPS && value <= panel.topY + EPS)
    .map((value) => Math.min(Math.max(value, panel.bottomY), panel.topY));
  const unique = [...new Set(spans.map((value) => value.toFixed(9)))].map(Number);
  const runLength = panel.axis === "x"
    ? panel.rect.maxX - panel.rect.minX
    : panel.rect.maxZ - panel.rect.minZ;

  for (let course = 0; course < unique.length - 1; course += 1) {
    const bottomY = unique[course]!;
    const topY = unique[course + 1]!;

    if (topY <= bottomY + EPS) {
      continue;
    }

    const widths = divideRun(
      runLength,
      rule,
      masonrySeed(seed, panel.id, `course_${course}`),
    );
    let cursor = 0;

    for (let stone = 0; stone < widths.length; stone += 1) {
      const width = widths[stone] ?? 0;
      const first = stone === 0;
      const last = stone === widths.length - 1;
      // The initial cell wall is one structural wythe. Opening a plan gap
      // through a full-depth stone would make every perpend a sightline through
      // the room wall; until bonded inner/outer wythes arrive, stones meet dry
      // and their separate outer quads retain the course division.
      const from = cursor;
      const to = cursor + width;
      cursor += width;

      if (to <= from + EPS) {
        continue;
      }

      const rect: Rect = panel.axis === "x"
        ? {
          ...panel.rect,
          minX: panel.rect.minX + from,
          maxX: panel.rect.minX + to,
        }
        : {
          ...panel.rect,
          minZ: panel.rect.minZ + from,
          maxZ: panel.rect.minZ + to,
        };
      const sides = stoneSides(panel, first, last);
      const piece: CellPanel = {
        ...panel,
        rect,
        bottomY,
        topY,
        sides,
        top: panel.top && course === unique.length - 2,
        bottom: panel.bottom && course === 0,
      };
      addPanelBlock(builder, piece);
    }
  }
}

function stoneSides(
  panel: CellPanel,
  first: boolean,
  last: boolean,
): SideFlags {
  const [left, front, right, rear] = panel.sides;

  if (panel.axis === "x") {
    return [
      first ? left : false,
      front,
      last ? right : false,
      rear,
    ];
  }

  return [
    left,
    last ? front : false,
    right,
    first ? rear : false,
  ];
}

function addHorizontalRing(
  builder: SolidBuilder,
  outer: Rect,
  covered: Rect,
  y: number,
): void {
  const pieces: readonly Rect[] = [
    {
      minX: outer.minX, maxX: covered.minX,
      minZ: outer.minZ, maxZ: outer.maxZ,
    },
    {
      minX: covered.maxX, maxX: outer.maxX,
      minZ: outer.minZ, maxZ: outer.maxZ,
    },
    {
      minX: covered.minX, maxX: covered.maxX,
      minZ: outer.minZ, maxZ: covered.minZ,
    },
    {
      minX: covered.minX, maxX: covered.maxX,
      minZ: covered.maxZ, maxZ: outer.maxZ,
    },
  ];

  for (const piece of pieces) {
    addHorizontalRect(builder, piece, y);
  }
}

function addHorizontalRect(
  builder: SolidBuilder,
  rect: Rect,
  y: number,
): void {
  if (!rectIsValid(rect)) {
    return;
  }

  const ring = rectCorners(rect).map((point) => ({ ...point, y }));
  builder.addBlock(
    { bottom: ring, top: ring },
    { sides: [false, false, false, false], top: true, bottom: false },
  );
}

function pointInsideRect(
  point: { readonly x: number; readonly z: number },
  rect: Rect,
): boolean {
  return point.x >= rect.minX - EPS
    && point.x <= rect.maxX + EPS
    && point.z >= rect.minZ - EPS
    && point.z <= rect.maxZ + EPS;
}

function faceNormalY(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
): number {
  const a = face[0]!;
  const b = face[1]!;
  const c = face[2]!;
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const y = ab.z * ac.x - ab.x * ac.z;
  const length = Math.hypot(
    ab.y * ac.z - ab.z * ac.y,
    y,
    ab.x * ac.y - ab.y * ac.x,
  );

  return length > EPS ? y / length : 0;
}
