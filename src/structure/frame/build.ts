import type { MaterialSlot } from "../../geometry/part";
import type { SolidBuilder, Vertex3 } from "../../geometry/solid-builder";
import { rectCorners, rectDepth, rectWidth, type Rect } from "../kernel/frame";
import { divideCourses, divideRun, masonrySeed, type MasonryRule } from "../kernel/masonry";
import type { FrameMemberRecord, FrameRecord, FrameSupportSectionRecord } from "./types";

const EPS = 1e-9;

/**
 * Draws every Frame constituent through the structure-wide block primitive.
 * With masonry enabled the same resolved volumes are divided into courses and
 * stones; no alternate support generator or profile mesh is involved.
 */
export function buildFrame(
  builder: SolidBuilder,
  frame: FrameRecord,
  masonry: MasonryRule | null,
  seed: number,
): void {
  const stylobates = frame.members.filter((member) => member.kind === "stylobate");
  const lintels = frame.members.filter((member) => member.kind === "lintel");
  const overhead = frame.members.filter((member) =>
    member.kind === "architrave"
    || member.kind === "frieze"
    || member.kind === "cornice");

  for (const member of stylobates) {
    buildMember(
      builder,
      member,
      masonry,
      seed,
      frame.supports.map((support) => support.footprint),
    );
  }
  for (const support of frame.supports) {
    builder.withMaterial("pillar", () => {
      for (let index = 0; index < support.sections.length; index += 1) {
        const section = support.sections[index];
        if (!section) {
          continue;
        }
        buildSupportSection(
          builder,
          section,
          support.sections[index + 1] ?? null,
          masonry,
          masonrySeed(seed, support.id, section.kind),
        );
      }
    });
  }
  for (const member of [...lintels, ...overhead]) {
    buildMember(builder, member, masonry, seed);
  }

  // Remove contact crowns only after every constituent exists. A support face
  // may be carried jointly by the lintels on its two sides, so union coverage
  // is evaluated across all footprints at that elevation.
  const contacts = [
    ...frame.supports.flatMap((support) => support.sections.map((section) => ({
      y: section.bottomY,
      rect: section.footprint,
    }))),
    ...frame.members.map((member) => ({ y: member.bottomY, rect: member.rect })),
  ];
  builder.cullFaces((face) => faceIsCoveredByFrameContact(face, contacts));
  const volumes = [
    ...frame.supports.flatMap((support) => support.sections.map((section) => ({
      rect: section.footprint,
      bottomY: section.bottomY,
      topY: section.topY,
    }))),
    ...frame.members.map((member) => ({
      rect: member.rect,
      bottomY: member.bottomY,
      topY: member.topY,
    })),
  ];
  builder.cullFaces((face) => faceIsInternalFrameFace(face, volumes));
}

/** True for an upward quad wholly carried by one or more Frame footprints. */
export function faceIsCoveredByFrame(
  face: readonly Vertex3[],
  frame: FrameRecord,
): boolean {
  const contacts = [
    ...frame.members.filter((member) => member.kind === "stylobate").map((member) => ({
      y: frame.bottomY,
      rect: member.rect,
    })),
    ...frame.supports.map((support) => ({ y: frame.bottomY, rect: support.footprint })),
  ];
  return faceIsCoveredByFrameContact(face, contacts);
}

function buildSupportSection(
  builder: SolidBuilder,
  section: FrameSupportSectionRecord,
  next: FrameSupportSectionRecord | null,
  masonry: MasonryRule | null,
  seed: number,
): void {
  const partitions = partitionRect(section.footprint, next ? [next.footprint] : []);
  if (!masonry) {
    for (const partition of partitions) {
      addRectBlock(builder, partition, section.bottomY, section.topY, true);
    }
    return;
  }

  const courses = divideCourses(section.topY - section.bottomY, masonry, seed);
  for (const course of courses) {
    const bottomY = section.bottomY + course.bottom;
    const topY = bottomY + course.height;
    for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
      const partition = partitions[partitionIndex]!;
      const xSpans = divideRun(
        rectWidth(partition),
        masonry,
        masonrySeed(seed, `course_${course.index}_${partitionIndex}`, "x"),
      );
      const zSpans = divideRun(
        rectDepth(partition),
        masonry,
        masonrySeed(seed, `course_${course.index}_${partitionIndex}`, "z"),
      );
      let minX = partition.minX;
      for (let xIndex = 0; xIndex < xSpans.length; xIndex += 1) {
        const xSpan = xSpans[xIndex] ?? 0;
        let minZ = partition.minZ;
        for (let zIndex = 0; zIndex < zSpans.length; zIndex += 1) {
          const zSpan = zSpans[zIndex] ?? 0;
          const rect = insetStoneRect(
            {
              minX,
              maxX: minX + xSpan,
              minZ,
              maxZ: minZ + zSpan,
            },
            masonry.gap,
          );
          addRectBlock(
            builder,
            rect,
            bottomY,
            topY,
            course.index === courses.length - 1,
          );
          minZ += zSpan;
        }
        minX += xSpan;
      }
    }
  }
}

function buildMember(
  builder: SolidBuilder,
  member: FrameMemberRecord,
  masonry: MasonryRule | null,
  seed: number,
  partitionRects: readonly Rect[] = [],
): void {
  builder.withMaterial(member.materialRole as MaterialSlot, () => {
    const cells = partitionRect(member.rect, partitionRects);
    if (!masonry) {
      for (const cell of cells) {
        addRectBlock(builder, cell, member.bottomY, member.topY, true);
      }
      return;
    }

    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const partition = cells[cellIndex]!;
      const horizontal = rectWidth(partition) >= rectDepth(partition);
      const run = horizontal ? rectWidth(partition) : rectDepth(partition);
      const spans = divideRun(
        run,
        masonry,
        masonrySeed(seed, member.id, `run_${cellIndex}`),
      );
      let cursor = horizontal ? partition.minX : partition.minZ;
      for (const span of spans) {
        const cell: Rect = horizontal
          ? { ...partition, minX: cursor, maxX: cursor + span }
          : { ...partition, minZ: cursor, maxZ: cursor + span };
        addRectBlock(
          builder,
          insetStoneRectAlongRun(cell, masonry.gap, horizontal),
          member.bottomY,
          member.topY,
          true,
        );
        cursor += span;
      }
    }
  });
}

function partitionRect(rect: Rect, cutters: readonly Rect[]): Rect[] {
  const xs = new Set([rect.minX, rect.maxX]);
  const zs = new Set([rect.minZ, rect.maxZ]);
  for (const cutter of cutters) {
    if (
      cutter.maxX <= rect.minX + EPS
      || cutter.minX >= rect.maxX - EPS
      || cutter.maxZ <= rect.minZ + EPS
      || cutter.minZ >= rect.maxZ - EPS
    ) {
      continue;
    }
    xs.add(Math.max(rect.minX, cutter.minX));
    xs.add(Math.min(rect.maxX, cutter.maxX));
    zs.add(Math.max(rect.minZ, cutter.minZ));
    zs.add(Math.min(rect.maxZ, cutter.maxZ));
  }
  const xValues = [...xs].sort((a, b) => a - b);
  const zValues = [...zs].sort((a, b) => a - b);
  const cells: Rect[] = [];
  for (let x = 0; x < xValues.length - 1; x += 1) {
    for (let z = 0; z < zValues.length - 1; z += 1) {
      const cell = {
        minX: xValues[x]!,
        maxX: xValues[x + 1]!,
        minZ: zValues[z]!,
        maxZ: zValues[z + 1]!,
      };
      if (rectWidth(cell) > EPS && rectDepth(cell) > EPS) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

function addRectBlock(
  builder: SolidBuilder,
  rect: Rect,
  bottomY: number,
  topY: number,
  showTop: boolean,
): void {
  if (rectWidth(rect) <= EPS || rectDepth(rect) <= EPS || topY <= bottomY + EPS) {
    return;
  }
  builder.addBlock(
    {
      bottom: rectCorners(rect).map((point) => ({ ...point, y: bottomY })),
      top: rectCorners(rect).map((point) => ({ ...point, y: topY })),
    },
    { sides: [true, true, true, true], top: showTop, bottom: false },
  );
}

function faceIsCoveredByFrameContact(
  face: readonly Vertex3[],
  contacts: readonly { readonly y: number; readonly rect: Rect }[],
): boolean {
  if (face.length !== 4 || faceNormalY(face) < 0.99) {
    return false;
  }
  const y = face[0]?.y;
  if (y === undefined || face.some((point) => Math.abs(point.y - y) > EPS)) {
    return false;
  }
  const level = contacts.filter((contact) => Math.abs(contact.y - y) <= EPS);
  return level.length > 0 && face.every((point) =>
    level.some((contact) => pointInsideRect(point, contact.rect)));
}

function faceIsInternalFrameFace(
  face: readonly Vertex3[],
  volumes: readonly {
    readonly rect: Rect;
    readonly bottomY: number;
    readonly topY: number;
  }[],
): boolean {
  if (face.length !== 4) {
    return false;
  }
  const normal = faceNormal(face);
  if (Math.abs(normal.y) > 0.99) {
    return false;
  }
  const centre = {
    x: face.reduce((sum, point) => sum + point.x, 0) / face.length,
    y: face.reduce((sum, point) => sum + point.y, 0) / face.length,
    z: face.reduce((sum, point) => sum + point.z, 0) / face.length,
  };
  const probe = 1e-5;
  const negative = {
    x: centre.x - normal.x * probe,
    y: centre.y,
    z: centre.z - normal.z * probe,
  };
  const positive = {
    x: centre.x + normal.x * probe,
    y: centre.y,
    z: centre.z + normal.z * probe,
  };
  return volumes.some((volume) => pointInsideVolume(negative, volume))
    && volumes.some((volume) => pointInsideVolume(positive, volume));
}

function insetStoneRect(rect: Rect, gap: number): Rect {
  const xInset = Math.min(gap * 0.5, rectWidth(rect) * 0.2);
  const zInset = Math.min(gap * 0.5, rectDepth(rect) * 0.2);
  return {
    minX: rect.minX + xInset,
    maxX: rect.maxX - xInset,
    minZ: rect.minZ + zInset,
    maxZ: rect.maxZ - zInset,
  };
}

function insetStoneRectAlongRun(rect: Rect, gap: number, horizontal: boolean): Rect {
  const inset = Math.min(
    gap * 0.5,
    (horizontal ? rectWidth(rect) : rectDepth(rect)) * 0.2,
  );
  return horizontal
    ? { ...rect, minX: rect.minX + inset, maxX: rect.maxX - inset }
    : { ...rect, minZ: rect.minZ + inset, maxZ: rect.maxZ - inset };
}

function pointInsideRect(point: Vertex3, rect: Rect): boolean {
  return point.x >= rect.minX - EPS
    && point.x <= rect.maxX + EPS
    && point.z >= rect.minZ - EPS
    && point.z <= rect.maxZ + EPS;
}

function pointInsideVolume(
  point: Vertex3,
  volume: { readonly rect: Rect; readonly bottomY: number; readonly topY: number },
): boolean {
  return pointInsideRect(point, volume.rect)
    && point.y > volume.bottomY + EPS
    && point.y < volume.topY - EPS;
}

function faceNormal(face: readonly Vertex3[]): Vertex3 {
  const a = face[0];
  const b = face[1];
  const c = face[2];
  if (!a || !b || !c) {
    return { x: 0, y: 0, z: 0 };
  }
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const length = Math.hypot(cross.x, cross.y, cross.z);
  return length > EPS
    ? { x: cross.x / length, y: cross.y / length, z: cross.z / length }
    : { x: 0, y: 0, z: 0 };
}

function faceNormalY(face: readonly Vertex3[]): number {
  return faceNormal(face).y;
}
