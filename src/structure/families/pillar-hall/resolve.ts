import { insetRect, rectDepth, rectWidth, type HorizontalOrientation, type Rect } from "../../kernel/frame";
import { structurePath } from "../../kernel/ids";
import type { SummitPlacementRecord } from "../../kernel/graph";
import type { Patch } from "../../kernel/patch";
import { toSlotRule } from "../mass/config";
import { resolvePillarHallSlots } from "./slots";
import type { PillarHallLayoutConfig } from "./config";
import type {
  PillarHallBayRecord,
  PillarHallMemberRecord,
  PillarHallRecord,
  PillarHallRowRecord,
  PillarPanelRecord,
  PillarSectionKind,
  PillarSectionRecord,
  PillarSupportRecord,
} from "./types";

const PROFILE: readonly {
  readonly kind: PillarSectionKind;
  readonly heightRatio: number;
  readonly widthRatio: number;
}[] = [
  { kind: "foot", heightRatio: 0.12, widthRatio: 1.55 },
  { kind: "lower_panel", heightRatio: 0.36, widthRatio: 1.3 },
  { kind: "shaft", heightRatio: 0.3, widthRatio: 1 },
  { kind: "capital", heightRatio: 0.14, widthRatio: 1.3 },
  { kind: "capstone", heightRatio: 0.08, widthRatio: 1.65 },
];

const LINEAR_BASE_HEIGHT = 0.82;
const LINEAR_BASE_DEPTH_RATIO = 1.65;
const LINEAR_PLINTH_WIDTH_RATIO = 1.85;
const LINEAR_PLINTH_DEPTH_RATIO = 2.07;
const CORNICE_HEIGHT = 0.18;
const CORNICE_DEPTH_PROJECTION = 0.24;
const EDGE_CLEARANCE = 0.08;
const EPS = 1e-9;
const ORIENTATION_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "front",
  rear: "rear",
  sidePositiveU: "side_positive_u",
  sideNegativeU: "side_negative_u",
};

interface RowIntent {
  readonly segment: "front" | "rear" | "left" | "right";
  readonly orientation: HorizontalOrientation;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly bayCount: number;
}

export interface ResolvedPillarHall {
  readonly record: PillarHallRecord;
  readonly patches: readonly Patch[];
}

export function resolvePillarHall(
  structureId: string,
  layout: PillarHallLayoutConfig,
  placement: SummitPlacementRecord,
  platformMassId: string,
): ResolvedPillarHall {
  const id = structurePath(structureId, "pillar_hall");
  const footprint = resolveCenterlineFootprint(layout, placement.rect);
  if (rectWidth(footprint) <= 0 || rectDepth(footprint) <= 0) {
    throw new RangeError(
      "The platform summit is too small for the Pillar Hall edge clearance. (pillar_hall.footprint_too_small)",
    );
  }

  const intents = rowIntents(layout, footprint);
  const supports = new Map<string, PillarSupportRecord>();
  const rows: PillarHallRowRecord[] = [];
  const bays: PillarHallBayRecord[] = [];
  const members: PillarHallMemberRecord[] = [];
  const hasContinuousBase = layout.archetype === "linear_screen";
  const supportBottomY = placement.y + (hasContinuousBase ? LINEAR_BASE_HEIGHT : 0);
  const supportTopY = supportBottomY + layout.pierHeight;
  const lintelTopY = supportTopY + layout.lintelHeight;
  const corniceTopY = lintelTopY + CORNICE_HEIGHT;

  for (const intent of intents) {
    const rowId = structurePath(id, `row_${intent.segment}`);
    const run = Math.hypot(
      intent.to[0] - intent.from[0],
      intent.to[1] - intent.from[1],
    );
    const bayWidth = run / intent.bayCount;
    if (bayWidth < layout.pierWidth * 2.15) {
      throw new RangeError(
        `The ${intent.segment} row has too many bays for the current pier width. (pillar_hall.bays_too_dense)`,
      );
    }

    const supportIds: string[] = [];
    for (let index = 0; index <= intent.bayCount; index += 1) {
      const t = index / intent.bayCount;
      const x = lerp(intent.from[0], intent.to[0], t);
      const z = lerp(intent.from[1], intent.to[1], t);
      const key = `${roundKey(x)}/${roundKey(z)}`;
      let support = supports.get(key);
      if (!support) {
        const supportId = structurePath(id, `support_${supports.size}`);
        const sections = resolveSections(x, z, supportBottomY, layout);
        support = {
          id: supportId,
          x,
          z,
          sections,
          panels: resolvePanels(supportId, sections, layout.panelDepth),
        };
        supports.set(key, support);
        if (hasContinuousBase) {
          members.push({
            id: structurePath(supportId, "base_plinth"),
            kind: "support_plinth",
            rect: supportPlinthRect(x, z, intent.orientation, layout.pierWidth),
            bottomY: placement.y,
            topY: supportBottomY,
            materialRole: "pedestal",
          });
        }
      }
      supportIds.push(support.id);
    }

    const bayIds: string[] = [];
    for (let index = 0; index < intent.bayCount; index += 1) {
      const bayId = structurePath(rowId, `bay_${index}`);
      const startSupportId = supportIds[index]!;
      const endSupportId = supportIds[index + 1]!;
      bays.push({
        id: bayId,
        index,
        rowId,
        startSupportId,
        endSupportId,
        width: bayWidth,
      });
      bayIds.push(bayId);

      const a = pointAt(intent, index / intent.bayCount);
      const b = pointAt(intent, (index + 1) / intent.bayCount);
      members.push({
        id: structurePath(bayId, "lintel"),
        kind: "lintel",
        rect: spanRect(
          a,
          b,
          layout.lintelDepth,
          index === 0 ? spanEndExtent(layout) : 0,
          index === intent.bayCount - 1 ? spanEndExtent(layout) : 0,
        ),
        bottomY: supportTopY,
        topY: lintelTopY,
        materialRole: "lintel",
      });
      if (hasContinuousBase) {
        for (const [panelIndex, rect] of baseFriezeRects(
          a,
          b,
          intent.orientation,
          layout.pierWidth,
        ).entries()) {
          members.push({
            id: structurePath(bayId, `base_frieze_${panelIndex}`),
            kind: "base_frieze",
            rect,
            bottomY: placement.y,
            topY: supportBottomY,
            materialRole: "frieze",
          });
        }
      }
    }

    if (hasContinuousBase) {
      members.push({
        id: structurePath(rowId, "pedestal"),
        kind: "pedestal",
        rect: memberRect(
          intent.from,
          intent.to,
          layout.pierWidth * LINEAR_BASE_DEPTH_RATIO,
        ),
        bottomY: placement.y,
        topY: supportBottomY,
        materialRole: "pedestal",
      });
    }
    members.push({
      id: structurePath(rowId, "cornice"),
      kind: "cornice",
      rect: spanRect(
        intent.from,
        intent.to,
        layout.lintelDepth + CORNICE_DEPTH_PROJECTION,
        spanEndExtent(layout),
        spanEndExtent(layout),
      ),
      bottomY: lintelTopY,
      topY: corniceTopY,
      materialRole: "cornice",
    });
    rows.push({
      id: rowId,
      orientation: intent.orientation,
      supportIds,
      bayIds,
    });
  }

  if (layout.archetype === "linear_screen") {
    const first = intents[0]!;
    for (const [name, point, direction] of [
      ["left", first.from, -1],
      ["right", first.to, 1],
    ] as const) {
      const width = layout.pierWidth * 1.15;
      const plinthHalf = layout.pierWidth * LINEAR_PLINTH_WIDTH_RATIO * 0.5;
      members.push({
        id: structurePath(id, `buttress_${name}`),
        kind: "buttress",
        rect: {
          minX: point[0] + (direction < 0 ? -plinthHalf - width : plinthHalf),
          maxX: point[0] + (direction < 0 ? -plinthHalf : plinthHalf + width),
          minZ: point[1] - layout.pierWidth * LINEAR_PLINTH_DEPTH_RATIO * 0.5,
          maxZ: point[1] + layout.pierWidth * LINEAR_PLINTH_DEPTH_RATIO * 0.5,
        },
        bottomY: placement.y,
        topY: supportBottomY,
        materialRole: "pedestal",
      });
    }
  }

  const roof = layout.archetype === "front_gallery"
    ? {
      id: structurePath(id, "roof"),
      footprint: {
        minX: footprint.minX - rowEndExtent(layout) - layout.roofProjection,
        maxX: footprint.maxX + rowEndExtent(layout) + layout.roofProjection,
        minZ: Math.min(...intents.flatMap((row) => [row.from[1], row.to[1]]))
          - (layout.lintelDepth + CORNICE_DEPTH_PROJECTION) * 0.5 - layout.roofProjection,
        maxZ: Math.max(...intents.flatMap((row) => [row.from[1], row.to[1]]))
          + (layout.lintelDepth + CORNICE_DEPTH_PROJECTION) * 0.5 + layout.roofProjection,
      },
      bottomY: corniceTopY,
      topY: corniceTopY + layout.roofThickness,
      thickness: layout.roofThickness,
      projection: layout.roofProjection,
      materialRole: "roof" as const,
    }
    : null;

  const resolved: PillarHallRecord = {
    id,
    kind: "pillar_hall",
    archetype: layout.archetype,
    platformMassId,
    supportPatchId: placement.patchId,
    footprint,
    bottomY: placement.y,
    topY: roof?.topY ?? corniceTopY,
    rows,
    supports: [...supports.values()],
    bays,
    members,
    roof,
    patchIds: [],
    frames: [],
    slots: [],
  };

  // The hall's own surfaces reach the graph only where something has claimed
  // them. A family that publishes a patch for every face of every box would
  // bury the ones that mean something.
  const prepared = resolvePillarHallSlots({
    hall: resolved,
    placement: layout.slotPlacement,
    rule: toSlotRule(layout),
  });

  return {
    record: {
      ...resolved,
      patchIds: prepared.patches.map((patch) => patch.id),
      frames: prepared.frames,
      slots: prepared.slots,
    },
    patches: prepared.patches,
  };
}

/**
 * Resolves the area available to support centre-lines after every part that
 * projects beyond them has claimed its share of the summit. Bay division must
 * happen inside this rectangle; a fixed inset cannot remain valid while pier,
 * span, roof, and end-buttress dimensions are editable independently.
 */
function resolveCenterlineFootprint(layout: PillarHallLayoutConfig, summit: Rect): Rect {
  const supportHalf = supportOuterHalf(layout);
  const corniceHalf = (layout.lintelDepth + CORNICE_DEPTH_PROJECTION) * 0.5;
  const endExtent = rowEndExtent(layout);
  let xClearance: number;
  let zClearance: number;

  switch (layout.archetype) {
    case "linear_screen":
      xClearance = Math.max(
        layout.pierWidth * (LINEAR_PLINTH_WIDTH_RATIO * 0.5 + 1.15),
        endExtent,
      ) + EDGE_CLEARANCE;
      zClearance = Math.max(
        supportHalf,
        corniceHalf,
        layout.pierWidth * LINEAR_PLINTH_DEPTH_RATIO * 0.5,
      ) + EDGE_CLEARANCE;
      break;
    case "front_gallery":
      xClearance = endExtent + layout.roofProjection + EDGE_CLEARANCE;
      zClearance = corniceHalf + layout.roofProjection + EDGE_CLEARANCE;
      break;
    case "open_pavilion":
      xClearance = Math.max(endExtent, corniceHalf) + EDGE_CLEARANCE;
      zClearance = xClearance;
      break;
  }

  return insetRect(summit, {
    front: zClearance,
    rear: zClearance,
    sidePositiveU: xClearance,
    sideNegativeU: xClearance,
  });
}

/** Lintel and cornice share this end plane even though their depths differ. */
function spanEndExtent(layout: PillarHallLayoutConfig): number {
  return (layout.lintelDepth + CORNICE_DEPTH_PROJECTION) * 0.5
    + layout.spanEndProjection;
}

function rowEndExtent(layout: PillarHallLayoutConfig): number {
  return Math.max(supportOuterHalf(layout), spanEndExtent(layout));
}

/** Includes raised panels, which can become the widest pier detail. */
function supportOuterHalf(layout: PillarHallLayoutConfig): number {
  return Math.max(
    layout.pierWidth * 1.65 * 0.5,
    layout.pierWidth * 1.55 * 0.5,
    layout.pierWidth * 1.3 * 0.5 + layout.panelDepth,
    layout.pierWidth * 0.5 + layout.panelDepth,
  );
}

function rowIntents(layout: PillarHallLayoutConfig, rect: Rect): RowIntent[] {
  const centerZ = (rect.minZ + rect.maxZ) * 0.5;
  const halfDepth = layout.rowDepth * 0.5;
  switch (layout.archetype) {
    case "linear_screen":
      return [{
        segment: "front",
        orientation: "front",
        from: [rect.minX, centerZ],
        to: [rect.maxX, centerZ],
        bayCount: layout.frontBayCount,
      }];
    case "front_gallery": {
      if (layout.rowDepth + layout.lintelDepth > rectDepth(rect) + EPS) {
        throw new RangeError(
          "The gallery row depth does not fit on the platform summit. (pillar_hall.row_depth_does_not_fit)",
        );
      }
      return [
        {
          segment: "front",
          orientation: "front",
          from: [rect.minX, centerZ + halfDepth],
          to: [rect.maxX, centerZ + halfDepth],
          bayCount: layout.frontBayCount,
        },
        {
          segment: "rear",
          orientation: "rear",
          from: [rect.maxX, centerZ - halfDepth],
          to: [rect.minX, centerZ - halfDepth],
          bayCount: layout.frontBayCount,
        },
      ];
    }
    case "open_pavilion":
      return [
        {
          segment: "rear",
          orientation: "rear",
          from: [rect.maxX, rect.minZ],
          to: [rect.minX, rect.minZ],
          bayCount: layout.frontBayCount,
        },
        {
          segment: "left",
          orientation: "sideNegativeU",
          from: [rect.minX, rect.minZ],
          to: [rect.minX, rect.maxZ],
          bayCount: layout.sideBayCount,
        },
        {
          segment: "right",
          orientation: "sidePositiveU",
          from: [rect.maxX, rect.maxZ],
          to: [rect.maxX, rect.minZ],
          bayCount: layout.sideBayCount,
        },
      ];
  }
}

function resolveSections(
  x: number,
  z: number,
  bottomY: number,
  layout: PillarHallLayoutConfig,
): PillarSectionRecord[] {
  let cursor = bottomY;
  return PROFILE.map(({ kind, heightRatio, widthRatio }) => {
    const height = layout.pierHeight * heightRatio;
    const width = layout.pierWidth * widthRatio;
    const section = {
      kind,
      footprint: centeredRect(x, z, width, width),
      bottomY: cursor,
      topY: cursor + height,
      materialRole: "pier" as const,
    };
    cursor += height;
    return section;
  });
}

function resolvePanels(
  supportId: string,
  sections: readonly PillarSectionRecord[],
  depth: number,
): PillarPanelRecord[] {
  return sections
    .filter((section): section is PillarSectionRecord & {
      readonly kind: "lower_panel" | "shaft";
    } => section.kind === "lower_panel" || section.kind === "shaft")
    .flatMap((section) => {
      const sectionWidth = rectWidth(section.footprint);
      const sectionHeight = section.topY - section.bottomY;
      const targetCellHeight = sectionWidth * 0.68;
      const count = section.kind === "lower_panel"
        ? clampInt(Math.round(sectionHeight / targetCellHeight), 1, 4)
        : 1;
      const height = sectionHeight / count;
      return Array.from({ length: count }, (_, index) => ({
        index,
        bottomY: section.bottomY + height * index,
        topY: section.bottomY + height * (index + 1),
      })).flatMap((segment) => [
        "front",
        "rear",
        "sidePositiveU",
        "sideNegativeU",
      ].map((orientation) => ({
        id: structurePath(
          supportId,
          `panel_${section.kind}_${segment.index}_${ORIENTATION_SEGMENT[orientation as HorizontalOrientation]}`,
        ),
        orientation: orientation as HorizontalOrientation,
        section: section.kind,
        index: segment.index,
        supportFootprint: section.footprint,
        bottomY: segment.bottomY,
        topY: segment.topY,
        insetU: Math.min(sectionWidth * 0.12, section.kind === "shaft" ? 0.1 : 0.065),
        insetV: Math.min(height * 0.12, section.kind === "shaft" ? 0.1 : 0.05),
        borderWidth: Math.min(
          section.kind === "shaft" ? 0.07 : 0.055,
          sectionWidth * 0.08,
          height * 0.08,
        ),
        depth,
        materialRole: "pierPanel" as const,
      })));
    });
}

function memberRect(
  from: readonly [number, number],
  to: readonly [number, number],
  depth: number,
): Rect {
  const horizontal = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]);
  return horizontal
    ? {
      minX: Math.min(from[0], to[0]),
      maxX: Math.max(from[0], to[0]),
      minZ: from[1] - depth * 0.5,
      maxZ: from[1] + depth * 0.5,
    }
    : {
      minX: from[0] - depth * 0.5,
      maxX: from[0] + depth * 0.5,
      minZ: Math.min(from[1], to[1]),
      maxZ: Math.max(from[1], to[1]),
    };
}

function spanRect(
  from: readonly [number, number],
  to: readonly [number, number],
  depth: number,
  startProjection: number,
  endProjection: number,
): Rect {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const length = Math.hypot(dx, dz);
  if (length <= EPS) {
    return memberRect(from, to, depth);
  }
  const ux = dx / length;
  const uz = dz / length;
  return memberRect(
    [from[0] - ux * startProjection, from[1] - uz * startProjection],
    [to[0] + ux * endProjection, to[1] + uz * endProjection],
    depth,
  );
}

function baseFriezeRects(
  from: readonly [number, number],
  to: readonly [number, number],
  orientation: HorizontalOrientation,
  pierWidth: number,
): readonly Rect[] {
  const margin = pierWidth * LINEAR_PLINTH_WIDTH_RATIO * 0.5;
  const depth = 0.055;
  const outer: Rect = (() => {
    switch (orientation) {
    case "front":
      return {
        minX: Math.min(from[0], to[0]) + margin,
        maxX: Math.max(from[0], to[0]) - margin,
        minZ: from[1] + pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5,
        maxZ: from[1] + pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5 + depth,
      };
    case "rear":
      return {
        minX: Math.min(from[0], to[0]) + margin,
        maxX: Math.max(from[0], to[0]) - margin,
        minZ: from[1] - pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5 - depth,
        maxZ: from[1] - pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5,
      };
    case "sidePositiveU":
      return {
        minX: from[0] + pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5,
        maxX: from[0] + pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5 + depth,
        minZ: Math.min(from[1], to[1]) + margin,
        maxZ: Math.max(from[1], to[1]) - margin,
      };
    case "sideNegativeU":
      return {
        minX: from[0] - pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5 - depth,
        maxX: from[0] - pierWidth * LINEAR_BASE_DEPTH_RATIO * 0.5,
        minZ: Math.min(from[1], to[1]) + margin,
        maxZ: Math.max(from[1], to[1]) - margin,
      };
    }
  })();
  const horizontal = rectWidth(outer) >= rectDepth(outer);
  const split = horizontal
    ? (outer.minX + outer.maxX) * 0.5
    : (outer.minZ + outer.maxZ) * 0.5;
  return horizontal
    ? [{ ...outer, maxX: split }, { ...outer, minX: split }]
    : [{ ...outer, maxZ: split }, { ...outer, minZ: split }];
}

function supportPlinthRect(
  x: number,
  z: number,
  orientation: HorizontalOrientation,
  pierWidth: number,
): Rect {
  const halfWidth = pierWidth * LINEAR_PLINTH_WIDTH_RATIO * 0.5;
  const halfDepth = pierWidth * LINEAR_PLINTH_DEPTH_RATIO * 0.5;
  switch (orientation) {
    case "front":
    case "rear":
      return {
        minX: x - halfWidth,
        maxX: x + halfWidth,
        minZ: z - halfDepth,
        maxZ: z + halfDepth,
      };
    case "sidePositiveU":
    case "sideNegativeU":
      return {
        minX: x - halfDepth,
        maxX: x + halfDepth,
        minZ: z - halfWidth,
        maxZ: z + halfWidth,
      };
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function pointAt(intent: RowIntent, t: number): readonly [number, number] {
  return [
    lerp(intent.from[0], intent.to[0], t),
    lerp(intent.from[1], intent.to[1], t),
  ];
}

function centeredRect(x: number, z: number, width: number, depth: number): Rect {
  return {
    minX: x - width * 0.5,
    maxX: x + width * 0.5,
    minZ: z - depth * 0.5,
    maxZ: z + depth * 0.5,
  };
}

function roundKey(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
