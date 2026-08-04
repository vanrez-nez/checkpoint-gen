import type { SolidBuilder } from "../../geometry/solid-builder";
import {
  rectCorners,
  rectIsValid,
  type HorizontalOrientation,
  type Rect,
} from "../kernel/frame";
import type { RoofRecord } from "../kernel/graph";
import type { Patch } from "../kernel/patch";
import { addFramedFace, type PreparedField } from "../mass/shell";
import { fieldForPiece, preparedRoofFields } from "./slots";

const EPS = 1e-9;
type SideFlags = readonly [boolean, boolean, boolean, boolean];

/**
 * Builds a flat roof from rectangular plan pieces. The pieces exist only to
 * assign exposed undersides correctly: room ceiling and overhangs face down,
 * while the wall-bearing ring has no buried contact face.
 */
export function buildRoof(
  builder: SolidBuilder,
  roof: RoofRecord,
  patches: ReadonlyMap<string, Patch> = new Map(),
): void {
  const topIsExposed = roof.cornice === null;
  const slabProjects = !sameRect(roof.slabFootprint, roof.bearingFootprint);
  // A reserved fascia is drawn as its border plus its field, so the border it
  // was measured against is a face and not a rectangle nobody answers for.
  const { slab: slabFields, cornice: corniceFields } = preparedRoofFields(
    roof,
    patches,
  );

  addRectBlock(
    builder,
    roof.ceilingFootprint,
    roof.bottomY,
    roof.slabTopY,
    [false, false, false, false],
    topIsExposed,
    true,
  );
  addRingBlocks(
    builder,
    roof.bearingFootprint,
    roof.ceilingFootprint,
    roof.bottomY,
    roof.slabTopY,
    !slabProjects,
    topIsExposed,
    false,
    slabProjects ? undefined : slabFields,
  );
  if (slabProjects) {
    addRingBlocks(
      builder,
      roof.slabFootprint,
      roof.bearingFootprint,
      roof.bottomY,
      roof.slabTopY,
      true,
      topIsExposed,
      true,
      slabFields,
    );
  }

  const { cornice } = roof;

  if (!cornice) {
    return;
  }

  builder.withMaterial("cornice", () => {
    // The supported centre and projected ring are separate so the molding's
    // underside exists only where it actually oversails the slab.
    addRectBlock(
      builder,
      roof.slabFootprint,
      cornice.bottomY,
      cornice.topY,
      [false, false, false, false],
      true,
      false,
    );
    addRingBlocks(
      builder,
      cornice.outline,
      roof.slabFootprint,
      cornice.bottomY,
      cornice.topY,
      true,
      true,
      true,
      corniceFields,
    );
  });
}

/** True for an upward wall-crown face wholly occupied by the roof bearing. */
export function faceIsCoveredByRoof(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  roof: RoofRecord,
): boolean {
  if (
    face.length !== 4
    || face.some((point) => Math.abs(point.y - roof.bottomY) > EPS)
    || faceNormalY(face) < 0.99
  ) {
    return false;
  }

  return [roof.bearingFootprint].some((rect) =>
    face.every((point) => pointInsideRect(point, rect)));
}

function addRingBlocks(
  builder: SolidBuilder,
  outer: Rect,
  inner: Rect,
  bottomY: number,
  topY: number,
  showOuterSides: boolean,
  showTop: boolean,
  showBottom: boolean,
  fields?: ReadonlyMap<HorizontalOrientation, PreparedField>,
): void {
  const pieces: readonly {
    readonly rect: Rect;
    readonly sides: SideFlags;
  }[] = [
    {
      rect: {
        minX: outer.minX,
        maxX: outer.maxX,
        minZ: inner.maxZ,
        maxZ: outer.maxZ,
      },
      sides: showOuterSides
        ? [true, true, true, false]
        : [false, false, false, false],
    },
    {
      rect: {
        minX: outer.minX,
        maxX: outer.maxX,
        minZ: outer.minZ,
        maxZ: inner.minZ,
      },
      sides: showOuterSides
        ? [true, false, true, true]
        : [false, false, false, false],
    },
    {
      rect: {
        minX: outer.minX,
        maxX: inner.minX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      },
      sides: showOuterSides
        ? [true, false, false, false]
        : [false, false, false, false],
    },
    {
      rect: {
        minX: inner.maxX,
        maxX: outer.maxX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      },
      sides: showOuterSides
        ? [false, false, true, false]
        : [false, false, false, false],
    },
  ];

  for (const piece of pieces) {
    const prepared = fields
      ? preparedSideOf(fields, piece.rect, piece.sides)
      : null;
    addRectBlock(
      builder,
      piece.rect,
      bottomY,
      topY,
      prepared
        ? piece.sides.map(
          (shown, side) => shown && side !== prepared.side,
        ) as unknown as SideFlags
        : piece.sides,
      showTop,
      showBottom,
    );

    if (prepared) {
      addFramedFace(
        builder,
        {
          id: "fascia",
          label: "wall",
          bottomY,
          topY,
          lower: piece.rect,
          upper: piece.rect,
          overhang: 0,
        },
        prepared.orientation,
        [prepared.field],
      );
    }
  }
}

/** Rect side order, matching the flags above: left, front, right, rear. */
const SIDE_RING: readonly HorizontalOrientation[] = [
  "sideNegativeU",
  "front",
  "sidePositiveU",
  "rear",
];

/**
 * The one outward side of a ring piece that carries a reserved field.
 *
 * A piece shows at most one fascia — the ring's front and rear pieces also show
 * their ends, but those are returns into the corner, not elevations.
 */
function preparedSideOf(
  fields: ReadonlyMap<HorizontalOrientation, PreparedField>,
  piece: Rect,
  sides: SideFlags,
): {
  readonly side: number;
  readonly orientation: HorizontalOrientation;
  readonly field: PreparedField;
} | null {
  for (const [side, orientation] of SIDE_RING.entries()) {
    if (!sides[side] || !fields.has(orientation)) {
      continue;
    }

    const field = fieldForPiece(fields, orientation, piece);

    if (field) {
      return { side, orientation, field };
    }
  }

  return null;
}

function addRectBlock(
  builder: SolidBuilder,
  rect: Rect,
  bottomY: number,
  topY: number,
  sides: SideFlags,
  top: boolean,
  bottom: boolean,
): void {
  if (!rectIsValid(rect) || topY <= bottomY + EPS) {
    return;
  }

  const bottomRing = rectCorners(rect).map((point) => ({
    x: point.x,
    y: bottomY,
    z: point.z,
  }));
  const topRing = rectCorners(rect).map((point) => ({
    x: point.x,
    y: topY,
    z: point.z,
  }));

  builder.addBlock(
    { bottom: bottomRing, top: topRing },
    { sides, top, bottom },
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
  const a = face[0];
  const b = face[1];
  const c = face[2];

  if (!a || !b || !c) {
    return 0;
  }

  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const normalY = ab.z * ac.x - ab.x * ac.z;
  const length = Math.hypot(
    ab.y * ac.z - ab.z * ac.y,
    normalY,
    ab.x * ac.y - ab.y * ac.x,
  );

  return length <= EPS ? 0 : normalY / length;
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.minX - b.minX) <= EPS
    && Math.abs(a.maxX - b.maxX) <= EPS
    && Math.abs(a.minZ - b.minZ) <= EPS
    && Math.abs(a.maxZ - b.maxZ) <= EPS;
}
