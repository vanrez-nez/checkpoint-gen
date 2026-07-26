import {
  assertPositive,
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../config/control-spec";
import {
  cloneBevelConfig,
  cloneStoneConfig,
  createBevelControls,
  createStoneControls,
  toStoneDetail,
  type BevelConfig,
  type StoneConfig,
} from "../../config/sections";
import type { PillarGeometryConfig } from "./generator";

export interface PillarConfig {
  height: number;
  shaftWidth: number;
  baseSteps: number;
  shaftCourses: number;
  shaftSubdivisions: number;
  stone: StoneConfig;
  bevel: BevelConfig;
}

export const DEFAULT_PILLAR_CONFIG: Readonly<PillarConfig> = {
  height: 1,
  shaftWidth: 0.2,
  baseSteps: 2,
  shaftCourses: 5,
  shaftSubdivisions: 2,
  stone: {
    seed: 1381,
    gapRatio: 0.04,
    sizeVariation: 0.4,
    displacement: 0.15,
  },
  bevel: {
    enabled: true,
    widthRatio: 0.14,
    depthRatio: 0.3,
    variation: 0.6,
  },
};

const control = controlsFor<PillarConfig>();

export const PILLAR_LAYOUT_CONTROLS: readonly ControlSpec<PillarConfig>[] = [
  control.number({
    key: "height",
    group: "Layout",
    name: "Pillar height",
    min: 1,
    max: 12,
    step: 0.1,
    scopes: ["pillars"],
    reframe: true,
  }),
  control.number({
    key: "shaftWidth",
    label: "shaft width",
    name: "Pillar shaft width",
    group: "Layout",
    min: 0.1,
    max: 3,
    step: 0.01,
    scopes: ["pillars"],
    reframe: true,
  }),
  control.number({
    key: "baseSteps",
    label: "base steps",
    name: "Base steps",
    group: "Layout",
    min: 1,
    max: 4,
    step: 1,
    integer: true,
    scopes: ["pillars"],
    reframe: true,
  }),
  control.number({
    key: "shaftCourses",
    label: "shaft courses",
    name: "Shaft courses",
    group: "Layout",
    min: 1,
    max: 8,
    step: 1,
    integer: true,
    scopes: ["pillars"],
  }),
  control.number({
    key: "shaftSubdivisions",
    label: "shaft subdivisions",
    name: "Shaft subdivisions",
    group: "Layout",
    min: 1,
    max: 4,
    step: 1,
    integer: true,
    scopes: ["pillars"],
  }),
];

export const PILLAR_STONE_CONTROLS = createStoneControls(["pillars"]);
export const PILLAR_BEVEL_CONTROLS = createBevelControls(["pillars"]);

export function clonePillarConfig(source: Readonly<PillarConfig>): PillarConfig {
  return {
    ...source,
    stone: cloneStoneConfig(source.stone),
    bevel: cloneBevelConfig(source.bevel),
  };
}

export function validatePillarConfig(config: PillarConfig): void {
  assertPositive(config.height, "Pillar height");
  assertPositive(config.shaftWidth, "Pillar shaft width");
  validateControls(config, PILLAR_LAYOUT_CONTROLS);
  validateControls(config.stone, PILLAR_STONE_CONTROLS);
  validateControls(config.bevel, PILLAR_BEVEL_CONTROLS);
}

/**
 * Flattens the nested config into the shape `createPillarGeometry` consumes, so
 * the masonry generator keeps its original body. `seed` is passed separately
 * because each placement derives its own from the shared pillar seed.
 */
export function toPillarGeometryConfig(
  config: PillarConfig,
  seed: number,
): PillarGeometryConfig {
  return {
    height: config.height,
    shaftWidth: config.shaftWidth,
    baseSteps: config.baseSteps,
    shaftCourses: config.shaftCourses,
    shaftSubdivisions: config.shaftSubdivisions,
    stoneGapRatio: config.stone.gapRatio,
    sizeVariation: config.stone.sizeVariation,
    displacement: config.stone.displacement,
    ...toStoneDetail(config.stone, config.bevel),
    seed,
  };
}
