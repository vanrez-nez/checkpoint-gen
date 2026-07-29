import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../config/control-spec";

export interface OfferingConfig {
  enabled: boolean;
  pedestalFit: number;
  verticalOffset: number;
  rotationDegrees: number;
  materialScale: number;
}

export const DEFAULT_OFFERING_CONFIG: Readonly<OfferingConfig> = {
  enabled: true,
  pedestalFit: 1.105,
  verticalOffset: 0,
  rotationDegrees: 0,
  materialScale: 6,
};

const control = controlsFor<OfferingConfig>();

export const OFFERING_CONTROLS: readonly ControlSpec<OfferingConfig>[] = [
  control.boolean({
    key: "enabled",
    group: "Layout",
    name: "Offering enabled",
    scopes: ["offering"],
  }),
  control.number({
    key: "pedestalFit",
    label: "pedestal fit",
    name: "Offering pedestal fit",
    group: "Layout",
    min: 0.1,
    max: 1.5,
    step: 0.01,
    scopes: ["offering"],
  }),
  control.number({
    key: "verticalOffset",
    label: "vertical offset",
    name: "Offering vertical offset",
    group: "Layout",
    min: -1,
    max: 1,
    step: 0.01,
    scopes: ["offering"],
  }),
  control.number({
    key: "rotationDegrees",
    label: "rotation",
    name: "Offering rotation",
    group: "Layout",
    min: -180,
    max: 180,
    step: 1,
    scopes: ["offering"],
  }),
  control.number({
    key: "materialScale",
    label: "material scale",
    name: "Offering material scale",
    group: "Material",
    min: 0.1,
    max: 8,
    step: 0.05,
    scopes: ["offering"],
  }),
];

export function cloneOfferingConfig(source: Readonly<OfferingConfig>): OfferingConfig {
  return { ...source };
}

export function validateOfferingConfig(config: OfferingConfig): void {
  validateControls(config, OFFERING_CONTROLS);
}
