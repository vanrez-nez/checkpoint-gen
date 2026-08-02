import type { SolidBuilder, Vertex3 } from "../../../geometry/solid-builder";
import { rectCorners, rectDepth, rectWidth, type HorizontalOrientation, type Rect } from "../../kernel/frame";
import type { MasonryRule } from "../../kernel/masonry";
import type { PillarHallMemberRecord, PillarHallRecord, PillarPanelRecord } from "./types";

const EPS = 1e-9;

/** Draws the family record directly; no generic Frame geometry survives. */
export function buildPillarHall(
  builder: SolidBuilder,
  hall: PillarHallRecord,
  _masonry: MasonryRule | null,
  _seed: number,
): void {
  for (const member of hall.members.filter((entry) =>
    entry.kind === "pedestal"
    || entry.kind === "support_plinth"
    || entry.kind === "buttress")) {
    if (member.kind === "support_plinth") {
      buildDecoratedFrontMember(
        builder,
        member,
        member.materialRole,
        "front",
        0.18,
        0.1,
      );
    } else {
      buildMember(builder, member, false);
    }
  }

  for (const support of hall.supports) {
    builder.withMaterial("pier", () => {
      for (const section of support.sections) {
        addRectBlock(
          builder,
          section.footprint,
          section.bottomY,
          section.topY,
          false,
          false,
          [false, false, false, false],
        );
      }
    });
    for (const panel of support.panels) {
      buildPanelFrame(builder, panel);
    }
  }

  for (const member of hall.members.filter((entry) =>
    entry.kind !== "pedestal"
    && entry.kind !== "support_plinth"
    && entry.kind !== "buttress")) {
    if (member.kind === "base_frieze") {
      buildFriezePanel(builder, member);
    } else {
      buildMember(builder, member, false);
    }
  }

  if (hall.roof) {
    builder.withMaterial(hall.roof.materialRole, () => {
      addRectBlock(
        builder,
        hall.roof!.footprint,
        hall.roof!.bottomY,
        hall.roof!.topY,
        false,
        false,
        [false, false, false, false],
      );
    });
  }

  const sectionVolumes = hall.supports.flatMap((support) =>
    support.sections.map((section, index) => ({
      rect: section.footprint,
      bottomY: section.bottomY,
      topY: section.topY,
      materialRole: section.materialRole,
      exposeBottom: index > 0,
      sides: [true, true, true, true] as const,
    })),
  );
  const memberVolumes = hall.members.map((member) => ({
    rect: member.rect,
    bottomY: member.bottomY,
    topY: member.topY,
    materialRole: member.materialRole,
    exposeBottom: member.kind === "lintel" || member.kind === "cornice",
    sides: memberSides(hall, member),
  }));
  const roofVolumes = hall.roof ? [{
    rect: hall.roof.footprint,
    bottomY: hall.roof.bottomY,
    topY: hall.roof.topY,
    materialRole: hall.roof.materialRole,
    exposeBottom: true,
    sides: [true, true, true, true] as const,
  }] : [];
  const semanticVolumes = [...sectionVolumes, ...memberVolumes, ...roofVolumes];
  const topSurfaces = [
    ...sectionVolumes.map((section) => ({
      rect: section.rect,
      y: section.topY,
      materialRole: section.materialRole,
    })),
    ...hall.members.map((member) => ({
      rect: member.rect,
      y: member.topY,
      materialRole: member.materialRole,
    })),
    ...(hall.roof ? [{
      rect: hall.roof.footprint,
      y: hall.roof.topY,
      materialRole: hall.roof.materialRole,
    }] : []),
  ];

  const contacts = [
    ...hall.supports.flatMap((support) => support.sections.map((section) => ({
      y: section.bottomY,
      rect: section.footprint,
    }))),
    ...hall.members.map((member) => ({ y: member.bottomY, rect: member.rect })),
    ...(hall.roof ? [{ y: hall.roof.bottomY, rect: hall.roof.footprint }] : []),
  ];
  const claimedTops: { readonly y: number; readonly rect: Rect }[] = [];
  for (const surface of topSurfaces) {
    const covers = contacts
      .filter((contact) => Math.abs(contact.y - surface.y) <= EPS)
      .map((contact) => contact.rect)
      .concat(
        claimedTops
          .filter((claim) => Math.abs(claim.y - surface.y) <= EPS)
          .map((claim) => claim.rect),
      );
    builder.withMaterial(surface.materialRole, () => {
      addExposedHorizontal(builder, surface.rect, covers, surface.y, true);
    });
    claimedTops.push({ y: surface.y, rect: surface.rect });
  }
  const upperContacts = semanticVolumes.map((volume) => ({
    y: volume.topY,
    rect: volume.rect,
  }));
  const claimedBottoms: { readonly y: number; readonly rect: Rect }[] = [];
  for (const volume of semanticVolumes.filter((entry) => entry.exposeBottom)) {
    const supports = upperContacts
      .filter((contact) => Math.abs(contact.y - volume.bottomY) <= EPS)
      .map((contact) => contact.rect)
      .concat(
        claimedBottoms
          .filter((claim) => Math.abs(claim.y - volume.bottomY) <= EPS)
          .map((claim) => claim.rect),
      );
    builder.withMaterial(volume.materialRole, () => {
      addExposedHorizontal(builder, volume.rect, supports, volume.bottomY, false);
    });
    claimedBottoms.push({ y: volume.bottomY, rect: volume.rect });
  }
  for (const volume of semanticVolumes) {
    builder.withMaterial(volume.materialRole, () => {
      for (let side = 0; side < volume.sides.length; side += 1) {
        if (volume.sides[side]) {
          addExposedVertical(builder, volume, side, semanticVolumes);
        }
      }
    });
  }
  builder.cullFaces((face) => faceIsCoveredByContact(face, contacts));
}

function buildMember(
  builder: SolidBuilder,
  member: PillarHallMemberRecord,
  showTop = true,
  sides: readonly [boolean, boolean, boolean, boolean] = [false, false, false, false],
): void {
  builder.withMaterial(member.materialRole, () => {
    addRectBlock(
      builder,
      member.rect,
      member.bottomY,
      member.topY,
      showTop,
      false,
      sides,
    );
  });
}

function memberSides(
  hall: PillarHallRecord,
  member: PillarHallMemberRecord,
): readonly [boolean, boolean, boolean, boolean] {
  if (hall.archetype === "linear_screen" && member.kind === "pedestal") {
    // The decorated bay panels and aligned support plinths own the complete
    // front elevation. The base remains one continuous support volume, but it
    // must not leave a second coplanar skin behind those facade pieces.
    return [true, false, true, true];
  }
  if (member.kind === "base_frieze") {
    return [true, false, true, false];
  }
  if (member.kind === "support_plinth") {
    return [true, false, true, true];
  }
  return [true, true, true, true];
}

/**
 * Four raised rails leave the pier face visible behind them. The centre is
 * therefore physically recessed relative to its indexed panel border without
 * cutting or duplicating the pier core.
 */
function buildPanelFrame(builder: SolidBuilder, panel: PillarPanelRecord): void {
  const face = panelFace(panel);
  const uMin = face.uMin + panel.insetU;
  const uMax = face.uMax - panel.insetU;
  const vMin = panel.bottomY + panel.insetV;
  const vMax = panel.topY - panel.insetV;
  const border = Math.min(panel.borderWidth, (uMax - uMin) * 0.22, (vMax - vMin) * 0.22);
  if (uMax - uMin <= border * 2 || vMax - vMin <= border * 2) {
    return;
  }

  builder.withMaterial(panel.materialRole, () => {
    const rails = [
      [uMin, uMax, vMin, vMin + border],
      [uMin, uMax, vMax - border, vMax],
      [uMin, uMin + border, vMin + border, vMax - border],
      [uMax - border, uMax, vMin + border, vMax - border],
    ] as const;
    for (const [index, [a0, a1, b0, b1]] of rails.entries()) {
      const rect = panelRailRect(panel.orientation, face.plane, a0, a1, panel.depth);
      const horizontalRail = index < 2;
      addRectBlock(
        builder,
        rect,
        b0,
        b1,
        horizontalRail,
        horizontalRail,
        panelRailSides(panel.orientation),
      );
    }
  });
}

function buildFriezePanel(
  builder: SolidBuilder,
  member: PillarHallMemberRecord,
): void {
  buildDecoratedFrontMember(builder, member, "frieze", "front", 0.06, 0.16);
}

function buildDecoratedFrontMember(
  builder: SolidBuilder,
  member: PillarHallMemberRecord,
  backingMaterial: PillarHallMemberRecord["materialRole"],
  orientation: HorizontalOrientation,
  horizontalInset: number,
  verticalInset: number,
): void {
  const horizontal = orientation === "front" || orientation === "rear";
  const inset = Math.min(
    horizontalInset,
    (horizontal ? rectWidth(member.rect) : rectDepth(member.rect)) * 0.18,
  );
  const depth = 0.025;
  const innerBottomY = member.bottomY + verticalInset;
  const innerTopY = member.topY - verticalInset;
  const inner = decoratedPanelRect(member.rect, orientation, inset, depth);
  builder.withMaterial(backingMaterial, () => {
    addRectBlock(
      builder,
      member.rect,
      member.bottomY,
      member.topY,
      false,
      false,
      [false, false, false, false],
    );
    const borderRects = horizontal
      ? [
        [member.rect.minX, member.rect.maxX, member.bottomY, innerBottomY],
        [member.rect.minX, member.rect.maxX, innerTopY, member.topY],
        [member.rect.minX, inner.minX, innerBottomY, innerTopY],
        [inner.maxX, member.rect.maxX, innerBottomY, innerTopY],
      ] as const
      : [
        [member.rect.minZ, member.rect.maxZ, member.bottomY, innerBottomY],
        [member.rect.minZ, member.rect.maxZ, innerTopY, member.topY],
        [member.rect.minZ, inner.minZ, innerBottomY, innerTopY],
        [inner.maxZ, member.rect.maxZ, innerBottomY, innerTopY],
      ] as const;
    for (const [uMin, uMax, bottomY, topY] of borderRects) {
      const rect = horizontal
        ? { ...member.rect, minX: uMin, maxX: uMax }
        : { ...member.rect, minZ: uMin, maxZ: uMax };
      addRectBlock(
        builder,
        rect,
        bottomY,
        topY,
        false,
        false,
        decoratedFaceSides(orientation),
      );
    }
  });
  builder.withMaterial("pierPanel", () => {
    addRectBlock(
      builder,
      inner,
      innerBottomY,
      innerTopY,
      true,
      true,
      panelRailSides(orientation),
    );
  });
}

function decoratedPanelRect(
  rect: Rect,
  orientation: HorizontalOrientation,
  inset: number,
  depth: number,
): Rect {
  switch (orientation) {
    case "front":
      return {
        minX: rect.minX + inset,
        maxX: rect.maxX - inset,
        minZ: rect.maxZ,
        maxZ: rect.maxZ + depth,
      };
    case "rear":
      return {
        minX: rect.minX + inset,
        maxX: rect.maxX - inset,
        minZ: rect.minZ - depth,
        maxZ: rect.minZ,
      };
    case "sidePositiveU":
      return {
        minX: rect.maxX,
        maxX: rect.maxX + depth,
        minZ: rect.minZ + inset,
        maxZ: rect.maxZ - inset,
      };
    case "sideNegativeU":
      return {
        minX: rect.minX - depth,
        maxX: rect.minX,
        minZ: rect.minZ + inset,
        maxZ: rect.maxZ - inset,
      };
  }
}

function decoratedFaceSides(
  orientation: HorizontalOrientation,
): readonly [boolean, boolean, boolean, boolean] {
  switch (orientation) {
    case "front":
      return [false, true, false, false];
    case "rear":
      return [false, false, false, true];
    case "sidePositiveU":
      return [false, false, true, false];
    case "sideNegativeU":
      return [true, false, false, false];
  }
}

/** Emits only the visible remainder of a horizontal crown after contacts. */
function addExposedHorizontal(
  builder: SolidBuilder,
  outer: Rect,
  covers: readonly Rect[],
  y: number,
  facesUp: boolean,
): void {
  let visible = [outer];
  for (const cover of covers) {
    visible = visible.flatMap((piece) => subtractRect(piece, cover));
  }
  for (const rect of visible) {
    const ring = rectCorners(rect).map((point) => ({ ...point, y }));
    builder.addBlock(
      { bottom: ring, top: ring },
      {
        sides: [false, false, false, false],
        top: facesUp,
        bottom: !facesUp,
      },
    );
  }
}

function subtractRect(source: Rect, cover: Rect): Rect[] {
  const overlap = {
    minX: Math.max(source.minX, cover.minX),
    maxX: Math.min(source.maxX, cover.maxX),
    minZ: Math.max(source.minZ, cover.minZ),
    maxZ: Math.min(source.maxZ, cover.maxZ),
  };
  if (rectWidth(overlap) <= EPS || rectDepth(overlap) <= EPS) {
    return [source];
  }

  return [
    { minX: source.minX, maxX: overlap.minX, minZ: source.minZ, maxZ: source.maxZ },
    { minX: overlap.maxX, maxX: source.maxX, minZ: source.minZ, maxZ: source.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minZ: source.minZ, maxZ: overlap.minZ },
    { minX: overlap.minX, maxX: overlap.maxX, minZ: overlap.maxZ, maxZ: source.maxZ },
  ].filter((rect) => rectWidth(rect) > EPS && rectDepth(rect) > EPS);
}

interface HallVolume {
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: PillarHallMemberRecord["materialRole"];
  readonly sides: readonly [boolean, boolean, boolean, boolean];
}

interface VerticalFaceRect {
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
}

/**
 * Subdivides a block side by every volume pressed against its outside. This is
 * the vertical counterpart to `addExposedHorizontal`: a perpendicular lintel
 * may consume the centre of a face without deleting either exposed end.
 */
function addExposedVertical(
  builder: SolidBuilder,
  volume: HallVolume,
  side: number,
  volumes: readonly HallVolume[],
): void {
  const runsAlongZ = side === 0 || side === 2;
  let visible: VerticalFaceRect[] = [{
    minU: runsAlongZ ? volume.rect.minZ : volume.rect.minX,
    maxU: runsAlongZ ? volume.rect.maxZ : volume.rect.maxX,
    minV: volume.bottomY,
    maxV: volume.topY,
  }];

  for (const candidate of volumes) {
    if (candidate === volume || !occupiesOutside(candidate.rect, volume.rect, side)) {
      continue;
    }
    const cover = {
      minU: runsAlongZ ? candidate.rect.minZ : candidate.rect.minX,
      maxU: runsAlongZ ? candidate.rect.maxZ : candidate.rect.maxX,
      minV: candidate.bottomY,
      maxV: candidate.topY,
    };
    visible = visible.flatMap((piece) => subtractVerticalFace(piece, cover));
  }

  for (const piece of visible) {
    const rect = runsAlongZ
      ? { ...volume.rect, minZ: piece.minU, maxZ: piece.maxU }
      : { ...volume.rect, minX: piece.minU, maxX: piece.maxU };
    const sides: [boolean, boolean, boolean, boolean] = [false, false, false, false];
    sides[side] = true;
    addRectBlock(
      builder,
      rect,
      piece.minV,
      piece.maxV,
      false,
      false,
      sides,
    );
  }
}

function occupiesOutside(candidate: Rect, source: Rect, side: number): boolean {
  const probe = 1e-5;
  const coordinate = side === 0
    ? source.minX - probe
    : side === 1
      ? source.maxZ + probe
      : side === 2
        ? source.maxX + probe
        : source.minZ - probe;
  return side === 0 || side === 2
    ? coordinate >= candidate.minX - EPS && coordinate <= candidate.maxX + EPS
    : coordinate >= candidate.minZ - EPS && coordinate <= candidate.maxZ + EPS;
}

function subtractVerticalFace(
  source: VerticalFaceRect,
  cover: VerticalFaceRect,
): VerticalFaceRect[] {
  const overlap = {
    minU: Math.max(source.minU, cover.minU),
    maxU: Math.min(source.maxU, cover.maxU),
    minV: Math.max(source.minV, cover.minV),
    maxV: Math.min(source.maxV, cover.maxV),
  };
  if (overlap.maxU - overlap.minU <= EPS || overlap.maxV - overlap.minV <= EPS) {
    return [source];
  }
  return [
    { minU: source.minU, maxU: overlap.minU, minV: source.minV, maxV: source.maxV },
    { minU: overlap.maxU, maxU: source.maxU, minV: source.minV, maxV: source.maxV },
    { minU: overlap.minU, maxU: overlap.maxU, minV: source.minV, maxV: overlap.minV },
    { minU: overlap.minU, maxU: overlap.maxU, minV: overlap.maxV, maxV: source.maxV },
  ].filter((piece) => piece.maxU - piece.minU > EPS && piece.maxV - piece.minV > EPS);
}

interface PanelFace {
  readonly plane: number;
  readonly uMin: number;
  readonly uMax: number;
}

function panelFace(panel: PillarPanelRecord): PanelFace {
  const rect = panel.supportFootprint;
  switch (panel.orientation) {
    case "front":
      return { plane: rect.maxZ, uMin: rect.minX, uMax: rect.maxX };
    case "rear":
      return { plane: rect.minZ, uMin: rect.minX, uMax: rect.maxX };
    case "sidePositiveU":
      return { plane: rect.maxX, uMin: rect.minZ, uMax: rect.maxZ };
    case "sideNegativeU":
      return { plane: rect.minX, uMin: rect.minZ, uMax: rect.maxZ };
  }
}

function panelRailRect(
  orientation: HorizontalOrientation,
  plane: number,
  uMin: number,
  uMax: number,
  depth: number,
): Rect {
  switch (orientation) {
    case "front":
      return { minX: uMin, maxX: uMax, minZ: plane, maxZ: plane + depth };
    case "rear":
      return { minX: uMin, maxX: uMax, minZ: plane - depth, maxZ: plane };
    case "sidePositiveU":
      return { minX: plane, maxX: plane + depth, minZ: uMin, maxZ: uMax };
    case "sideNegativeU":
      return { minX: plane - depth, maxX: plane, minZ: uMin, maxZ: uMax };
  }
}

function panelRailSides(
  orientation: HorizontalOrientation,
): readonly [boolean, boolean, boolean, boolean] {
  switch (orientation) {
    case "front":
      return [true, true, true, false];
    case "rear":
      return [true, false, true, true];
    case "sidePositiveU":
      return [false, true, true, true];
    case "sideNegativeU":
      return [true, true, false, true];
  }
}

function addRectBlock(
  builder: SolidBuilder,
  rect: Rect,
  bottomY: number,
  topY: number,
  showTop: boolean,
  showBottom = false,
  sides: readonly [boolean, boolean, boolean, boolean] = [true, true, true, true],
): void {
  if (rectWidth(rect) <= EPS || rectDepth(rect) <= EPS || topY <= bottomY + EPS) {
    return;
  }
  builder.addBlock(
    {
      bottom: rectCorners(rect).map((point) => ({ ...point, y: bottomY })),
      top: rectCorners(rect).map((point) => ({ ...point, y: topY })),
    },
    { sides, top: showTop, bottom: showBottom },
  );
}

function faceIsCoveredByContact(
  face: readonly Vertex3[],
  contacts: readonly { readonly y: number; readonly rect: Rect }[],
): boolean {
  if (face.length !== 4 || faceNormalY(face) < 0.99) {
    return false;
  }
  const y = face[0]?.y;
  if (y === undefined || face.some((point) => Math.abs(point.y - y) > EPS)) {
    return false;
  }
  return contacts.some((contact) =>
    Math.abs(contact.y - y) <= EPS
    && face.every((point) => pointInsideRect(point, contact.rect)));
}

function pointInsideRect(point: Vertex3, rect: Rect): boolean {
  return point.x >= rect.minX - EPS
    && point.x <= rect.maxX + EPS
    && point.z >= rect.minZ - EPS
    && point.z <= rect.maxZ + EPS;
}

function faceNormal(face: readonly Vertex3[]): Vertex3 {
  const a = face[0];
  const b = face[1];
  const c = face[2];
  if (!a || !b || !c) {
    return { x: 0, y: 0, z: 0 };
  }
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const length = Math.hypot(cross.x, cross.y, cross.z);
  return length > EPS
    ? { x: cross.x / length, y: cross.y / length, z: cross.z / length }
    : { x: 0, y: 0, z: 0 };
}

function faceNormalY(face: readonly Vertex3[]): number {
  return faceNormal(face).y;
}
