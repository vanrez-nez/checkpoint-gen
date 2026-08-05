/**
 * Reconstructs a cell grid as a continuous field with rounded corners.
 *
 * Ported verbatim from the Geometry Engravings editor
 * (`src/height-map/rounded-pixels.ts`). Kept byte-identical below this comment
 * so the two can be diffed when that project changes: the engraving an artist
 * previewed there and the engraving this project carves have to be the same
 * shape, and the corner cases here — the diagonal-pair rule, the three-corner
 * inversion — are the kind of thing that is only right once.
 *
 * With a radius of zero it degenerates to a supersampled nearest-neighbour
 * upsample, which is why the runtime has no separate un-rounded path.
 * Sampling wraps toroidally, so the result tiles seamlessly.
 */

const ANTIALIAS_SAMPLES = 2;

export function rasterizeRoundedPixelField(
  sourceLevels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  cornerRadius: number,
  heightByLevel: Uint8Array,
): Uint8Array {
  if (sourceLevels.length !== sourceWidth * sourceHeight) {
    throw new Error("Logical pixel field dimensions do not match its data.");
  }
  if (heightByLevel.length < 2) throw new Error("Rounded pixel fields require at least two levels.");
  if (sourceWidth < 1 || sourceHeight < 1 || targetWidth < 1 || targetHeight < 1) {
    throw new Error("Rounded pixel field dimensions must be positive.");
  }
  const radius = clamp(cornerRadius, 0, 0.5);
  const result = new Uint8Array(targetWidth * targetHeight);
  const sampleCount = ANTIALIAS_SAMPLES * ANTIALIAS_SAMPLES;

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      let sum = 0;
      for (let sampleY = 0; sampleY < ANTIALIAS_SAMPLES; sampleY += 1) {
        const logicalY = (
          targetY + (sampleY + 0.5) / ANTIALIAS_SAMPLES
        ) * sourceHeight / targetHeight;
        for (let sampleX = 0; sampleX < ANTIALIAS_SAMPLES; sampleX += 1) {
          const logicalX = (
            targetX + (sampleX + 0.5) / ANTIALIAS_SAMPLES
          ) * sourceWidth / targetWidth;
          const level = sampleRoundedLevel(
            sourceLevels,
            sourceWidth,
            sourceHeight,
            logicalX,
            logicalY,
            radius,
          );
          const height = heightByLevel[level];
          if (height === undefined) throw new Error(`Logical pixel level ${level} has no height.`);
          sum += height;
        }
      }
      result[targetY * targetWidth + targetX] = Math.round(sum / sampleCount);
    }
  }
  return result;
}

function sampleRoundedLevel(
  source: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fractionX = x - cellX;
  const fractionY = y - cellY;
  const base = sampleCell(source, width, height, cellX, cellY);
  if (radius <= 0) return base;

  const nearVerticalEdge = fractionX < radius || fractionX > 1 - radius;
  const nearHorizontalEdge = fractionY < radius || fractionY > 1 - radius;
  if (!nearVerticalEdge || !nearHorizontalEdge) return base;

  const cornerX = fractionX < radius ? cellX : cellX + 1;
  const cornerY = fractionY < radius ? cellY : cellY + 1;
  const offsetX = x - cornerX;
  const offsetY = y - cornerY;
  const northWest = sampleCell(source, width, height, cornerX - 1, cornerY - 1);
  const northEast = sampleCell(source, width, height, cornerX, cornerY - 1);
  const southWest = sampleCell(source, width, height, cornerX - 1, cornerY);
  const southEast = sampleCell(source, width, height, cornerX, cornerY);
  const maximumLevel = Math.max(northWest, northEast, southWest, southEast);
  let result = 0;
  for (let threshold = 1; threshold <= maximumLevel; threshold += 1) {
    if (roundedThresholdContains(
      northWest >= threshold,
      northEast >= threshold,
      southWest >= threshold,
      southEast >= threshold,
      offsetX,
      offsetY,
      radius,
    )) result = threshold;
  }
  return result;
}

function roundedThresholdContains(
  northWest: boolean,
  northEast: boolean,
  southWest: boolean,
  southEast: boolean,
  x: number,
  y: number,
  radius: number,
): boolean {
  const activeCount = Number(northWest) + Number(northEast)
    + Number(southWest) + Number(southEast);
  if (activeCount === 0) return false;
  if (activeCount === 4) return true;

  if (activeCount === 1) {
    const index = northWest ? 0 : northEast ? 1 : southWest ? 2 : 3;
    return circleContains(index, x, y, radius);
  }
  if (activeCount === 3) {
    const index = !northWest ? 0 : !northEast ? 1 : !southWest ? 2 : 3;
    return !circleContains(index, x, y, radius);
  }
  if (northWest && southEast || northEast && southWest) {
    return northWest && circleContains(0, x, y, radius)
      || northEast && circleContains(1, x, y, radius)
      || southWest && circleContains(2, x, y, radius)
      || southEast && circleContains(3, x, y, radius);
  }

  const quadrant = (y < 0 ? 0 : 2) + (x < 0 ? 0 : 1);
  return quadrant === 0 ? northWest
    : quadrant === 1 ? northEast
      : quadrant === 2 ? southWest
        : southEast;
}

function circleContains(index: number, x: number, y: number, radius: number): boolean {
  const centerX = index === 0 || index === 2 ? -radius : radius;
  const centerY = index < 2 ? -radius : radius;
  return Math.hypot(x - centerX, y - centerY) <= radius;
}

function sampleCell(
  source: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  return source[wrap(y, height) * width + wrap(x, width)]!;
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
