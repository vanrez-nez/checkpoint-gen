import type {
  CellExteriorOpeningRequest,
  ResolvedCell,
} from "../cell/resolve";
import {
  rectDepth,
  rectWidth,
  type HorizontalOrientation,
  type LocalFrame,
  type Rect,
} from "../kernel/frame";
import type { CellOpeningRecord, CellRecord } from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchFeature,
  type PatchRegion,
} from "../kernel/patch";
import { DiagnosticCollector } from "../kernel/validate";
import { resolveFacadeBands, resolveFacadeBays } from "./layout";
import type {
  FacadeBandRecord,
  FacadeBandRule,
  FacadeBayRecord,
  FacadeBayRule,
  FacadeRecord,
  FacadeSpec,
} from "./types";

const EPS = 1e-9;

export interface ResolvedCellFacades {
  readonly cell: CellRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
  readonly facades: readonly FacadeRecord[];
}

/**
 * Applies one reusable facade grammar to the bare exterior wall pairs emitted
 * by Cell. Cell owns rooms and circulation destinations; Facade owns where and
 * how those requirements modify the public wall surface.
 */
export function resolveCellFacades(
  resolved: ResolvedCell,
  spec: FacadeSpec,
  diagnostics: DiagnosticCollector,
): ResolvedCellFacades | null {
  if (!validSpec(spec, resolved.record, diagnostics)) {
    return null;
  }

  const patches = new Map(resolved.patches.map((patch) => [patch.id, patch]));
  const links = [...resolved.links];
  const openings: CellOpeningRecord[] = [];
  const facades: FacadeRecord[] = [];
  const extraPatchIds: string[] = [];

  for (const wall of resolved.record.walls) {
    const exterior = patches.get(wall.outerPatchId);
    const interior = patches.get(wall.innerPatchId);
    if (!exterior || !interior) {
      diagnostics.error(
        "facade.wall_patch_missing",
        resolved.record.id,
        `Facade target is missing wall pair "${wall.outerPatchId}" / "${wall.innerPatchId}".`,
      );
      return null;
    }

    const request = resolved.exteriorOpenings.find(
      (candidate) => candidate.direction === wall.orientation,
    ) ?? null;
    const facadeId = structurePath(
      resolved.record.id,
      `facade_${segment(wall.orientation)}`,
    );
    const margin = resolved.record.wallThickness;
    const bayRules = facadeBayRules(resolved.record, wall.orientation, request, spec);
    const symmetry = "bilateral" as const;
    const bays = resolveFacadeBays(
      facadeId,
      exterior.frame.uLength,
      { start: margin, end: margin },
      bayRules,
      symmetry,
      diagnostics,
    );
    const bandRules = facadeBandRules(spec);
    const bands = resolveFacadeBands(
      facadeId,
      exterior.frame.vLength,
      bandRules,
      diagnostics,
    );

    if (!bays || !bands) {
      return null;
    }

    let exteriorPatch = withLayoutRegions(exterior, bays, bands);
    let interiorPatch = interior;
    const featureIds: string[] = [];

    if (request) {
      const result = addThroughOpening(
        exteriorPatch,
        interiorPatch,
        request.id,
        "portal",
        request.threshold,
        request.bottomY,
        request.topY,
        200,
        "portalReveal",
      );
      exteriorPatch = result.exterior;
      interiorPatch = result.interior;
      featureIds.push(...result.featureIds);
      const reveals = openingRevealPatches(
        request.id,
        request.threshold,
        request.direction,
        request.bottomY,
        request.topY,
        false,
      );
      for (const reveal of reveals) {
        patches.set(reveal.id, reveal);
        extraPatchIds.push(reveal.id);
        links.push([wall.outerPatchId, reveal.id], [wall.innerPatchId, reveal.id]);
      }
      linkRevealLoop(reveals, links);
      openings.push({
        id: request.id,
        kind: request.kind,
        direction: request.direction,
        width: request.width,
        height: request.height,
        bottomY: request.bottomY,
        topY: request.topY,
        threshold: request.threshold,
        exteriorPatchId: request.exteriorPatchId,
        interiorPatchId: request.interiorPatchId,
        destinationRoomIds: request.destinationRoomIds,
        revealPatchIds: reveals.map((patch) => patch.id),
      });
    }

    if (spec.style === "hierarchical") {
      const openingBand = bands.find((band) => band.role === "opening_zone")
        ?? bands[0]!;
      const hierarchy = addHierarchicalFeatures({
        cell: resolved.record,
        facadeId,
        direction: wall.orientation,
        exterior: exteriorPatch,
        interior: interiorPatch,
        bays,
        bands,
        openingBand,
        request,
        spec,
      });
      exteriorPatch = hierarchy.exterior;
      interiorPatch = hierarchy.interior;
      featureIds.push(...hierarchy.featureIds);
      for (const reveal of hierarchy.reveals) {
        patches.set(reveal.id, reveal);
        extraPatchIds.push(reveal.id);
        links.push([wall.outerPatchId, reveal.id], [wall.innerPatchId, reveal.id]);
      }
      for (const group of hierarchy.revealGroups) {
        linkRevealLoop(group, links);
      }
    }

    patches.set(exteriorPatch.id, exteriorPatch);
    patches.set(interiorPatch.id, interiorPatch);
    facades.push({
      id: facadeId,
      cellId: resolved.record.id,
      orientation: wall.orientation,
      exteriorPatchId: exteriorPatch.id,
      interiorPatchId: interiorPatch.id,
      style: spec.style,
      symmetry,
      bays,
      bands,
      featureIds,
    });
  }

  const cell: CellRecord = {
    ...resolved.record,
    openings: [...openings].sort((a, b) =>
      resolved.exteriorOpenings.findIndex((request) => request.id === a.id)
      - resolved.exteriorOpenings.findIndex((request) => request.id === b.id)),
    patchIds: [...resolved.record.patchIds, ...extraPatchIds],
  };

  return { cell, patches: [...patches.values()], links, facades };
}

interface HierarchyInput {
  readonly cell: CellRecord;
  readonly facadeId: string;
  readonly direction: HorizontalOrientation;
  readonly exterior: Patch;
  readonly interior: Patch;
  readonly bays: readonly FacadeBayRecord[];
  readonly bands: readonly FacadeBandRecord[];
  readonly openingBand: FacadeBandRecord;
  readonly request: CellExteriorOpeningRequest | null;
  readonly spec: FacadeSpec;
}

interface HierarchyResult {
  readonly exterior: Patch;
  readonly interior: Patch;
  readonly featureIds: readonly string[];
  readonly reveals: readonly Patch[];
  readonly revealGroups: readonly (readonly Patch[])[];
}

function addHierarchicalFeatures(input: HierarchyInput): HierarchyResult {
  let exterior = input.exterior;
  let interior = input.interior;
  const featureIds: string[] = [];
  const reveals: Patch[] = [];
  const revealGroups: Patch[][] = [];
  const primary = highestBay(input.bays);
  const secondary = input.bays.filter((bay) => bay.id !== primary.id);

  if (!input.request && input.direction === "sidePositiveU") {
    const bounds = insetSlot(primary, input.openingBand, 0.24, 0.2, 0.76);
    const openingId = structurePath(input.facadeId, "window_primary");
    const volume = openingRect(input.cell, input.direction, input.exterior.frame, bounds.uRange);
    const bottomY = input.cell.bottomY + bounds.vRange[0] * input.cell.height;
    const topY = input.cell.bottomY + bounds.vRange[1] * input.cell.height;
    const result = addThroughOpening(
      exterior,
      interior,
      openingId,
      "window",
      volume,
      bottomY,
      topY,
      180,
      "windowReveal",
    );
    exterior = result.exterior;
    interior = result.interior;
    featureIds.push(...result.featureIds);
    const group = openingRevealPatches(
      openingId,
      volume,
      input.direction,
      bottomY,
      topY,
      true,
    );
    reveals.push(...group);
    revealGroups.push(group);
  } else if (!input.request) {
    const slot = insetSlot(primary, input.openingBand, 0.2, 0.18, 0.78);
    const result = addDepthFeature(
      exterior,
      structurePath(input.facadeId, "recessed_panel_primary"),
      slot.uRange,
      slot.vRange,
      "inset",
      input.spec.recessDepth,
      90,
      ["facade", "recessed_panel", "primary"],
      "panel",
    );
    exterior = result.patch;
    featureIds.push(result.featureId);
  }

  for (const bay of secondary) {
    const slot = insetSlot(bay, input.openingBand, 0.18, 0.18, 0.78);
    if (
      input.request
      && input.direction === "sidePositiveU"
      && bay.index === secondary[0]?.index
    ) {
      const openingId = structurePath(input.facadeId, "window_secondary");
      const volume = openingRect(input.cell, input.direction, input.exterior.frame, slot.uRange);
      const bottomY = input.cell.bottomY + slot.vRange[0] * input.cell.height;
      const topY = input.cell.bottomY + slot.vRange[1] * input.cell.height;
      const opening = addThroughOpening(
        exterior,
        interior,
        openingId,
        "window",
        volume,
        bottomY,
        topY,
        180,
        "windowReveal",
      );
      exterior = opening.exterior;
      interior = opening.interior;
      featureIds.push(...opening.featureIds);
      const group = openingRevealPatches(
        openingId,
        volume,
        input.direction,
        bottomY,
        topY,
        true,
      );
      reveals.push(...group);
      revealGroups.push(group);
      continue;
    }
    const kind = input.request ? "niche" : "recessed_panel";
    const result = addDepthFeature(
      exterior,
      structurePath(input.facadeId, `${kind}_${String(bay.index + 1).padStart(2, "0")}`),
      slot.uRange,
      slot.vRange,
      "inset",
      input.spec.recessDepth,
      80,
      ["facade", kind, "secondary"],
      kind === "niche" ? "niche" : "panel",
    );
    exterior = result.patch;
    featureIds.push(result.featureId);
  }

  const pilasterWidth = Math.min(0.22, input.exterior.frame.uLength * 0.035);
  for (let boundary = 0; boundary < input.bays.length - 1; boundary += 1) {
    const u = input.bays[boundary]!.uRange[1];
    const normalizedWidth = pilasterWidth / input.exterior.frame.uLength;
    const left = input.bays[boundary]!;
    const right = input.bays[boundary + 1]!;
    const uRange: readonly [number, number] = input.request && right.role === "entrance"
      ? [u - normalizedWidth, u]
      : input.request && left.role === "entrance"
        ? [u, u + normalizedWidth]
        : [u - normalizedWidth * 0.5, u + normalizedWidth * 0.5];
    const result = addDepthFeature(
      exterior,
      structurePath(input.facadeId, `pilaster_${String(boundary + 1).padStart(2, "0")}`),
      uRange,
      [0, input.openingBand.vRange[1]],
      "extrude",
      input.spec.pilasterProjection,
      120,
      ["facade", "pilaster", "bay_boundary"],
      "pilaster",
    );
    exterior = result.patch;
    featureIds.push(result.featureId);
  }

  const frieze = input.bands.find((band) => band.role === "frieze");
  if (frieze) {
    const margin = input.cell.wallThickness / input.exterior.frame.uLength;
    const result = addDepthFeature(
      exterior,
      structurePath(input.facadeId, "frieze"),
      [margin, 1 - margin],
      frieze.vRange,
      "extrude",
      input.spec.friezeProjection,
      110,
      ["facade", "frieze", "continuous"],
      "frieze",
    );
    exterior = result.patch;
    featureIds.push(result.featureId);
  }

  return { exterior, interior, featureIds, reveals, revealGroups };
}

function facadeBayRules(
  cell: CellRecord,
  direction: HorizontalOrientation,
  request: CellExteriorOpeningRequest | null,
  spec: FacadeSpec,
): FacadeBayRule[] {
  if (request) {
    return [
      { id: "bay_secondary_01", role: "secondary", weight: 1, hierarchy: 1 },
      { id: "bay_entrance", role: "entrance", width: request.width, hierarchy: 3 },
      { id: "bay_secondary_02", role: "secondary", weight: 1, hierarchy: 1 },
    ];
  }
  if (spec.style === "plain") {
    return [{ id: "bay_solid", role: "solid", weight: 1, hierarchy: 1 }];
  }

  const widths = cellDerivedBayWidths(cell, direction);
  if (widths.length > 1 && mirroredNumbers(widths)) {
    return widths.map((width, index) => ({
      id: `bay_${String(index + 1).padStart(2, "0")}`,
      role: index === Math.floor(widths.length / 2) ? "primary" : "secondary",
      width,
      hierarchy: index === Math.floor(widths.length / 2) ? 3 : 1,
    }));
  }
  return [
    { id: "bay_secondary_01", role: "secondary", weight: 1, hierarchy: 1 },
    { id: "bay_primary", role: "primary", weight: 1.4, hierarchy: 3 },
    { id: "bay_secondary_02", role: "secondary", weight: 1, hierarchy: 1 },
  ];
}

function facadeBandRules(spec: FacadeSpec): FacadeBandRule[] {
  return spec.style === "plain"
    ? [{ id: "band_wall_body", role: "wall_body", weight: 1, continuity: "continuous" }]
    : [
      { id: "band_opening", role: "opening_zone", weight: 1, continuity: "per_bay" },
      {
        id: "band_frieze",
        role: "frieze",
        height: spec.friezeHeight,
        continuity: "continuous",
      },
    ];
}

function withLayoutRegions(
  patch: Patch,
  bays: readonly FacadeBayRecord[],
  bands: readonly FacadeBandRecord[],
): Patch {
  const regions: PatchRegion[] = [
    ...bays.map((bay) => ({
      id: structurePath(patch.id, `layout_${lastSegment(bay.id)}`),
      uRange: bay.uRange,
      vRange: [0, 1] as const,
      priority: bay.hierarchy,
      allowedOperations: [],
      exclusions: [],
      tags: ["facade", "bay", bay.role],
    })),
    ...bands.map((band) => ({
      id: structurePath(patch.id, `layout_${lastSegment(band.id)}`),
      uRange: [0, 1] as const,
      vRange: band.vRange,
      priority: 1,
      allowedOperations: [],
      exclusions: [],
      tags: ["facade", "band", band.role, band.continuity],
    })),
  ];
  return { ...patch, regions: [...patch.regions, ...regions] };
}

function addThroughOpening(
  exterior: Patch,
  interior: Patch,
  openingId: string,
  kind: "portal" | "window",
  volume: Rect,
  bottomY: number,
  topY: number,
  priority: number,
  materialRole: "portalReveal" | "windowReveal",
): { readonly exterior: Patch; readonly interior: Patch; readonly featureIds: readonly string[] } {
  const outerRegion = openingRegion(exterior, openingId, kind, volume, bottomY, topY, priority);
  const innerRegion = openingRegion(interior, openingId, kind, volume, bottomY, topY, priority);
  const outerFeature = cutFeature(
    structurePath(exterior.id, `cut_${lastSegment(openingId)}`),
    outerRegion.id,
    materialRole,
  );
  const innerFeature = cutFeature(
    structurePath(interior.id, `cut_${lastSegment(openingId)}`),
    innerRegion.id,
    materialRole,
  );

  return {
    exterior: appendFeature(exterior, outerRegion, outerFeature),
    interior: appendFeature(interior, innerRegion, innerFeature),
    featureIds: [outerFeature.id, innerFeature.id],
  };
}

function addDepthFeature(
  patch: Patch,
  id: string,
  uRange: readonly [number, number],
  vRange: readonly [number, number],
  operation: "inset" | "extrude",
  depth: number,
  priority: number,
  tags: readonly string[],
  materialRole: "niche" | "panel" | "pilaster" | "frieze",
): { readonly patch: Patch; readonly featureId: string } {
  const region: PatchRegion = {
    id: structurePath(patch.id, `region_${lastSegment(id)}`),
    uRange,
    vRange,
    priority,
    allowedOperations: [operation],
    exclusions: [],
    tags,
  };
  const feature: PatchFeature = {
    id,
    operation,
    depth,
    materialRole,
    regionId: region.id,
    order: patch.features.length,
    dependsOn: [],
    runsBefore: [],
    runsAfter: [],
    conflictPolicy: "clip",
  };
  return { patch: appendFeature(patch, region, feature), featureId: feature.id };
}

function appendFeature(patch: Patch, region: PatchRegion, feature: PatchFeature): Patch {
  return {
    ...patch,
    regions: [...patch.regions, region],
    features: [...patch.features, feature],
  };
}

function cutFeature(
  id: string,
  regionId: string,
  materialRole: "portalReveal" | "windowReveal",
): PatchFeature {
  return {
    id,
    operation: "cut",
    depth: 0,
    materialRole,
    regionId,
    order: 0,
    dependsOn: [],
    runsBefore: [],
    runsAfter: [],
    conflictPolicy: "error",
  };
}

function openingRegion(
  patch: Patch,
  openingId: string,
  kind: "portal" | "window",
  volume: Rect,
  bottomY: number,
  topY: number,
  priority: number,
): PatchRegion {
  const along = rectPoints(volume).map((point) => projectU(patch.frame, point));
  return {
    id: structurePath(patch.id, `region_${kind}_${lastSegment(openingId)}`),
    uRange: [Math.min(...along), Math.max(...along)],
    vRange: [
      (bottomY - patch.frame.origin.y) / patch.frame.vLength,
      (topY - patch.frame.origin.y) / patch.frame.vLength,
    ],
    priority,
    allowedOperations: ["cut"],
    exclusions: [],
    tags: ["opening", kind, ...(kind === "portal" ? ["circulation"] : [])],
  };
}

function insetSlot(
  bay: FacadeBayRecord,
  band: FacadeBandRecord,
  horizontalInset: number,
  bottomRatio: number,
  topRatio: number,
): { readonly uRange: readonly [number, number]; readonly vRange: readonly [number, number] } {
  const uSpan = bay.uRange[1] - bay.uRange[0];
  const vSpan = band.vRange[1] - band.vRange[0];
  return {
    uRange: [
      bay.uRange[0] + uSpan * horizontalInset,
      bay.uRange[1] - uSpan * horizontalInset,
    ],
    vRange: [
      band.vRange[0] + vSpan * bottomRatio,
      band.vRange[0] + vSpan * topRatio,
    ],
  };
}

function cellDerivedBayWidths(
  cell: CellRecord,
  direction: HorizontalOrientation,
): number[] {
  const intervals = cell.rooms
    .filter((room) => roomTouches(room.footprint, cell.interior, direction))
    .map((room) => direction === "front" || direction === "rear"
      ? [room.footprint.minX, room.footprint.maxX] as const
      : [room.footprint.minZ, room.footprint.maxZ] as const)
    .sort((a, b) => a[0] - b[0]);

  if (intervals.length <= 1) {
    return [];
  }
  const domainStart = direction === "front" || direction === "rear"
    ? cell.interior.minX
    : cell.interior.minZ;
  const domainEnd = direction === "front" || direction === "rear"
    ? cell.interior.maxX
    : cell.interior.maxZ;
  const boundaries = [
    domainStart,
    ...intervals.slice(0, -1).map((interval, index) =>
      (interval[1] + intervals[index + 1]![0]) * 0.5),
    domainEnd,
  ];
  return boundaries.slice(0, -1).map((start, index) => boundaries[index + 1]! - start);
}

function roomTouches(
  room: Rect,
  interior: Rect,
  direction: HorizontalOrientation,
): boolean {
  switch (direction) {
    case "front": return Math.abs(room.maxZ - interior.maxZ) <= EPS;
    case "rear": return Math.abs(room.minZ - interior.minZ) <= EPS;
    case "sidePositiveU": return Math.abs(room.maxX - interior.maxX) <= EPS;
    case "sideNegativeU": return Math.abs(room.minX - interior.minX) <= EPS;
  }
}

function openingRect(
  cell: CellRecord,
  direction: HorizontalOrientation,
  frame: LocalFrame,
  uRange: readonly [number, number],
): Rect {
  const points = uRange.map((u) => ({
    x: frame.origin.x + frame.uAxis.x * frame.uLength * u,
    z: frame.origin.z + frame.uAxis.z * frame.uLength * u,
  }));
  const along = direction === "front" || direction === "rear"
    ? points.map((point) => point.x)
    : points.map((point) => point.z);
  const minimum = Math.min(...along);
  const maximum = Math.max(...along);
  switch (direction) {
    case "front": return { minX: minimum, maxX: maximum, minZ: cell.interior.maxZ, maxZ: cell.footprint.maxZ };
    case "rear": return { minX: minimum, maxX: maximum, minZ: cell.footprint.minZ, maxZ: cell.interior.minZ };
    case "sidePositiveU": return { minX: cell.interior.maxX, maxX: cell.footprint.maxX, minZ: minimum, maxZ: maximum };
    case "sideNegativeU": return { minX: cell.footprint.minX, maxX: cell.interior.minX, minZ: minimum, maxZ: maximum };
  }
}

function openingRevealPatches(
  id: string,
  volume: Rect,
  direction: HorizontalOrientation,
  bottomY: number,
  topY: number,
  includeSill: boolean,
): Patch[] {
  const members = [
    revealJamb(structurePath(id, "jamb_start"), volume, direction, "start", bottomY, topY),
    revealJamb(structurePath(id, "jamb_end"), volume, direction, "end", bottomY, topY),
    revealHorizontal(structurePath(id, "soffit"), volume, topY, "soffit"),
  ];
  if (includeSill) {
    members.push(revealHorizontal(structurePath(id, "sill"), volume, bottomY, "sill"));
  }
  return members;
}

function revealJamb(
  id: string,
  volume: Rect,
  direction: HorizontalOrientation,
  end: "start" | "end",
  bottomY: number,
  topY: number,
): Patch {
  const alongX = direction === "front" || direction === "rear";
  const atStart = end === "start";
  const frame: LocalFrame = alongX
    ? {
      origin: { x: atStart ? volume.minX : volume.maxX, y: bottomY, z: volume.minZ },
      uAxis: { x: 0, y: 0, z: 1 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: atStart ? 1 : -1, y: 0, z: 0 },
      uLength: rectDepth(volume),
      vLength: topY - bottomY,
    }
    : {
      origin: { x: volume.minX, y: bottomY, z: atStart ? volume.minZ : volume.maxZ },
      uAxis: { x: 1, y: 0, z: 0 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: atStart ? 1 : -1 },
      uLength: rectWidth(volume),
      vLength: topY - bottomY,
    };
  return revealPatch(id, frame, "jamb");
}

function revealHorizontal(
  id: string,
  volume: Rect,
  y: number,
  member: "soffit" | "sill",
): Patch {
  const frame: LocalFrame = {
    origin: { x: volume.minX, y, z: volume.minZ },
    uAxis: { x: 1, y: 0, z: 0 },
    vAxis: { x: 0, y: 0, z: 1 },
    normal: { x: 0, y: member === "soffit" ? -1 : 1, z: 0 },
    uLength: rectWidth(volume),
    vLength: rectDepth(volume),
  };
  return revealPatch(id, frame, member);
}

function revealPatch(id: string, frame: LocalFrame, member: string): Patch {
  return {
    id,
    role: PATCH_ROLES.cellOpeningReveal,
    frame,
    dimensions: { u: frame.uLength, v: frame.vLength, thickness: 0 },
    evaluator: "planar",
    edges: revealEdges(id),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["opening", "facade", "reveal", member],
  };
}

function linkRevealLoop(
  reveals: readonly Patch[],
  links: (readonly [string, string])[],
): void {
  const jambs = reveals.filter((patch) => patch.tags.includes("jamb"));
  const horizontals = reveals.filter(
    (patch) => patch.tags.includes("soffit") || patch.tags.includes("sill"),
  );
  for (const jamb of jambs) {
    for (const horizontal of horizontals) {
      links.push([jamb.id, horizontal.id]);
    }
  }
}

function revealEdges(id: string): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", "sideNegativeU"),
    uMax: patchEdge(id, "u_max", "sidePositiveU"),
    vMin: patchEdge(id, "v_min", "bottom"),
    vMax: patchEdge(id, "v_max", "top"),
  };
}

function patchEdge(
  patchId: string,
  segmentId: string,
  orientation: PatchEdges["uMin"]["orientation"],
) {
  return { id: structurePath(patchId, `edge_${segmentId}`), orientation, treatment: null };
}

function projectU(frame: LocalFrame, point: { readonly x: number; readonly z: number }): number {
  return (
    (point.x - frame.origin.x) * frame.uAxis.x
    + (point.z - frame.origin.z) * frame.uAxis.z
  ) / frame.uLength;
}

function rectPoints(rect: Rect): readonly { readonly x: number; readonly z: number }[] {
  return [
    { x: rect.minX, z: rect.minZ },
    { x: rect.minX, z: rect.maxZ },
    { x: rect.maxX, z: rect.minZ },
    { x: rect.maxX, z: rect.maxZ },
  ];
}

function highestBay(bays: readonly FacadeBayRecord[]): FacadeBayRecord {
  return [...bays].sort((a, b) => b.hierarchy - a.hierarchy || a.index - b.index)[0]!;
}

function mirroredNumbers(values: readonly number[]): boolean {
  return values.every((value, index) =>
    Math.abs(value - values[values.length - 1 - index]!) <= EPS);
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function segment(direction: HorizontalOrientation): string {
  switch (direction) {
    case "front": return "front";
    case "rear": return "rear";
    case "sidePositiveU": return "right";
    case "sideNegativeU": return "left";
  }
}

function validSpec(
  spec: FacadeSpec,
  cell: CellRecord,
  diagnostics: DiagnosticCollector,
): boolean {
  if (spec.style === "plain") {
    return true;
  }
  if (
    ![spec.recessDepth, spec.pilasterProjection, spec.friezeHeight, spec.friezeProjection]
      .every((value) => Number.isFinite(value) && value > 0)
  ) {
    diagnostics.error(
      "facade.invalid_dimensions",
      cell.id,
      "Facade recess, projection and frieze dimensions must be positive.",
    );
    return false;
  }
  if (spec.recessDepth >= cell.wallThickness - EPS) {
    diagnostics.error(
      "facade.recess_too_deep",
      cell.id,
      "Facade recess depth must remain shallower than the cell wall.",
    );
    return false;
  }
  if (spec.friezeHeight >= cell.height - EPS) {
    diagnostics.error(
      "facade.frieze_too_tall",
      cell.id,
      "The facade frieze must leave positive wall-body height.",
    );
    return false;
  }
  return true;
}
