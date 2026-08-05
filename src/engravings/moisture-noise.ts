import * as THREE from "three";

/**
 * The blotchy mask that decides where an engraving's cavities look wet.
 *
 * Ported verbatim from the Geometry Engravings editor
 * (`src/scene/moisture-noise.ts`). Kept byte-identical below this comment so
 * the two can be diffed when that project changes. It is deterministic and
 * seeded, so the same engraving weathers the same way on every load and in
 * every session — a stone that reorganised its own staining on reload would
 * read as an animation nobody asked for.
 *
 * One texture serves every decal: it is sampled in the engraving's own space,
 * so sharing it costs nothing and re-deriving it per layer would buy nothing.
 */

export const MOISTURE_NOISE_SIZE = 256;
const MOISTURE_NOISE_SEED = 0x6d2b79f5;

export class MoistureNoiseTextureResource {
  private value: THREE.DataTexture | null = null;

  get(): THREE.DataTexture {
    this.value ??= createMoistureNoiseTexture();
    return this.value;
  }

  dispose(): void {
    this.value?.dispose();
    this.value = null;
  }
}

export function createMoistureNoiseTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    generateMoistureNoise(),
    MOISTURE_NOISE_SIZE,
    MOISTURE_NOISE_SIZE,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export function generateMoistureNoise(size = MOISTURE_NOISE_SIZE): Uint8Array {
  if (!Number.isInteger(size) || size < 1) throw new Error("Moisture noise size must be a positive integer.");
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = moistureNoiseValue((x + 0.5) / size, (y + 0.5) / size);
      data[y * size + x] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
  }
  return data;
}

export function moistureNoiseValue(u: number, v: number): number {
  const octaves = [
    [3, 0.48, 0],
    [7, 0.28, 1],
    [17, 0.16, 2],
    [31, 0.08, 3],
  ] as const;
  let value = 0;
  for (const [cells, weight, octave] of octaves) {
    value += periodicValueNoise(u, v, cells, MOISTURE_NOISE_SEED + octave * 0x9e3779b9) * weight;
  }
  return smoothstep(0.12, 0.9, value);
}

function periodicValueNoise(u: number, v: number, cells: number, seed: number): number {
  const x = fract(u) * cells;
  const y = fract(v) * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const northWest = latticeValue(x0, y0, cells, seed);
  const northEast = latticeValue(x0 + 1, y0, cells, seed);
  const southWest = latticeValue(x0, y0 + 1, cells, seed);
  const southEast = latticeValue(x0 + 1, y0 + 1, cells, seed);
  return mix(
    mix(northWest, northEast, tx),
    mix(southWest, southEast, tx),
    ty,
  );
}

function latticeValue(x: number, y: number, cells: number, seed: number): number {
  const wrappedX = ((x % cells) + cells) % cells;
  const wrappedY = ((y % cells) + cells) % cells;
  let hash = seed ^ Math.imul(wrappedX + 1, 0x27d4eb2d) ^ Math.imul(wrappedY + 1, 0x165667b1);
  hash = Math.imul(hash ^ hash >>> 15, 0x85ebca6b);
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35);
  return ((hash ^ hash >>> 16) >>> 0) / 0xffffffff;
}

function fade(value: number): number {
  return value * value * (3 - 2 * value);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function mix(a: number, b: number, factor: number): number {
  return a + (b - a) * factor;
}

function smoothstep(low: number, high: number, value: number): number {
  const normalized = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return normalized * normalized * (3 - 2 * normalized);
}
