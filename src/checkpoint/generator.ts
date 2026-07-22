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
} from "../geometry/stone-builder";
import {
  createPolarEntryFrames,
  type PolarEntryFrame,
} from "./entries";

export interface CheckpointGeometryConfig extends StoneDetailConfig {
  radius: number;
  rowsPerTier: number;
  entryCount: number;
  entryWidthRatio: number;
  entryLengthRatio: number;
  entryFadeRatio: number;
  edgeFragmentation: number;
  entryEndHeightRatio: number;
  stoneGapRatio: number;
  sizeVariation: number;
  displacement: number;
  tierRiseRatio: number;
}

export interface CheckpointGeometryResult extends StoneGeometryResult {
  centerTopY: number;
  centerDiameter: number;
}

export const DEFAULT_CHECKPOINT_CONFIG: Readonly<CheckpointGeometryConfig> = {
  radius: 3,
  rowsPerTier: 4,
  entryCount: 4,
  entryWidthRatio: 0.35,
  entryLengthRatio: 0.6,
  entryFadeRatio: 0.5,
  edgeFragmentation: 1,
  entryEndHeightRatio: 0.04,
  stoneGapRatio: 0.008,
  sizeVariation: 0.4,
  displacement: 0.03,
  tierRiseRatio: 0.06,
  bevelEnabled: true,
  bevelWidthRatio: 0.03,
  bevelDepthRatio: 0.11,
  bevelVariation: 0.6,
  seed: 741,
};

const TIER_COUNT = 3;
const CENTER_RADIUS_RATIO = 0.14;
const STONE_HEIGHT_RATIO = 0.045;
const CENTER_HEIGHT_RATIO = 0.01;
const CENTER_BURY_DEPTH_RATIO = 0.025;
// Half-side of the square center block, as a fraction of the center radius.
// Tuned so the block's top footprint matches the Xochipilli statue's square
// base (≈0.69·centerRadius at the default pedestal fit) with a small reveal.
const CENTER_SQUARE_HALF_RATIO = 0.6;
const MIN_RING_SEGMENTS = 6;
export function createCheckpointGeometry(
  config: CheckpointGeometryConfig,
): CheckpointGeometryResult {
  validateConfig(config);

  const builder = new StoneGeometryBuilder(config);
  const totalRows = TIER_COUNT * config.rowsPerTier;
  const centerRadius = config.radius * CENTER_RADIUS_RATIO;
  const radialStep = (config.radius - centerRadius) / totalRows;
  const stoneHeight = config.radius * STONE_HEIGHT_RATIO;
  const tierRise = config.radius * config.tierRiseRatio;
  const gap = config.radius * config.stoneGapRatio;

  addCircularPlate(
    builder,
    config,
    centerRadius,
    radialStep,
    stoneHeight,
    tierRise,
    gap,
  );

  for (const frame of createPolarEntryFrames(config.entryCount)) {
    addEntry(builder, config, frame, radialStep, stoneHeight, gap);
  }

  const centerTopY = addCenterStone(
    builder,
    config,
    centerRadius,
    stoneHeight,
    tierRise,
  );

  return {
    ...finalizeStoneGeometry(builder),
    centerTopY,
    centerDiameter: centerRadius * 2,
  };
}

function addCircularPlate(
  builder: StoneGeometryBuilder,
  config: CheckpointGeometryConfig,
  centerRadius: number,
  radialStep: number,
  stoneHeight: number,
  tierRise: number,
  gap: number,
): void {
  const totalRows = TIER_COUNT * config.rowsPerTier;

  for (let row = 0; row < totalRows; row += 1) {
    const innerRadius = centerRadius + row * radialStep;
    const outerRadius = innerRadius + radialStep;
    const middleRadius = (innerRadius + outerRadius) * 0.5;
    const targetArcLength = radialStep * 1.35;
    const segmentCount = Math.max(
      MIN_RING_SEGMENTS,
      Math.round((Math.PI * 2 * middleRadius) / targetArcLength),
    );
    const random = createRandom(hashSeed(config.seed, `ring-${row}`));
    const spans = normalizedSpans(segmentCount, Math.PI * 2, config.sizeVariation, random);
    const phase = row % 2 === 0 ? 0 : Math.PI / segmentCount;
    const tierFromOutside = Math.floor((totalRows - 1 - row) / config.rowsPerTier);
    const baseTop = stoneHeight + tierFromOutside * tierRise;
    let angle = phase;

    for (const span of spans) {
      const angularGap = gap / Math.max(middleRadius, gap);
      const startAngle = angle + angularGap * 0.5;
      const endAngle = angle + span - angularGap * 0.5;
      const insetInner = innerRadius + gap * 0.5;
      const insetOuter = outerRadius - gap * 0.5;
      const cellScale = Math.min(radialStep, middleRadius * span);
      const jitter = cellScale * config.displacement;
      const points = [
        polarPoint(insetInner, startAngle, random, jitter),
        polarPoint(insetInner, endAngle, random, jitter),
        polarPoint(insetOuter, endAngle, random, jitter),
        polarPoint(insetOuter, startAngle, random, jitter),
      ];
      const heightVariation = stoneHeight * config.sizeVariation * 0.18;
      const stoneTop = baseTop + randomRange(random, -heightVariation, heightVariation);
      const topY = points.map(
        () => stoneTop + randomRange(random, -jitter * 0.08, jitter * 0.08),
      );

      builder.addStone(points, 0, topY, stoneHeight);
      angle += span;
    }
  }
}

function addEntry(
  builder: StoneGeometryBuilder,
  config: CheckpointGeometryConfig,
  frame: PolarEntryFrame,
  targetCellSize: number,
  stoneHeight: number,
  gap: number,
): void {
  const width = config.radius * config.entryWidthRatio;
  const length = config.radius * config.entryLengthRatio;
  const laneCount = Math.max(2, Math.round(width / (targetCellSize * 1.2)));
  const random = createRandom(hashSeed(config.seed, `entry-${frame.index}`));
  const laneWidths = normalizedSpans(laneCount, width, config.sizeVariation, random);
  const fadeStart = 1 - config.entryFadeRatio;
  let lateral = -width * 0.5;

  for (const laneWidth of laneWidths) {
    const lateralStart = lateral;
    const lateralEnd = lateral + laneWidth;
    const startA = circleBoundary(config.radius, lateralStart);
    const startB = circleBoundary(config.radius, lateralEnd);
    const availableLength = config.radius + length - Math.min(startA, startB);
    const rowCount = Math.max(1, Math.round(availableLength / targetCellSize));
    const laneEnd = 1 - randomRange(
      random,
      0,
      config.entryFadeRatio * config.edgeFragmentation * 0.65,
    );
    const rowSpans = normalizedSpans(
      rowCount,
      laneEnd,
      config.sizeVariation,
      random,
    );
    let progress = 0;

    for (const progressSpan of rowSpans) {
      const nextProgress = progress + progressSpan;
      const fadeAmount = THREE.MathUtils.smoothstep(
        (progress + nextProgress) * 0.5,
        fadeStart,
        1,
      );
      const subdivisionCount = fadeAmount > 0
        && random() < fadeAmount * config.edgeFragmentation
        ? 2
        : 1;

      for (let subdivision = 0; subdivision < subdivisionCount; subdivision += 1) {
        const subdivisionStart = THREE.MathUtils.lerp(
          progress,
          nextProgress,
          subdivision / subdivisionCount,
        );
        const subdivisionEnd = THREE.MathUtils.lerp(
          progress,
          nextProgress,
          (subdivision + 1) / subdivisionCount,
        );
        const subdivisionFade = THREE.MathUtils.smoothstep(
          (subdivisionStart + subdivisionEnd) * 0.5,
          fadeStart,
          1,
        );
        const missingChance = Math.pow(subdivisionFade, 1.35)
          * config.edgeFragmentation
          * 0.9;

        if (random() < missingChance) {
          continue;
        }

        addEntryStone(
          builder,
          config,
          frame,
          random,
          startA,
          startB,
          config.radius + length,
          lateralStart,
          lateralEnd,
          laneWidth,
          availableLength,
          laneEnd,
          subdivisionStart,
          subdivisionEnd,
          stoneHeight,
          gap,
        );
      }

      progress = nextProgress;
    }

    lateral = lateralEnd;
  }
}

function addEntryStone(
  builder: StoneGeometryBuilder,
  config: CheckpointGeometryConfig,
  frame: PolarEntryFrame,
  random: () => number,
  startA: number,
  startB: number,
  entryEnd: number,
  lateralStart: number,
  lateralEnd: number,
  laneWidth: number,
  availableLength: number,
  laneEnd: number,
  progress: number,
  nextProgress: number,
  stoneHeight: number,
  gap: number,
): void {
  const a0 = THREE.MathUtils.lerp(startA, entryEnd, progress);
  const a1 = THREE.MathUtils.lerp(startB, entryEnd, progress);
  const a2 = THREE.MathUtils.lerp(startB, entryEnd, nextProgress);
  const a3 = THREE.MathUtils.lerp(startA, entryEnd, nextProgress);
  const rawPoints = [
    localToWorld(frame, a0, lateralStart),
    localToWorld(frame, a1, lateralEnd),
    localToWorld(frame, a2, lateralEnd),
    localToWorld(frame, a3, lateralStart),
  ];
  const points = insetAndJitter(rawPoints, gap, config.displacement, random);
  const cellDepth = availableLength * (nextProgress - progress);
  const jitter = Math.min(laneWidth, cellDepth) * config.displacement;
  const slopeProgress = progress === 0
    ? 0
    : THREE.MathUtils.clamp(nextProgress / Math.max(laneEnd, Number.EPSILON), 0, 1);
  const steppedHeight = THREE.MathUtils.lerp(
    stoneHeight,
    stoneHeight * config.entryEndHeightRatio,
    slopeProgress,
  );
  const heightVariation = steppedHeight * config.sizeVariation * 0.18;
  const stoneTop = steppedHeight
    + randomRange(random, -heightVariation, heightVariation);
  const topJitter = Math.min(jitter * 0.08, steppedHeight * 0.08);
  const topY = points.map(
    () => Math.max(
      config.radius * 0.001,
      stoneTop + randomRange(random, -topJitter, topJitter),
    ),
  );

  builder.addStone(points, 0, topY, steppedHeight);
}

function addCenterStone(
  builder: StoneGeometryBuilder,
  config: CheckpointGeometryConfig,
  centerRadius: number,
  stoneHeight: number,
  tierRise: number,
): number {
  const innerTierTop = stoneHeight + (TIER_COUNT - 1) * tierRise;
  const formationHeight = config.radius * CENTER_HEIGHT_RATIO;
  const centerTopY = innerTierTop + formationHeight;

  // Axis-aligned square block (edges parallel to X/Z) so its top matches the
  // offering statue's square base. Corners at (±half, ±half).
  const half = centerRadius * CENTER_SQUARE_HALF_RATIO;
  const points: Point2[] = [
    { x: half, z: half },
    { x: -half, z: half },
    { x: -half, z: -half },
    { x: half, z: -half },
  ];

  builder.addStone(
    points,
    -config.radius * CENTER_BURY_DEPTH_RATIO,
    points.map(() => centerTopY),
    formationHeight,
  );

  return centerTopY;
}

function validateConfig(config: CheckpointGeometryConfig): void {
  if (!Number.isFinite(config.radius) || config.radius <= 0) {
    throw new RangeError("Checkpoint radius must be greater than zero.");
  }
  if (!Number.isInteger(config.rowsPerTier) || config.rowsPerTier < 1 || config.rowsPerTier > 4) {
    throw new RangeError("Rows per tier must be an integer from 1 to 4.");
  }
  if (!Number.isInteger(config.entryCount) || config.entryCount < 1 || config.entryCount > 8) {
    throw new RangeError("Entry count must be an integer from 1 to 8.");
  }

  assertRange(config.entryWidthRatio, 0.25, 1.5, "Entry width ratio");
  assertRange(config.entryLengthRatio, 0.25, 3, "Entry length ratio");
  assertRange(config.entryFadeRatio, 0.1, 0.5, "Entry fade ratio");
  assertRange(config.edgeFragmentation, 0, 1, "Edge fragmentation");
  assertRange(config.entryEndHeightRatio, 0.01, 1, "Entry end height ratio");
  assertRange(config.stoneGapRatio, 0.002, 0.04, "Stone gap ratio");
  assertRange(config.sizeVariation, 0.05, 0.4, "Size variation");
  assertRange(config.displacement, 0.01, 0.2, "Displacement");
  assertRange(config.tierRiseRatio, 0.005, 0.12, "Tier rise ratio");
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

function polarPoint(
  radius: number,
  angle: number,
  random: () => number,
  jitter: number,
): Point2 {
  const radialJitter = randomRange(random, -jitter, jitter);
  const tangentialJitter = randomRange(random, -jitter, jitter);
  const adjustedRadius = radius + radialJitter;

  return {
    x: Math.cos(angle) * adjustedRadius - Math.sin(angle) * tangentialJitter,
    z: Math.sin(angle) * adjustedRadius + Math.cos(angle) * tangentialJitter,
  };
}

function insetAndJitter(
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

  return points.map((point) => {
    const dx = point.x - center.x;
    const dz = point.z - center.z;
    const distance = Math.hypot(dx, dz);
    const inset = Math.min(gap * 0.5, distance * 0.2);
    const scale = distance > 0 ? (distance - inset) / distance : 1;
    const jitter = Math.min(distance * displacement, gap * 0.65);

    return {
      x: center.x + dx * scale + randomRange(random, -jitter, jitter),
      z: center.z + dz * scale + randomRange(random, -jitter, jitter),
    };
  });
}

function circleBoundary(radius: number, lateral: number): number {
  return Math.sqrt(Math.max(radius * radius - lateral * lateral, 0));
}

function localToWorld(frame: PolarEntryFrame, axial: number, lateral: number): Point2 {
  return {
    x: frame.axisX * axial + frame.lateralX * lateral,
    z: frame.axisZ * axial + frame.lateralZ * lateral,
  };
}
