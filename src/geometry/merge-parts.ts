import * as THREE from "three";
import {
  MATERIAL_SLOTS,
  emptyPartStats,
  emptySectionStats,
  type GeometryPart,
  type MaterialSlot,
  type PartSection,
  type PartStats,
} from "./part";

export interface MergedComposition {
  /** Indexed, with one coalesced draw group per non-empty material slot. */
  readonly geometry: THREE.BufferGeometry;
  readonly sections: Readonly<Record<PartSection, PartStats>>;
  readonly totals: PartStats;
}

type PreparedPart = {
  readonly part: GeometryPart;
  readonly position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  readonly normal: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  readonly index: THREE.BufferAttribute;
  readonly vertexCount: number;
  readonly baseUvs: Float32Array;
  readonly vertexAoBase: Float32Array;
  readonly bakedShadowBase: Float32Array;
  readonly surfaceMaterials: Uint8Array;
};

/**
 * Merges local-space parts into one indexed geometry.
 *
 * Vertices retain the existing stable part-slot order while triangles are
 * coalesced by their semantic `surfaceMaterial` owner. Each used slot therefore
 * becomes exactly one draw group — unlike `mergeGeometries`, which emits one
 * group per input. Positions and normals are transformed by each part's matrix
 * on the way into the destination buffers, so no part geometry is ever cloned
 * or mutated and cached parts stay reusable.
 *
 * The live `uv` and `vertexAo` attributes are seeded from `userData` rather than
 * from the part's own live attributes, so a part that was already scaled or
 * dimmed by the scene cannot leak that state into the composition.
 *
 * `declaredSections` seeds the stats record so a section that produced no parts
 * still reports zero. Sections observed on parts but not declared are added as
 * they are encountered.
 */
export function mergeParts(
  parts: readonly GeometryPart[],
  declaredSections: Iterable<PartSection> = [],
): MergedComposition {
  const ordered = orderBySlot(parts);
  const sections = emptySectionStats(declaredSections);
  const totals = emptyPartStats();

  let vertexTotal = 0;
  let indexTotal = 0;

  for (const prepared of ordered) {
    vertexTotal += prepared.vertexCount;
    indexTotal += prepared.index.count;
  }

  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const vertexAo = new Float32Array(vertexTotal);
  const colors = new Float32Array(vertexTotal * 3).fill(1);
  const baseUvs = new Float32Array(vertexTotal * 2);
  const vertexAoBase = new Float32Array(vertexTotal);
  const bakedShadowBase = new Float32Array(vertexTotal);
  const surfaceMaterials = new Uint8Array(vertexTotal);
  const indices = new Uint32Array(indexTotal);
  const slotIndexCounts = new Map<MaterialSlot, number>();
  const slotIndices = MATERIAL_SLOTS.map(() => [] as number[]);

  let vertexOffset = 0;

  for (const prepared of ordered) {
    const { part, position, normal, index, vertexCount } = prepared;

    writePositions(positions, position, part.matrix, vertexOffset);
    writeNormals(normals, normal, part.matrix, vertexOffset);

    uvs.set(prepared.baseUvs, vertexOffset * 2);
    baseUvs.set(prepared.baseUvs, vertexOffset * 2);
    vertexAo.set(prepared.vertexAoBase, vertexOffset);
    vertexAoBase.set(prepared.vertexAoBase, vertexOffset);
    bakedShadowBase.set(prepared.bakedShadowBase, vertexOffset);
    surfaceMaterials.set(prepared.surfaceMaterials, vertexOffset);

    for (let cursor = 0; cursor < index.count; cursor += 3) {
      const a = readPartIndex(part, index, cursor, position.count);
      const b = readPartIndex(part, index, cursor + 1, position.count);
      const c = readPartIndex(part, index, cursor + 2, position.count);
      const materialA = prepared.surfaceMaterials[a];
      const materialB = prepared.surfaceMaterials[b];
      const materialC = prepared.surfaceMaterials[c];

      if (
        materialA === undefined
        || materialB === undefined
        || materialC === undefined
      ) {
        throw new Error(
          `Part "${part.id}" triangle ${cursor / 3} has no surface material.`,
        );
      }
      if (materialA !== materialB || materialA !== materialC) {
        throw new Error(
          `Part "${part.id}" triangle ${cursor / 3} spans multiple surface materials.`,
        );
      }
      if (materialA >= MATERIAL_SLOTS.length) {
        throw new RangeError(
          `Part "${part.id}" triangle ${cursor / 3} uses unknown surface material ${materialA}.`,
        );
      }

      slotIndices[materialA]!.push(
        a + vertexOffset,
        b + vertexOffset,
        c + vertexOffset,
      );
    }

    const sectionStats = sections[part.section] ?? emptyPartStats();
    sections[part.section] = sectionStats;
    sectionStats.partCount += 1;
    sectionStats.stoneCount += part.stoneCount;
    sectionStats.vertexCount += vertexCount;
    sectionStats.triangleCount += index.count / 3;

    vertexOffset += vertexCount;
  }

  let indexOffset = 0;
  for (let slot = 0; slot < MATERIAL_SLOTS.length; slot += 1) {
    const source = slotIndices[slot]!;
    indices.set(source, indexOffset);
    slotIndexCounts.set(MATERIAL_SLOTS[slot]!, source.length);
    indexOffset += source.length;
  }

  for (const stats of Object.values(sections)) {
    totals.partCount += stats.partCount;
    totals.stoneCount += stats.stoneCount;
    totals.vertexCount += stats.vertexCount;
    totals.triangleCount += stats.triangleCount;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("vertexAo", new THREE.BufferAttribute(vertexAo, 1));
  geometry.setAttribute(
    "surfaceMaterial",
    new THREE.Uint8BufferAttribute(surfaceMaterials, 1),
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.userData.baseUvs = baseUvs;
  geometry.userData.vertexAoBase = vertexAoBase;
  geometry.userData.bakedShadowBase = bakedShadowBase;
  addMaterialGroups(geometry, slotIndexCounts);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return { geometry, sections, totals };
}

/**
 * Stable-partitions parts by their fallback material slot, dropping empty parts
 * and validating the part contract on the way. Triangle grouping is resolved
 * later from each vertex's semantic material attribute.
 */
function orderBySlot(parts: readonly GeometryPart[]): PreparedPart[] {
  const ordered: PreparedPart[] = [];

  for (const slot of MATERIAL_SLOTS) {
    for (const part of parts) {
      if (part.slot !== slot) {
        continue;
      }

      const prepared = preparePart(part);

      if (prepared) {
        ordered.push(prepared);
      }
    }
  }

  return ordered;
}

function preparePart(part: GeometryPart): PreparedPart | null {
  const position = part.geometry.getAttribute("position");

  if (!position || position.count === 0) {
    return null;
  }

  const normal = part.geometry.getAttribute("normal");
  const index = part.geometry.getIndex();

  if (!normal) {
    throw new Error(`Part "${part.id}" is missing a normal attribute.`);
  }
  if (!index) {
    throw new Error(`Part "${part.id}" is missing an index.`);
  }
  if (index.count === 0) {
    throw new Error(`Part "${part.id}" has vertices but an empty index.`);
  }
  if (index.count % 3 !== 0) {
    throw new Error(
      `Part "${part.id}" index count ${index.count} is not divisible by three.`,
    );
  }

  if (part.matrix.determinant() <= 0) {
    throw new Error(
      `Part "${part.id}" has a mirrored or degenerate matrix, which would invert its winding.`,
    );
  }

  const vertexCount = position.count;

  return {
    part,
    position,
    normal,
    index,
    vertexCount,
    baseUvs: readBaseArray(part, "baseUvs", vertexCount * 2),
    vertexAoBase: readBaseArray(part, "vertexAoBase", vertexCount),
    bakedShadowBase: readBaseArray(part, "bakedShadowBase", vertexCount),
    surfaceMaterials: readSurfaceMaterials(part, vertexCount),
  };
}

function readSurfaceMaterials(
  part: GeometryPart,
  vertexCount: number,
): Uint8Array {
  const attribute = part.geometry.getAttribute("surfaceMaterial");

  if (!attribute) {
    return new Uint8Array(vertexCount).fill(
      MATERIAL_SLOTS.indexOf(part.slot),
    );
  }
  if (attribute.itemSize !== 1 || attribute.count !== vertexCount) {
    throw new Error(
      `Part "${part.id}" surfaceMaterial has ${attribute.count} entries of size ${attribute.itemSize}; expected ${vertexCount} entries of size 1.`,
    );
  }

  const materials = new Uint8Array(vertexCount);

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const material = attribute.getX(vertex);

    if (
      !Number.isInteger(material)
      || material < 0
      || material >= MATERIAL_SLOTS.length
    ) {
      throw new RangeError(
        `Part "${part.id}" vertex ${vertex} uses unknown surface material ${material}.`,
      );
    }

    materials[vertex] = material;
  }

  return materials;
}

function readPartIndex(
  part: GeometryPart,
  index: THREE.BufferAttribute,
  cursor: number,
  vertexCount: number,
): number {
  const value = index.getX(cursor);

  if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
    throw new Error(
      `Part "${part.id}" index ${cursor} references invalid vertex ${value}.`,
    );
  }

  return value;
}

function readBaseArray(
  part: GeometryPart,
  key: "baseUvs" | "vertexAoBase" | "bakedShadowBase",
  expectedLength: number,
): Float32Array {
  const value = part.geometry.userData[key] as unknown;

  if (!(value instanceof Float32Array)) {
    throw new Error(`Part "${part.id}" is missing userData.${key}.`);
  }
  if (value.length !== expectedLength) {
    throw new Error(
      `Part "${part.id}" userData.${key} has ${value.length} entries; expected ${expectedLength}.`,
    );
  }

  return value;
}

function writePositions(
  target: Float32Array,
  source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrix: THREE.Matrix4,
  vertexOffset: number,
): void {
  const contiguous = isIdentity(matrix) ? plainFloat32(source) : null;

  if (contiguous) {
    target.set(contiguous, vertexOffset * 3);
    return;
  }

  const e = matrix.elements;

  for (let vertex = 0; vertex < source.count; vertex += 1) {
    const x = source.getX(vertex);
    const y = source.getY(vertex);
    const z = source.getZ(vertex);
    const offset = (vertexOffset + vertex) * 3;
    target[offset] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    target[offset + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    target[offset + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  }
}

function writeNormals(
  target: Float32Array,
  source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrix: THREE.Matrix4,
  vertexOffset: number,
): void {
  const contiguous = isIdentity(matrix) ? plainFloat32(source) : null;

  if (contiguous) {
    target.set(contiguous, vertexOffset * 3);
    return;
  }

  const n = new THREE.Matrix3().getNormalMatrix(matrix).elements;

  for (let vertex = 0; vertex < source.count; vertex += 1) {
    const x = source.getX(vertex);
    const y = source.getY(vertex);
    const z = source.getZ(vertex);
    const nx = n[0]! * x + n[3]! * y + n[6]! * z;
    const ny = n[1]! * x + n[4]! * y + n[7]! * z;
    const nz = n[2]! * x + n[5]! * y + n[8]! * z;
    const length = Math.hypot(nx, ny, nz) || 1;
    const offset = (vertexOffset + vertex) * 3;
    target[offset] = nx / length;
    target[offset + 1] = ny / length;
    target[offset + 2] = nz / length;
  }
}

/** Adds one draw group per material slot that actually contains triangles. */
function addMaterialGroups(
  geometry: THREE.BufferGeometry,
  slotIndexCounts: ReadonlyMap<MaterialSlot, number>,
): void {
  let start = 0;

  for (let slot = 0; slot < MATERIAL_SLOTS.length; slot += 1) {
    const count = slotIndexCounts.get(MATERIAL_SLOTS[slot]!) ?? 0;

    if (count === 0) {
      continue;
    }

    geometry.addGroup(start, count, slot);
    start += count;
  }
}

function plainFloat32(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Float32Array | null {
  const array = attribute.array;

  return !(attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    && array instanceof Float32Array
    && array.length === attribute.count * attribute.itemSize
    ? array
    : null;
}

function isIdentity(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;

  return e[0] === 1 && e[1] === 0 && e[2] === 0 && e[3] === 0
    && e[4] === 0 && e[5] === 1 && e[6] === 0 && e[7] === 0
    && e[8] === 0 && e[9] === 0 && e[10] === 1 && e[11] === 0
    && e[12] === 0 && e[13] === 0 && e[14] === 0 && e[15] === 1;
}
