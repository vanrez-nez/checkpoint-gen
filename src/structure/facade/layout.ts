import { structurePath } from "../kernel/ids";
import { DiagnosticCollector } from "../kernel/validate";
import type {
  FacadeBandRecord,
  FacadeBandRule,
  FacadeBayRecord,
  FacadeBayRule,
  FacadeSymmetry,
} from "./types";

const EPS = 1e-9;

export interface FacadeMargins {
  readonly start: number;
  readonly end: number;
}

/** Resolves authored fixed and weighted horizontal intervals into stable UV bays. */
export function resolveFacadeBays(
  facadeId: string,
  width: number,
  margins: FacadeMargins,
  rules: readonly FacadeBayRule[],
  symmetry: FacadeSymmetry,
  diagnostics: DiagnosticCollector,
): readonly FacadeBayRecord[] | null {
  if (!Number.isFinite(width) || width <= 0 || rules.length === 0) {
    diagnostics.error(
      "facade.invalid_bay_domain",
      facadeId,
      "A facade needs positive width and at least one bay rule.",
    );
    return null;
  }
  if (
    !Number.isFinite(margins.start)
    || !Number.isFinite(margins.end)
    || margins.start < 0
    || margins.end < 0
    || margins.start + margins.end >= width - EPS
  ) {
    diagnostics.error(
      "facade.invalid_margins",
      facadeId,
      "Facade margins must be non-negative and leave positive bay width.",
    );
    return null;
  }
  if (!validRuleIds(rules.map((rule) => rule.id))) {
    diagnostics.error(
      "facade.duplicate_bay_id",
      facadeId,
      "Facade bay rule ids must be unique and non-empty.",
    );
    return null;
  }
  if (!rules.every(validBayRule)) {
    diagnostics.error(
      "facade.invalid_bay_rule",
      facadeId,
      "Each bay needs exactly one positive fixed width or positive weight.",
    );
    return null;
  }
  if (symmetry === "bilateral" && !rulesAreMirrored(rules)) {
    diagnostics.error(
      "facade.bays_not_bilateral",
      facadeId,
      "A bilateral facade needs mirrored bay roles, dimensions and hierarchy.",
    );
    return null;
  }

  const available = width - margins.start - margins.end;
  const fixed = rules.reduce((sum, rule) => sum + (rule.width ?? 0), 0);
  const weight = rules.reduce((sum, rule) => sum + (rule.weight ?? 0), 0);
  const weightedSpace = available - fixed;

  if (weightedSpace < -EPS || (weight <= EPS && weightedSpace > EPS)) {
    diagnostics.error(
      "facade.bays_do_not_fit",
      facadeId,
      "Fixed bays exceed the facade domain or leave space with no weighted bay to receive it.",
    );
    return null;
  }

  let cursor = margins.start;
  return rules.map((rule, index) => {
    const resolvedWidth = rule.width
      ?? (weight > EPS ? weightedSpace * (rule.weight ?? 0) / weight : 0);
    const start = cursor;
    const end = index === rules.length - 1
      ? width - margins.end
      : cursor + resolvedWidth;
    cursor = end;

    return {
      id: structurePath(facadeId, rule.id),
      index,
      role: rule.role,
      hierarchy: rule.hierarchy,
      uRange: [start / width, end / width],
      width: end - start,
    } satisfies FacadeBayRecord;
  });
}

/** Resolves fixed-height and weighted vertical facade bands. */
export function resolveFacadeBands(
  facadeId: string,
  height: number,
  rules: readonly FacadeBandRule[],
  diagnostics: DiagnosticCollector,
): readonly FacadeBandRecord[] | null {
  if (!Number.isFinite(height) || height <= 0 || rules.length === 0) {
    diagnostics.error(
      "facade.invalid_band_domain",
      facadeId,
      "A facade needs positive height and at least one vertical band rule.",
    );
    return null;
  }
  if (!validRuleIds(rules.map((rule) => rule.id))) {
    diagnostics.error(
      "facade.duplicate_band_id",
      facadeId,
      "Facade band rule ids must be unique and non-empty.",
    );
    return null;
  }
  if (!rules.every(validBandRule)) {
    diagnostics.error(
      "facade.invalid_band_rule",
      facadeId,
      "Each facade band needs exactly one positive fixed height or positive weight.",
    );
    return null;
  }

  const fixed = rules.reduce((sum, rule) => sum + (rule.height ?? 0), 0);
  const weight = rules.reduce((sum, rule) => sum + (rule.weight ?? 0), 0);
  const weightedSpace = height - fixed;

  if (weightedSpace < -EPS || (weight <= EPS && weightedSpace > EPS)) {
    diagnostics.error(
      "facade.bands_do_not_fit",
      facadeId,
      "Fixed facade bands exceed the wall height or leave height with no weighted band to receive it.",
    );
    return null;
  }

  let cursor = 0;
  return rules.map((rule, index) => {
    const resolvedHeight = rule.height
      ?? (weight > EPS ? weightedSpace * (rule.weight ?? 0) / weight : 0);
    const start = cursor;
    const end = index === rules.length - 1 ? height : cursor + resolvedHeight;
    cursor = end;

    return {
      id: structurePath(facadeId, rule.id),
      index,
      role: rule.role,
      continuity: rule.continuity,
      vRange: [start / height, end / height],
      height: end - start,
    } satisfies FacadeBandRecord;
  });
}

function validRuleIds(ids: readonly string[]): boolean {
  return ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;
}

function validBayRule(rule: FacadeBayRule): boolean {
  const fixed = rule.width !== undefined;
  const weighted = rule.weight !== undefined;
  return fixed !== weighted
    && Number.isFinite(rule.width ?? rule.weight)
    && (rule.width ?? rule.weight ?? 0) > 0;
}

function validBandRule(rule: FacadeBandRule): boolean {
  const fixed = rule.height !== undefined;
  const weighted = rule.weight !== undefined;
  return fixed !== weighted
    && Number.isFinite(rule.height ?? rule.weight)
    && (rule.height ?? rule.weight ?? 0) > 0;
}

function rulesAreMirrored(rules: readonly FacadeBayRule[]): boolean {
  for (let index = 0; index < Math.floor(rules.length / 2); index += 1) {
    const left = rules[index];
    const right = rules[rules.length - 1 - index];
    if (
      !left
      || !right
      || left.role !== right.role
      || left.hierarchy !== right.hierarchy
      || !sameOptionalNumber(left.width, right.width)
      || !sameOptionalNumber(left.weight, right.weight)
    ) {
      return false;
    }
  }
  return true;
}

function sameOptionalNumber(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : Math.abs(a - b) <= EPS;
}
