import * as THREE from "three";
import type { SurfaceMapMipLevel } from "./surface-maps";
import type { EngravingSurfaceMaps } from "./worker-protocol";

export interface EngravingTextures {
  readonly ambientOcclusion: THREE.DataTexture;
  readonly moistureAccumulation: THREE.DataTexture;
  readonly normal: THREE.DataTexture;
}

export function createEngravingTextures(
  maps: EngravingSurfaceMaps,
): EngravingTextures {
  return {
    ambientOcclusion: mipmappedDataTexture(
      maps.ambientOcclusionMipmaps,
      THREE.RedFormat,
    ),
    moistureAccumulation: mipmappedDataTexture(
      maps.moistureAccumulationMipmaps,
      THREE.RedFormat,
    ),
    normal: mipmappedDataTexture(maps.normalMipmaps, THREE.RGBAFormat),
  };
}

export function disposeEngravingTextures(
  textures: EngravingTextures | null,
): void {
  textures?.ambientOcclusion.dispose();
  textures?.moistureAccumulation.dispose();
  textures?.normal.dispose();
}

/**
 * Uploads a CPU-built mip chain as it stands.
 *
 * Two settings here are load bearing and look like oversights. Mips are not
 * generated, because the chain arrives already built — occlusion area-averaged
 * and normals renormalised, which is not what a generic box filter would
 * produce and is what keeps a minified engraving from flattening into grey.
 * And `flipY` is off, because every level was already oriented for Three's UVs
 * on the CPU; the WebGPU upload path only flips mip zero when a custom chain is
 * supplied, so leaving it on would flip the shading with distance.
 */
function mipmappedDataTexture(
  mipmaps: SurfaceMapMipLevel[],
  format: THREE.PixelFormat,
): THREE.DataTexture {
  const base = mipmaps[0];

  if (!base) {
    throw new Error("An engraving surface map arrived with no mip levels.");
  }

  const texture = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    format,
    THREE.UnsignedByteType,
  );
  texture.mipmaps = mipmaps;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  // The editor could omit this because its map widths all derived from 1024 and
  // were aligned by construction. Ours are aligned by a rounding rule instead,
  // so the alignment is stated rather than assumed.
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}
