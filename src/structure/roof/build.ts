import type { SolidBuilder } from "../../geometry/solid-builder";
import { rectCorners, rectIsValid, type Rect } from "../kernel/frame";
import type { RoofRecord } from "../kernel/graph";

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
): void {
  const topIsExposed = roof.cornice === null;
  const slabProjects = !sameRect(roof.slabFootprint, roof.bearingFootprint);

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
    );
  }

  if (!roof.cornice) {
    return;
  }

  // The supported centre and projected ring are separate so the molding's
  // underside exists only where it actually oversails the slab.
  addRectBlock(
    builder,
    roof.slabFootprint,
    roof.cornice.bottomY,
    roof.cornice.topY,
    [false, false, false, false],
    true,
    false,
  );
  addRingBlocks(
    builder,
    roof.cornice.outline,
    roof.slabFootprint,
    roof.cornice.bottomY,
    roof.cornice.topY,
    true,
    true,
    true,
  );
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

  return face.every((point) => pointInsideRect(point, roof.bearingFootprint));
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
    addRectBlock(
      builder,
      piece.rect,
      bottomY,
      topY,
      piece.sides,
      showTop,
      showBottom,
    );
  }
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
