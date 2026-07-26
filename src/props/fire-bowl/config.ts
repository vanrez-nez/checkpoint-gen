import {
  assertPositive,
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../config/control-spec";

export interface FireBowlConfig {
  enabled: boolean;
  scale: number;
  radialSegments: number;
}

export const DEFAULT_FIRE_BOWL_CONFIG: Readonly<FireBowlConfig> = {
  enabled: true,
  scale: 0.5,
  radialSegments: 16,
};

const control = controlsFor<FireBowlConfig>();

export const FIRE_BOWL_CONTROLS: readonly ControlSpec<FireBowlConfig>[] = [
  control.boolean({
    key: "enabled",
    group: "Fire Bowl",
    name: "Fire bowl enabled",
    scopes: ["bowls"],
    reframe: true,
  }),
  control.number({
    key: "scale",
    group: "Fire Bowl",
    name: "Fire bowl scale",
    min: 0.5,
    max: 2,
    step: 0.05,
    scopes: ["bowls"],
    reframe: true,
  }),
  control.number({
    key: "radialSegments",
    label: "radial detail",
    name: "Fire bowl radial segments",
    group: "Fire Bowl",
    min: 16,
    max: 64,
    step: 4,
    integer: true,
    scopes: ["bowls"],
  }),
];

export function cloneFireBowlConfig(source: Readonly<FireBowlConfig>): FireBowlConfig {
  return { ...source };
}

export function validateFireBowlConfig(
  config: FireBowlConfig,
  referenceWidth: number,
): void {
  validateControls(config, FIRE_BOWL_CONTROLS);
  assertPositive(referenceWidth, "Fire bowl reference width");
}
