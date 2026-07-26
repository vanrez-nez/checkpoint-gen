import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../config/control-spec";

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

const control = controlsFor<FireConfig>();

/**
 * Ranges match what the pane always exposed. The previous standalone validator
 * allowed wider bands for radius (to 5), height (to 10), baseHeight (to 5) and
 * glowDistance (to 20) that no control could ever reach; the narrower pane
 * range wins now that both read this table.
 *
 * VertexConeFireBatch keeps its own wider internal guard, because that one
 * protects the class against arbitrary callers rather than against the UI.
 */
export const FIRE_CONTROLS: readonly ControlSpec<FireConfig>[] = [
  control.boolean({
    key: "enabled",
    group: "Flame",
    name: "Fire enabled",
    scopes: ["fire"],
    reframe: true,
  }),
  control.number({
    key: "scale",
    group: "Flame",
    name: "Fire scale",
    min: 0.1,
    max: 5,
    step: 0.05,
    scopes: ["fire"],
    reframe: true,
  }),
  control.number({
    key: "radius",
    group: "Flame",
    name: "Fire radius",
    min: 0.01,
    max: 1,
    step: 0.005,
    scopes: ["fire"],
    reframe: true,
  }),
  control.number({
    key: "height",
    group: "Flame",
    name: "Fire height",
    min: 0.02,
    max: 2,
    step: 0.01,
    scopes: ["fire"],
    reframe: true,
  }),
  control.number({
    key: "baseHeight",
    label: "base height",
    name: "Fire base height",
    group: "Flame",
    min: 0,
    max: 1,
    step: 0.005,
    scopes: ["fire"],
    reframe: true,
  }),
  control.number({
    key: "radialSegments",
    label: "radial detail",
    name: "Fire radial segments",
    group: "Flame",
    min: 16,
    max: 64,
    step: 4,
    integer: true,
    scopes: ["fire"],
  }),
  control.number({
    key: "speed",
    group: "Flame",
    name: "Fire speed",
    min: 0,
    max: 10,
    step: 0.1,
    scopes: ["fire"],
  }),
  control.number({
    key: "noiseScale",
    label: "noise scale",
    name: "Fire noise scale",
    group: "Flame",
    min: 0.5,
    max: 12,
    step: 0.1,
    scopes: ["fire"],
  }),
  control.number({
    key: "turbulence",
    group: "Flame",
    name: "Fire turbulence",
    min: 0,
    max: 2,
    step: 0.05,
    scopes: ["fire"],
  }),
  control.number({
    key: "intensity",
    group: "Flame",
    name: "Fire intensity",
    min: 0,
    max: 5,
    step: 0.05,
    scopes: ["fire"],
  }),
  control.boolean({
    key: "glowEnabled",
    label: "enabled",
    name: "Fire glow enabled",
    group: "Glow",
    scopes: ["fire"],
  }),
  control.number({
    key: "glowIntensity",
    label: "intensity",
    name: "Fire glow intensity",
    group: "Glow",
    min: 0,
    max: 20,
    step: 0.1,
    scopes: ["fire"],
  }),
  control.number({
    key: "glowDistance",
    label: "distance",
    name: "Fire glow distance",
    group: "Glow",
    min: 0.1,
    max: 10,
    step: 0.1,
    scopes: ["fire"],
  }),
  control.number({
    key: "glowFlicker",
    label: "flicker",
    name: "Fire glow flicker",
    group: "Glow",
    min: 0,
    max: 0.5,
    step: 0.01,
    scopes: ["fire"],
  }),
];

export function cloneFireConfig(source: Readonly<FireConfig>): FireConfig {
  return { ...source };
}

export function validateFireConfig(config: FireConfig): void {
  validateControls(config, FIRE_CONTROLS);
}
