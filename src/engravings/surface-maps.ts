/**
 * Derives the three maps an engraving contributes to a surface: a tangent-space
 * normal, a cavity occlusion term, and where water would collect.
 *
 * Ported verbatim from the Geometry Engravings editor
 * (`src/height-map/surface-maps.ts`). Kept byte-identical below this comment so
 * the two can be diffed when that project changes. Two details here are load
 * bearing and easy to undo by accident: every mip level is oriented for Three's
 * UVs on the CPU rather than relying on `flipY`, and the normal map's green
 * channel is inverted while doing so. Both pair with `flipY = false` on the
 * uploaded texture — change one and the shading flips with distance.
 */

export interface SurfaceMapMipLevel {
  data: Uint8Array;
  height: number;
  width: number;
}

export interface DerivedSurfaceMaps {
  ambientOcclusionMipmaps: SurfaceMapMipLevel[];
  moistureAccumulationMipmaps: SurfaceMapMipLevel[];
  normalMipmaps: SurfaceMapMipLevel[];
}

export function deriveSurfaceMaps(
  height: Uint8Array,
  width: number,
  heightPx: number,
  normalRadius = 1,
  logicalCellSize = 1,
): DerivedSurfaceMaps {
  if (height.length !== width * heightPx) throw new Error("Height-field dimensions do not match its data.");
  const radius = Math.max(1, Math.min(16, Math.round(normalRadius)));
  const ambientOcclusion = new Uint8Array(height.length);
  const moistureAccumulation = new Uint8Array(height.length);
  const normal = new Uint8Array(height.length * 4);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
  const ambientOcclusionRadii = [1, 2, 4, 8, 16] as const;
  const moistureSearch = buildMoistureSearch(width, heightPx, logicalCellSize);
  const sample = (x: number, y: number) => height[wrap(y, heightPx) * width + wrap(x, width)]! / 255;

  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const base = sample(x, y);
      const slopeX = (sample(x + radius, y) - sample(x - radius, y)) / (radius * 2);
      const slopeY = (sample(x, y + radius) - sample(x, y - radius)) / (radius * 2);
      const inverseLength = 1 / Math.hypot(slopeX, slopeY, 1);
      normal[index * 4] = encodeNormalComponent(-slopeX * inverseLength);
      normal[index * 4 + 1] = encodeNormalComponent(-slopeY * inverseLength);
      normal[index * 4 + 2] = encodeNormalComponent(inverseLength);
      normal[index * 4 + 3] = 255;
      let horizon = 0;
      const moistureDirectionalRise: number[] = [];
      for (const [directionX, directionY] of directions) {
        let directionHorizon = 0;
        const directionLength = Math.hypot(directionX, directionY);
        for (const radius of ambientOcclusionRadii) {
          const rise = sample(x + directionX * radius, y + directionY * radius) - base;
          directionHorizon = Math.max(directionHorizon, rise / (radius * directionLength));
        }
        horizon += directionHorizon;

        let directionRise = 0;
        for (const searchRadius of moistureSearch.radii) {
          const proximity = Math.max(0, 1 - searchRadius / moistureSearch.falloffRadius);
          directionRise = Math.max(
            directionRise,
            (sample(x + directionX * searchRadius, y + directionY * searchRadius) - base)
              * proximity,
          );
        }
        moistureDirectionalRise.push(directionRise);
      }
      ambientOcclusion[index] = Math.round(Math.max(0.18, 1 - (horizon / directions.length) * 3.2) * 255);
      const depth = 1 - base;
      // Require higher geometry along both axes. One wall or an open trench
      // therefore stays dry, while an L-shaped corner and a fully enclosed
      // depression both qualify as cavities. Opposite walls add strength but
      // are not required, so natural corner deposits remain visible.
      const horizontalRise = Math.max(moistureDirectionalRise[0]!, moistureDirectionalRise[1]!);
      const verticalRise = Math.max(moistureDirectionalRise[2]!, moistureDirectionalRise[3]!);
      const enclosure = Math.sqrt(horizontalRise * verticalRise);
      const enclosedCardinalSides = moistureDirectionalRise
        .slice(0, 4)
        .filter((rise) => rise > 1 / 255)
        .length;
      const closureStrength = enclosure > 0 ? 0.7 + Math.max(0, enclosedCardinalSides - 2) * 0.15 : 0;
      moistureAccumulation[index] = Math.round(depth * enclosure * closureStrength * 255);
    }
  }
  return {
    // Three's WebGPU DataTexture upload only applies flipY to mip zero when custom
    // mipmaps are supplied. Orient every CPU level instead so distance cannot switch Y.
    ambientOcclusionMipmaps: orientMipmapsForUv(
      buildAmbientOcclusionMipmaps(ambientOcclusion, width, heightPx),
      1,
      false,
    ),
    moistureAccumulationMipmaps: orientMipmapsForUv(
      buildAmbientOcclusionMipmaps(moistureAccumulation, width, heightPx),
      1,
      false,
    ),
    normalMipmaps: orientMipmapsForUv(
      buildNormalMipmaps(normal, width, heightPx),
      4,
      true,
    ),
  };
}

function buildMoistureSearch(
  width: number,
  height: number,
  logicalCellSize: number,
): { falloffRadius: number; radii: number[] } {
  const cellSize = Math.max(1, logicalCellSize);
  const tileLimit = Math.max(1, Math.floor(Math.max(width, height) / 2));
  const maxSampleRadius = Math.max(1, Math.min(tileLimit, Math.ceil(cellSize * 3)));
  const sampleStep = Math.max(1, cellSize / 4);
  const radii = new Set<number>();
  const steps = Math.max(1, Math.ceil(maxSampleRadius / sampleStep));
  for (let step = 1; step <= steps; step += 1) {
    radii.add(Math.max(1, Math.round(step * maxSampleRadius / steps)));
  }
  return {
    falloffRadius: maxSampleRadius + sampleStep,
    radii: [...radii].sort((left, right) => left - right),
  };
}

function orientMipmapsForUv(
  mipmaps: SurfaceMapMipLevel[],
  components: number,
  invertNormalY: boolean,
): SurfaceMapMipLevel[] {
  return mipmaps.map((level) => {
    const data = new Uint8Array(level.data.length);
    const rowLength = level.width * components;
    for (let sourceY = 0; sourceY < level.height; sourceY += 1) {
      const sourceOffset = sourceY * rowLength;
      const targetOffset = (level.height - sourceY - 1) * rowLength;
      data.set(level.data.subarray(sourceOffset, sourceOffset + rowLength), targetOffset);
      if (invertNormalY) {
        for (let x = 0; x < level.width; x += 1) {
          const greenIndex = targetOffset + x * components + 1;
          data[greenIndex] = 255 - data[greenIndex]!;
        }
      }
    }
    return { data, height: level.height, width: level.width };
  });
}

function buildAmbientOcclusionMipmaps(
  base: Uint8Array,
  width: number,
  height: number,
): SurfaceMapMipLevel[] {
  const levels: SurfaceMapMipLevel[] = [{ data: base, height, width }];
  let previous = levels[0]!;
  while (previous.width > 1 || previous.height > 1) {
    const nextWidth = Math.max(1, Math.floor(previous.width / 2));
    const nextHeight = Math.max(1, Math.floor(previous.height / 2));
    const data = new Uint8Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        let occlusionSum = 0;
        let sampleCount = 0;
        for (let offsetY = 0; offsetY < 2; offsetY += 1) {
          for (let offsetX = 0; offsetX < 2; offsetX += 1) {
            const sourceX = Math.min(previous.width - 1, x * 2 + offsetX);
            const sourceY = Math.min(previous.height - 1, y * 2 + offsetY);
            occlusionSum += previous.data[sourceY * previous.width + sourceX]!;
            sampleCount += 1;
          }
        }
        data[y * nextWidth + x] = Math.round(occlusionSum / sampleCount);
      }
    }
    previous = { data, height: nextHeight, width: nextWidth };
    levels.push(previous);
  }
  return levels;
}

function buildNormalMipmaps(
  base: Uint8Array,
  width: number,
  height: number,
): SurfaceMapMipLevel[] {
  const levels: SurfaceMapMipLevel[] = [{ data: base, height, width }];
  let previous = levels[0]!;
  while (previous.width > 1 || previous.height > 1) {
    const nextWidth = Math.max(1, Math.floor(previous.width / 2));
    const nextHeight = Math.max(1, Math.floor(previous.height / 2));
    const data = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        let normalX = 0;
        let normalY = 0;
        let normalZ = 0;
        for (let offsetY = 0; offsetY < 2; offsetY += 1) {
          for (let offsetX = 0; offsetX < 2; offsetX += 1) {
            const sourceX = Math.min(previous.width - 1, x * 2 + offsetX);
            const sourceY = Math.min(previous.height - 1, y * 2 + offsetY);
            const sourceIndex = (sourceY * previous.width + sourceX) * 4;
            normalX += decodeNormalComponent(previous.data[sourceIndex]!);
            normalY += decodeNormalComponent(previous.data[sourceIndex + 1]!);
            normalZ += decodeNormalComponent(previous.data[sourceIndex + 2]!);
          }
        }
        const inverseLength = 1 / Math.max(1e-6, Math.hypot(normalX, normalY, normalZ));
        const targetIndex = (y * nextWidth + x) * 4;
        data[targetIndex] = encodeNormalComponent(normalX * inverseLength);
        data[targetIndex + 1] = encodeNormalComponent(normalY * inverseLength);
        data[targetIndex + 2] = encodeNormalComponent(normalZ * inverseLength);
        data[targetIndex + 3] = 255;
      }
    }
    previous = { data, height: nextHeight, width: nextWidth };
    levels.push(previous);
  }
  return levels;
}

function decodeNormalComponent(value: number): number {
  return value / 255 * 2 - 1;
}

function encodeNormalComponent(value: number): number {
  return Math.round((Math.max(-1, Math.min(1, value)) * 0.5 + 0.5) * 255);
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}
