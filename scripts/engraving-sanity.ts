/**
 * What the engraving runtime has to get right before anything is drawn.
 *
 * The bit packing is a contract with another program — the Geometry Engravings
 * editor writes `public/engravings/engravings.json` without this project being
 * consulted — so most of what follows pins that convention rather than this
 * project's own behaviour. The rest pins the two things in the ported map
 * derivation that are silently wrong when they break: the normal encoding and
 * the mip orientation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bitsPerCell,
  decodeEngravingLayer,
  engravingLabel,
  heightByLevel,
  packedByteLength,
  parseEngravingCatalog,
  unpackCellLevels,
  type EngravingCatalogDocument,
} from "../src/engravings/document";
import {
  ENGRAVING_MAX_DIMENSION,
  ENGRAVING_MIN_DIMENSION,
  ENGRAVING_RESOLUTION_TIERS,
  engravingTargetSize,
} from "../src/engravings/resolution";
import {
  createDefaultStructureConfig,
  sectionsForScopes,
} from "../src/config/structure-config";
import { buildEngravingDecalBatches } from "../src/engravings/build";
import { setEngravingCatalog } from "../src/engravings/catalog";
import { StructureComposer } from "../src/structure/composer";
import { allSlots, patchIndex } from "../src/structure/kernel/graph";
import {
  DEFAULT_ENGRAVING_ASSIGNMENT,
  NO_ENGRAVING,
  cloneStructureEngravings,
  validateStructureEngravings,
} from "../src/engravings/config";
import {
  DECAL_MAX_EDGE,
  DECAL_NORMAL_OFFSET,
  MAX_GRID_CELLS,
  MAX_TILE_REPEATS,
  NO_DECAL_REPEAT,
  gridCellRects,
  mergeDecalQuads,
  resolveDecalPlacement,
  resolveDecalQuad,
  resolveDecalRect,
  resolveDecalRepeat,
  resolveGridLayout,
  type DecalTiling,
} from "../src/engravings/decal-geometry";
import {
  createGlyphPicker,
  resolveGlyphPool,
} from "../src/engravings/glyph-pool";
import { containDecalRect } from "../src/engravings/decal-geometry";
import { rasterizeRoundedPixelField } from "../src/engravings/rounded-pixels";
import { deriveSurfaceMaps } from "../src/engravings/surface-maps";
import {
  createHorizontalFrame,
  evaluateFrame,
  type LocalFrame,
} from "../src/structure/kernel/frame";
import type { SlotRecord } from "../src/structure/kernel/slot";
import { listStructures } from "../src/structure/registry";

// --- 1. Round trip against the exporter's own packer -------------------------

/**
 * Copied from the editor's `packDepthValues`
 * (`external/geometry-engravings/src/export/document.ts`). Duplicated rather
 * than imported because the point is to test our decoder against *their*
 * encoder: importing our own inverse of it would prove only that a function
 * agrees with itself.
 */
function packDepthValues(values: readonly number[], levels: number): Uint8Array {
  const bits = bitsPerCell(levels);
  const packed = new Uint8Array(Math.ceil((values.length * bits) / 8));
  let bitOffset = 0;

  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value >= levels) {
      throw new Error(`Depth ${value} cannot be encoded with ${levels} levels.`);
    }

    for (let bit = 0; bit < bits; bit += 1) {
      if ((value & (1 << bit)) !== 0) {
        const byteIndex = bitOffset >> 3;
        packed[byteIndex] = (packed[byteIndex] ?? 0) | (1 << (bitOffset & 7));
      }

      bitOffset += 1;
    }
  }

  return packed;
}

/** A seeded generator, so a failure is the same failure on the next run. */
function pseudoRandomDepths(count: number, levels: number, seed: number): number[] {
  const values: number[] = [];
  let state = seed >>> 0;

  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(state % levels);
  }

  return values;
}

for (const levels of [2, 3, 4, 8, 16]) {
  const cases: number[][] = [
    pseudoRandomDepths(1000, levels, 0x5eed + levels),
    new Array(37).fill(0),
    new Array(37).fill(levels - 1),
    Array.from({ length: 41 }, (_, index) => (index % 2 === 0 ? 0 : levels - 1)),
    // A length that is not a multiple of eight is where a cell straddling a
    // byte boundary, and a final byte with unused bits, both show up.
    Array.from({ length: 13 }, (_, index) => index % levels),
  ];

  for (const values of cases) {
    const packed = packDepthValues(values, levels);
    assert.equal(
      packed.length,
      packedByteLength(values.length, levels),
      `Packed length disagrees for ${values.length} cells at ${levels} levels.`,
    );
    assert.deepEqual(
      [...unpackCellLevels(packed, values.length, levels)],
      values,
      `Round trip failed for ${values.length} cells at ${levels} levels.`,
    );
  }
}

// --- 2. Known vectors --------------------------------------------------------

// Least significant bit first, so 0b10110100 reads right to left.
assert.deepEqual(
  [...unpackCellLevels(Uint8Array.of(0b10110100), 8, 2)],
  [0, 0, 1, 0, 1, 1, 0, 1],
  "Single-bit cells must unpack least-significant-bit first.",
);

// Two bits per cell: 0b11100100 is 00 | 01 | 10 | 11 read from the low end.
assert.deepEqual(
  [...unpackCellLevels(Uint8Array.of(0b11100100), 4, 4)],
  [0, 1, 2, 3],
  "Two-bit cells must unpack least-significant-bit first.",
);

assert.throws(
  () => unpackCellLevels(Uint8Array.of(0, 0), 8, 2),
  /2 bytes; 8 cells at 2 levels need 1/,
  "A byte-length mismatch must name both figures.",
);

// Three levels take two bits, so a value of 3 is representable but invalid.
assert.throws(
  () => unpackCellLevels(Uint8Array.of(0b00000011), 1, 3),
  /outside 0\.\.2/,
  "A cell decoded above the level count must be rejected, not clamped.",
);

// --- 3. The real asset -------------------------------------------------------

const catalogSource = JSON.parse(
  readFileSync("public/engravings/engravings.json", "utf8"),
) as EngravingCatalogDocument;

const catalog = parseEngravingCatalog(catalogSource);
const layerCount = Object.keys(catalogSource.layers).length;

assert.equal(
  catalog.ids.length,
  layerCount,
  `Every layer in the project must decode; ${catalog.ids.length} of ${layerCount} did.`,
);
assert.equal(catalog.layers.size, catalog.ids.length);
assert.equal(
  Object.keys(catalog.options).length,
  catalog.ids.length,
  "Two layers must not collapse onto one pane label.",
);

const levelCounts = new Set<number>();

for (const id of catalog.ids) {
  const layer = catalog.layers.get(id)!;
  const source = catalogSource.layers[id]!;
  levelCounts.add(layer.levels);

  assert.equal(
    layer.cellLevels.length,
    layer.width * layer.height,
    `Layer "${id}" decoded the wrong number of cells.`,
  );
  assert.equal(
    Math.ceil((source.data.length * 3) / 4) - countBase64Padding(source.data),
    packedByteLength(layer.width * layer.height, layer.levels),
    `Layer "${id}" carries the wrong number of packed bytes.`,
  );

  for (const value of layer.cellLevels) {
    assert.ok(
      value < layer.levels,
      `Layer "${id}" holds a cell at level ${value} of ${layer.levels}.`,
    );
  }
}

assert.deepEqual(
  [...levelCounts].sort((left, right) => left - right),
  [2, 4],
  "The shipped project is meant to exercise both a one-bit and a two-bit packing.",
);

assert.equal(engravingLabel("pattern-a"), "Pattern A");
assert.equal(engravingLabel("glyph-ollin-2"), "Glyph ollin 2");
assert.equal(engravingLabel("ribbon-jaguar"), "Ribbon jaguar");

assert.throws(
  () => parseEngravingCatalog({ ...catalogSource, version: 2 }),
  /is not the version 1 encoding/,
  "A newer encoding must be refused rather than read as version 1.",
);
assert.throws(
  () => parseEngravingCatalog({ ...catalogSource, format: "something-else" }),
  /is not "geometry-engravings-optimized"/,
  "A foreign format must be named, not guessed at.",
);

// One unreadable layer must cost exactly that layer. The parser reports the
// skip through `console.error`, which is the right thing in the app and pure
// noise here, so it is captured for the length of this one call.
const firstId = catalog.ids[0]!;
const reported: unknown[] = [];
const realConsoleError = console.error;
console.error = (...args: unknown[]) => { reported.push(args[0]); };

const truncated = parseEngravingCatalog({
  ...catalogSource,
  layers: {
    ...catalogSource.layers,
    [firstId]: { ...catalogSource.layers[firstId]!, data: "AA==" },
  },
});

console.error = realConsoleError;
assert.equal(reported.length, 1, "Exactly one layer should have been reported.");
assert.match(
  String(reported[0]),
  new RegExp(`"${firstId}" could not be read`),
  "A skipped layer must be named.",
);
assert.equal(
  truncated.ids.length,
  catalog.ids.length - 1,
  "A malformed layer must be skipped without taking the file with it.",
);
assert.ok(!truncated.layers.has(firstId));

assert.throws(
  () => decodeEngravingLayer("bad", { width: 4, height: 4, levels: 1, data: "AA==" }),
  /outside 2\.\.32/,
  "A single depth level has no depth to describe.",
);
assert.throws(
  () => decodeEngravingLayer("bad", {
    width: 2, height: 1, levels: 2, data: "AA==", pixelCornerRadius: 0.9,
  }),
  /outside 0\.\.0\.5/,
  "A corner radius past half a cell is not a rounding.",
);

// --- 4. Level greys ----------------------------------------------------------

assert.deepEqual([...heightByLevel(2)], [255, 0]);
assert.deepEqual([...heightByLevel(4)], [255, 170, 85, 0]);

// --- 5. Target resolution ----------------------------------------------------

// The smallest layer is lifted by the floor, the largest is held by the
// ceiling, and the ones in between are governed by the ratio alone.
assert.deepEqual(engravingTargetSize(4, 6), { width: 64, height: 96 });
assert.deepEqual(engravingTargetSize(110, 110), { width: 384, height: 384 });
assert.deepEqual(engravingTargetSize(32, 128), { width: 96, height: 384 });
assert.deepEqual(engravingTargetSize(30, 14), { width: 360, height: 168 });

for (const id of catalog.ids) {
  const layer = catalog.layers.get(id)!;
  const target = engravingTargetSize(layer.width, layer.height);
  const longest = Math.max(target.width, target.height);

  assert.ok(
    longest >= ENGRAVING_MIN_DIMENSION && longest <= ENGRAVING_MAX_DIMENSION,
    `Layer "${id}" derives a ${target.width} by ${target.height} map, outside the bounds.`,
  );
  assert.ok(
    target.width % 4 === 0 && target.height % 4 === 0,
    `Layer "${id}" derives an unaligned ${target.width} by ${target.height} map.`,
  );
  // Aspect is preserved to within the four-texel rounding.
  assert.ok(
    Math.abs(target.width / target.height - layer.width / layer.height)
      < 8 / Math.min(target.width, target.height),
    `Layer "${id}" derives a map that does not hold its aspect.`,
  );
}

// --- 6. Map derivation -------------------------------------------------------

const CHECKER_CELLS = 4;
const CHECKER_SIZE = 32;
const checker = Uint8Array.from(
  { length: CHECKER_CELLS * CHECKER_CELLS },
  (_, index) => (
    (Math.floor(index / CHECKER_CELLS) + (index % CHECKER_CELLS)) % 2
  ),
);
const checkerHeights = heightByLevel(2);
const checkerField = rasterizeRoundedPixelField(
  checker,
  CHECKER_CELLS,
  CHECKER_CELLS,
  CHECKER_SIZE,
  CHECKER_SIZE,
  0.5,
  checkerHeights,
);

assert.equal(checkerField.length, CHECKER_SIZE * CHECKER_SIZE);

const checkerMaps = deriveSurfaceMaps(
  checkerField,
  CHECKER_SIZE,
  CHECKER_SIZE,
  1,
  CHECKER_SIZE / CHECKER_CELLS,
);

const expectedMipCount = Math.floor(Math.log2(CHECKER_SIZE)) + 1;

for (const [name, chain, components] of [
  ["normal", checkerMaps.normalMipmaps, 4],
  ["ambient occlusion", checkerMaps.ambientOcclusionMipmaps, 1],
  ["moisture", checkerMaps.moistureAccumulationMipmaps, 1],
] as const) {
  assert.equal(
    chain.length,
    expectedMipCount,
    `The ${name} chain must run to a single texel; it has ${chain.length} levels.`,
  );
  assert.equal(chain[0]!.width, CHECKER_SIZE);
  assert.equal(chain[0]!.height, CHECKER_SIZE);

  for (let index = 0; index < chain.length; index += 1) {
    const level = chain[index]!;
    assert.equal(
      level.data.length,
      level.width * level.height * components,
      `The ${name} chain's level ${index} is the wrong size for its dimensions.`,
    );

    if (index === 0) {
      continue;
    }

    const previous = chain[index - 1]!;
    assert.equal(level.width, Math.max(1, Math.floor(previous.width / 2)));
    assert.equal(level.height, Math.max(1, Math.floor(previous.height / 2)));
  }
}

/**
 * A flat field has no slope anywhere, so every normal points straight out.
 *
 * Red comes back as 128 and green as 127, and that asymmetry is the assertion
 * worth having. Zero encodes as `round(0.5 * 255)` = 128, and the orientation
 * pass then inverts green to `255 - 128` = 127. So green being 128 here would
 * mean the inversion never ran, and green being anything else would mean the
 * encoding moved. One byte pins both.
 */
const flatMaps = deriveSurfaceMaps(new Uint8Array(8 * 8).fill(200), 8, 8, 1, 1);
const flatNormals = flatMaps.normalMipmaps[0]!.data;

for (let index = 0; index < flatNormals.length; index += 4) {
  assert.deepEqual(
    [...flatNormals.subarray(index, index + 4)],
    [128, 127, 255, 255],
    "A flat height field must encode as a straight-out, green-inverted normal.",
  );
}

/**
 * The orientation flip is invisible on a symmetric field and inverts the
 * lighting on every other one, so it is checked against a field that is dark at
 * the top and light at the bottom.
 */
const RAMP_SIZE = 8;
const ramp = Uint8Array.from(
  { length: RAMP_SIZE * RAMP_SIZE },
  (_, index) => Math.floor(index / RAMP_SIZE) * 32,
);
const rampMaps = deriveSurfaceMaps(ramp, RAMP_SIZE, RAMP_SIZE, 1, 1);
const rampOcclusion = rampMaps.ambientOcclusionMipmaps[0]!;

// Row 0 of the uploaded map is the field's *last* row, because every level is
// oriented for Three's UVs on the CPU rather than by `flipY`.
const rampTopRow = [...rampOcclusion.data.subarray(0, RAMP_SIZE)];
const rampBottomRow = [
  ...rampOcclusion.data.subarray(
    (RAMP_SIZE - 1) * RAMP_SIZE,
    RAMP_SIZE * RAMP_SIZE,
  ),
];
assert.notDeepEqual(
  rampTopRow,
  rampBottomRow,
  "The ramp must occlude differently at its two ends for this to prove anything.",
);

const unorientedRamp = deriveOccludedRows(ramp, RAMP_SIZE);
assert.deepEqual(
  rampTopRow,
  unorientedRamp[RAMP_SIZE - 1],
  "Every mip level must be flipped for Three's UVs, not just the base.",
);

/**
 * The normal chain is flipped and green-inverted in the same pass, which is
 * what turns an image-space normal into the +Y-up convention `normalMap()`
 * expects. Checking them together is the only way to catch the case where one
 * was undone and the other was not: on a vertically symmetric field the two
 * cancel exactly.
 */
const rampNormals = rampMaps.normalMipmaps[0]!.data;
const unorientedGreens = deriveNormalGreenRows(ramp, RAMP_SIZE);

assert.ok(
  new Set(unorientedGreens.flat()).size > 1,
  "The ramp must slope for this to prove anything.",
);

for (let y = 0; y < RAMP_SIZE; y += 1) {
  const row = [...rampNormals.subarray(y * RAMP_SIZE * 4, (y + 1) * RAMP_SIZE * 4)]
    .filter((_, index) => index % 4 === 1);

  assert.deepEqual(
    row,
    unorientedGreens[RAMP_SIZE - 1 - y]!.map((green) => 255 - green),
    `Normal row ${y} must be the mirrored source row with green inverted.`,
  );
}

/**
 * Re-derives just the occlusion rows without the orientation pass, by running
 * the same horizon rule the map does. Only used to prove the flip happened.
 */
function deriveOccludedRows(field: Uint8Array, size: number): number[][] {
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
  ] as const;
  const radii = [1, 2, 4, 8, 16] as const;
  const wrap = (value: number) => ((value % size) + size) % size;
  const sample = (x: number, y: number) => field[wrap(y) * size + wrap(x)]! / 255;
  const rows: number[][] = [];

  for (let y = 0; y < size; y += 1) {
    const row: number[] = [];

    for (let x = 0; x < size; x += 1) {
      const base = sample(x, y);
      let horizon = 0;

      for (const [directionX, directionY] of directions) {
        const length = Math.hypot(directionX, directionY);
        let directionHorizon = 0;

        for (const radius of radii) {
          directionHorizon = Math.max(
            directionHorizon,
            (sample(x + directionX * radius, y + directionY * radius) - base)
              / (radius * length),
          );
        }

        horizon += directionHorizon;
      }

      row.push(Math.round(Math.max(0.18, 1 - (horizon / directions.length) * 3.2) * 255));
    }

    rows.push(row);
  }

  return rows;
}

// --- 7. Decal placement against a real slot ----------------------------------

interface FixtureGraph {
  readonly masses: readonly {
    readonly slots: readonly SlotRecord[];
  }[];
  readonly patches: readonly { readonly id: string; readonly frame: LocalFrame }[];
}

const fixture = JSON.parse(
  readFileSync("tests/fixtures/structure/engraved-terraces.json", "utf8"),
) as FixtureGraph;

const fixtureSlot = fixture.masses
  .flatMap((mass) => mass.slots)
  .find((slot) => slot.id === "structure/mass_main/base/facade_front/slot_1");
assert.ok(fixtureSlot, "The engraved-terraces fixture must still publish slot_1.");

const fixtureFrame = fixture.patches.find(
  (patch) => patch.id === fixtureSlot.patchId,
)?.frame;
assert.ok(fixtureFrame, "The fixture slot must still name a patch that exists.");

/**
 * A margin-free stretch is the identity on the published boundary. If it is
 * not, the bilinear mapping disagrees with the kernel about what a slot's
 * corners are, and every other placement is built on that disagreement.
 */
const identityQuad = resolveDecalQuad(fixtureSlot, fixtureFrame, {
  fit: "stretch",
  margin: 0,
  aspect: 1,
  offset: 0,
})!;
assert.ok(identityQuad, "A well-formed slot must resolve a quad.");

fixtureSlot.boundary.forEach((corner, index) => {
  const expected = evaluateFrame(fixtureFrame, corner.u, corner.v, 0);
  const actual = identityQuad.corners[index]!;

  for (const axis of ["x", "y", "z"] as const) {
    assert.ok(
      Math.abs(actual[axis] - expected[axis]) < 1e-9,
      `Stretched corner ${index} drifted on ${axis}: `
      + `${actual[axis]} against ${expected[axis]}.`,
    );
  }
});

// The stand-off runs along the frame normal and nowhere else.
const offsetQuad = resolveDecalQuad(fixtureSlot, fixtureFrame, {
  fit: "stretch",
  margin: 0,
  aspect: 1,
  offset: DECAL_NORMAL_OFFSET,
})!;

offsetQuad.corners.forEach((corner, index) => {
  const flat = identityQuad.corners[index]!;

  for (const axis of ["x", "y", "z"] as const) {
    assert.ok(
      Math.abs(
        (corner[axis] - flat[axis]) - fixtureFrame.normal[axis] * DECAL_NORMAL_OFFSET,
      ) < 1e-9,
      `The offset must move corner ${index} along the normal alone.`,
    );
  }
});

// A margin pulls the quad strictly inside the boundary, by twice itself on each
// axis — this slot is 7.78 m wide and 0.13 m tall, so both are measurable.
const MARGIN = 0.01;
const marginRect = resolveDecalRect(fixtureSlot, {
  fit: "stretch",
  margin: MARGIN,
  aspect: 1,
})!;
const marginWidth = fixtureSlot.extent.uBottom * (marginRect.sMax - marginRect.sMin);
const marginHeight = fixtureSlot.extent.v * (marginRect.tMax - marginRect.tMin);

assert.ok(
  Math.abs(marginWidth - (fixtureSlot.extent.uBottom - 2 * MARGIN)) < 1e-9,
  `A margin must take ${MARGIN} m off each side; the width came back ${marginWidth}.`,
);
assert.ok(
  Math.abs(marginHeight - (fixtureSlot.extent.v - 2 * MARGIN)) < 1e-9,
  `A margin must take ${MARGIN} m off each side; the height came back ${marginHeight}.`,
);
assert.ok(
  marginRect.sMin > 0 && marginRect.sMax < 1
  && marginRect.tMin > 0 && marginRect.tMax < 1,
  "A margined rectangle must lie strictly inside its slot.",
);

// A margin larger than the slot must clamp rather than invert it.
const crushedRect = resolveDecalRect(fixtureSlot, {
  fit: "stretch",
  margin: 100,
  aspect: 1,
})!;
assert.ok(
  crushedRect.sMax > crushedRect.sMin && crushedRect.tMax > crushedRect.tMin,
  "An overlarge margin must clamp, not turn the slot inside out.",
);

/**
 * Contain on this slot is the hard case: it is 7.78 m by 0.13 m, an aspect of
 * nearly sixty, so a square motif has to letterbox almost entirely away in `u`.
 */
const containRect = resolveDecalRect(fixtureSlot, {
  fit: "contain",
  margin: 0,
  aspect: 1,
})!;
const containAspect = (fixtureSlot.extent.uBottom * (containRect.sMax - containRect.sMin))
  / (fixtureSlot.extent.v * (containRect.tMax - containRect.tMin));

assert.ok(
  Math.abs(containAspect - 1) < 1e-6,
  `A contained square must come back square; its aspect is ${containAspect}.`,
);
assert.ok(
  Math.abs((containRect.sMin + containRect.sMax) / 2 - 0.5) < 1e-9
  && Math.abs((containRect.tMin + containRect.tMax) / 2 - 0.5) < 1e-9,
  "Containing must letterbox symmetrically, leaving the motif centred.",
);
assert.ok(
  Math.abs(containRect.tMax - containRect.tMin - 1) < 1e-9,
  "The short axis is the one that fills; here that is the slot's height.",
);

// A wide motif in a tall slot is the same rule the other way round.
const tallContain = resolveDecalRect(
  { ...fixtureSlot, extent: { uBottom: 1, uTop: 1, v: 4 } },
  { fit: "contain", margin: 0, aspect: 2 },
)!;
assert.ok(
  Math.abs((1 * (tallContain.sMax - tallContain.sMin))
    / (4 * (tallContain.tMax - tallContain.tMin)) - 2) < 1e-6,
  "Containing must shrink the other axis when the slot is the taller one.",
);
assert.ok(
  Math.abs(tallContain.sMax - tallContain.sMin - 1) < 1e-9,
  "A slot taller than its motif fills across.",
);

/**
 * The handedness trap. A facade's u crossed into its v points along its normal;
 * a horizontal frame's points against it. Both must produce a quad that faces
 * the viewer, so exactly one of them has to be wound the other way.
 */
assert.equal(
  identityQuad.flipWinding,
  false,
  "A facade frame is right-handed about its normal and must not be flipped.",
);
assert.equal(
  resolveDecalQuad(
    fixtureSlot,
    createHorizontalFrame({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, 3),
    { fit: "stretch", margin: 0, aspect: 1 },
  )!.flipWinding,
  true,
  "A horizontal frame is left-handed about its normal and must be flipped.",
);

// --- 8. Merging --------------------------------------------------------------

/**
 * A decal is divided until no edge outruns the bound the structure's own
 * geometry is refined to. That is what lets a shadow cross an engraved
 * elevation continuously instead of stopping at the engraving: the sun is baked
 * per vertex, and four corners cannot describe a stair's shadow edge.
 */
const mergedQuads = [identityQuad, offsetQuad, identityQuad];
const merged = mergeDecalQuads(mergedQuads)!;
assert.ok(merged, "Three quads must merge.");

// This slot is 7.78 m by 0.13 m, so it divides across and not up.
const columns = Math.ceil(fixtureSlot.extent.uBottom / DECAL_MAX_EDGE);
assert.ok(columns > 1, "The fixture slot must be long enough to divide.");
const perQuadVertices = (columns + 1) * 2;
const perQuadIndices = columns * 6;

assert.equal(
  merged.getAttribute("position").count,
  mergedQuads.length * perQuadVertices,
);
assert.equal(merged.getIndex()!.count, mergedQuads.length * perQuadIndices);

const engravingUv = merged.getAttribute("engravingUv");
const index = merged.getIndex()!;

for (let quad = 0; quad < mergedQuads.length; quad += 1) {
  const from = quad * perQuadVertices;
  const to = from + perQuadVertices;

  for (let step = 0; step < perQuadIndices; step += 1) {
    const value = index.getX(quad * perQuadIndices + step);
    assert.ok(
      value >= from && value < to,
      `Quad ${quad} must index only its own vertices.`,
    );
  }

  // However finely it was divided, the engraving still occupies exactly one
  // unit square: the corners are present and nothing runs outside them. This
  // holds whatever the repeat is — the tiled UVs live on their own attribute,
  // and this one stays the slot's own space for the moisture blotching to read.
  const us: number[] = [];
  const vs: number[] = [];

  for (let vertex = from; vertex < to; vertex += 1) {
    us.push(engravingUv.getX(vertex));
    vs.push(engravingUv.getY(vertex));
  }

  assert.equal(Math.min(...us), 0, `Quad ${quad} must start at u 0.`);
  assert.equal(Math.max(...us), 1, `Quad ${quad} must reach u 1.`);
  assert.equal(Math.min(...vs), 0, `Quad ${quad} must start at v 0.`);
  assert.equal(Math.max(...vs), 1, `Quad ${quad} must reach v 1.`);
}

// Every divided vertex must still lie on the original quad, or the decal has
// drifted off the stone it was placed against.
const position = merged.getAttribute("position");
const [cornerA] = identityQuad.corners;
const planeNormal = identityQuad.normal;
const planeOffset = planeNormal.x * cornerA.x
  + planeNormal.y * cornerA.y
  + planeNormal.z * cornerA.z;

for (let vertex = 0; vertex < perQuadVertices; vertex += 1) {
  const distance = planeNormal.x * position.getX(vertex)
    + planeNormal.y * position.getY(vertex)
    + planeNormal.z * position.getZ(vertex)
    - planeOffset;
  assert.ok(
    Math.abs(distance) < 1e-9,
    `Divided vertex ${vertex} left the quad's plane by ${distance}.`,
  );
}

// A quad short on both axes is left whole, so nothing is divided for its own sake.
const smallMerged = mergeDecalQuads([{
  corners: [
    { x: 0, y: 0, z: 0 },
    { x: 0.4, y: 0, z: 0 },
    { x: 0.4, y: 0.3, z: 0 },
    { x: 0, y: 0.3, z: 0 },
  ],
  normal: { x: 0, y: 0, z: 1 },
  flipWinding: false,
  repeat: NO_DECAL_REPEAT,
}])!;
assert.equal(
  smallMerged.getAttribute("position").count,
  4,
  "A decal smaller than the bound must stay a single quad.",
);
smallMerged.dispose();

for (const name of ["uv", "vertexAo", "color"] as const) {
  assert.ok(
    merged.getAttribute(name),
    `A decal must carry ${name}; the scene's per-vertex passes all read it.`,
  );
}

const mergedVertices = merged.getAttribute("position").count;

for (const key of ["baseUvs", "vertexAoBase", "bakedShadowBase"] as const) {
  assert.equal(
    (merged.userData[key] as Float32Array).length,
    key === "baseUvs" ? mergedVertices * 2 : mergedVertices,
    `A decal must carry a ${key} array the live attribute is re-derived from.`,
  );
}

// The three base arrays must not alias the live attributes, or a slider would
// scale its own input and drift a little further on every change.
assert.notEqual(merged.userData.baseUvs, merged.getAttribute("uv").array);
assert.notEqual(merged.userData.vertexAoBase, merged.getAttribute("vertexAo").array);

merged.dispose();
assert.equal(mergeDecalQuads([]), null, "Nothing to place is not a geometry.");

// --- 8b. Arrangements --------------------------------------------------------

const seamless = (
  mode: DecalTiling["mode"],
  scale: number,
): DecalTiling => ({ mode, scale, cellMin: 0.1, cellMax: 1, gutter: 0 });

/**
 * A tile is derived from the motif's own proportions rather than typed, because
 * one assignment resolves every slot its feature matches and a stated size could
 * only be right for one of them. A square motif on a two-by-half-metre band is
 * therefore four across, and doubling the scale halves that.
 */
assert.deepEqual(resolveDecalRepeat(2, 0.5, 1, seamless("horizontal", 1)), { s: 4, t: 1 });
assert.deepEqual(resolveDecalRepeat(2, 0.5, 1, seamless("horizontal", 2)), { s: 2, t: 1 });
// A 1:4 ribbon is four times as tall as it is wide, so it runs four times as
// often along the same band.
assert.deepEqual(resolveDecalRepeat(2, 0.5, 0.25, seamless("horizontal", 1)), { s: 16, t: 1 });
assert.deepEqual(resolveDecalRepeat(0.5, 2, 1, seamless("vertical", 1)), { s: 1, t: 4 });

// Fractional and unrounded: the run starts at the origin corner and the far
// edge cuts the last motif, which is what a band does where it meets a corner.
assert.equal(resolveDecalRepeat(1, 0.3, 1, seamless("horizontal", 1)).s, 1 / 0.3);

// Never below one. A slot too narrow for a repeat gets one squeezed into it
// rather than a fragment of a motif with no beginning.
assert.deepEqual(resolveDecalRepeat(0.2, 1, 1, seamless("horizontal", 1)), { s: 1, t: 1 });
// And never past the guard, however far a slot's height has collapsed.
assert.equal(
  resolveDecalRepeat(1000, 0.001, 1, seamless("horizontal", 1)).s,
  MAX_TILE_REPEATS,
);

// Four ways of asking for nothing, all the same answer. The NaN matters: it
// would otherwise reach a vertex attribute and blank a whole draw call with
// nothing to point at.
assert.deepEqual(resolveDecalRepeat(9, 9, 1, undefined), NO_DECAL_REPEAT);
assert.deepEqual(resolveDecalRepeat(9, 9, 1, seamless("none", 1)), NO_DECAL_REPEAT);
assert.deepEqual(resolveDecalRepeat(9, 9, 1, seamless("horizontal", 0)), NO_DECAL_REPEAT);
assert.deepEqual(
  resolveDecalRepeat(9, 9, 1, seamless("horizontal", Number.NaN)),
  NO_DECAL_REPEAT,
);
// A grid carries its count in the layout rather than here.
assert.deepEqual(resolveDecalRepeat(9, 9, 1, seamless("grid", 1)), NO_DECAL_REPEAT);

/**
 * The identity that makes every claim above safe: at a repeat of one the tiled
 * attribute *is* the slot-local one, so switching tiling off renders exactly
 * what shipped before there was any.
 */
const untiled = mergeDecalQuads([identityQuad])!;
const untiledUv = untiled.getAttribute("engravingUv");
const untiledTileUv = untiled.getAttribute("engravingTileUv");
assert.equal(untiledTileUv.itemSize, 2);
assert.equal(untiledTileUv.count, untiledUv.count);

for (let vertex = 0; vertex < untiledUv.count; vertex += 1) {
  assert.equal(untiledTileUv.getX(vertex), untiledUv.getX(vertex));
  assert.equal(untiledTileUv.getY(vertex), untiledUv.getY(vertex));
}

untiled.dispose();

/**
 * Three quads with three different repeats in one geometry.
 *
 * Not a hypothetical: a batch is keyed by layer and host surface, and a mass
 * puts its band cornice and its summit roof cornice both on `cornice`, so one
 * mesh really does carry two features' settings. That is the whole reason the
 * repeat rides a vertex attribute instead of a material uniform — a uniform
 * would have to pick a winner, and "the stronger tiling" means nothing.
 *
 * The flipped quad is here because a mirrored motif on a terrace or plinth-top
 * slot would be a failure nobody would see.
 */
const tiledQuads = [
  { ...identityQuad, repeat: { s: 6, t: 1 } },
  { ...identityQuad, repeat: { s: 1, t: 3 } },
  { ...identityQuad, flipWinding: true, repeat: { s: 4, t: 2 } },
];
const tiledMerged = mergeDecalQuads(tiledQuads)!;
const tiledUv = tiledMerged.getAttribute("engravingUv");
const tileUv = tiledMerged.getAttribute("engravingTileUv");

for (let quad = 0; quad < tiledQuads.length; quad += 1) {
  const from = quad * perQuadVertices;
  const to = from + perQuadVertices;
  const { s, t } = tiledQuads[quad]!.repeat;
  const us: number[] = [];
  const vs: number[] = [];
  const tileUs: number[] = [];
  const tileVs: number[] = [];

  for (let vertex = from; vertex < to; vertex += 1) {
    us.push(tiledUv.getX(vertex));
    vs.push(tiledUv.getY(vertex));
    tileUs.push(tileUv.getX(vertex));
    tileVs.push(tileUv.getY(vertex));
  }

  assert.equal(Math.min(...us), 0, `Tiled quad ${quad} must still start at u 0.`);
  assert.equal(Math.max(...us), 1, `Tiled quad ${quad} must still reach u 1.`);
  assert.equal(Math.min(...vs), 0, `Tiled quad ${quad} must still start at v 0.`);
  assert.equal(Math.max(...vs), 1, `Tiled quad ${quad} must still reach v 1.`);
  assert.equal(Math.min(...tileUs), 0, `Tiled quad ${quad} must start at tile u 0.`);
  assert.equal(Math.max(...tileUs), s, `Tiled quad ${quad} must reach tile u ${s}.`);
  assert.equal(Math.min(...tileVs), 0, `Tiled quad ${quad} must start at tile v 0.`);
  assert.equal(Math.max(...tileVs), t, `Tiled quad ${quad} must reach tile v ${t}.`);
}

// Tiling a run adds no geometry at all. This is the assertion that would catch
// anyone reintroducing a quad per tile on the seamless path, where the sun bake
// would then scale with a slider.
assert.equal(
  tiledMerged.getAttribute("position").count,
  tiledQuads.length * perQuadVertices,
);
tiledMerged.dispose();

/**
 * The grid fitter, with no ratio bias anywhere in it.
 *
 * Scoring on how much of the field the cells actually cover already prefers the
 * orientation that fits, because a wrongly-turned grid wastes area. Ties — a
 * square field takes two by two and three by three equally well — go to the
 * larger cell, which is what makes the maximum the operative control.
 */
assert.deepEqual(resolveGridLayout(2, 1, 0.4, 1.2), { columns: 2, rows: 1 });
assert.deepEqual(resolveGridLayout(1, 2, 0.4, 1.2), { columns: 1, rows: 2 });
assert.deepEqual(resolveGridLayout(2, 2, 0.4, 1.2), { columns: 2, rows: 2 });
// The case a bias was meant to protect: a field a tenth taller than it is wide
// must stay one cell, because a column of two would cover only 55% of it.
assert.deepEqual(resolveGridLayout(1, 1.1, 0.4, 1.2), { columns: 1, rows: 1 });
assert.deepEqual(resolveGridLayout(1.1, 1, 0.4, 1.2), { columns: 1, rows: 1 });
// A real pier panel, which is the commonest slot in the project.
assert.deepEqual(resolveGridLayout(0.541, 0.333, 0.15, 0.6), { columns: 1, rows: 1 });
assert.deepEqual(resolveGridLayout(0.541, 0.333, 0.15, 0.28), { columns: 2, rows: 1 });

const capped = resolveGridLayout(40, 40, 0.05, 0.05);
assert.ok(
  capped.columns * capped.rows <= MAX_GRID_CELLS,
  `A grid may not exceed ${MAX_GRID_CELLS} cells; got ${capped.columns * capped.rows}.`,
);

// A band far thinner than the smallest cell has no legal division at all, and
// must still place something rather than refusing.
const bandGrid = resolveGridLayout(23.418, 0.16, 0.4, 1.2);
assert.ok(bandGrid.columns >= 1 && bandGrid.rows === 1);

/**
 * Cells are square in metres, and a glyph keeps the shape it was authored as.
 *
 * This is the assertion the whole grid exists to hold. Squaring a glyph is not
 * a rounding fix — only six of the fifteen shipped glyphs are square, and
 * `glyph-scopion` is 50 by 66 — and it is done by containing the glyph in its
 * cell rather than by padding a texture, which is what keeps it free.
 */
const gridSlot: SlotRecord = {
  ...fixtureSlot,
  extent: { uBottom: 2, uTop: 2, v: 2 },
  boundary: [
    { u: 0, v: 0 },
    { u: 2, v: 0 },
    { u: 2, v: 2 },
    { u: 0, v: 2 },
  ],
};
const gridTiling: DecalTiling = {
  mode: "grid",
  scale: 1,
  cellMin: 0.4,
  cellMax: 1.2,
  gutter: 0,
};
const gridPlaced = resolveDecalPlacement(gridSlot, {
  fit: "stretch",
  margin: 0,
  aspect: 1,
  tiling: gridTiling,
})!;
assert.deepEqual(gridPlaced.grid, { columns: 2, rows: 2 });
assert.deepEqual(gridPlaced.repeat, { s: 2, t: 2 });

const gridCells = gridCellRects(gridPlaced.rect, gridPlaced.grid!, 0);
assert.equal(gridCells.length, 4, "A two by two grid has four cells.");

for (const [index, cell] of gridCells.entries()) {
  const width = gridSlot.extent.uBottom * (cell.sMax - cell.sMin);
  const height = gridSlot.extent.v * (cell.tMax - cell.tMin);
  assert.ok(
    Math.abs(width - height) < 1e-9,
    `Cell ${index} must be square in metres; it is ${width} by ${height}.`,
  );
}

// Reading order: the top row comes first, because a sequential run is a text
// and a text starts at the top. `t` runs up the slot, so that is the last row
// along it.
assert.ok(
  gridCells[0]!.tMin > gridCells[2]!.tMin,
  "The first cell must be on the top row.",
);
assert.ok(
  gridCells[0]!.sMin < gridCells[1]!.sMin,
  "The first row must read left to right.",
);

// The gutter shrinks a cell about its own centre and nothing else.
const guttered = gridCellRects(gridPlaced.rect, gridPlaced.grid!, 0.1);

for (const [index, cell] of guttered.entries()) {
  const plain = gridCells[index]!;
  assert.ok(
    Math.abs((cell.sMin + cell.sMax) - (plain.sMin + plain.sMax)) < 1e-12
    && Math.abs((cell.tMin + cell.tMax) - (plain.tMin + plain.tMax)) < 1e-12,
    `Cell ${index} must keep its centre when guttered.`,
  );
  assert.ok(
    cell.sMax - cell.sMin < plain.sMax - plain.sMin,
    `Cell ${index} must shrink when guttered.`,
  );
}

// A glyph that was not authored square keeps its proportions inside a square
// cell. `glyph-scopion` at 50 by 66 is the worst the catalog carries.
const scorpion = 50 / 66;
const contained = containDecalRect(gridSlot, gridCells[0]!, scorpion)!;
const containedAspect = (gridSlot.extent.uBottom * (contained.sMax - contained.sMin))
  / (gridSlot.extent.v * (contained.tMax - contained.tMin));
assert.ok(
  Math.abs(containedAspect - scorpion) < 1e-9,
  `A contained glyph must keep its authored aspect; got ${containedAspect}.`,
);

// --- 8c. The glyph pool ------------------------------------------------------

/**
 * An empty catalog rejects nothing.
 *
 * The project file is loaded from disk after these modules are evaluated, and
 * every default has to validate before that happens — the same reason the
 * document list carries `None` as a real value. Asserted before the catalog is
 * installed below, because afterwards it can never be observed again.
 */
assert.deepEqual(
  resolveGlyphPool("glyph-*"),
  [],
  "An unloaded catalog must yield an empty pool rather than a rejection.",
);

setEngravingCatalog(catalog);

const glyphIds = catalog.ids.filter((id) => id.startsWith("glyph-"));
assert.ok(glyphIds.length > 1, "The catalog must carry glyphs to pool.");

assert.deepEqual(
  resolveGlyphPool("glyph-*").map((layer) => layer.id),
  glyphIds,
  "A wildcard must expand in catalog order.",
);
assert.deepEqual(
  resolveGlyphPool("").map((layer) => layer.id),
  [...catalog.ids],
  "An empty pool means every layer the catalog carries.",
);
// Written order, not catalog order: with a sequential arrangement the pool is
// the sequence, and sorting it would carve something other than what was asked.
assert.deepEqual(
  resolveGlyphPool(" glyph-sun , glyph-eagle ").map((layer) => layer.id),
  ["glyph-sun", "glyph-eagle"],
  "Named layers must keep the order they were written in.",
);
assert.deepEqual(
  resolveGlyphPool("glyph-sun, glyph-sun").map((layer) => layer.id),
  ["glyph-sun"],
  "A repeat collapses to its first appearance.",
);
assert.throws(
  () => resolveGlyphPool("glyph-nonesuch"),
  /glyph-nonesuch/,
  "A layer the catalog does not carry must be named, not dropped.",
);
assert.throws(
  () => resolveGlyphPool("nonesuch-*"),
  /nonesuch-\*/,
  "A pattern that matches nothing must be named too.",
);

/**
 * Sequential runs one counter across every slot, so a colonnade reads as one
 * text rather than as the same panel repeated; random reseeds per slot, so a
 * panel is stable under every rebuild that leaves its slot id alone.
 */
const pool = resolveGlyphPool("glyph-*");
const sequential = createGlyphPicker(pool, "sequential");
sequential.beginSlot("slot-a");
const firstSlot = [sequential.next().id, sequential.next().id];
sequential.beginSlot("slot-b");
const secondSlot = [sequential.next().id, sequential.next().id];
assert.deepEqual(firstSlot, [pool[0]!.id, pool[1]!.id]);
assert.deepEqual(
  secondSlot,
  [pool[2]!.id, pool[3]!.id],
  "A sequential run must continue across slots, not restart at each one.",
);

const drawFour = (slotId: string): string[] => {
  const picker = createGlyphPicker(pool, "random");
  picker.beginSlot(slotId);
  return [0, 1, 2, 3].map(() => picker.next().id);
};
assert.deepEqual(
  drawFour("slot-a"),
  drawFour("slot-a"),
  "A random grid must be identical on every rebuild of the same slot.",
);
assert.notDeepEqual(
  drawFour("slot-a"),
  drawFour("slot-b"),
  "Two slots must not draw the same glyphs.",
);

// --- 8d. The resolution budget -----------------------------------------------

/**
 * The tiers are a memory budget, so what has to hold is that they are ordered
 * and that the floor still wins — a four-by-six pattern keeps a usable mip
 * chain at every tier rather than collapsing along with the ceiling.
 */
const tierSizes = (["low", "medium", "high"] as const).map((tier) => {
  const size = engravingTargetSize(110, 110, ENGRAVING_RESOLUTION_TIERS[tier]);
  return size.width * size.height;
});

for (let index = 1; index < tierSizes.length; index += 1) {
  assert.ok(
    tierSizes[index]! > tierSizes[index - 1]!,
    "Each resolution tier must cost strictly more than the one below it.",
  );
}

assert.deepEqual(
  engravingTargetSize(110, 110, ENGRAVING_RESOLUTION_TIERS.high),
  engravingTargetSize(110, 110),
  "The high tier must be what the ceiling was before there were tiers.",
);
assert.deepEqual(
  engravingTargetSize(4, 6, ENGRAVING_RESOLUTION_TIERS.low),
  engravingTargetSize(4, 6),
  "A layer governed by the floor must be untouched by the budget.",
);

// --- 9. Every slot feature engraves a surface its structure dresses ----------

// `defineStructure` already throws on this at module load, which is the right
// place to catch it. Restating it here turns that into a readable failure
// naming the feature rather than a stack trace out of an import.
let featureCount = 0;

for (const definition of listStructures()) {
  const dressed = new Set(definition.materialSurfaces ?? ["stone"]);

  for (const feature of definition.slotFeatures ?? []) {
    featureCount += 1;
    assert.ok(
      dressed.has(feature.surface),
      `${definition.id}: slot feature "${feature.id}" engraves `
      + `"${feature.surface}", which it does not dress.`,
    );
  }
}

assert.ok(
  featureCount > 0,
  "No structure declares a slot feature, so nothing above proved anything.",
);

/**
 * Every published slot must be claimed by exactly one feature.
 *
 * A `SlotRecord` says which face it was cut from, not which feature asked for
 * it, so each family declares a predicate that recognises its own. Two failure
 * modes follow, and both are silent in the app: a predicate that claims nothing
 * leaves a feature permanently unengravable, and two that overlap engrave the
 * same stone twice with the decals fighting for the same depth. Neither shows
 * as an error — only as an engraving that will not appear, or one that flickers.
 * This is the check that makes them loud.
 */
/**
 * The least of a slot a default assignment may cover before it stops reading as
 * ornament and starts reading as a bug. A tenth is generous: the case this
 * guards against covers well under one per cent.
 */
const MIN_ENGRAVING_COVERAGE = 0.1;



const composer = new StructureComposer();
let claimedSlots = 0;

for (const definition of listStructures()) {
  const features = definition.slotFeatures ?? [];

  if (features.length === 0) {
    continue;
  }

  // Some features belong to one archetype only — a decorated base slab is a
  // linear screen's, a roof fascia a front gallery's — so a family is swept
  // across every form it can take rather than only its default one.
  const unmatched = new Set(features.map((feature) => feature.id));
  const featureDefaults = cloneStructureEngravings(definition);

  for (const archetype of archetypesOf(definition)) {
    const built = createDefaultStructureConfig();
    built.typeId = definition.id;
    const layout = built.layouts[definition.id]! as Record<string, unknown>;

    if (archetype !== null) {
      layout.archetype = archetype;
      // Selecting a form replaces the whole preset, exactly as the pane does.
      definition.layoutControls
        .find((control) => control.key === "archetype")
        ?.onChange?.(layout);
    }

    // Every feature switched on, so a family whose defaults leave one off is
    // still proved. Slot settings live on the layout beside everything else.
    for (const feature of features) {
      feature.select(layout).enabled = true;
    }

    const composition = composer.build(built);
    const published = allSlots(composition.graph);

    const where = archetype === null
      ? definition.id
      : `${definition.id}/${archetype}`;
    assert.ok(
      published.length > 0,
      `${where} published no slots with every feature enabled.`,
    );

    /**
     * A slot must end up carrying an engraving anyone can see.
     *
     * `contain` keeps a motif's proportions by shrinking it to the slot's short
     * axis, which on a running band twenty metres long and a hand's width tall
     * centres a speck — arithmetically right and indistinguishable from a
     * broken feature. Each family therefore declares which of its features
     * publish bands, and this is what holds that declaration to the slots that
     * actually come out.
     */
    for (const feature of features) {
      const owned = published.filter((slot) => feature.matches(slot));

      for (const slot of owned) {
        const placed = resolveDecalPlacement(slot, {
          fit: featureDefaults[feature.id]!.fit,
          margin: DEFAULT_ENGRAVING_ASSIGNMENT.margin,
          // The squarest motif is the worst case for a band: it is the one
          // `contain` shrinks the furthest.
          aspect: 1,
        });

        if (!placed) {
          continue;
        }

        const rect = placed.rect;
        // Nothing arranges itself by default. Every coverage figure below is
        // measured against a single instance, so a default that quietly tiled
        // would shrink all of them without any being re-measured.
        assert.deepEqual(
          placed.repeat,
          NO_DECAL_REPEAT,
          `${where}: feature "${feature.id}" tiles by default.`,
        );
        assert.equal(placed.grid, null);

        const width = ((slot.extent.uBottom + slot.extent.uTop) / 2)
          * (rect.sMax - rect.sMin);
        const height = slot.extent.v * (rect.tMax - rect.tMin);
        const covered = (width * height)
          / (((slot.extent.uBottom + slot.extent.uTop) / 2) * slot.extent.v);

        assert.ok(
          covered >= MIN_ENGRAVING_COVERAGE,
          `${where}: feature "${feature.id}" would engrave `
          + `${(covered * 100).toFixed(1)}% of slot "${slot.id}" `
          + `(${width.toFixed(2)} m by ${height.toFixed(2)} m in a `
          + `${slot.extent.uBottom.toFixed(2)} by ${slot.extent.v.toFixed(2)} `
          + "field). A band has to fill, not contain.",
        );
      }
    }

    for (const slot of published) {
      const claimants = features.filter((feature) => feature.matches(slot));
      assert.ok(
        claimants.length <= 1,
        `${where}: slot "${slot.id}" is claimed by `
        + `${claimants.map((feature) => feature.id).join(" and ")}.`,
      );
      assert.equal(
        claimants.length,
        1,
        `${where}: slot "${slot.id}" (part "${slot.part}", role `
        + `"${slot.faceRole}", kind "${slot.kind}") is claimed by no feature, `
        + "so it can never be engraved.",
      );
      claimants.forEach((feature) => unmatched.delete(feature.id));
      claimedSlots += 1;
    }

    composition.geometry.dispose();
  }

  // And every feature must find something somewhere, or its dropdown governs
  // nothing and its predicate is dead code.
  assert.deepEqual(
    [...unmatched],
    [],
    `${definition.id}: these features matched no slot in any of their forms.`,
  );
}

// --- 9b. A seamless run costs no geometry ------------------------------------

/**
 * The claim the whole seamless design rests on, measured through the real build
 * rather than argued: a hundred repeats is the same mesh as one.
 *
 * It matters beyond the draw call. The decal sun bake is a per-vertex ray cast
 * against the structure's own hierarchy, so a run whose vertex count tracked its
 * repeat would put the cost of a slider onto every change of the light. This is
 * the assertion that would catch anyone reintroducing a quad per tile here.
 */
{
  const engraved = listStructures().find(
    (definition) => (definition.slotFeatures ?? []).length > 0,
  )!;
  const runLayer = catalog.ids.find((id) => id.startsWith("pattern-"))!;

  const verticesFor = (tiling: "none" | "horizontal") => {
    const config = createDefaultStructureConfig();
    config.typeId = engraved.id;
    const assignments = config.engravings[engraved.id]!;

    for (const feature of engraved.slotFeatures ?? []) {
      feature.select(
        config.layouts[engraved.id]! as Record<string, unknown>,
      ).enabled = true;
      Object.assign(assignments[feature.id]!, { document: runLayer, tiling });
    }

    const composition = composer.build(config);
    const batches = buildEngravingDecalBatches(
      composition.graph,
      engraved.slotFeatures ?? [],
      assignments,
      config.layouts[engraved.id]!,
    );
    const vertices = batches.reduce(
      (total, batch) => total + batch.geometry.getAttribute("position").count,
      0,
    );
    const tileU = batches.flatMap((batch) => {
      const attribute = batch.geometry.getAttribute("engravingTileUv");
      return Array.from({ length: attribute.count }, (_, i) => attribute.getX(i));
    });

    for (const batch of batches) {
      batch.geometry.dispose();
    }

    composition.geometry.dispose();
    return { vertices, peak: Math.max(...tileU) };
  };

  const plain = verticesFor("none");
  const tiled = verticesFor("horizontal");

  assert.ok(plain.vertices > 0, "The reference build must place some decals.");
  assert.equal(
    tiled.vertices,
    plain.vertices,
    "Tiling a run must add no vertices; the repeat rides an attribute.",
  );
  assert.equal(plain.peak, 1, "An untiled run must stop at one repeat.");
  assert.ok(
    tiled.peak > 1,
    `The tiled build must actually have tiled; its peak repeat is ${tiled.peak}.`,
  );
}

/**
 * Every form a family can take, or a single null for one that has just the one.
 *
 * Read off the family's own archetype control rather than from a list here, so
 * a family that gains a form is swept without this script being touched.
 */
function archetypesOf(
  definition: ReturnType<typeof listStructures>[number],
): (string | null)[] {
  const control = definition.layoutControls.find(
    (spec) => spec.key === "archetype" && spec.kind === "list",
  );

  return control && control.kind === "list"
    ? Object.values(control.options)
    : [null];
}

// --- 9b2. A carved face carries its own depth --------------------------------

/**
 * A stela register is a pocket cut into the body, but its slot is published
 * against the body's *uncut* face — so for as long as the record said nothing
 * about depth, every register engraving was drawn at the outer plane and hung
 * the pocket's whole depth in front of the stone it was carved into. Present,
 * correct to the millimetre, and floating.
 *
 * That is the failure `SlotFeatureSpec.standOff` warns about, inverted: there
 * the stone was in front of the patch, here it is behind. The field the record
 * gained says which, and this holds the two halves — that the resolver
 * publishes it, and that the decal actually moves by it.
 */
{
  const stela = listStructures().find((definition) => definition.id === "stela")!;
  const config = createDefaultStructureConfig();
  config.typeId = stela.id;
  const layout = config.layouts[stela.id]! as Record<string, unknown>;
  layout.archetype = "framed_tablet";
  stela.layoutControls
    .find((control) => control.key === "archetype")
    ?.onChange?.(layout);

  for (const feature of stela.slotFeatures ?? []) {
    feature.select(layout as never).enabled = true;
  }

  const composition = composer.build(config);
  const published = allSlots(composition.graph);
  const bayFeature = stela.slotFeatures!.find((f) => f.id === "bayField")!;
  const fields = published.filter((slot) => bayFeature.matches(slot));

  assert.ok(fields.length > 0, "A framed tablet must publish bay fields.");
  assert.ok(
    fields.every((slot) => slot.faceOffset < 0),
    "A framed bay is a pocket, so its face sits behind the patch that names it.",
  );

  // The recess the family cut is the depth the slot reports. Not re-derived
  // here — read off the frame record, so the two are proved to agree rather
  // than proved to be the same arithmetic twice.
  const frames = composition.graph.stelae?.[0]?.frames ?? [];
  const recess = frames[0]?.recessDepth;
  assert.ok(
    recess !== undefined && recess > 0,
    "A framed tablet must cut a recess to be a test of one.",
  );
  assert.ok(
    fields.every((slot) => Math.abs(slot.faceOffset + recess!) < 1e-9),
    `A bay field must sit exactly ${recess} behind the face, not somewhere near it.`,
  );

  // And it must reach the geometry: the same slot placed with and without its
  // depth differs by exactly that depth along the patch normal.
  const patch = patchIndex(composition.graph).get(fields[0]!.patchId)!;
  const sunk = resolveDecalQuad(fields[0]!, patch.frame, {
    fit: "stretch",
    margin: 0,
    aspect: 1,
    offset: DECAL_NORMAL_OFFSET + fields[0]!.faceOffset,
  })!;
  const flush = resolveDecalQuad(fields[0]!, patch.frame, {
    fit: "stretch",
    margin: 0,
    aspect: 1,
    offset: DECAL_NORMAL_OFFSET,
  })!;
  const drop = Math.hypot(
    flush.corners[0].x - sunk.corners[0].x,
    flush.corners[0].y - sunk.corners[0].y,
    flush.corners[0].z - sunk.corners[0].z,
  );
  assert.ok(
    Math.abs(drop - recess!) < 1e-9,
    `Honouring the depth must move the decal by exactly it; it moved ${drop}.`,
  );

  composition.geometry.dispose();
}

// --- 9c. Appearance decides what shares a mesh -------------------------------

/**
 * Two features on the same layer and the same stone shared a mesh, and
 * therefore a material, and therefore had to agree on the two shading
 * strengths — which the scene resolved by taking the strongest across every
 * feature on the surface. That fudge was already coarser than the batching it
 * served: it maxed over features whose motif the batch had nothing to do with.
 *
 * A tint makes it incoherent rather than merely approximate, so appearance now
 * decides what may share. These hold the two halves of that: features that
 * agree still share one mesh, and features that differ get their own and keep
 * their own numbers.
 */
{
  const family = listStructures().find(
    (definition) => (definition.slotFeatures ?? []).length > 1,
  )!;
  const [first, second] = family.slotFeatures!;

  const batchesWith = (tints: readonly [string, string]) => {
    const config = createDefaultStructureConfig();
    config.typeId = family.id;
    const assignments = config.engravings[family.id]!;
    const layout = config.layouts[family.id]! as Record<string, unknown>;

    for (const feature of family.slotFeatures ?? []) {
      feature.select(layout as never).enabled = true;
      Object.assign(assignments[feature.id]!, { document: catalog.ids[0]! });
    }

    assignments[first!.id]!.tint = tints[0];
    assignments[second!.id]!.tint = tints[1];

    const composition = composer.build(config);
    const built = buildEngravingDecalBatches(
      composition.graph, family.slotFeatures ?? [], assignments, layout,
    );
    const result = built.map((batch) => ({
      surface: batch.hostSurface,
      tint: batch.appearance.tint,
    }));

    built.forEach((batch) => batch.geometry.dispose());
    composition.geometry.dispose();
    return result;
  };

  const shared = batchesWith(["#ffffff", "#ffffff"]);
  const split = batchesWith(["#ffffff", "#884422"]);

  assert.ok(shared.length > 0, "The reference build must place some decals.");
  assert.ok(
    split.length > shared.length,
    "Two features that disagree on tint must not share a mesh; "
    + `${shared.length} batches became ${split.length}.`,
  );
  assert.ok(
    split.some((batch) => batch.tint === "#884422"),
    "A feature's own tint must reach the batch that draws it.",
  );
  assert.ok(
    shared.every((batch) => batch.tint === "#ffffff"),
    "Agreement must still collapse to one appearance.",
  );
}

// --- 10. Config defaults, cloning and validation -----------------------------

// The catalog is a module-level fact everywhere else, so the control options
// are empty until it is set. Section 8c installed the real one, and everything
// below runs against it.

const defaultConfig = createDefaultStructureConfig();

for (const definition of listStructures()) {
  const assignments = defaultConfig.engravings[definition.id];
  assert.ok(assignments, `${definition.id} must own an engraving record.`);
  assert.deepEqual(
    Object.keys(assignments).sort(),
    (definition.slotFeatures ?? []).map((feature) => feature.id).sort(),
    `${definition.id} must carry exactly one assignment per slot feature.`,
  );

  for (const assignment of Object.values(assignments)) {
    assert.equal(
      assignment.document,
      NO_ENGRAVING,
      "Nothing is engraved until it is asked for.",
    );
  }

  validateStructureEngravings(definition, assignments);
}

const engravedDefinition = listStructures().find(
  (definition) => (definition.slotFeatures ?? []).length > 0,
)!;
const engravedFeature = engravedDefinition.slotFeatures![0]!;
const sampleLayer = catalog.ids[0]!;

// A real selection validates.
const chosen = cloneStructureEngravings(engravedDefinition, {
  [engravedFeature.id]: {
    document: sampleLayer,
    fit: "stretch",
    margin: 0.05,
    normalStrength: 2,
    aoIntensity: 0.5,
    tint: "#8899aa",
    // A tiled selection rather than a bare one, so the arrangement fields are
    // proved to validate on the path a real assignment takes.
    tiling: "grid",
    tileScale: 0.5,
    glyphs: "glyph-*",
    glyphOrder: "random",
    cellMin: 0.2,
    cellMax: 0.8,
    cellGutter: 0.05,
  },
});
assert.equal(chosen[engravedFeature.id]!.document, sampleLayer);
validateStructureEngravings(engravedDefinition, chosen);

// Cloning must detach: the pane's last-known-good snapshot depends on it.
chosen[engravedFeature.id]!.margin = 0.4;
assert.equal(
  cloneStructureEngravings(engravedDefinition, chosen)[engravedFeature.id]!.margin,
  0.4,
);

for (const [field, value, pattern] of [
  // A layer the project no longer carries. This is the case that actually
  // happens, because the project file is rewritten by another program.
  ["document", "glyph-that-was-removed", /engraving/i],
  // Still rejected, and deliberately: repeating a motif is not a fit. A fit
  // says what shape one instance is, a tiling says how many there are, and
  // folding them together would make "contained, four across" unsayable.
  ["fit", "tile", /fit/i],
  ["margin", 5, /margin/i],
  ["normalStrength", -1, /relief/i],
  ["tiling", "brick", /tiling/i],
  ["glyphOrder", "spiral", /order/i],
  // A pool naming a layer the catalog no longer carries has to be a named
  // rejection the pane can restore from, for the same reason a stale document
  // is: the project file is rewritten by another program.
  ["glyphs", "glyph-nonesuch", /glyph/i],
  ["cellMax", 99, /cell/i],
  ["cellGutter", 0.9, /gutter/i],
  // Not a colour the picker could ever have produced.
  ["tint", "burnt sienna", /tint/i],
] as const) {
  assert.throws(
    () => validateStructureEngravings(
      engravedDefinition,
      cloneStructureEngravings(engravedDefinition, {
        [engravedFeature.id]: {
          ...DEFAULT_ENGRAVING_ASSIGNMENT,
          [field]: value,
        } as never,
      }),
    ),
    pattern,
    `A bad ${field} must be rejected by name.`,
  );
}

assert.throws(
  () => validateStructureEngravings(engravedDefinition, {}),
  /Missing engraving assignment/,
  "A feature with no assignment must be named, not defaulted over.",
);

// Every scope must map to a section list, or a dispatch would silently do
// nothing. `engraving` invalidates none, exactly like `material`.
assert.deepEqual([...sectionsForScopes(["engraving"], engravedDefinition)], []);
assert.ok(
  sectionsForScopes(["layout"], engravedDefinition).size > 0,
  "Layout must still invalidate something, or the check above proves nothing.",
);

// --- 11. A declared stand-off reaches the built geometry ---------------------

/**
 * A slot names a patch and a place on it, but not that its stone is somewhere
 * else. A stela's ribbons are mouldings laid on the body face and published
 * against the body's own patch, so a decal placed from the record alone lands
 * inside the moulding — present, correct to the millimetre, and invisible.
 *
 * The family declares how far its stone stands off, and the check is that the
 * declaration reaches the built quad: the decal has to move when the projection
 * it is read from moves. Re-deriving the expected position instead would only
 * prove the arithmetic agrees with itself.
 */
/**
 * Named rather than discovered. A check that only inspects whoever happens to
 * declare a stand-off passes trivially the moment the declaration is dropped,
 * which is precisely the regression worth catching.
 */
const APPLIED_MOULDINGS: Readonly<Record<string, readonly string[]>> = {
  stela: ["bandRibbon", "returnRibbon"],
};

for (const [structureId, applied] of Object.entries(APPLIED_MOULDINGS)) {
  const definition = listStructures().find((entry) => entry.id === structureId);
  assert.ok(definition, `No structure "${structureId}" to check stand-offs on.`);

  for (const id of applied) {
    const feature = (definition.slotFeatures ?? []).find((f) => f.id === id);
    assert.ok(feature, `${structureId} no longer declares a "${id}" feature.`);
    assert.ok(
      feature.standOff !== undefined,
      `${structureId}: "${id}" lays its stone on the face its slots name, so it `
      + "must declare how far off that stone stands. Without it the decal is "
      + "built inside the moulding and never appears.",
    );
  }
}

for (const definition of listStructures()) {
  const features = (definition.slotFeatures ?? [])
    .filter((feature) => feature.standOff !== undefined);

  if (features.length === 0) {
    continue;
  }

  const decalFront = (projection: number) => {
    const built = createDefaultStructureConfig();
    built.typeId = definition.id;
    const layout = built.layouts[definition.id]! as Record<string, unknown>;

    for (const feature of definition.slotFeatures ?? []) {
      feature.select(layout).enabled = true;
      built.engravings[definition.id]![feature.id]!.document =
        features.some((entry) => entry.id === feature.id)
          ? catalog.ids[0]!
          : NO_ENGRAVING;
    }

    // Every family declaring a stand-off reads it from a projection the user
    // can drag, so moving that is what moves the stone.
    layout.ribbonProjection = projection;
    const composition = composer.build(built);
    const batches = buildEngravingDecalBatches(
      composition.graph,
      definition.slotFeatures ?? [],
      built.engravings[definition.id]!,
      layout,
    );
    composition.geometry.dispose();

    assert.equal(
      batches.length,
      1,
      `${definition.id}: expected one stand-off batch, got ${batches.length}.`,
    );

    const geometry = batches[0]!.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    // Distance of the first vertex along its own face normal. The ribbon's
    // extent does not move when it projects further; only its plane does.
    const reach = position.getX(0) * normal.getX(0)
      + position.getY(0) * normal.getY(0)
      + position.getZ(0) * normal.getZ(0);
    geometry.dispose();
    return reach;
  };

  const near = decalFront(0.02);
  const far = decalFront(0.2);

  assert.ok(
    Math.abs((far - near) - 0.18) < 1e-6,
    `${definition.id}: pushing its stone 180 mm further out moved the decal `
    + `${((far - near) * 1000).toFixed(1)} mm. The stand-off is declared but `
    + "never reaches the geometry, so the decal stays buried in the stone.",
  );
}

/** The green channel each row would carry before the orientation pass. */
function deriveNormalGreenRows(field: Uint8Array, size: number): number[][] {
  const wrap = (value: number) => ((value % size) + size) % size;
  const sample = (x: number, y: number) => field[wrap(y) * size + wrap(x)]! / 255;
  const rows: number[][] = [];

  for (let y = 0; y < size; y += 1) {
    const row: number[] = [];

    for (let x = 0; x < size; x += 1) {
      const slopeX = (sample(x + 1, y) - sample(x - 1, y)) / 2;
      const slopeY = (sample(x, y + 1) - sample(x, y - 1)) / 2;
      const inverseLength = 1 / Math.hypot(slopeX, slopeY, 1);
      row.push(Math.round(
        (Math.max(-1, Math.min(1, -slopeY * inverseLength)) * 0.5 + 0.5) * 255,
      ));
    }

    rows.push(row);
  }

  return rows;
}

function countBase64Padding(value: string): number {
  return value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
}

console.log(
  `Engraving sanity: ${catalog.ids.length} layers decoded, `
  + `${expectedMipCount}-level mip chains verified, `
  + `decals placed on ${fixtureSlot.id.split("/").slice(-3).join("/")}, `
  + `${featureCount} slot features claiming ${claimedSlots} slots.`,
);
