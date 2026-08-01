import type { Diagnostic } from "../kernel/validate";
import { evaluateFrame } from "../kernel/frame";
import {
  IMPLEMENTED_PATCH_OPERATIONS,
  PATCH_OPERATIONS,
  type Patch,
  type PatchFeature,
  type PatchOperation,
  type PatchRegion,
} from "../kernel/patch";

const EPS = 1e-9;

/** A rectangular fragment in one patch's stable normalized domain. */
export interface FeatureRegionFragment {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** One accepted feature and the region fragments it may execute over. */
export interface CompiledPatchFeature {
  readonly feature: PatchFeature;
  readonly region: PatchRegion;
  readonly fragments: readonly FeatureRegionFragment[];
}

export interface CompiledPatchFeatures {
  readonly features: readonly CompiledPatchFeature[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Axis-aligned world bounds of one executable cut fragment. */
export interface CutWorldBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Compiles one patch's declarative features without mutating the patch.
 *
 * Explicit dependency edges decide ordering first. Among otherwise-ready
 * features, the stable order is operation phase, higher region priority,
 * authored order, then id. That makes graph serialization and geometry
 * independent of insertion order.
 */
export function compilePatchFeatures(patch: Patch): CompiledPatchFeatures {
  const diagnostics: Diagnostic[] = [];
  const regions = indexRegions(patch, diagnostics);
  const features = indexFeatures(patch, diagnostics);
  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();

  for (const feature of patch.features) {
    edges.set(feature.id, new Set());
    incoming.set(feature.id, 0);
    validateFeature(patch, feature, regions, diagnostics);
  }

  for (const feature of patch.features) {
    for (const reference of [...feature.dependsOn, ...feature.runsAfter]) {
      addDependencyEdge(patch, reference, feature.id, features, edges, incoming, diagnostics);
    }
    for (const reference of feature.runsBefore) {
      addDependencyEdge(patch, feature.id, reference, features, edges, incoming, diagnostics);
    }
  }

  const ready = patch.features
    .filter((feature) => (incoming.get(feature.id) ?? 0) === 0)
    .sort((a, b) => compareFeatures(a, b, regions));
  const ordered: PatchFeature[] = [];

  while (ready.length > 0) {
    const current = ready.shift();

    if (!current) {
      break;
    }

    ordered.push(current);
    for (const nextId of edges.get(current.id) ?? []) {
      const remaining = (incoming.get(nextId) ?? 0) - 1;
      incoming.set(nextId, remaining);

      if (remaining === 0) {
        const next = features.get(nextId);
        if (next) {
          ready.push(next);
          ready.sort((a, b) => compareFeatures(a, b, regions));
        }
      }
    }
  }

  if (ordered.length !== patch.features.length) {
    const cyclic = patch.features
      .filter((feature) => !ordered.some((candidate) => candidate.id === feature.id))
      .map((feature) => feature.id)
      .sort();
    diagnostics.push(error(
      "feature.dependency_cycle",
      patch.id,
      `Patch features contain a dependency cycle: ${cyclic.join(", ")}.`,
    ));
  }

  const accepted: CompiledPatchFeature[] = [];

  for (const feature of ordered) {
    const region = feature.regionId ? regions.get(feature.regionId) : undefined;

    if (!region || !IMPLEMENTED_PATCH_OPERATIONS.includes(feature.operation)) {
      continue;
    }

    const unavailableDependencies = feature.dependsOn.filter(
      (dependencyId) =>
        !accepted.some((candidate) => candidate.feature.id === dependencyId),
    );
    if (unavailableDependencies.length > 0) {
      diagnostics.push(error(
        "feature.dependency_unresolved",
        feature.id,
        `Feature dependencies did not produce an executable result: ${unavailableDependencies.join(", ")}.`,
      ));
      continue;
    }

    let fragments = [regionFragment(region)];
    const conflicts = accepted.filter((candidate) =>
      regionsConflict(region, candidate.region)
      && fragments.some((fragment) =>
        candidate.fragments.some((other) => overlaps(fragment, other))),
    );

    if (conflicts.length === 0) {
      accepted.push({ feature, region, fragments });
      continue;
    }

    const conflictIds = conflicts.map((candidate) => candidate.feature.id).sort();
    switch (feature.conflictPolicy) {
      case "error":
        diagnostics.push(error(
          "feature.conflict",
          feature.id,
          `Feature conflicts with ${conflictIds.join(", ")}.`,
        ));
        break;
      case "skip":
        diagnostics.push(notice(
          "feature.conflict_skipped",
          feature.id,
          `Feature was skipped because it conflicts with ${conflictIds.join(", ")}.`,
          "skipped",
        ));
        break;
      case "replace":
        if (conflicts.some((conflict) => feature.dependsOn.includes(conflict.feature.id))) {
          diagnostics.push(error(
            "feature.dependency_replaced",
            feature.id,
            "A feature cannot replace a result it declares as a dependency.",
          ));
          break;
        }
        for (const conflict of conflicts) {
          const index = accepted.indexOf(conflict);
          if (index >= 0) {
            accepted.splice(index, 1);
          }
        }
        accepted.push({ feature, region, fragments });
        diagnostics.push(notice(
          "feature.conflict_replaced",
          feature.id,
          `Feature replaced ${conflictIds.join(", ")}.`,
          conflictIds.join(","),
        ));
        break;
      case "clip":
        for (const conflict of conflicts) {
          for (const occupied of conflict.fragments) {
            fragments = fragments.flatMap((fragment) => subtractRect(fragment, occupied));
          }
        }
        if (fragments.length > 0) {
          accepted.push({ feature, region, fragments });
        }
        diagnostics.push(notice(
          "feature.conflict_clipped",
          feature.id,
          `Feature was clipped around ${conflictIds.join(", ")}.`,
          fragments.length === 0
            ? "empty"
            : fragments.map(formatFragment).join(";"),
        ));
        break;
    }
  }

  return { features: accepted, diagnostics };
}

/** The executable cut fragments on a validated patch. */
export function compiledCutFragments(patch: Patch): readonly FeatureRegionFragment[] {
  const compiled = compilePatchFeatures(patch);
  const failure = compiled.diagnostics.find((entry) => entry.severity === "error");

  if (failure) {
    throw new Error(`${failure.message} (${failure.code})`);
  }

  return compiled.features
    .filter((entry) => entry.feature.operation === "cut")
    .flatMap((entry) => entry.fragments);
}

/** World-space cut bounds used to validate paired faces of the same wall. */
export function compiledCutWorldBounds(
  patch: Patch,
  compiled: CompiledPatchFeatures = compilePatchFeatures(patch),
): readonly CutWorldBounds[] {
  const failure = compiled.diagnostics.find((entry) => entry.severity === "error");

  if (failure) {
    return [];
  }

  return compiled.features
    .filter((entry) => entry.feature.operation === "cut")
    .flatMap((entry) => entry.fragments)
    .map((fragment) => {
      const corners = [
        evaluateFrame(patch.frame, fragment.uMin, fragment.vMin),
        evaluateFrame(patch.frame, fragment.uMax, fragment.vMin),
        evaluateFrame(patch.frame, fragment.uMin, fragment.vMax),
        evaluateFrame(patch.frame, fragment.uMax, fragment.vMax),
      ];

      return {
        minX: Math.min(...corners.map((point) => point.x)),
        maxX: Math.max(...corners.map((point) => point.x)),
        minY: Math.min(...corners.map((point) => point.y)),
        maxY: Math.max(...corners.map((point) => point.y)),
        minZ: Math.min(...corners.map((point) => point.z)),
        maxZ: Math.max(...corners.map((point) => point.z)),
      };
    });
}

function indexRegions(
  patch: Patch,
  diagnostics: Diagnostic[],
): Map<string, PatchRegion> {
  const regions = new Map<string, PatchRegion>();

  for (const region of patch.regions) {
    if (regions.has(region.id)) {
      diagnostics.push(error(
        "region.duplicate_id",
        region.id,
        `Patch "${patch.id}" contains duplicate region id "${region.id}".`,
      ));
      continue;
    }
    regions.set(region.id, region);

    if (!validRange(region.uRange) || !validRange(region.vRange)) {
      diagnostics.push(error(
        "region.invalid_bounds",
        region.id,
        "Region bounds must be ordered inside the normalized patch domain.",
      ));
    }
    for (const operation of region.allowedOperations) {
      if (!PATCH_OPERATIONS.includes(operation)) {
        diagnostics.push(error(
          "region.operation_unknown",
          region.id,
          `Region permits unknown operation "${String(operation)}".`,
        ));
      }
    }
  }

  for (const region of patch.regions) {
    for (const excludedId of region.exclusions) {
      if (!regions.has(excludedId)) {
        diagnostics.push(error(
          "region.exclusion_missing",
          region.id,
          `Region excludes missing region "${excludedId}" on patch "${patch.id}".`,
        ));
      }
    }
  }

  return regions;
}

function indexFeatures(
  patch: Patch,
  diagnostics: Diagnostic[],
): Map<string, PatchFeature> {
  const features = new Map<string, PatchFeature>();

  for (const feature of patch.features) {
    if (features.has(feature.id)) {
      diagnostics.push(error(
        "feature.duplicate_id",
        feature.id,
        `Patch "${patch.id}" contains duplicate feature id "${feature.id}".`,
      ));
      continue;
    }
    features.set(feature.id, feature);
  }

  return features;
}

function validateFeature(
  patch: Patch,
  feature: PatchFeature,
  regions: ReadonlyMap<string, PatchRegion>,
  diagnostics: Diagnostic[],
): void {
  if (!PATCH_OPERATIONS.includes(feature.operation)) {
    diagnostics.push(error(
      "feature.operation_unknown",
      feature.id,
      `Feature names unknown operation "${String(feature.operation)}".`,
    ));
    return;
  }

  if (!IMPLEMENTED_PATCH_OPERATIONS.includes(feature.operation)) {
    diagnostics.push(error(
      "feature.operation_unimplemented",
      feature.id,
      `Patch operation "${feature.operation}" is declared but not implemented in this phase.`,
    ));
  }

  if (feature.operation === "cut" && patch.evaluator !== "planar") {
    diagnostics.push(error(
      "feature.evaluator_unsupported",
      feature.id,
      `Patch operation "cut" currently requires a planar patch, not "${patch.evaluator}".`,
    ));
  }

  if (!feature.regionId) {
    diagnostics.push(error(
      "feature.region_required",
      feature.id,
      `Patch operation "${feature.operation}" requires a target region.`,
    ));
    return;
  }

  const region = regions.get(feature.regionId);
  if (!region) {
    diagnostics.push(error(
      "feature.region_missing",
      feature.id,
      `Feature names missing region "${feature.regionId}" on patch "${patch.id}".`,
    ));
    return;
  }

  if (!region.allowedOperations.includes(feature.operation)) {
    diagnostics.push(error(
      "feature.operation_disallowed",
      feature.id,
      `Region "${region.id}" does not permit operation "${feature.operation}".`,
    ));
  }
}

function addDependencyEdge(
  patch: Patch,
  from: string,
  to: string,
  features: ReadonlyMap<string, PatchFeature>,
  edges: Map<string, Set<string>>,
  incoming: Map<string, number>,
  diagnostics: Diagnostic[],
): void {
  if (!features.has(from) || !features.has(to)) {
    const missing = !features.has(from) ? from : to;
    diagnostics.push(error(
      "feature.dependency_missing",
      patch.id,
      `Feature dependency "${missing}" does not exist on patch "${patch.id}".`,
    ));
    return;
  }

  const outgoing = edges.get(from);
  if (!outgoing || outgoing.has(to)) {
    return;
  }
  outgoing.add(to);
  incoming.set(to, (incoming.get(to) ?? 0) + 1);
}

function compareFeatures(
  a: PatchFeature,
  b: PatchFeature,
  regions: ReadonlyMap<string, PatchRegion>,
): number {
  const operation = operationPrecedence(a.operation) - operationPrecedence(b.operation);
  if (operation !== 0) {
    return operation;
  }

  const priority = (regions.get(b.regionId ?? "")?.priority ?? 0)
    - (regions.get(a.regionId ?? "")?.priority ?? 0);
  if (priority !== 0) {
    return priority;
  }

  return a.order - b.order || a.id.localeCompare(b.id);
}

/** Mirrors the specification's coarse feature-precedence stages. */
function operationPrecedence(operation: PatchOperation): number {
  switch (operation) {
    case "replace":
    case "step":
    case "slope":
    case "clip":
      return 10;
    case "cut":
      return 20;
    case "inset":
    case "extrude":
    case "frame":
    case "cap":
    case "border":
      return 30;
    case "subdivide":
    case "repeat":
      return 40;
    case "attach":
      return 50;
    case "remove":
      return 60;
    case "displace":
      return 70;
  }
}

function regionsConflict(a: PatchRegion, b: PatchRegion): boolean {
  return a.exclusions.includes(b.id)
    || b.exclusions.includes(a.id)
    || overlaps(regionFragment(a), regionFragment(b));
}

function regionFragment(region: PatchRegion): FeatureRegionFragment {
  return {
    uMin: region.uRange[0],
    uMax: region.uRange[1],
    vMin: region.vRange[0],
    vMax: region.vRange[1],
  };
}

function overlaps(a: FeatureRegionFragment, b: FeatureRegionFragment): boolean {
  return a.uMin < b.uMax - EPS
    && a.uMax > b.uMin + EPS
    && a.vMin < b.vMax - EPS
    && a.vMax > b.vMin + EPS;
}

function subtractRect(
  source: FeatureRegionFragment,
  occupied: FeatureRegionFragment,
): FeatureRegionFragment[] {
  if (!overlaps(source, occupied)) {
    return [source];
  }

  const uMin = Math.max(source.uMin, occupied.uMin);
  const uMax = Math.min(source.uMax, occupied.uMax);
  const vMin = Math.max(source.vMin, occupied.vMin);
  const vMax = Math.min(source.vMax, occupied.vMax);
  const pieces: FeatureRegionFragment[] = [
    { uMin: source.uMin, uMax: uMin, vMin: source.vMin, vMax: source.vMax },
    { uMin: uMax, uMax: source.uMax, vMin: source.vMin, vMax: source.vMax },
    { uMin, uMax, vMin: source.vMin, vMax: vMin },
    { uMin, uMax, vMin: vMax, vMax: source.vMax },
  ];

  return pieces.filter((piece) =>
    piece.uMax > piece.uMin + EPS && piece.vMax > piece.vMin + EPS);
}

function validRange(range: readonly [number, number]): boolean {
  return Number.isFinite(range[0])
    && Number.isFinite(range[1])
    && range[0] >= -EPS
    && range[1] <= 1 + EPS
    && range[1] > range[0] + EPS;
}

function formatFragment(fragment: FeatureRegionFragment): string {
  return [fragment.uMin, fragment.uMax, fragment.vMin, fragment.vMax]
    .map((value) => Number(value.toFixed(9)))
    .join(",");
}

function error(code: string, entityId: string, message: string): Diagnostic {
  return { severity: "error", code, entityId, message };
}

function notice(
  code: string,
  entityId: string,
  message: string,
  resolved: string,
): Diagnostic {
  return { severity: "notice", code, entityId, message, resolved };
}
