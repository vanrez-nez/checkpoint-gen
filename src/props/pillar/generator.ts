import * as THREE from "three";
import {
  StoneGeometryBuilder,
  createRandom,
  finalizeStoneGeometry,
  hashSeed,
  normalizedSpans,
  randomRange,
  type Point2,
  type StoneDetailConfig,
  type StoneGeometryResult,
} from "../../geometry/stone-builder";

export interface PillarGeometryConfig extends StoneDetailConfig {
  height: number;
  shaftWidth: number;
  baseSteps: number;
  shaftCourses: number;
  shaftSubdivisions: number;
  stoneGapRatio: number;
  sizeVariation: number;
  displacement: number;
}

export type PillarGeometryResult = StoneGeometryResult;

type MasonryLayer = {
  bottomY: number;
  height: number;
  width: number;
  subdivisions: number;
  label: string;
  grounded?: boolean;
};

const BASE_HEIGHT_RATIO = 0.18;
const SHAFT_HEIGHT_RATIO = 0.64;
const NECK_HEIGHT_RATIO = 0.04;
const CORNICE_HEIGHT_RATIO = 0.04;
const CAP_HEIGHT_RATIO = 0.1;
const BASE_BOTTOM_WIDTH_RATIO = 1.65;
const BASE_TOP_WIDTH_RATIO = 1.15;
const SINGLE_BASE_WIDTH_RATIO = 1.4;
const NECK_WIDTH_RATIO = 1.05;
const CORNICE_WIDTH_RATIO = 1.35;
const CAP_WIDTH_RATIO = 1.45;

/**
 * Builds one pillar's masonry in local space, with the base sitting on y = 0.
 *
 * The fire bowl used to be merged in here as a second material group; it is now
 * a sibling part, so this returns ungrouped stone geometry and the composer is
 * the only thing that assigns material groups.
 */
export function createPillarGeometry(
  config: PillarGeometryConfig,
): PillarGeometryResult {
  validateConfig(config);

  const builder = new StoneGeometryBuilder(config);
  const layers = createLayers(config);

  for (const layer of layers) {
    addMasonryLayer(builder, config, layer);
  }

  return finalizeStoneGeometry(builder);
}

export function getPillarBaseWidth(
  config: Pick<PillarGeometryConfig, "shaftWidth" | "baseSteps">,
): number {
  return config.shaftWidth * (
    config.baseSteps === 1
      ? SINGLE_BASE_WIDTH_RATIO
      : BASE_BOTTOM_WIDTH_RATIO
  );
}

export function derivePillarSeed(seed: number, placementLabel: string): number {
  return hashSeed(seed, `pillar-${placementLabel}`);
}

function createLayers(config: PillarGeometryConfig): MasonryLayer[] {
  const layers: MasonryLayer[] = [];
  const targetBlockWidth = config.shaftWidth / config.shaftSubdivisions;
  const baseHeight = config.height * BASE_HEIGHT_RATIO;
  const baseStepHeight = baseHeight / config.baseSteps;

  for (let step = 0; step < config.baseSteps; step += 1) {
    const progress = config.baseSteps === 1 ? 0.5 : step / (config.baseSteps - 1);
    const widthRatio = config.baseSteps === 1
      ? SINGLE_BASE_WIDTH_RATIO
      : THREE.MathUtils.lerp(BASE_BOTTOM_WIDTH_RATIO, BASE_TOP_WIDTH_RATIO, progress);
    const width = config.shaftWidth * widthRatio;
    layers.push({
      bottomY: step * baseStepHeight,
      height: baseStepHeight,
      width,
      subdivisions: subdivisionsForWidth(width, targetBlockWidth),
      label: `base-${step}`,
      grounded: step === 0,
    });
  }

  const shaftBottom = baseHeight;
  const shaftHeight = config.height * SHAFT_HEIGHT_RATIO;
  const courseHeight = shaftHeight / config.shaftCourses;

  for (let course = 0; course < config.shaftCourses; course += 1) {
    layers.push({
      bottomY: shaftBottom + course * courseHeight,
      height: courseHeight,
      width: config.shaftWidth,
      subdivisions: config.shaftSubdivisions,
      label: `shaft-${course}`,
    });
  }

  const capitalBottom = shaftBottom + shaftHeight;
  const neckHeight = config.height * NECK_HEIGHT_RATIO;
  const corniceHeight = config.height * CORNICE_HEIGHT_RATIO;
  const capHeight = config.height * CAP_HEIGHT_RATIO;
  const neckWidth = config.shaftWidth * NECK_WIDTH_RATIO;
  const corniceWidth = config.shaftWidth * CORNICE_WIDTH_RATIO;
  const capWidth = config.shaftWidth * CAP_WIDTH_RATIO;

  layers.push({
    bottomY: capitalBottom,
    height: neckHeight,
    width: neckWidth,
    subdivisions: subdivisionsForWidth(neckWidth, targetBlockWidth),
    label: "capital-neck",
  });
  layers.push({
    bottomY: capitalBottom + neckHeight,
    height: corniceHeight,
    width: corniceWidth,
    subdivisions: subdivisionsForWidth(corniceWidth, targetBlockWidth),
    label: "capital-cornice",
  });
  layers.push({
    bottomY: capitalBottom + neckHeight + corniceHeight,
    height: capHeight,
    width: capWidth,
    subdivisions: subdivisionsForWidth(capWidth, targetBlockWidth),
    label: "capital-cap",
  });

  return layers;
}

function addMasonryLayer(
  builder: StoneGeometryBuilder,
  config: PillarGeometryConfig,
  layer: MasonryLayer,
): void {
  const random = createRandom(hashSeed(config.seed, layer.label));
  const zSpans = normalizedSpans(
    layer.subdivisions,
    layer.width,
    config.sizeVariation,
    random,
  );
  const rowNearSpans = Array.from({ length: layer.subdivisions }, (_, row) => (
    normalizedSpans(
      layer.subdivisions,
      layer.width,
      config.sizeVariation,
      createRandom(hashSeed(config.seed, `${layer.label}-row-${row}-near`)),
    )
  ));
  const rowFarSpans = Array.from({ length: layer.subdivisions }, (_, row) => (
    normalizedSpans(
      layer.subdivisions,
      layer.width,
      config.sizeVariation,
      createRandom(hashSeed(config.seed, `${layer.label}-row-${row}-far`)),
    )
  ));
  const minimumSpan = Math.min(
    ...zSpans,
    ...rowNearSpans.flat(),
    ...rowFarSpans.flat(),
  );
  const gap = Math.min(
    config.shaftWidth * config.stoneGapRatio,
    minimumSpan * 0.2,
    layer.height * 0.2,
  );
  const bottomY = layer.bottomY;
  const nominalTop = layer.bottomY + layer.height;
  let z = -layer.width * 0.5;

  for (let row = 0; row < zSpans.length; row += 1) {
    const spanZ = zSpans[row];
    const nearSpans = rowNearSpans[row];
    const farSpans = rowFarSpans[row];

    if (spanZ === undefined || !nearSpans || !farSpans) {
      continue;
    }

    let nearX = -layer.width * 0.5;
    let farX = -layer.width * 0.5;

    for (let column = 0; column < nearSpans.length; column += 1) {
      const nearWidth = nearSpans[column];
      const farWidth = farSpans[column];

      if (nearWidth === undefined || farWidth === undefined) {
        continue;
      }

      const points = createCellPoints(
        nearX,
        farX,
        z,
        nearWidth,
        farWidth,
        spanZ,
        gap,
        config.displacement,
        random,
        column,
        row,
        layer.subdivisions,
        layer.grounded === true,
      );
      const availableHeight = nominalTop - bottomY;
      const topY = points.map(() => nominalTop);

      builder.addStone(points, bottomY, topY, availableHeight);
      nearX += nearWidth;
      farX += farWidth;
    }

    z += spanZ;
  }
}

function createCellPoints(
  nearX: number,
  farX: number,
  z: number,
  nearWidth: number,
  farWidth: number,
  depth: number,
  gap: number,
  displacement: number,
  random: () => number,
  column: number,
  row: number,
  subdivisions: number,
  lockOutline: boolean,
): Point2[] {
  const inset = gap * 0.5;
  const minimumDimension = Math.min(nearWidth, farWidth, depth);
  const edgeVariation = Math.min(
    minimumDimension * displacement * 0.35,
    minimumDimension * 0.08,
  );
  const isLeftEdge = column === 0;
  const isRightEdge = column === subdivisions - 1;
  const isNearEdge = row === 0;
  const isFarEdge = row === subdivisions - 1;
  const variedInset = () => inset + randomRange(random, 0, edgeVariation);
  const points = [
    {
      x: nearX + (lockOutline && isLeftEdge ? 0 : variedInset()),
      z: z + (lockOutline && isNearEdge ? 0 : variedInset()),
    },
    {
      x: farX + (lockOutline && isLeftEdge ? 0 : variedInset()),
      z: z + depth - (lockOutline && isFarEdge ? 0 : variedInset()),
    },
    {
      x: farX + farWidth - (lockOutline && isRightEdge ? 0 : variedInset()),
      z: z + depth - (lockOutline && isFarEdge ? 0 : variedInset()),
    },
    {
      x: nearX + nearWidth - (lockOutline && isRightEdge ? 0 : variedInset()),
      z: z + (lockOutline && isNearEdge ? 0 : variedInset()),
    },
  ];

  return points;
}

function subdivisionsForWidth(width: number, targetBlockWidth: number): number {
  return Math.max(1, Math.round(width / targetBlockWidth));
}

function validateConfig(config: PillarGeometryConfig): void {
  if (!Number.isFinite(config.height) || config.height <= 0) {
    throw new RangeError("Pillar height must be greater than zero.");
  }
  if (!Number.isFinite(config.shaftWidth) || config.shaftWidth <= 0) {
    throw new RangeError("Pillar shaft width must be greater than zero.");
  }
  assertIntegerRange(config.baseSteps, 1, 4, "Base steps");
  assertIntegerRange(config.shaftCourses, 1, 8, "Shaft courses");
  assertIntegerRange(config.shaftSubdivisions, 1, 4, "Shaft subdivisions");
  assertRange(config.stoneGapRatio, 0.002, 0.04, "Stone gap ratio");
  assertRange(config.sizeVariation, 0.05, 0.4, "Size variation");
  assertRange(config.displacement, 0.01, 0.2, "Displacement");

  if (typeof config.bevelEnabled !== "boolean") {
    throw new TypeError("Bevel enabled must be a boolean.");
  }

  assertRange(config.bevelWidthRatio, 0.02, 0.3, "Bevel width ratio");
  assertRange(config.bevelDepthRatio, 0.05, 0.6, "Bevel depth ratio");
  assertRange(config.bevelVariation, 0, 0.6, "Bevel variation");

  if (!Number.isInteger(config.seed)) {
    throw new RangeError("Seed must be an integer.");
  }

}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
}

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`);
  }
}
