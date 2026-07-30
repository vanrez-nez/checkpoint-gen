import { finalizeGeometry, type FinalizedGeometry, type Point2 } from "./finalize";
import type { MaterialSlot } from "./part";
import { createRandom, hashSeed, randomRange } from "./random";
import {
  DEFAULT_FACE_SHADING,
  FLAT_FACE_SHADING,
} from "./shading";

// The masonry builder was the first geometry code here, so the seeded-random and
// buffer-finalizing helpers grew inside it. They are now shared with every other
// builder and live in ./random and ./finalize; these re-exports keep the older
// import sites working.
export { createBoxProjectedUvs, type Point2 } from "./finalize";
export { createRandom, hashSeed, normalizedSpans, randomRange } from "./random";

/**
 * Pulls a stone's outline in off its cell and lets its corners wander.
 *
 * The shortest edge of the stone's undisturbed cell sets the scale, and each
 * plan corner moves independently by up to `cell scale × displacement` on X
 * and Z. The gap is applied separately as a half-gap inset before that
 * movement. Mass uses the same scale on its local surface-normal and
 * along-course axes while sharing the latter at neighboring joint ends.
 *
 * That is the Circular plate's established behavior. Keeping the jitter itself
 * separate lets radial cells perform their exact polar gap inset and then use
 * the same displacement operation as rectangular entry and Mass cells.
 */
export function insetAndJitter(
  points: readonly Point2[],
  gap: number,
  displacement: number,
  random: () => number,
): Point2[] {
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  center.x /= points.length;
  center.z /= points.length;

  const inset = points.map((point) => {
    const dx = point.x - center.x;
    const dz = point.z - center.z;
    const distance = Math.hypot(dx, dz);
    const amount = Math.min(gap * 0.5, distance * 0.2);
    const scale = distance > 0 ? (distance - amount) / distance : 1;

    return {
      x: center.x + dx * scale,
      z: center.z + dz * scale,
    };
  });

  return jitterPoints(
    inset,
    minimumEdgeLength(points),
    displacement,
    random,
  );
}

/** Applies the Circular plate's size-relative X/Z corner displacement. */
export function jitterPoints(
  points: readonly Point2[],
  cellScale: number,
  displacement: number,
  random: () => number,
): Point2[] {
  const jitter = displacementDistance(cellScale, displacement);

  return points.map((point) => ({
    x: point.x + randomRange(random, -jitter, jitter),
    z: point.z + randomRange(random, -jitter, jitter),
  }));
}

/** Circular's displacement rule, shared by every stone layout. */
export function displacementDistance(
  cellScale: number,
  displacement: number,
): number {
  return Math.max(cellScale, 0) * Math.max(displacement, 0);
}

export interface StoneDetailConfig {
  bevelEnabled: boolean;
  bevelWidthRatio: number;
  bevelDepthRatio: number;
  bevelVariation: number;
  seed: number;
}

export interface StoneGeometryResult extends FinalizedGeometry {
  stoneCount: number;
}

type InsetPolygon = {
  points: Point2[];
  widths: number[];
};

export class StoneGeometryBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly ambientOcclusion: number[] = [];
  readonly bakedShadow: number[] = [];
  stoneCount = 0;

  constructor(private readonly config: StoneDetailConfig) {}

  addStone(
    points: readonly Point2[],
    bottomY: number,
    topY: readonly number[],
    bevelReferenceHeight: number,
  ): void {
    if (points.length < 3 || points.length !== topY.length) {
      throw new Error("A stone requires matching polygon and height data.");
    }

    const shouldReverse = signedArea(points) > 0;
    const polygon = shouldReverse ? [...points].reverse() : [...points];
    const heights = shouldReverse ? [...topY].reverse() : [...topY];

    if (this.config.bevelEnabled) {
      this.addChamferedStone(polygon, bottomY, heights, bevelReferenceHeight);
    } else {
      this.addHardStone(polygon, bottomY, heights);
    }

    this.stoneCount += 1;
  }

  private addHardStone(
    polygon: readonly Point2[],
    bottomY: number,
    heights: readonly number[],
  ): void {
    const topStart = this.positions.length / 3;

    for (let index = 0; index < polygon.length; index += 1) {
      const point = polygon[index];
      const height = heights[index];

      if (point && height !== undefined) {
        this.positions.push(point.x, height, point.z);
        this.ambientOcclusion.push(FLAT_FACE_SHADING.topAo);
        this.bakedShadow.push(FLAT_FACE_SHADING.topShadow);
      }
    }

    for (let index = 1; index < polygon.length - 1; index += 1) {
      this.indices.push(topStart, topStart + index, topStart + index + 1);
    }

    for (let index = 0; index < polygon.length; index += 1) {
      const nextIndex = (index + 1) % polygon.length;
      const current = polygon[index];
      const next = polygon[nextIndex];
      const currentHeight = heights[index];
      const nextHeight = heights[nextIndex];

      if (!current || !next || currentHeight === undefined || nextHeight === undefined) {
        continue;
      }

      const sideStart = this.positions.length / 3;
      this.positions.push(
        current.x, bottomY, current.z,
        next.x, bottomY, next.z,
        next.x, nextHeight, next.z,
        current.x, currentHeight, current.z,
      );
      this.ambientOcclusion.push(
        DEFAULT_FACE_SHADING.bottomAo,
        DEFAULT_FACE_SHADING.bottomAo,
        DEFAULT_FACE_SHADING.topAo,
        DEFAULT_FACE_SHADING.topAo,
      );
      this.bakedShadow.push(
        DEFAULT_FACE_SHADING.bottomShadow,
        DEFAULT_FACE_SHADING.bottomShadow,
        DEFAULT_FACE_SHADING.topShadow,
        DEFAULT_FACE_SHADING.topShadow,
      );
      this.indices.push(
        sideStart, sideStart + 1, sideStart + 2,
        sideStart, sideStart + 2, sideStart + 3,
      );
    }
  }

  private addChamferedStone(
    polygon: readonly Point2[],
    bottomY: number,
    heights: readonly number[],
    bevelReferenceHeight: number,
  ): void {
    const random = createRandom(hashSeed(this.config.seed, `bevel-${this.stoneCount}`));
    const requestedWidths = polygon.map((point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      const edgeLength = next
        ? Math.hypot(next.x - point.x, next.z - point.z)
        : 0;
      const widthVariation = randomRange(
        random,
        1 - this.config.bevelVariation,
        1 + this.config.bevelVariation,
      );

      return Math.min(
        edgeLength * this.config.bevelWidthRatio * widthVariation,
        edgeLength * 0.3,
        Math.max(bevelReferenceHeight, 0) * 1.5,
      );
    });
    const depthVariation = randomRange(
      random,
      1 - this.config.bevelVariation,
      1 + this.config.bevelVariation,
    );
    const inset = createSafeInset(polygon, requestedWidths);

    if (!inset) {
      this.addHardStone(polygon, bottomY, heights);
      return;
    }

    const availableHeight = Math.min(
      ...heights.map((height) => Math.max(height - bottomY, 0)),
    );
    const depth = Math.min(
      Math.max(bevelReferenceHeight, 0) * this.config.bevelDepthRatio * depthVariation,
      availableHeight * 0.45,
      Math.min(...inset.widths) * 1.25,
    );

    if (depth <= 1e-6) {
      this.addHardStone(polygon, bottomY, heights);
      return;
    }

    const outerRing: number[] = [];
    const innerRing: number[] = [];

    for (let index = 0; index < polygon.length; index += 1) {
      const point = polygon[index];
      const insetPoint = inset.points[index];
      const height = heights[index];

      if (!point || !insetPoint || height === undefined) {
        continue;
      }

      outerRing.push(this.pushVertex(
        point.x,
        height - depth,
        point.z,
        DEFAULT_FACE_SHADING.topAo,
        DEFAULT_FACE_SHADING.topShadow,
      ));
      innerRing.push(this.pushVertex(
        insetPoint.x,
        height,
        insetPoint.z,
        FLAT_FACE_SHADING.topAo,
        FLAT_FACE_SHADING.topShadow,
      ));
    }

    for (let index = 0; index < polygon.length; index += 1) {
      const nextIndex = (index + 1) % polygon.length;
      const outerCurrent = outerRing[index];
      const outerNext = outerRing[nextIndex];
      const innerCurrent = innerRing[index];
      const innerNext = innerRing[nextIndex];

      if (
        outerCurrent === undefined
        || outerNext === undefined
        || innerCurrent === undefined
        || innerNext === undefined
      ) {
        continue;
      }

      this.indices.push(
        outerCurrent, outerNext, innerNext,
        outerCurrent, innerNext, innerCurrent,
      );
    }

    const topStart = this.positions.length / 3;

    for (let index = 0; index < inset.points.length; index += 1) {
      const point = inset.points[index];
      const height = heights[index];

      if (point && height !== undefined) {
        this.pushVertex(
          point.x,
          height,
          point.z,
          FLAT_FACE_SHADING.topAo,
          FLAT_FACE_SHADING.topShadow,
        );
      }
    }

    for (let index = 1; index < polygon.length - 1; index += 1) {
      this.indices.push(topStart, topStart + index, topStart + index + 1);
    }

    for (let index = 0; index < polygon.length; index += 1) {
      const nextIndex = (index + 1) % polygon.length;
      const current = polygon[index];
      const next = polygon[nextIndex];
      const currentShoulder = outerRing[index];
      const nextShoulder = outerRing[nextIndex];

      if (!current || !next || currentShoulder === undefined || nextShoulder === undefined) {
        continue;
      }

      const sideStart = this.positions.length / 3;
      this.pushVertex(
        current.x,
        bottomY,
        current.z,
        DEFAULT_FACE_SHADING.bottomAo,
        DEFAULT_FACE_SHADING.bottomShadow,
      );
      this.pushVertex(
        next.x,
        bottomY,
        next.z,
        DEFAULT_FACE_SHADING.bottomAo,
        DEFAULT_FACE_SHADING.bottomShadow,
      );
      this.copyVertex(nextShoulder);
      this.copyVertex(currentShoulder);
      this.indices.push(
        sideStart, sideStart + 1, sideStart + 2,
        sideStart, sideStart + 2, sideStart + 3,
      );
    }
  }

  private pushVertex(
    x: number,
    y: number,
    z: number,
    ambientOcclusion: number,
    bakedShadow: number,
  ): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.ambientOcclusion.push(ambientOcclusion);
    this.bakedShadow.push(bakedShadow);
    return index;
  }

  private copyVertex(index: number): number {
    const offset = index * 3;
    return this.pushVertex(
      this.positions[offset] ?? 0,
      this.positions[offset + 1] ?? 0,
      this.positions[offset + 2] ?? 0,
      this.ambientOcclusion[index] ?? 1,
      this.bakedShadow[index] ?? 1,
    );
  }
}

export function finalizeStoneGeometry(
  builder: StoneGeometryBuilder,
  fallbackSlot: MaterialSlot = "stone",
): StoneGeometryResult {
  return {
    ...finalizeGeometry(builder, fallbackSlot),
    stoneCount: builder.stoneCount,
  };
}

function signedArea(points: readonly Point2[]): number {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current && next) {
      area += current.x * next.z - next.x * current.z;
    }
  }

  return area * 0.5;
}

function minimumEdgeLength(points: readonly Point2[]): number {
  let minimum = Number.POSITIVE_INFINITY;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];

    if (current && next) {
      minimum = Math.min(minimum, Math.hypot(next.x - current.x, next.z - current.z));
    }
  }

  return minimum;
}

function createSafeInset(
  polygon: readonly Point2[],
  requestedWidths: readonly number[],
): InsetPolygon | null {
  if (
    requestedWidths.length !== polygon.length
    || requestedWidths.some((width) => !Number.isFinite(width) || width <= 1e-6)
  ) {
    return null;
  }

  let scale = 1;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const widths = requestedWidths.map((width) => width * scale);
    const points = offsetPolygon(polygon, widths);

    if (points && isSafeInset(polygon, points, widths)) {
      return { points, widths };
    }

    scale *= 0.5;
  }

  return null;
}

function offsetPolygon(
  polygon: readonly Point2[],
  widths: readonly number[],
): Point2[] | null {
  const inset: Point2[] = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];

    if (!previous || !current || !next) {
      return null;
    }

    const previousDirection = {
      x: current.x - previous.x,
      z: current.z - previous.z,
    };
    const currentDirection = {
      x: next.x - current.x,
      z: next.z - current.z,
    };
    const previousLength = Math.hypot(previousDirection.x, previousDirection.z);
    const currentLength = Math.hypot(currentDirection.x, currentDirection.z);
    const previousWidth = widths[(index - 1 + widths.length) % widths.length];
    const currentWidth = widths[index];

    if (
      previousLength <= 1e-8
      || currentLength <= 1e-8
      || previousWidth === undefined
      || currentWidth === undefined
    ) {
      return null;
    }

    const previousLine = {
      x: previous.x + (previousDirection.z / previousLength) * previousWidth,
      z: previous.z - (previousDirection.x / previousLength) * previousWidth,
    };
    const currentLine = {
      x: current.x + (currentDirection.z / currentLength) * currentWidth,
      z: current.z - (currentDirection.x / currentLength) * currentWidth,
    };
    const intersection = lineIntersection(
      previousLine,
      previousDirection,
      currentLine,
      currentDirection,
    );

    if (!intersection) {
      return null;
    }

    inset.push(intersection);
  }

  return inset;
}

function lineIntersection(
  a: Point2,
  aDirection: Point2,
  b: Point2,
  bDirection: Point2,
): Point2 | null {
  const denominator = cross2(aDirection, bDirection);

  if (Math.abs(denominator) <= 1e-8) {
    return null;
  }

  const difference = { x: b.x - a.x, z: b.z - a.z };
  const distance = cross2(difference, bDirection) / denominator;
  const point = {
    x: a.x + aDirection.x * distance,
    z: a.z + aDirection.z * distance,
  };

  return Number.isFinite(point.x) && Number.isFinite(point.z) ? point : null;
}

function isSafeInset(
  polygon: readonly Point2[],
  inset: readonly Point2[],
  widths: readonly number[],
): boolean {
  const originalArea = Math.abs(signedArea(polygon));
  const insetArea = signedArea(inset);
  const tolerance = Math.max(minimumEdgeLength(polygon) * 1e-7, 1e-9);

  if (
    inset.length !== polygon.length
    || insetArea >= -tolerance
    || Math.abs(insetArea) >= originalArea - tolerance
    || Math.abs(insetArea) <= originalArea * 0.05
  ) {
    return false;
  }

  for (let index = 0; index < inset.length; index += 1) {
    const previous = inset[(index - 1 + inset.length) % inset.length];
    const current = inset[index];
    const next = inset[(index + 1) % inset.length];
    const source = polygon[index];

    if (!previous || !current || !next || !source) {
      return false;
    }

    const incoming = { x: current.x - previous.x, z: current.z - previous.z };
    const outgoing = { x: next.x - current.x, z: next.z - current.z };
    const miterLength = Math.hypot(current.x - source.x, current.z - source.z);
    const previousWidth = widths[(index - 1 + widths.length) % widths.length];
    const currentWidth = widths[index];

    if (
      previousWidth === undefined
      || currentWidth === undefined
      || Math.hypot(incoming.x, incoming.z) <= tolerance
      || cross2(incoming, outgoing) > tolerance
      || miterLength > Math.max(previousWidth, currentWidth) * 4
    ) {
      return false;
    }

    for (let edge = 0; edge < polygon.length; edge += 1) {
      const edgeStart = polygon[edge];
      const edgeEnd = polygon[(edge + 1) % polygon.length];

      if (!edgeStart || !edgeEnd) {
        return false;
      }

      const edgeDirection = {
        x: edgeEnd.x - edgeStart.x,
        z: edgeEnd.z - edgeStart.z,
      };
      const toPoint = {
        x: current.x - edgeStart.x,
        z: current.z - edgeStart.z,
      };

      if (cross2(edgeDirection, toPoint) > tolerance) {
        return false;
      }
    }
  }

  return true;
}

function cross2(a: Point2, b: Point2): number {
  return a.x * b.z - a.z * b.x;
}
