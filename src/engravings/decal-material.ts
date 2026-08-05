import * as THREE from "three";
import type { NodeMaterial } from "three/webgpu";
import {
  attribute,
  float,
  normalMap,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import type { MaterialGraphRuntime } from "material-designer-runtime";
import type { EngravingTextures } from "./textures";

// Three's TSL node types encode vector widths in large conditional types, and
// this compositor is width-polymorphic across float, vec2 and vec3. The local
// graph values stay loose for the same reason they do in the editor this is
// ported from.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeValue = any;

/** How far the engraving's own occlusion is allowed to darken the base colour. */
const AO_COLOR_INFLUENCE = 0.35;

export interface EngravingDecalMaterialInput {
  /** The runtime of the surface the decal lies on, not one of its own. */
  readonly runtime: MaterialGraphRuntime;
  readonly textures: EngravingTextures;
  readonly moistureNoise: THREE.Texture;
  readonly aoIntensity: number;
  readonly normalStrength: number;
  readonly moistureLevel: number;
  /** The layer's own width over its height, in cells. */
  readonly aspect: number;
}

/**
 * Builds the material one engraved decal renders with.
 *
 * A copy of the host's material rather than the host's material itself. The
 * editor this is ported from mutates `runtime.getNodeMaterial()` in place,
 * which it can do because that material dresses exactly one slab; here the same
 * object is handed to every draw group of the merged structure, so mutating it
 * would engrave the entire building.
 *
 * The engraving and the stone are sampled in different spaces on purpose. The
 * stone reads the box-projected UVs the whole structure shares, so the grain
 * runs through the decal uninterrupted; the engraving reads its own slot-local
 * square. Neither multiplies by a scale here — texture density in this project
 * rides the `uv` attribute, so scaling again would be the one mistake that
 * makes a decal read as a sticker laid on the wall.
 */
export function buildEngravingDecalMaterial(
  input: EngravingDecalMaterialInput,
): NodeMaterial {
  // Cloned from the host rather than built beside it. Every material document
  // in this project compiles to a physical node material carrying its own
  // index of refraction, specular and sheen, and a standard one assembled from
  // the same channels shades visibly differently — a decal built that way reads
  // as a brighter patch with a hard edge, which is precisely what an engraving
  // must not be. Cloning inherits the class, every scalar and every node, so
  // the decal *is* the surface, with the cuts composited into it.
  const host = input.runtime.getNodeMaterial();
  const material = host.clone() as NodeMaterial & Record<string, NodeValue>;
  const source = host as NodeMaterial & Record<string, NodeValue>;
  const { textures } = input;
  const engravingUv: NodeValue = attribute("engravingUv", "vec2");
  // The engraving's own square, multiplied by however many times the motif
  // repeats across the quad. At a repeat of one it is `engravingUv` exactly, so
  // an untiled decal renders as it always did.
  const engravingTileUv: NodeValue = attribute("engravingTileUv", "vec2");
  const materialUv: NodeValue = uv();
  const channel = (
    name: Parameters<typeof input.runtime.surface.getChannelTexture>[0],
  ) => input.runtime.surface.getChannelTexture(name);
  const sample = (map: THREE.Texture): NodeValue => texture(map, materialUv);

  const engravingAo: NodeValue = float(1).sub(
    float(1)
      .sub(texture(textures.ambientOcclusion, engravingTileUv).r)
      .mul(float(Math.max(0, input.aoIntensity))),
  ).saturate();
  // Cavities darken the stone a little even in direct light, or a deep cut
  // reads as a flat drawing the moment the sun faces it.
  const cavityColor: NodeValue = float(1).sub(
    float(1).sub(engravingAo).mul(AO_COLOR_INFLUENCE),
  );

  const moistureLevel: NodeValue = float(
    Math.max(0, Math.min(1, input.moistureLevel)),
  );
  // The blotching stays in the slot's own space while the three derived maps
  // move to the tiled one, and that split is the point: the accumulation map
  // says where water collects in the *cut*, so it has to repeat with the cut,
  // while the noise says where the *wall* is damp — and a wall that stained
  // itself once per motif would advertise the repetition rather than break it
  // up. For the same reason the aspect here stays the layer's own and is not
  // scaled by the repeat, which would shrink the blotches as a run tightened.
  const moistureUv: NodeValue = vec2(
    engravingUv.x.mul(Math.max(0.0001, input.aspect)),
    engravingUv.y,
  ).mul(0.37);
  const moistureSpots: NodeValue = smoothstep(
    float(0.82).sub(moistureLevel.mul(0.52)).sub(0.12),
    float(0.82).sub(moistureLevel.mul(0.52)).add(0.12),
    texture(input.moistureNoise, moistureUv).r,
  );
  const moistureDarkening: NodeValue = float(1).sub(
    texture(textures.moistureAccumulation, engravingTileUv).r
      .mul(moistureSpots)
      .mul(moistureLevel)
      .mul(0.9),
  );

  // Roughness, metalness and emission are inherited untouched by the clone: an
  // engraving changes how the stone is shaped, not what it is made of. Only
  // colour, normal and occlusion carry the cut, and each is composed onto
  // whatever the host already had rather than replacing it.
  const baseColor = channel("baseColor");
  const hostColor: NodeValue = source.colorNode
    ?? (baseColor ? sample(baseColor).rgb : null);
  material.colorNode = hostColor
    ? hostColor.mul(cavityColor).mul(moistureDarkening)
    : null;

  const engravingNormalSample: NodeValue = texture(
    textures.normal,
    engravingTileUv,
  ).xyz.mul(2).sub(1);
  const engravingNormal: NodeValue = vec3(
    engravingNormalSample.xy.mul(float(Math.max(0, input.normalStrength) * 2)),
    engravingNormalSample.z,
  ).normalize();
  const hostNormal = channel("normal");
  // The stone's own grain and the engraving's cut are combined rather than one
  // replacing the other: a carved surface is still the same stone.
  const combinedNormal: NodeValue = hostNormal
    ? vec3(
      engravingNormal.x.add(sample(hostNormal).x.mul(2).sub(1)),
      engravingNormal.y.add(sample(hostNormal).y.mul(2).sub(1)),
      engravingNormal.z.mul(sample(hostNormal).z.mul(2).sub(1)),
    ).normalize()
    : engravingNormal;
  material.normalNode = normalMap(combinedNormal.mul(0.5).add(0.5));

  const hostAo = channel("ambientOcclusion");
  const graphAo: NodeValue = source.aoNode
    ?? (hostAo ? sample(hostAo).r : float(1));
  material.aoNode = graphAo.mul(engravingAo).mul(attribute("vertexAo", "float"));

  // The sun and crack terms ride the vertex colour channel for the structure,
  // and `setupDiffuseColor` multiplies it into a user-supplied colour node just
  // the same, so a decal is shaded by them without asking for anything else.
  material.vertexColors = true;
  material.side = THREE.FrontSide;
  // A decal already stands proud of its host by a few millimetres. This is what
  // covers the rest, and unlike the offset it scales itself with distance.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -2;
  material.needsUpdate = true;
  return material;
}

/**
 * Disposes the material and nothing else. The engraving textures belong to the
 * map cache and the noise to the scene, and both outlive any one decal.
 */
export function disposeEngravingDecalMaterial(
  material: THREE.Material | null,
): void {
  material?.dispose();
}
