import type { Node } from "three/webgpu";
import * as THREE from "three/webgpu";
import {
  Fn,
  clamp,
  float,
  instanceIndex,
  mix,
  mx_fractal_noise_float,
  positionGeometry,
  positionLocal,
  smoothstep,
  time,
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";

export interface VertexConePlacement {
  x: number;
  y: number;
  z: number;
}

export interface VertexConeFireConfig {
  enabled: boolean;
  scale: number;
  radius: number;
  height: number;
  baseHeight: number;
  speed: number;
  noiseScale: number;
  turbulence: number;
  intensity: number;
  pillarHeight: number;
  radialSegments: number;
  placements: readonly VertexConePlacement[];
}

export interface FireConfig {
  enabled: boolean;
  scale: number;
  radius: number;
  height: number;
  baseHeight: number;
  radialSegments: number;
  speed: number;
  noiseScale: number;
  turbulence: number;
  intensity: number;
  glowEnabled: boolean;
  glowIntensity: number;
  glowDistance: number;
  glowFlicker: number;
}

export interface VertexConeFireStats {
  flameCount: number;
  vertexCount: number;
  triangleCount: number;
  drawCallCount: number;
}

export const DEFAULT_FIRE_CONFIG: Readonly<FireConfig> = {
  enabled: true,
  scale: 1.25,
  radius: 0.08,
  height: 0.43,
  baseHeight: 0.065,
  radialSegments: 16,
  speed: 7,
  noiseScale: 4.8,
  turbulence: 2,
  intensity: 5,
  glowEnabled: true,
  glowIntensity: 0.6,
  glowDistance: 3,
  glowFlicker: 0.25,
};

const SOURCE_RADIUS = 0.42;
const SOURCE_HEIGHT = 1.5;
const VERTICAL_SEGMENTS = 24;
const PHASE_STEP = 1.17;
const VERTICAL_NOISE_RATIO = 2.2 / 3;

type FloatNode = Node<"float">;
const createFloatUniform = (value: number) => uniform(value, "float");
type FloatUniformNode = ReturnType<typeof createFloatUniform>;

const fireRamp = /*#__PURE__*/ Fn(([heat]: [FloatNode]) => {
  const color = vec3(0.02, 0, 0).toVar();
  color.assign(mix(color, vec3(0.85, 0.06, 0.005), smoothstep(0.05, 0.35, heat)));
  color.assign(mix(color, vec3(1, 0.42, 0.02), smoothstep(0.35, 0.62, heat)));
  color.assign(mix(color, vec3(1, 0.85, 0.25), smoothstep(0.62, 0.85, heat)));
  color.assign(mix(color, vec3(1, 0.99, 0.88), smoothstep(0.85, 1, heat)));
  return color;
});

export class VertexConeFireBatch {
  readonly object: THREE.InstancedMesh<THREE.ConeGeometry, THREE.MeshBasicNodeMaterial>;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly radialScaleNode: FloatUniformNode;
  private readonly heightScaleNode: FloatUniformNode;
  private readonly speedNode: FloatUniformNode;
  private readonly noiseScaleNode: FloatUniformNode;
  private readonly turbulenceNode: FloatUniformNode;
  private readonly intensityNode: FloatUniformNode;
  private readonly transform = new THREE.Object3D();
  private radialSegments: number;
  private active = false;
  private sceneVisible = true;

  constructor(
    radialSegments: number,
    private readonly capacity: number,
  ) {
    validateRadialSegments(radialSegments);

    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Fire batch capacity must be a positive integer.");
    }

    this.radialSegments = radialSegments;
    this.radialScaleNode = createFloatUniform(1);
    this.heightScaleNode = createFloatUniform(1);
    this.speedNode = createFloatUniform(DEFAULT_FIRE_CONFIG.speed);
    this.noiseScaleNode = createFloatUniform(DEFAULT_FIRE_CONFIG.noiseScale);
    this.turbulenceNode = createFloatUniform(DEFAULT_FIRE_CONFIG.turbulence);
    this.intensityNode = createFloatUniform(DEFAULT_FIRE_CONFIG.intensity);
    this.material = createVertexConeMaterial(
      this.radialScaleNode,
      this.heightScaleNode,
      this.speedNode,
      this.noiseScaleNode,
      this.turbulenceNode,
      this.intensityNode,
    );
    this.object = new THREE.InstancedMesh(
      createConeGeometry(radialSegments),
      this.material,
      capacity,
    );
    this.object.name = "Fire bowl flames";
    this.object.count = 0;
    this.object.castShadow = false;
    this.object.receiveShadow = false;
  }

  update(config: VertexConeFireConfig): VertexConeFireStats {
    validateConfig(config, this.capacity);

    if (config.radialSegments !== this.radialSegments) {
      const previousGeometry = this.object.geometry;
      this.object.geometry = createConeGeometry(config.radialSegments);
      this.radialSegments = config.radialSegments;
      previousGeometry.dispose();
    }

    const flameCount = config.enabled ? config.placements.length : 0;
    this.object.count = flameCount;
    this.active = flameCount > 0;

    if (!this.active) {
      this.object.visible = false;
      this.object.boundingBox = null;
      this.object.boundingSphere = null;
      return this.getStats();
    }

    const radialScale = config.radius * config.scale / SOURCE_RADIUS;
    const heightScale = config.height * config.scale / SOURCE_HEIGHT;
    this.radialScaleNode.value = radialScale;
    this.heightScaleNode.value = heightScale;
    this.speedNode.value = config.speed;
    this.noiseScaleNode.value = config.noiseScale;
    this.turbulenceNode.value = config.turbulence;
    this.intensityNode.value = config.intensity;

    for (let index = 0; index < flameCount; index += 1) {
      const placement = config.placements[index];

      if (!placement) {
        continue;
      }

      this.transform.position.set(
        placement.x,
        placement.y + config.pillarHeight + config.baseHeight,
        placement.z,
      );
      this.transform.rotation.set(0, 0, 0);
      this.transform.scale.set(radialScale, heightScale, radialScale);
      this.transform.updateMatrix();
      this.object.setMatrixAt(index, this.transform.matrix);
    }

    this.object.instanceMatrix.needsUpdate = true;
    this.object.computeBoundingBox();

    if (this.object.boundingBox) {
      this.object.boundingBox.expandByVector(new THREE.Vector3(
        radialScale * 0.35 * config.turbulence,
        heightScale * 0.22 * config.turbulence,
        radialScale * 0.35 * config.turbulence,
      ));
      this.object.boundingSphere = this.object.boundingBox.getBoundingSphere(
        new THREE.Sphere(),
      );
    }

    this.object.visible = this.sceneVisible;
    return this.getStats();
  }

  setSceneVisible(visible: boolean): void {
    this.sceneVisible = visible;
    this.object.visible = this.active && visible;
  }

  getStats(): VertexConeFireStats {
    const flameCount = this.object.count;
    const vertexCount = this.object.geometry.getAttribute("position").count;
    const triangleCount = (this.object.geometry.index?.count ?? 0) / 3;

    return {
      flameCount,
      vertexCount: vertexCount * flameCount,
      triangleCount: triangleCount * flameCount,
      drawCallCount: flameCount > 0 ? 1 : 0,
    };
  }

  expandBounds(target: THREE.Box3): void {
    if (this.active && this.object.boundingBox) {
      target.union(this.object.boundingBox);
    }
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

function createVertexConeMaterial(
  radialScale: FloatUniformNode,
  heightScale: FloatUniformNode,
  speed: FloatUniformNode,
  noiseScale: FloatUniformNode,
  turbulence: FloatUniformNode,
  intensity: FloatUniformNode,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const phase = float(instanceIndex).mul(PHASE_STEP);
  const animatedTime = time.add(phase).mul(speed);
  const height = positionGeometry.y.div(SOURCE_HEIGHT).clamp(0, 1);
  const xNoise = varying(mx_fractal_noise_float(
    vec3(
      positionGeometry.x.mul(noiseScale),
      positionGeometry.y.mul(noiseScale).mul(VERTICAL_NOISE_RATIO).sub(animatedTime),
      positionGeometry.z.mul(noiseScale),
    ),
    3,
    2,
    0.55,
  ), "vFireNoise");
  const fragmentHeight = varying(height, "vFireHeight");

  material.positionNode = Fn(() => {
    const position = positionLocal.toVar();
    const amount = height.pow(1.3).mul(0.35);
    const zNoise = mx_fractal_noise_float(
      vec3(
        positionGeometry.z.mul(noiseScale),
        positionGeometry.y.mul(noiseScale).mul(VERTICAL_NOISE_RATIO).sub(animatedTime),
        positionGeometry.x.mul(noiseScale).add(7.7),
      ),
      3,
      2,
      0.55,
    );
    position.x.addAssign(xNoise.mul(amount).mul(radialScale).mul(turbulence));
    position.z.addAssign(zNoise.mul(amount).mul(radialScale).mul(turbulence));
    position.y.addAssign(
      xNoise.mul(height).mul(0.22).mul(heightScale).mul(turbulence),
    );
    return position;
  })();

  material.colorNode = Fn(() => {
    const heat = clamp(float(1).sub(fragmentHeight).add(xNoise.mul(0.25)), 0, 1);
    const alpha = smoothstep(1, 0.35, fragmentHeight)
      .mul(smoothstep(0, 0.18, fragmentHeight))
      .mul(0.85);
    return vec4(fireRamp(heat).mul(alpha).mul(intensity), alpha);
  })();

  return material;
}

function createConeGeometry(radialSegments: number): THREE.ConeGeometry {
  const geometry = new THREE.ConeGeometry(
    SOURCE_RADIUS,
    SOURCE_HEIGHT,
    radialSegments,
    VERTICAL_SEGMENTS,
    true,
  );
  geometry.translate(0, SOURCE_HEIGHT * 0.5, 0);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function validateConfig(config: VertexConeFireConfig, capacity: number): void {
  validateRadialSegments(config.radialSegments);

  if (typeof config.enabled !== "boolean") {
    throw new TypeError("Fire enabled must be a boolean.");
  }
  assertRange(config.scale, 0.1, 5, "Fire scale");
  assertRange(config.radius, 0.01, 5, "Fire radius");
  assertRange(config.height, 0.02, 10, "Fire height");
  assertRange(config.baseHeight, 0, 5, "Fire base height");
  assertRange(config.speed, 0, 10, "Fire speed");
  assertRange(config.noiseScale, 0.5, 12, "Fire noise scale");
  assertRange(config.turbulence, 0, 2, "Fire turbulence");
  assertRange(config.intensity, 0, 5, "Fire intensity");
  if (!Number.isFinite(config.pillarHeight) || config.pillarHeight <= 0) {
    throw new RangeError("Fire pillar height must be greater than zero.");
  }
  if (config.placements.length > capacity) {
    throw new RangeError(`Fire placement count cannot exceed ${capacity}.`);
  }

  for (const placement of config.placements) {
    if (![placement.x, placement.y, placement.z].every(Number.isFinite)) {
      throw new RangeError("Fire placements must contain finite coordinates.");
    }
  }
}

export function validateFireConfig(config: FireConfig): void {
  validateRadialSegments(config.radialSegments);

  if (typeof config.enabled !== "boolean") {
    throw new TypeError("Fire enabled must be a boolean.");
  }
  if (typeof config.glowEnabled !== "boolean") {
    throw new TypeError("Fire glow enabled must be a boolean.");
  }

  assertRange(config.scale, 0.1, 5, "Fire scale");
  assertRange(config.radius, 0.01, 5, "Fire radius");
  assertRange(config.height, 0.02, 10, "Fire height");
  assertRange(config.baseHeight, 0, 5, "Fire base height");
  assertRange(config.speed, 0, 10, "Fire speed");
  assertRange(config.noiseScale, 0.5, 12, "Fire noise scale");
  assertRange(config.turbulence, 0, 2, "Fire turbulence");
  assertRange(config.intensity, 0, 5, "Fire intensity");
  assertRange(config.glowIntensity, 0, 20, "Fire glow intensity");
  assertRange(config.glowDistance, 0.1, 20, "Fire glow distance");
  assertRange(config.glowFlicker, 0, 0.5, "Fire glow flicker");
}

function validateRadialSegments(radialSegments: number): void {
  if (
    !Number.isInteger(radialSegments)
    || radialSegments < 16
    || radialSegments > 64
    || radialSegments % 4 !== 0
  ) {
    throw new RangeError("Fire radial segments must be a multiple of 4 from 16 to 64.");
  }
}

function assertRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
}
