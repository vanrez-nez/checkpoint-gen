import assert from "node:assert/strict";
import * as THREE from "three";
import { StructureComposer } from "../src/structure/composer";
import {
  DEFAULT_STRUCTURE_ID,
  STRUCTURES,
  structureOptions,
  getStructure,
  listStructures,
} from "../src/structure/registry";
import {
  DEFAULT_CIRCULAR_LAYOUT,
  CIRCULAR_LAYOUT_CONTROLS,
  toShellConfig,
  validateCircularLayout,
} from "../src/structure/families/circular/config";
import {
  DEFAULT_MASS_LAYOUT,
  DEFAULT_MASS_STONE_CONFIG,
  MASS_LAYOUT_CONTROLS,
  type MassLayoutConfig,
} from "../src/structure/families/mass/config";
import {
  createCircularPlacements,
  createPolarEntryFrames,
} from "../src/structure/families/circular/layout";
import {
  buildCircularShell,
  circularCenterMetrics,
} from "../src/structure/families/circular/shell";
import {
  createDefaultStructureConfig,
  sectionsForScopes,
  validateActiveStructureConfig,
  type StructureConfig,
} from "../src/config/structure-config";
import {
  applyStructureHash,
  encodeStructureHash,
  isStructureHash,
} from "../src/config/structure-hash";
import { validateControls, type ControlSpec } from "../src/config/control-spec";
import {
  ILLUMINATION_CONTROLS,
  VIEW_CONTROLS,
  DEFAULT_BEVEL_CONFIG,
  DEFAULT_ILLUMINATION_CONFIG,
  DEFAULT_STONE_CONFIG,
  DEFAULT_VIEW_CONFIG,
  createBevelControls,
  createStoneControls,
} from "../src/config/sections";
import {
  IDENTITY_MATRIX,
  MATERIAL_SLOTS,
  createPlacementMatrix,
  materialSlotIndex,
  type GeometryPart,
  type MaterialSlot,
  type PartSection,
} from "../src/geometry/part";
import { mergeParts } from "../src/geometry/merge-parts";
import { finalizeGeometry } from "../src/geometry/finalize";
import { SolidBuilder } from "../src/geometry/solid-builder";
import {
  DEFAULT_FIRE_BOWL_CONFIG,
  FIRE_BOWL_CONTROLS,
} from "../src/props/fire-bowl/config";
import { createFireBowlGeometry } from "../src/props/fire-bowl/generator";
import {
  DEFAULT_FIRE_CONFIG,
  FIRE_CONTROLS,
  validateFireConfig,
} from "../src/props/fire/config";
import {
  VertexConeFireBatch,
  type VertexConeFireConfig,
} from "../src/props/fire/vertex-cone";
import {
  DEFAULT_PILLAR_CONFIG,
  PILLAR_BEVEL_CONTROLS,
  PILLAR_LAYOUT_CONTROLS,
  PILLAR_STONE_CONTROLS,
  toPillarGeometryConfig,
} from "../src/props/pillar/config";
import {
  createPillarGeometry,
  getPillarBaseWidth,
} from "../src/props/pillar/generator";
import {
  DEFAULT_OFFERING_CONFIG,
  OFFERING_CONTROLS,
  validateOfferingConfig,
} from "../src/props/offering/config";
import {
  calculateOfferingSupportCenter,
  calculateOfferingTransform,
  prepareOfferingGeometry,
} from "../src/props/offering/model";
import { MainScene } from "../src/scene/main";

const config = createDefaultStructureConfig();
const layout = DEFAULT_CIRCULAR_LAYOUT;
const pillarConfig = config.pillar;

assert.deepEqual(
  {
    radius: layout.radius,
    rowsPerTier: layout.rowsPerTier,
    entryWidth: layout.entryWidthRatio,
    entryLength: layout.entryLengthRatio,
    entryCount: layout.entryCount,
    fadeLength: layout.entryFadeRatio,
    fragmentation: layout.edgeFragmentation,
    lastHeight: layout.entryEndHeightRatio,
    tierRise: layout.tierRiseRatio,
    seed: DEFAULT_STONE_CONFIG.seed,
    gap: DEFAULT_STONE_CONFIG.gapRatio,
    sizeVariation: DEFAULT_STONE_CONFIG.sizeVariation,
    displacement: DEFAULT_STONE_CONFIG.displacement,
    bevelEnabled: DEFAULT_BEVEL_CONFIG.enabled,
    bevelWidth: DEFAULT_BEVEL_CONFIG.widthRatio,
    bevelDepth: DEFAULT_BEVEL_CONFIG.depthRatio,
    bevelVariation: DEFAULT_BEVEL_CONFIG.variation,
  },
  {
    radius: 3,
    rowsPerTier: 4,
    entryWidth: 0.35,
    entryLength: 0.6,
    entryCount: 4,
    fadeLength: 0.5,
    fragmentation: 0.76,
    lastHeight: 0.04,
    tierRise: 0.06,
    seed: 741,
    gap: 0.006,
    sizeVariation: 0.33,
    displacement: 0.08,
    bevelEnabled: true,
    bevelWidth: 0.03,
    bevelDepth: 0.11,
    bevelVariation: 0.6,
  },
  "The Circular controls must open with the approved defaults.",
);
assert.deepEqual(config.stones.circular, DEFAULT_STONE_CONFIG);
assert.deepEqual(config.stones.mass, DEFAULT_MASS_STONE_CONFIG);
assert.notStrictEqual(
  config.stones.circular,
  config.stones.mass,
  "Circular and Mass must not share one mutable Stone target.",
);
assert.deepEqual(config.bevels.circular, DEFAULT_BEVEL_CONFIG);

// --- structure geometry codes ---------------------------------------------
const circularDefaultCode = encodeStructureHash(config);
assert.ok(circularDefaultCode.length <= 10);
assert.ok(isStructureHash(circularDefaultCode));

const massDefaultHashConfig = createDefaultStructureConfig();
massDefaultHashConfig.typeId = "mass";
const massDefaultCode = encodeStructureHash(massDefaultHashConfig);
assert.equal(massDefaultCode, "g1xRQ4T4fGZF7WGs-D");
assert.notEqual(massDefaultCode, circularDefaultCode);

const oneEditHashConfig = createDefaultStructureConfig();
oneEditHashConfig.typeId = "mass";
(oneEditHashConfig.layouts.mass as MassLayoutConfig).footprintWidth = 30;
assert.notEqual(encodeStructureHash(oneEditHashConfig), massDefaultCode);

const sceneOnlyHashConfig = createDefaultStructureConfig();
const sceneIndependentCode = encodeStructureHash(sceneOnlyHashConfig);
sceneOnlyHashConfig.view.wireframe = !sceneOnlyHashConfig.view.wireframe;
sceneOnlyHashConfig.view.patchDebug = !sceneOnlyHashConfig.view.patchDebug;
sceneOnlyHashConfig.illumination.keyIntensity = 1.2;
sceneOnlyHashConfig.illumination.keyColor = "#ff0000";
assert.equal(
  encodeStructureHash(sceneOnlyHashConfig),
  sceneIndependentCode,
  "Scene and debug controls must not enter a structure geometry code.",
);

const materialOnlyHashConfig = createDefaultStructureConfig();
materialOnlyHashConfig.typeId = "mass";
const materialIndependentCode = encodeStructureHash(materialOnlyHashConfig);
materialOnlyHashConfig.materialPalettes.mass!.stone = "stone";
materialOnlyHashConfig.materialPalettes.mass!.roof = "flamed-basalt";
assert.equal(
  encodeStructureHash(materialOnlyHashConfig),
  materialIndependentCode,
  "Surface-material selection must not enter a structure geometry code.",
);
const invalidMaterialConfig = createDefaultStructureConfig();
invalidMaterialConfig.materialPalettes.circular!.stone =
  "not-a-material" as never;
assert.throws(
  () => validateActiveStructureConfig(invalidMaterialConfig),
  /masonry must be one of/,
);
assertCompositionGeometryEqual(
  new StructureComposer().build(massDefaultHashConfig).geometry,
  new StructureComposer().build(materialOnlyHashConfig).geometry,
  "Material palette changes must not regenerate different geometry",
);
const massSurfaceComposition = new StructureComposer().build(
  massDefaultHashConfig,
);
assert.deepEqual(
  massSurfaceComposition.geometry.groups.map((group) => group.materialIndex),
  [
    materialSlotIndex("stone"),
    materialSlotIndex("trim"),
    materialSlotIndex("stairs"),
    materialSlotIndex("summit"),
    materialSlotIndex("interior"),
    materialSlotIndex("roof"),
  ],
  "The default Mass must expose every semantic architectural surface.",
);
assert.equal(
  massSurfaceComposition.geometry.groups.reduce(
    (sum, group) => sum + group.count,
    0,
  ),
  massSurfaceComposition.geometry.getIndex()?.count,
);

const inactiveFamilyHashConfig = createDefaultStructureConfig();
const activeCircularCode = encodeStructureHash(inactiveFamilyHashConfig);
(inactiveFamilyHashConfig.layouts.mass as MassLayoutConfig).footprintWidth = 40;
inactiveFamilyHashConfig.stones.mass!.seed = 1234;
inactiveFamilyHashConfig.layouts.mass = { invalid: Number.NaN };
assert.equal(
  encodeStructureHash(inactiveFamilyHashConfig),
  activeCircularCode,
  "Inactive structure state must not enter the selected structure's code.",
);

assert.throws(() => applyStructureHash(createDefaultStructureConfig(), "nope"));
assert.throws(() => applyStructureHash(createDefaultStructureConfig(), "g1"));
assert.throws(
  () => applyStructureHash(createDefaultStructureConfig(), `${circularDefaultCode}A`),
  /non-canonical|trailing/,
);
const offStepHashConfig = createDefaultStructureConfig();
(offStepHashConfig.layouts.circular as { radius: number }).radius = 3.14159;
assert.throws(
  () => encodeStructureHash(offStepHashConfig),
  /does not align/,
  "Geometry codes must reject lossy numeric quantization.",
);

const geometryHashCoverage = new Set<string>();

for (const scenario of geometryHashScenarios()) {
  const baseline = scenario.create();
  const baselineCode = encodeStructureHash(baseline);

  for (const section of hashControlSections(baseline)) {
    for (const spec of section.specs) {
      const mutated = scenario.create();
      const matching = hashControlSections(mutated).find(
        (candidate) => candidate.label === section.label,
      );
      assert.ok(matching);
      mutateHashControl(matching.target, spec);
      const code = encodeStructureHash(mutated);
      geometryHashCoverage.add(
        `${mutated.typeId}.${section.label}.${spec.key}`,
      );
      assert.notEqual(
        code,
        baselineCode,
        `${scenario.label}: ${section.label}.${spec.key} must change the geometry code`,
      );

      const restored = createDefaultStructureConfig();
      restored.view.wireframe = true;
      const layoutReference = restored.layouts[mutated.typeId];
      const viewReference = restored.view;
      applyStructureHash(restored, code);
      assert.equal(encodeStructureHash(restored), code);
      assertEffectiveHashValuesEqual(mutated, restored);
      assert.strictEqual(restored.layouts[mutated.typeId], layoutReference);
      assert.strictEqual(restored.view, viewReference);
      assert.equal(restored.view.wireframe, true);
    }
  }
}

for (const typeId of ["circular", "mass"]) {
  const expected = createGeometryHashScenario(typeId, "all");

  for (const section of hashControlSections(expected)) {
    for (const spec of section.specs) {
      assert.ok(
        geometryHashCoverage.has(`${typeId}.${section.label}.${spec.key}`),
        `${typeId}.${section.label}.${spec.key} has no active hash-sensitivity case`,
      );
    }
  }
}

const circularRoundTripSource = createDefaultStructureConfig();
(circularRoundTripSource.layouts.circular as { radius: number }).radius = 4.2;
circularRoundTripSource.stones.circular!.seed = 314;
circularRoundTripSource.pillar.height = 2.4;
circularRoundTripSource.fireBowl.radialSegments = 32;
const circularRoundTripTarget = createDefaultStructureConfig();
applyStructureHash(
  circularRoundTripTarget,
  encodeStructureHash(circularRoundTripSource),
);
assertCompositionGeometryEqual(
  new StructureComposer().build(circularRoundTripSource).geometry,
  new StructureComposer().build(circularRoundTripTarget).geometry,
  "Circular geometry-code round trip",
);

const massRoundTripSource = createDefaultStructureConfig();
massRoundTripSource.typeId = "mass";
const massRoundTripLayout = massRoundTripSource.layouts.mass as MassLayoutConfig;
massRoundTripLayout.footprintWidth = 30;
massRoundTripLayout.bandCount = 5;
massRoundTripLayout.stairSideTreatment = "sloped_parapet";
massRoundTripLayout.stairParapetCorniceProjection = 0.1;
massRoundTripLayout.summitBuildingEnabled = true;
massRoundTripLayout.summitRoofEnabled = true;
const massRoundTripTarget = createDefaultStructureConfig();
applyStructureHash(massRoundTripTarget, encodeStructureHash(massRoundTripSource));
assertCompositionGeometryEqual(
  new StructureComposer().build(massRoundTripSource).geometry,
  new StructureComposer().build(massRoundTripTarget).geometry,
  "Mass geometry-code round trip",
);

const editedCircularConfig = createDefaultStructureConfig();
editedCircularConfig.stones.circular!.displacement = 0.2;
editedCircularConfig.typeId = "mass";
const pristineMassConfig = createDefaultStructureConfig();
pristineMassConfig.typeId = "mass";
const massAfterCircularEdit = new StructureComposer().build(editedCircularConfig);
const pristineMass = new StructureComposer().build(pristineMassConfig);
assert.deepEqual(
  Array.from(massAfterCircularEdit.geometry.getAttribute("position").array),
  Array.from(pristineMass.geometry.getAttribute("position").array),
  "Editing Circular Stone controls must not alter Mass after a type switch.",
);

// --- shell -----------------------------------------------------------------
const shell = buildCircularShell(
  toShellConfig(layout, DEFAULT_STONE_CONFIG, DEFAULT_BEVEL_CONFIG),
);
const pillar = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed),
);
const fireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG },
  pillarConfig.shaftWidth,
);
assertValidGeometry(shell.geometry, "shell");
assertValidGeometry(pillar.geometry, "pillar");
assertValidPart(fireBowl.geometry, "fire bowl");
assert.ok(Math.abs(
  (shell.geometry.boundingBox?.max.y ?? 0) - shell.centerTopY,
) < 1e-6);
assert.ok(Math.abs(shell.centerDiameter - layout.radius * 0.28) < 1e-12);

// The standalone metric helper must agree with what the shell actually built,
// since the composer reports the offering anchor from the helper alone.
const centerMetrics = circularCenterMetrics(layout.radius, layout.tierRiseRatio);
assert.ok(Math.abs(centerMetrics.centerTopY - shell.centerTopY) < 1e-12);
assert.ok(Math.abs(centerMetrics.centerDiameter - shell.centerDiameter) < 1e-12);

// The center block's vertex range is reported explicitly rather than assumed to
// be the tail of the buffer, which only held while it was the last stone added.
const flatCenterShell = buildCircularShell(toShellConfig(
  layout,
  DEFAULT_STONE_CONFIG,
  { ...DEFAULT_BEVEL_CONFIG, enabled: false },
));
const flatCenterPositions = flatCenterShell.geometry.getAttribute("position");
assert.equal(flatCenterShell.centerVertexCount, 4 + 4 * 4);
assert.equal(
  flatCenterShell.centerVertexStart + flatCenterShell.centerVertexCount,
  flatCenterPositions.count,
);

for (
  let index = flatCenterShell.centerVertexStart;
  index < flatCenterShell.centerVertexStart + flatCenterShell.centerVertexCount;
  index += 1
) {
  const y = flatCenterPositions.getY(index);

  if (y > 0) {
    assert.ok(Math.abs(y - flatCenterShell.centerTopY) < 1e-6);
  }
}

// --- offering --------------------------------------------------------------
const offeringGeometry = new THREE.BoxGeometry(2, 4, 1);
offeringGeometry.deleteAttribute("uv");
prepareOfferingGeometry(offeringGeometry);
assert.equal(offeringGeometry.getAttribute("uv").count, offeringGeometry.getAttribute("position").count);
assert.equal(offeringGeometry.getAttribute("vertexAo").count, offeringGeometry.getAttribute("position").count);
assert.equal(offeringGeometry.getAttribute("color").count, offeringGeometry.getAttribute("position").count);
assert.equal(
  (offeringGeometry.userData.baseUvs as Float32Array).length,
  offeringGeometry.getAttribute("position").count * 2,
);

const offeringBounds = new THREE.Box3(
  new THREE.Vector3(-1, -2, -0.5),
  new THREE.Vector3(1, 2, 0.5),
);
const offeringTransform = calculateOfferingTransform(offeringBounds, shell);
assert.ok(Math.abs(
  offeringTransform.scale * 2
    - shell.centerDiameter * DEFAULT_OFFERING_CONFIG.pedestalFit,
) < 1e-12);
assert.ok(Math.abs(
  offeringTransform.position.y + offeringBounds.min.y * offeringTransform.scale
    - shell.centerTopY,
) < 1e-12);
assert.ok(Math.abs(offeringTransform.position.x) < 1e-12);
assert.ok(Math.abs(offeringTransform.position.z) < 1e-12);
assert.equal(offeringTransform.rotationY, 0);

const adjustedOfferingTransform = calculateOfferingTransform(
  offeringBounds,
  shell,
  {
    ...DEFAULT_OFFERING_CONFIG,
    pedestalFit: 1.1,
    verticalOffset: 0.25,
    rotationDegrees: 90,
    materialScale: 2,
  },
);
assert.ok(Math.abs(
  adjustedOfferingTransform.scale * 2 - shell.centerDiameter * 1.1,
) < 1e-12);
assert.ok(Math.abs(
  adjustedOfferingTransform.position.y
    + offeringBounds.min.y * adjustedOfferingTransform.scale
    - shell.centerTopY
    - 0.25,
) < 1e-12);
assert.ok(Math.abs(adjustedOfferingTransform.rotationY - Math.PI * 0.5) < 1e-12);
assert.throws(
  () => validateOfferingConfig({ ...DEFAULT_OFFERING_CONFIG, pedestalFit: 0 }),
  /pedestal fit/,
);
assert.throws(
  () => validateOfferingConfig({ ...DEFAULT_OFFERING_CONFIG, materialScale: 8.1 }),
  /material scale/,
);

const offsetOffering = new THREE.Group();
const offeringBaseGeometry = new THREE.BoxGeometry(2, 1, 2);
const offeringUpperGeometry = new THREE.BoxGeometry(4, 3, 2);
const offeringBaseMesh = new THREE.Mesh(offeringBaseGeometry);
const offeringUpperMesh = new THREE.Mesh(offeringUpperGeometry);
offeringBaseMesh.position.set(-2, 0.5, 0);
offeringUpperMesh.position.set(1, 2.5, 0);
offsetOffering.add(offeringBaseMesh, offeringUpperMesh);
offsetOffering.updateMatrixWorld(true);
const offsetOfferingBounds = new THREE.Box3().setFromObject(offsetOffering);
const supportCenter = calculateOfferingSupportCenter(
  offsetOffering,
  offsetOfferingBounds,
);
assert.ok(Math.abs(supportCenter.x + 2) < 1e-12);
assert.ok(Math.abs(supportCenter.z) < 1e-12);
const supportAlignedTransform = calculateOfferingTransform(
  offsetOfferingBounds,
  shell,
  { ...DEFAULT_OFFERING_CONFIG },
  supportCenter,
);
assert.ok(Math.abs(
  supportAlignedTransform.position.x
    + supportCenter.x * supportAlignedTransform.scale,
) < 1e-12);

// --- pillar ----------------------------------------------------------------
assert.ok(Math.abs(pillar.geometry.boundingBox?.min.y ?? 1) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.y ?? 0) - pillarConfig.height) < 1e-6);
const defaultBaseHalfWidth = getPillarBaseWidth(pillarConfig) * 0.5;
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.x ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.x ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.z ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.z ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.equal(fireBowl.supportCount, 8);
assert.equal(fireBowl.footCount, 4);
// The pillar generator no longer emits groups; the composer owns that now.
assert.equal(pillar.geometry.groups.length, 0);
assert.equal(
  (pillar.geometry.userData.baseUvs as Float32Array).length,
  pillar.geometry.getAttribute("uv").count * 2,
);
assert.equal(
  (pillar.geometry.userData.vertexAoBase as Float32Array).length,
  pillar.geometry.getAttribute("vertexAo").count,
);

const detailedFireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG, radialSegments: 64 },
  pillarConfig.shaftWidth,
);
const scaledFireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG, scale: DEFAULT_FIRE_BOWL_CONFIG.scale * 2 },
  pillarConfig.shaftWidth,
);
assert.ok(detailedFireBowl.vertexCount > fireBowl.vertexCount);
assert.ok(detailedFireBowl.triangleCount > fireBowl.triangleCount);
assert.ok(Math.abs(
  (scaledFireBowl.geometry.boundingBox?.max.x ?? 0)
    / (fireBowl.geometry.boundingBox?.max.x ?? 1)
    - 2,
) < 1e-6);

const repeatedPillar = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed),
);
assert.deepEqual(
  Array.from(repeatedPillar.geometry.getAttribute("position").array),
  Array.from(pillar.geometry.getAttribute("position").array),
  "Pillar positions must be deterministic for the same seed.",
);
assert.deepEqual(
  Array.from(repeatedPillar.geometry.index?.array ?? []),
  Array.from(pillar.geometry.index?.array ?? []),
  "Pillar indices must be deterministic for the same seed.",
);

const changedSeed = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed + 1),
);
assert.notDeepEqual(
  Array.from(changedSeed.geometry.getAttribute("position").array),
  Array.from(pillar.geometry.getAttribute("position").array),
  "Changing the pillar seed must change its masonry detail.",
);

const hardEdges = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, bevel: { ...pillarConfig.bevel, enabled: false } },
  pillarConfig.stone.seed,
));
assert.ok(hardEdges.vertexCount < pillar.vertexCount);
assert.ok(hardEdges.triangleCount < pillar.triangleCount);

const moreCourses = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, shaftCourses: pillarConfig.shaftCourses + 1 },
  pillarConfig.stone.seed,
));
const moreSubdivisions = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, shaftSubdivisions: pillarConfig.shaftSubdivisions + 1 },
  pillarConfig.stone.seed,
));
const moreSteps = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, baseSteps: pillarConfig.baseSteps + 1 },
  pillarConfig.stone.seed,
));
assert.ok(moreCourses.stoneCount > pillar.stoneCount);
assert.ok(moreSubdivisions.stoneCount > pillar.stoneCount);
assert.ok(moreSteps.stoneCount > pillar.stoneCount);

const extremePillars = [
  createPillarGeometry(toPillarGeometryConfig({
    height: 1,
    shaftWidth: 0.25,
    baseSteps: 1,
    shaftCourses: 1,
    shaftSubdivisions: 1,
    stone: { seed: 1, gapRatio: 0.002, sizeVariation: 0.05, displacement: 0.01 },
    bevel: { enabled: true, widthRatio: 0.02, depthRatio: 0.05, variation: 0 },
  }, 1)),
  createPillarGeometry(toPillarGeometryConfig({
    height: 12,
    shaftWidth: 3,
    baseSteps: 4,
    shaftCourses: 8,
    shaftSubdivisions: 4,
    stone: { seed: 2, gapRatio: 0.04, sizeVariation: 0.4, displacement: 0.2 },
    bevel: { enabled: true, widthRatio: 0.3, depthRatio: 0.6, variation: 0.6 },
  }, 2)),
];

for (const [index, result] of extremePillars.entries()) {
  assertValidGeometry(result.geometry, `extreme pillar ${index + 1}`);
}

// --- circular layout -------------------------------------------------------
const singleEntryPlacements = createCircularPlacements(
  { ...layout, entryCount: 1 },
  pillarConfig,
);
const allPlacements = createCircularPlacements(layout, pillarConfig);
assert.equal(singleEntryPlacements.length, 2);
assert.equal(allPlacements.length, layout.entryCount * 2);
assert.equal(
  new Set(allPlacements.map((placement) => placement.label)).size,
  allPlacements.length,
);
assert.equal(
  new Set(allPlacements.map((placement) => placement.seed)).size,
  allPlacements.length,
);
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.x)));
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.y)));
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.z)));

const threeEntryFrames = createPolarEntryFrames(3);
assert.ok(Math.abs(threeEntryFrames[0]?.angle ?? 1) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[1]?.angle ?? 0) - Math.PI * 2 / 3) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[2]?.angle ?? 0) - Math.PI * 4 / 3) < 1e-12);
assertValidGeometry(
  buildCircularShell(toShellConfig(
    { ...layout, entryCount: 3 },
    DEFAULT_STONE_CONFIG,
    DEFAULT_BEVEL_CONFIG,
  )).geometry,
  "three-entry shell",
);

const entryHalfWidth = layout.radius * layout.entryWidthRatio * 0.5;
const junctionDistance = Math.sqrt(layout.radius ** 2 - entryHalfWidth ** 2);

for (const placement of allPlacements) {
  const axisX = Math.sin(placement.angle);
  const axisZ = Math.cos(placement.angle);
  const lateralX = Math.cos(placement.angle);
  const lateralZ = -Math.sin(placement.angle);
  const axial = placement.x * axisX + placement.z * axisZ;
  const lateral = placement.x * lateralX + placement.z * lateralZ;
  assert.ok(Math.abs(axial - defaultBaseHalfWidth - junctionDistance) < 1e-9);
  assert.ok(Math.abs(Math.abs(lateral) - defaultBaseHalfWidth - entryHalfWidth) < 1e-9);
  assert.equal(placement.y, 0);
}

// --- part merging ----------------------------------------------------------
// Faces own semantic material ids at emission. Culling compacts that ownership
// with every other vertex buffer rather than leaving stale indices behind.
const materialBuilder = new SolidBuilder();
const block = (offsetX: number) => ({
  bottom: [
    { x: offsetX, y: 0, z: 0 },
    { x: offsetX + 1, y: 0, z: 0 },
    { x: offsetX + 1, y: 0, z: 1 },
    { x: offsetX, y: 0, z: 1 },
  ],
  top: [
    { x: offsetX, y: 1, z: 0 },
    { x: offsetX + 1, y: 1, z: 0 },
    { x: offsetX + 1, y: 1, z: 1 },
    { x: offsetX, y: 1, z: 1 },
  ],
});
materialBuilder.addBlock(
  block(0),
  { sides: [true, true, true, true], top: true, bottom: true },
);
materialBuilder.withMaterial("trim", () => {
  materialBuilder.addBlock(
    block(2),
    { sides: [true, true, true, true], top: true, bottom: true },
  );
});
for (const start of materialBuilder.blockFaces) {
  assert.equal(
    new Set(materialBuilder.surfaceMaterials.slice(start, start + 4)).size,
    1,
    "Every emitted quad must have exactly one semantic material owner.",
  );
}
assert.equal(
  materialBuilder.assignFaceMaterial(
    (face) => face.every((corner) => corner.x > 1.5),
    "stairs",
  ),
  6,
);
assert.equal(
  materialBuilder.cullFaces((face) => face.every((corner) => corner.x < 1.5)),
  6,
);
assert.equal(
  materialBuilder.surfaceMaterials.length,
  materialBuilder.positions.length / 3,
);
assert.ok(
  materialBuilder.surfaceMaterials.every(
    (material) => material === materialSlotIndex("stairs"),
  ),
);
const finalizedMaterialGeometry = finalizeGeometry(materialBuilder).geometry;
assert.deepEqual(
  Array.from(finalizedMaterialGeometry.getAttribute("surfaceMaterial").array),
  materialBuilder.surfaceMaterials,
);
assert.throws(
  () => finalizeGeometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    ambientOcclusion: [1, 1, 1],
    bakedShadow: [1, 1, 1],
    surfaceMaterials: [0, 0],
  }),
  /Surface-material buffer.*expected 3/,
);

// Synthetic parts first: distinct patterned base arrays make the concatenation
// order observable, and passing iron before stone proves the merger reorders by
// material slot rather than by argument order.
const syntheticStoneGeometry = new THREE.BoxGeometry(1, 1, 1);
const syntheticIronGeometry = new THREE.BoxGeometry(2, 2, 2);
const syntheticStone = createSyntheticPart(
  "synthetic/stone",
  "layout",
  "stone",
  syntheticStoneGeometry,
  IDENTITY_MATRIX,
  3,
);
const syntheticIron = createSyntheticPart(
  "synthetic/iron",
  "fireBowls",
  "iron",
  syntheticIronGeometry,
  new THREE.Matrix4().makeTranslation(5, 0, 0),
  0,
);
const syntheticStoneCount = syntheticStoneGeometry.getAttribute("position").count;
const syntheticIronCount = syntheticIronGeometry.getAttribute("position").count;
// Declaring the sections up front is what makes an empty section report zero
// instead of disappearing from the stats.
const CIRCULAR_SECTIONS: readonly PartSection[] = ["layout", "pillars", "fireBowls"];
const syntheticMerge = mergeParts(
  [syntheticIron, syntheticStone],
  CIRCULAR_SECTIONS,
);
const syntheticPositions = syntheticMerge.geometry.getAttribute("position");
const syntheticIndex = syntheticMerge.geometry.getIndex();

assert.ok(syntheticIndex, "Merged geometry must be indexed.");
assert.equal(syntheticPositions.count, syntheticStoneCount + syntheticIronCount);
assert.equal(
  syntheticIndex.count,
  (syntheticStoneGeometry.getIndex()?.count ?? 0) + (syntheticIronGeometry.getIndex()?.count ?? 0),
);
assert.equal(syntheticMerge.totals.vertexCount, syntheticPositions.count);
assert.equal(syntheticMerge.sections.layout.vertexCount, syntheticStoneCount);
assert.equal(syntheticMerge.sections.fireBowls.vertexCount, syntheticIronCount);
assert.equal(syntheticMerge.sections.layout.stoneCount, 3);
assert.equal(syntheticMerge.sections.pillars.partCount, 0);

assert.equal(syntheticMerge.geometry.groups.length, 2);
assert.equal(syntheticMerge.geometry.groups[0]?.materialIndex, 0);
assert.equal(
  syntheticMerge.geometry.groups[1]?.materialIndex,
  materialSlotIndex("iron"),
);
assert.equal(syntheticMerge.geometry.groups[0]?.start, 0);
assert.equal(
  syntheticMerge.geometry.groups[0]?.count,
  syntheticStoneGeometry.getIndex()?.count,
);
assert.equal(
  syntheticMerge.geometry.groups[1]?.start,
  syntheticMerge.geometry.groups[0]?.count,
);
assert.equal(
  syntheticMerge.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  syntheticIndex.count,
);

const syntheticStonePositions = syntheticStoneGeometry.getAttribute("position");
const syntheticIronPositions = syntheticIronGeometry.getAttribute("position");

for (let vertex = 0; vertex < syntheticStoneCount; vertex += 1) {
  assert.equal(syntheticPositions.getX(vertex), syntheticStonePositions.getX(vertex));
  assert.equal(syntheticPositions.getY(vertex), syntheticStonePositions.getY(vertex));
}

for (let vertex = 0; vertex < syntheticIronCount; vertex += 1) {
  const merged = syntheticStoneCount + vertex;
  assert.ok(Math.abs(
    syntheticPositions.getX(merged) - (syntheticIronPositions.getX(vertex) + 5),
  ) < 1e-6);
  assert.ok(Math.abs(
    syntheticPositions.getZ(merged) - syntheticIronPositions.getZ(vertex),
  ) < 1e-6);
}

for (let cursor = 0; cursor < syntheticIndex.count; cursor += 1) {
  const value = syntheticIndex.getX(cursor);
  assert.ok(Number.isInteger(value) && value >= 0 && value < syntheticPositions.count);
}

const syntheticIronIndex = syntheticIronGeometry.getIndex();
assert.ok(syntheticIronIndex);
const syntheticIronIndexStart = syntheticMerge.geometry.groups[1]?.start ?? 0;

for (let cursor = 0; cursor < syntheticIronIndex.count; cursor += 1) {
  assert.equal(
    syntheticIndex.getX(syntheticIronIndexStart + cursor),
    syntheticIronIndex.getX(cursor) + syntheticStoneCount,
  );
}

const syntheticBaseUvs = syntheticMerge.geometry.userData.baseUvs as Float32Array;
const syntheticAo = syntheticMerge.geometry.userData.vertexAoBase as Float32Array;
const syntheticShadow = syntheticMerge.geometry.userData.bakedShadowBase as Float32Array;
assert.equal(syntheticBaseUvs.length, syntheticPositions.count * 2);
assert.equal(syntheticAo.length, syntheticPositions.count);
assert.equal(syntheticShadow.length, syntheticPositions.count);
assert.deepEqual(
  Array.from(syntheticBaseUvs.subarray(0, syntheticStoneCount * 2)),
  Array.from(syntheticStoneGeometry.userData.baseUvs as Float32Array),
);
assert.deepEqual(
  Array.from(syntheticBaseUvs.subarray(syntheticStoneCount * 2)),
  Array.from(syntheticIronGeometry.userData.baseUvs as Float32Array),
);
assert.deepEqual(
  Array.from(syntheticAo.subarray(0, syntheticStoneCount)),
  Array.from(syntheticStoneGeometry.userData.vertexAoBase as Float32Array),
);
// Live attributes are seeded from the base arrays, never from the part's own,
// so a part the scene already scaled cannot leak that state into the merge.
assert.deepEqual(
  Array.from(syntheticMerge.geometry.getAttribute("uv").array),
  Array.from(syntheticBaseUvs),
);
assert.deepEqual(
  Array.from(syntheticMerge.geometry.getAttribute("vertexAo").array),
  Array.from(syntheticAo),
);
assert.ok(
  Array.from(syntheticMerge.geometry.getAttribute("color").array).every((value) => value === 1),
);

// A single part can contain several semantic materials. Triangles are bucketed
// into one indexed group per used slot while the vertex stream stays intact.
const mixedGeometry = new THREE.BoxGeometry(1, 1, 1);
const mixedPart = createSyntheticPart(
  "synthetic/mixed",
  "layout",
  "stone",
  mixedGeometry,
  IDENTITY_MATRIX,
  1,
);
const mixedMaterials = new Uint8Array(
  mixedGeometry.getAttribute("position").count,
);
mixedMaterials.fill(materialSlotIndex("trim"), mixedMaterials.length / 2);
mixedGeometry.setAttribute(
  "surfaceMaterial",
  new THREE.Uint8BufferAttribute(mixedMaterials, 1),
);
const mixedMerge = mergeParts([mixedPart], ["layout"]);
assert.deepEqual(
  mixedMerge.geometry.groups.map((group) => group.materialIndex),
  [materialSlotIndex("stone"), materialSlotIndex("trim")],
);
assert.equal(
  mixedMerge.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  mixedMerge.geometry.getIndex()?.count,
);
assert.deepEqual(
  Array.from(mixedMerge.geometry.getAttribute("surfaceMaterial").array),
  Array.from(mixedMaterials),
);

const invalidMixedGeometry = mixedGeometry.clone();
const invalidMixedPart = createSyntheticPart(
  "synthetic/invalid-mixed",
  "layout",
  "stone",
  invalidMixedGeometry,
  IDENTITY_MATRIX,
  1,
);
const invalidMaterials = new Uint8Array(
  invalidMixedGeometry.getAttribute("position").count,
);
const invalidIndex = invalidMixedGeometry.getIndex();
assert.ok(invalidIndex);
invalidMaterials[invalidIndex.getX(0)] = materialSlotIndex("trim");
invalidMixedGeometry.setAttribute(
  "surfaceMaterial",
  new THREE.Uint8BufferAttribute(invalidMaterials, 1),
);
assert.throws(
  () => mergeParts([invalidMixedPart], ["layout"]),
  /triangle 0 spans multiple surface materials/,
);

// A single-slot composition still emits one full-coverage group, because a mesh
// with an array material draws nothing when the geometry has no groups.
const stoneOnlyMerge = mergeParts([syntheticStone], CIRCULAR_SECTIONS);
assert.equal(stoneOnlyMerge.geometry.groups.length, 1);
assert.equal(stoneOnlyMerge.geometry.groups[0]?.materialIndex, 0);
assert.equal(stoneOnlyMerge.geometry.groups[0]?.start, 0);
assert.equal(
  stoneOnlyMerge.geometry.groups[0]?.count,
  stoneOnlyMerge.geometry.getIndex()?.count,
);
assert.equal(stoneOnlyMerge.sections.fireBowls.vertexCount, 0);

// An empty composition has no material groups. A zero-count group would make
// WebGPU submit DrawIndexed(0), which is valid but emits a warning every frame.
const emptyMerge = mergeParts([], ["mass"]);
assert.equal(emptyMerge.geometry.getIndex()?.count, 0);
assert.equal(emptyMerge.geometry.groups.length, 0);
assert.equal(emptyMerge.totals.triangleCount, 0);

// Contract violations fail loudly, naming the offending part.
const missingUserDataGeometry = new THREE.BoxGeometry(1, 1, 1);
assert.throws(
  () => mergeParts([{
    id: "broken/part",
    section: "layout",
    slot: "stone",
    geometry: missingUserDataGeometry,
    matrix: IDENTITY_MATRIX,
    stoneCount: 0,
  }]),
  /broken\/part.*userData\.baseUvs/,
);
assert.throws(
  () => mergeParts([createSyntheticPart(
    "mirrored/part",
    "layout",
    "stone",
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.Matrix4().makeScale(-1, 1, 1),
    0,
  )]),
  /mirrored\/part.*mirrored or degenerate/,
);
const emptyIndexGeometry = new THREE.BufferGeometry();
emptyIndexGeometry.setAttribute(
  "position",
  new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
);
emptyIndexGeometry.setAttribute(
  "normal",
  new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
);
emptyIndexGeometry.setIndex([]);
assert.throws(
  () => mergeParts([createSyntheticPart(
    "empty-index/part",
    "layout",
    "stone",
    emptyIndexGeometry,
    IDENTITY_MATRIX,
    0,
  )]),
  /empty-index\/part.*empty index/,
);

// --- composition -----------------------------------------------------------
const composer = new StructureComposer();
const composition = composer.build(config);
const compositionPositions = composition.geometry.getAttribute("position");
const compositionNormals = composition.geometry.getAttribute("normal");
assertValidGeometry(composition.geometry, "composition");

assert.equal(composition.sections.layout.vertexCount, shell.vertexCount);
assert.equal(composition.sections.layout.stoneCount, shell.stoneCount);
assert.equal(
  composition.sections.pillars.vertexCount,
  pillar.vertexCount * allPlacements.length,
);
assert.equal(
  composition.sections.pillars.stoneCount,
  pillar.stoneCount * allPlacements.length,
);
assert.equal(
  composition.sections.fireBowls.vertexCount,
  fireBowl.vertexCount * allPlacements.length,
);
assert.equal(
  composition.sections.fireBowls.triangleCount,
  fireBowl.triangleCount * allPlacements.length,
);
assert.equal(
  composition.totals.vertexCount,
  shell.vertexCount
    + (pillar.vertexCount + fireBowl.vertexCount) * allPlacements.length,
);
assert.equal(
  composition.totals.triangleCount,
  shell.triangleCount
    + (pillar.triangleCount + fireBowl.triangleCount) * allPlacements.length,
);

// Exactly two coalesced groups, unlike mergeGeometries' one-per-input.
assert.equal(composition.geometry.groups.length, 2);
assert.equal(composition.geometry.groups[0]?.materialIndex, 0);
assert.equal(
  composition.geometry.groups[1]?.materialIndex,
  materialSlotIndex("iron"),
);
assert.equal(
  composition.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  composition.geometry.getIndex()?.count,
);

// The iron slot starts exactly at the pillar top — end-to-end proof that the
// bowl's placement matrix reproduces the old geometry-mutating translate.
assert.ok(Math.abs(
  groupMinimumY(composition.geometry, materialSlotIndex("iron"))
    - pillarConfig.height,
) < 1e-6);

// Anchors describe the props that stay outside the merged geometry.
assert.ok(composition.anchors.offering);
assert.ok(Math.abs(
  composition.anchors.offering.centerTopY - shell.centerTopY,
) < 1e-12);
assert.equal(composition.anchors.flames.length, allPlacements.length);
assert.equal(composition.anchors.glows.length, layout.entryCount);
assert.ok(composition.anchors.flames.every(
  (flame) => Math.abs(flame.y - pillarConfig.height) < 1e-9,
));

// The shell keeps the leading vertex range untouched, so per-part determinism
// survived composition.
for (let vertex = 0; vertex < shell.vertexCount; vertex += 1) {
  assert.equal(
    compositionPositions.getX(vertex),
    shell.geometry.getAttribute("position").getX(vertex),
  );
  assert.equal(
    compositionPositions.getY(vertex),
    shell.geometry.getAttribute("position").getY(vertex),
  );
}

// Placed pillars match the same geometry transformed by hand. Entry 0 is
// axis-aligned, so a rotated placement is probed too — otherwise a dropped
// rotation would pass unnoticed.
const probeVertex = new THREE.Vector3();
const probeNormal = new THREE.Vector3();
const rotatedPlacementIndex = allPlacements.findIndex(
  (placement) => Math.abs(placement.rotationY) > 1e-6,
);
assert.ok(rotatedPlacementIndex > 0, "Expected at least one rotated placement.");
const probePillars: { geometry: THREE.BufferGeometry }[] = [];

for (const placementIndex of [0, rotatedPlacementIndex]) {
  const probePlacement = allPlacements[placementIndex];
  assert.ok(probePlacement);
  // Each placement derives its own seed, so the expected masonry must be
  // regenerated with that seed rather than reusing the base-seed pillar.
  const probePillar = createPillarGeometry(
    toPillarGeometryConfig(pillarConfig, probePlacement.seed),
  );
  probePillars.push(probePillar);
  const pillarPositions = probePillar.geometry.getAttribute("position");
  const pillarNormals = probePillar.geometry.getAttribute("normal");
  const probeMatrix = createPlacementMatrix(
    probePlacement.x,
    probePlacement.y,
    probePlacement.z,
    probePlacement.rotationY,
  );
  const probeNormalMatrix = new THREE.Matrix3().getNormalMatrix(probeMatrix);
  const partStart = shell.vertexCount + placementIndex * pillar.vertexCount;

  for (let vertex = 0; vertex < pillarPositions.count; vertex += 1) {
    probeVertex.set(
      pillarPositions.getX(vertex),
      pillarPositions.getY(vertex),
      pillarPositions.getZ(vertex),
    ).applyMatrix4(probeMatrix);
    const merged = partStart + vertex;
    assert.ok(Math.abs(compositionPositions.getX(merged) - probeVertex.x) < 1e-5);
    assert.ok(Math.abs(compositionPositions.getY(merged) - probeVertex.y) < 1e-5);
    assert.ok(Math.abs(compositionPositions.getZ(merged) - probeVertex.z) < 1e-5);

    probeNormal.set(
      pillarNormals.getX(vertex),
      pillarNormals.getY(vertex),
      pillarNormals.getZ(vertex),
    ).applyMatrix3(probeNormalMatrix);

    if (probeNormal.lengthSq() > 0) {
      probeNormal.normalize();
    }

    assert.ok(
      Math.abs(compositionNormals.getX(merged) - probeNormal.x) < 1e-5
        && Math.abs(compositionNormals.getY(merged) - probeNormal.y) < 1e-5
        && Math.abs(compositionNormals.getZ(merged) - probeNormal.z) < 1e-5,
      `Normal ${vertex} of placement ${placementIndex} was not transformed.`,
    );
  }
}

// Rotating a part must not denormalize normals or introduce new degenerate
// ones. The fire bowl ships two zero-length normals per bowl from
// computeVertexNormals over degenerate triangles; that predates composition.
const expectedZeroNormals = countZeroNormals(fireBowl.geometry.getAttribute("normal"))
  * allPlacements.length;
let zeroNormals = 0;
let worstNormalError = 0;

for (let vertex = 0; vertex < compositionNormals.count; vertex += 1) {
  const length = Math.hypot(
    compositionNormals.getX(vertex),
    compositionNormals.getY(vertex),
    compositionNormals.getZ(vertex),
  );

  if (length === 0) {
    zeroNormals += 1;
  } else {
    worstNormalError = Math.max(worstNormalError, Math.abs(length - 1));
  }
}

assert.equal(zeroNormals, expectedZeroNormals);
assert.ok(worstNormalError < 1e-5, `Merged normals drifted by ${worstNormalError}.`);

// Building the same config twice is deterministic.
const repeatedComposition = new StructureComposer().build(config);
assert.deepEqual(
  Array.from(repeatedComposition.geometry.getAttribute("position").array),
  Array.from(compositionPositions.array),
);
assert.deepEqual(
  Array.from(repeatedComposition.geometry.getIndex()?.array ?? []),
  Array.from(composition.geometry.getIndex()?.array ?? []),
);

// A scoped rebuild must equal a full rebuild of the same mutated config, and
// must leave the cached shell byte-identical. This is what stands between the
// part cache and a stale-geometry bug.
const mutatedConfig = createDefaultStructureConfig();
mutatedConfig.pillar.height = 2;
const incrementalComposer = new StructureComposer();
incrementalComposer.build(createDefaultStructureConfig());
const incremental = incrementalComposer.build(
  mutatedConfig,
  sectionsForScopes(["pillars"]),
);
const fullRebuild = new StructureComposer().build(mutatedConfig);
assert.deepEqual(
  Array.from(incremental.geometry.getAttribute("position").array),
  Array.from(fullRebuild.geometry.getAttribute("position").array),
  "An incremental rebuild must match a full rebuild of the same config.",
);

for (let vertex = 0; vertex < shell.vertexCount; vertex += 1) {
  assert.equal(
    incremental.geometry.getAttribute("position").getX(vertex),
    shell.geometry.getAttribute("position").getX(vertex),
  );
}

// Bowls off collapses to a single stone group and drops every fire anchor.
const noBowlConfig = createDefaultStructureConfig();
noBowlConfig.fireBowl.enabled = false;
const noBowlComposition = new StructureComposer().build(noBowlConfig);
assert.equal(noBowlComposition.geometry.groups.length, 1);
assert.equal(noBowlComposition.geometry.groups[0]?.materialIndex, 0);
assert.equal(
  noBowlComposition.geometry.groups[0]?.count,
  noBowlComposition.geometry.getIndex()?.count,
);
assert.equal(noBowlComposition.sections.fireBowls.vertexCount, 0);
assert.equal(noBowlComposition.anchors.flames.length, 0);
assert.equal(noBowlComposition.anchors.glows.length, 0);

// --- registry --------------------------------------------------------------
assert.ok(listStructures().length >= 1);
assert.equal(
  new Set(STRUCTURES.map((type) => type.id)).size,
  STRUCTURES.length,
  "Structure ids must be unique.",
);
assert.throws(() => getStructure("nope"), /Unknown structure/);
// Every registered structure is offered, under a label of its own — asserted
// against the registry rather than a literal list, so adding a structure does
// not mean editing this file.
assert.deepEqual(
  structureOptions(),
  Object.fromEntries(STRUCTURES.map((structure) => [structure.label, structure.id])),
);
assert.equal(
  new Set(STRUCTURES.map((structure) => structure.label)).size,
  STRUCTURES.length,
  "Structure labels must be unique, or the dropdown loses an entry.",
);
assert.ok(STRUCTURES.some((structure) => structure.id === DEFAULT_STRUCTURE_ID));

for (const definition of STRUCTURES) {
  // Props form a dependency chain: flames need a bowl, bowls need a pillar.
  if (definition.props.includes("fire")) {
    assert.ok(definition.props.includes("fireBowl"), `${definition.id}: fire needs fireBowl`);
  }
  if (definition.props.includes("fireBowl")) {
    assert.ok(definition.props.includes("pillar"), `${definition.id}: fireBowl needs pillar`);
  }
  assert.ok(definition.layoutControls.length > 0, `${definition.id} has no layout controls`);
  assert.doesNotThrow(() => definition.validateLayout(definition.cloneLayout()));

  // Every structure owns its tab layout. Its folder groups and shared props
  // must form exact, non-overlapping partitions so adding a structure never
  // leaks unrelated tabs or strands controls on an implicit global page.
  const assignedLayoutGroups = definition.controlTabs.flatMap(
    (tab) => [...(tab.layoutGroups ?? [])],
  );
  const assignedProps = definition.controlTabs.flatMap(
    (tab) => [...(tab.props ?? [])],
  );
  assert.equal(
    new Set(assignedLayoutGroups).size,
    assignedLayoutGroups.length,
    `${definition.id} assigns a layout group to more than one tab`,
  );
  assert.deepEqual(
    new Set(assignedLayoutGroups),
    new Set(definition.layoutControls.map((control) => control.group)),
    `${definition.id} tab layout does not cover its control groups`,
  );
  assert.equal(
    new Set(assignedProps).size,
    assignedProps.length,
    `${definition.id} assigns a prop to more than one tab`,
  );
  assert.deepEqual(
    new Set(assignedProps),
    new Set(definition.props),
    `${definition.id} tab layout does not cover its props`,
  );

  // Sections are the composer's cache keys and its merge order, so a structure
  // that declares none or repeats one would silently lose parts.
  assert.ok(definition.sections.length > 0, `${definition.id} declares no sections`);
  assert.equal(
    new Set(definition.sections).size,
    definition.sections.length,
    `${definition.id} repeats a section`,
  );

  // A scope a structure's own controls use must resolve to that structure's own
  // sections. This is what catches a new structure reusing a shared scope name
  // without mapping it, which would rebuild nothing at all.
  for (const spec of definition.layoutControls) {
    for (const scope of spec.scopes ?? []) {
      for (const section of sectionsForScopes([scope], definition)) {
        assert.ok(
          definition.sections.includes(section),
          `${definition.id}: control "${spec.key}" scope "${scope}" resolves to `
          + `section "${section}", which it does not declare.`,
        );
      }
    }
  }
}

const massControlTabs = getStructure("mass").controlTabs;
assert.deepEqual(
  massControlTabs.map((tab) => tab.label),
  ["Structure", "Stairs", "Summit", "Materials"],
);
assert.deepEqual(
  massControlTabs.find((tab) => tab.id === "stairs")?.layoutGroups,
  ["Stair"],
);
assert.deepEqual(
  massControlTabs.find((tab) => tab.id === "summit")?.layoutGroups,
  ["Summit", "Summit building", "Roof"],
);
assert.ok(
  massControlTabs.every(
    (tab) => !["Pillars", "Fire", "Offering"].includes(tab.label),
  ),
);

// --- control specs ---------------------------------------------------------
// Every spec must describe a real field whose default sits inside its own
// range. This is what makes the UI/validator range drift that existed before
// impossible to reintroduce.
assertSpecCoverage(CIRCULAR_LAYOUT_CONTROLS, DEFAULT_CIRCULAR_LAYOUT, "circular layout");
assertSpecCoverage(MASS_LAYOUT_CONTROLS, DEFAULT_MASS_LAYOUT, "mass layout");
assertSpecCoverage(createStoneControls(["layout"]), DEFAULT_STONE_CONFIG, "circular stone");
assertSpecCoverage(createStoneControls(["layout"]), DEFAULT_MASS_STONE_CONFIG, "mass stone");
assertSpecCoverage(createBevelControls(["layout"]), DEFAULT_BEVEL_CONFIG, "circular bevel");
assertSpecCoverage(PILLAR_LAYOUT_CONTROLS, DEFAULT_PILLAR_CONFIG, "pillar layout");
assertSpecCoverage(PILLAR_STONE_CONTROLS, DEFAULT_PILLAR_CONFIG.stone, "pillar stone");
assertSpecCoverage(PILLAR_BEVEL_CONTROLS, DEFAULT_PILLAR_CONFIG.bevel, "pillar bevel");
assertSpecCoverage(FIRE_BOWL_CONTROLS, DEFAULT_FIRE_BOWL_CONFIG, "fire bowl");
assertSpecCoverage(FIRE_CONTROLS, DEFAULT_FIRE_CONFIG, "fire");
assertSpecCoverage(OFFERING_CONTROLS, DEFAULT_OFFERING_CONFIG, "offering");
assertSpecCoverage(VIEW_CONTROLS, DEFAULT_VIEW_CONFIG, "view");
assertSpecCoverage(ILLUMINATION_CONTROLS, DEFAULT_ILLUMINATION_CONFIG, "illumination");

// --- validators ------------------------------------------------------------
assert.doesNotThrow(() => validateActiveStructureConfig(
  createDefaultStructureConfig(),
));
const defaultMassConfig = createDefaultStructureConfig();
defaultMassConfig.typeId = "mass";
assert.doesNotThrow(() => validateActiveStructureConfig(defaultMassConfig));

assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  CIRCULAR_LAYOUT_CONTROLS,
  (current) => current.layouts.circular,
  "circular layout",
);
assertEveryControlParamIsValidated(
  () => {
    const current = createDefaultStructureConfig();
    current.typeId = "mass";
    return current;
  },
  MASS_LAYOUT_CONTROLS,
  (current) => current.layouts.mass,
  "mass layout",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  createStoneControls(["layout"]),
  (current) => current.stones.circular,
  "structure stone",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  createBevelControls(["layout"]),
  (current) => current.bevels.circular,
  "structure bevel",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  PILLAR_LAYOUT_CONTROLS,
  (current) => current.pillar,
  "pillar layout",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  PILLAR_STONE_CONTROLS,
  (current) => current.pillar.stone,
  "pillar stone",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  PILLAR_BEVEL_CONTROLS,
  (current) => current.pillar.bevel,
  "pillar bevel",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  FIRE_BOWL_CONTROLS,
  (current) => current.fireBowl,
  "fire bowl",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  FIRE_CONTROLS,
  (current) => current.fire,
  "fire",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  OFFERING_CONTROLS,
  (current) => current.offering,
  "offering",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  VIEW_CONTROLS,
  (current) => current.view,
  "view",
);
assertEveryControlParamIsValidated(
  createDefaultStructureConfig,
  ILLUMINATION_CONTROLS,
  (current) => current.illumination,
  "illumination",
);

for (const color of ["keyColor", "skyColor", "groundColor"] as const) {
  const invalid = createDefaultStructureConfig();
  invalid.illumination[color] = "not-a-color";
  assert.throws(
    () => validateActiveStructureConfig(invalid),
    /hexadecimal color/,
    `illumination.${color} must be validated`,
  );
}

for (const [key, value, expected] of [
  ["footprintWidth", 2, /batter_inverts_footprint/],
  ["footprintDepth", 2, /batter_inverts_footprint/],
  ["totalHeight", 60, /batter_inverts_footprint/],
  ["summitRatio", 0.05, /stair\.does_not_fit/],
] as const) {
  const invalid = createDefaultStructureConfig();
  invalid.typeId = "mass";
  (invalid.layouts.mass as MassLayoutConfig)[key] = value;
  assert.throws(
    () => validateActiveStructureConfig(invalid),
    expected,
    `mass ${key}=${value} must be rejected before tessellation`,
  );
}

assert.throws(
  () => createPillarGeometry(toPillarGeometryConfig(
    { ...pillarConfig, baseSteps: 0 },
    pillarConfig.stone.seed,
  )),
  /Base steps/,
);
assert.throws(
  () => createPillarGeometry(toPillarGeometryConfig(
    { ...pillarConfig, height: 0 },
    pillarConfig.stone.seed,
  )),
  /height/,
);
assert.throws(
  () => createFireBowlGeometry({ ...DEFAULT_FIRE_BOWL_CONFIG, scale: 0.49 }, 1),
  /scale/,
);
assert.throws(
  () => createFireBowlGeometry({ ...DEFAULT_FIRE_BOWL_CONFIG, radialSegments: 18 }, 1),
  /radial segments/,
);
assert.throws(
  () => validateCircularLayout({ ...layout, entryCount: 0 }),
  /Entry count/,
);
assert.throws(
  () => validateCircularLayout({ ...layout, entryCount: 9 }),
  /Entry count/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, scale: 0 }),
  /Fire scale/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, radius: 0 }),
  /Fire radius/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, glowFlicker: 0.51 }),
  /Fire glow flicker/,
);

// --- fire batch ------------------------------------------------------------
const fireBatch = new VertexConeFireBatch(DEFAULT_FIRE_CONFIG.radialSegments, 16);
const fireMaterial = fireBatch.object.material;
const initialFireGeometry = fireBatch.object.geometry;
const fireBatchConfig: Omit<VertexConeFireConfig, "placements"> = {
  enabled: DEFAULT_FIRE_CONFIG.enabled,
  scale: DEFAULT_FIRE_CONFIG.scale,
  radius: DEFAULT_FIRE_CONFIG.radius,
  height: DEFAULT_FIRE_CONFIG.height,
  baseHeight: DEFAULT_FIRE_CONFIG.baseHeight,
  speed: DEFAULT_FIRE_CONFIG.speed,
  noiseScale: DEFAULT_FIRE_CONFIG.noiseScale,
  turbulence: DEFAULT_FIRE_CONFIG.turbulence,
  intensity: DEFAULT_FIRE_CONFIG.intensity,
  radialSegments: DEFAULT_FIRE_CONFIG.radialSegments,
};
const defaultFireStats = fireBatch.update({
  ...fireBatchConfig,
  placements: composition.anchors.flames,
});
assert.equal(fireBatch.object.count, allPlacements.length);
assert.equal(fireBatch.object.geometry.getAttribute("position").count, 425);
assert.equal(defaultFireStats.flameCount, 8);
assert.equal(defaultFireStats.vertexCount, 3_400);
assert.equal(defaultFireStats.triangleCount, 6_016);
assert.equal(defaultFireStats.drawCallCount, 1);
assert.equal(fireMaterial.transparent, true);
assert.equal(fireMaterial.blending, THREE.AdditiveBlending);
assert.equal(fireMaterial.depthWrite, false);
assert.equal(fireMaterial.depthTest, true);
assert.equal(fireMaterial.side, THREE.DoubleSide);
assert.ok(fireBatch.object.boundingBox && !fireBatch.object.boundingBox.isEmpty());
assert.ok(fireBatch.object.boundingSphere && fireBatch.object.boundingSphere.radius > 0);

// Flames sit at the anchor plus the flame base offset; the batch no longer
// knows anything about pillar height.
const firstFireMatrix = new THREE.Matrix4();
const firstFirePosition = new THREE.Vector3();
const firstFlameAnchor = composition.anchors.flames[0];
assert.ok(firstFlameAnchor);
fireBatch.object.getMatrixAt(0, firstFireMatrix);
firstFirePosition.setFromMatrixPosition(firstFireMatrix);
assert.ok(Math.abs(firstFirePosition.x - firstFlameAnchor.x) < 1e-6);
assert.ok(Math.abs(firstFirePosition.z - firstFlameAnchor.z) < 1e-6);
assert.ok(Math.abs(
  firstFirePosition.y - firstFlameAnchor.y - DEFAULT_FIRE_CONFIG.baseHeight,
) < 1e-6);

fireBatch.update({
  ...fireBatchConfig,
  radius: DEFAULT_FIRE_CONFIG.radius * 2,
  height: DEFAULT_FIRE_CONFIG.height * 2,
  baseHeight: DEFAULT_FIRE_CONFIG.baseHeight * 2,
  placements: composition.anchors.flames.slice(0, 2),
});
assert.equal(fireBatch.object.geometry, initialFireGeometry);
assert.equal(fireBatch.object.material, fireMaterial);

const detailedFireStats = fireBatch.update({
  ...fireBatchConfig,
  radialSegments: 64,
  placements: composition.anchors.flames,
});
assert.notEqual(fireBatch.object.geometry, initialFireGeometry);
assert.equal(fireBatch.object.material, fireMaterial);
assert.equal(fireBatch.object.geometry.getAttribute("position").count, 1_625);
assert.equal(detailedFireStats.vertexCount, 13_000);
assert.equal(detailedFireStats.triangleCount, 24_064);
assert.equal(detailedFireStats.drawCallCount, 1);

const disabledFireStats = fireBatch.update({
  ...fireBatchConfig,
  enabled: false,
  radialSegments: 64,
  placements: composition.anchors.flames,
});
assert.equal(fireBatch.object.count, 0);
assert.equal(fireBatch.object.visible, false);
assert.deepEqual(disabledFireStats, {
  flameCount: 0,
  vertexCount: 0,
  triangleCount: 0,
  drawCallCount: 0,
});
assert.throws(
  () => fireBatch.update({
    ...fireBatchConfig,
    radialSegments: 16,
    placements: Array.from({ length: 17 }, () => ({ x: 0, y: 0, z: 0 })),
  }),
  /cannot exceed 16/,
);
fireBatch.dispose();

// --- scene -----------------------------------------------------------------
const sceneConfig = createDefaultStructureConfig();
const scene = new MainScene(sceneConfig);
const sceneStats = scene.getStats();
assert.equal(sceneStats.sections.pillars.partCount, 8);
assert.equal(sceneStats.sections.pillars.vertexCount, pillar.vertexCount * 8);
assert.equal(sceneStats.sections.fireBowls.partCount, 8);
assert.equal(sceneStats.sections.fireBowls.vertexCount, fireBowl.vertexCount * 8);
assert.equal(sceneStats.totals.vertexCount, composition.totals.vertexCount);
assert.equal(sceneStats.flames.count, 8);
assert.equal(sceneStats.flames.vertexCount, 3_400);
assert.equal(sceneStats.flames.triangleCount, 6_016);
assert.equal(sceneStats.flames.drawCallCount, 1);
assert.equal(sceneStats.glowLightCount, 4);
// One static mesh for the whole structure, where there used to be nine (the
// plate plus one per pillar). The flame batch is instanced and stays separate.
const staticMeshes = scene.scene.children.filter((child) => (
  child instanceof THREE.Mesh
  && !(child as THREE.InstancedMesh).isInstancedMesh
));
assert.equal(staticMeshes.length, 1);
assert.equal(staticMeshes[0]?.name, "Structure");
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  4,
);
assert.equal(scene.scene.getObjectByName("Fire bowl flames")?.type, "Mesh");

const structureMesh = scene.scene.getObjectByName("Structure") as THREE.Mesh;
assert.ok(Array.isArray(structureMesh.material));
assert.equal(
  (structureMesh.material as THREE.Material[]).length,
  MATERIAL_SLOTS.length,
);
assert.equal(structureMesh.geometry.groups.length, 2);

// Fire retuning must not rebuild geometry or recreate the flame batch.
const firstGlowLight = scene.scene.children.find((child) => child.type === "PointLight");
const flameObject = scene.scene.getObjectByName("Fire bowl flames") as THREE.Mesh;
const flameGeometry = flameObject.geometry;
const structureGeometry = structureMesh.geometry;
sceneConfig.fire.speed = 5;
sceneConfig.fire.noiseScale = 6;
sceneConfig.fire.turbulence = 1.5;
sceneConfig.fire.intensity = 2;
sceneConfig.fire.glowIntensity = 1.2;
const tunedFireStats = scene.updateFireEffects(sceneConfig);
assert.equal(tunedFireStats.flames.count, 8);
assert.equal(scene.scene.getObjectByName("Fire bowl flames"), flameObject);
assert.equal(flameObject.geometry, flameGeometry);
assert.equal(structureMesh.geometry, structureGeometry);
assert.equal(
  scene.scene.children.find((child) => child.type === "PointLight"),
  firstGlowLight,
);
assert.equal((firstGlowLight as THREE.PointLight).intensity, 1.2);

const eightEntryConfig = createDefaultStructureConfig();
eightEntryConfig.layouts.circular.entryCount = 8;
const maximumFireStats = scene.rebuild(eightEntryConfig);
assert.equal(maximumFireStats.sections.pillars.partCount, 16);
assert.equal(maximumFireStats.flames.count, 16);
assert.equal(maximumFireStats.flames.drawCallCount, 1);
assert.equal(maximumFireStats.glowLightCount, 8);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  8,
);

const noFireConfig = createDefaultStructureConfig();
noFireConfig.fireBowl.enabled = false;
const noFireStats = scene.rebuild(noFireConfig);
assert.equal(noFireStats.flames.count, 0);
assert.equal(noFireStats.flames.drawCallCount, 0);
assert.equal(noFireStats.glowLightCount, 0);
assert.equal(noFireStats.sections.fireBowls.partCount, 0);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  0,
);

// Bowl size is independent of flame size.
const scaledBowlConfig = createDefaultStructureConfig();
scaledBowlConfig.fireBowl.scale = 2;
const independentFireStats = scene.rebuild(scaledBowlConfig);
assert.equal(independentFireStats.flames.vertexCount, 3_400);
assert.equal(independentFireStats.flames.triangleCount, 6_016);
assert.equal(independentFireStats.glowLightCount, 4);

const disabledFlameConfig = createDefaultStructureConfig();
disabledFlameConfig.fire.enabled = false;
const explicitlyDisabledFireStats = scene.updateFireEffects(disabledFlameConfig);
assert.equal(explicitlyDisabledFireStats.flames.count, 0);
assert.equal(explicitlyDisabledFireStats.glowLightCount, 0);
scene.dispose();

// --- cleanup ---------------------------------------------------------------
for (const result of [
  shell,
  pillar,
  fireBowl,
  detailedFireBowl,
  scaledFireBowl,
  repeatedPillar,
  changedSeed,
  hardEdges,
  moreCourses,
  moreSubdivisions,
  moreSteps,
  flatCenterShell,
  ...extremePillars,
  ...probePillars,
]) {
  result.geometry.dispose();
}
composer.dispose();
massSurfaceComposition.geometry.dispose();
finalizedMaterialGeometry.dispose();
syntheticMerge.geometry.dispose();
mixedMerge.geometry.dispose();
stoneOnlyMerge.geometry.dispose();
emptyMerge.geometry.dispose();
emptyIndexGeometry.dispose();
composition.geometry.dispose();
repeatedComposition.geometry.dispose();
incremental.geometry.dispose();
fullRebuild.geometry.dispose();
noBowlComposition.geometry.dispose();
syntheticStoneGeometry.dispose();
syntheticIronGeometry.dispose();
mixedGeometry.dispose();
invalidMixedGeometry.dispose();
missingUserDataGeometry.dispose();
offeringGeometry.dispose();
offeringBaseGeometry.dispose();
offeringUpperGeometry.dispose();

console.log(
  `Geometry sanity passed: ${pillar.stoneCount} stones per default pillar, `
  + `${allPlacements.length} default placements, `
  + `${composition.totals.vertexCount} composed vertices in `
  + `${composition.geometry.groups.length} material groups.`,
);

function assertValidGeometry(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const vertexAo = geometry.getAttribute("vertexAo");
  const color = geometry.getAttribute("color");
  const surfaceMaterial = geometry.getAttribute("surfaceMaterial");
  const index = geometry.index;

  assert.ok(position.count > 0, `${label} must contain vertices.`);
  assert.equal(normal.count, position.count);
  assert.equal(uv.count, position.count);
  assert.equal(vertexAo.count, position.count);
  assert.equal(color.count, position.count);
  assert.equal(surfaceMaterial.count, position.count);
  assert.ok(
    Array.from(surfaceMaterial.array).every(
      (value) =>
        Number.isInteger(value) && value >= 0 && value < MATERIAL_SLOTS.length,
    ),
  );
  assert.ok(index && index.count > 0, `${label} must contain indices.`);
  assert.equal(index.count % 3, 0);
  assert.ok(Array.from(position.array).every(Number.isFinite));
  assert.ok(Array.from(normal.array).every(Number.isFinite));
  assert.ok(Array.from(uv.array).every(Number.isFinite));
  assert.ok(Array.from(index.array).every((value) => value >= 0 && value < position.count));
  assert.ok(geometry.boundingBox && !geometry.boundingBox.isEmpty());
  assert.ok(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius));
}

/**
 * The part contract, which is looser than a renderable geometry: a part needs
 * position, normal, an index and the three userData base arrays, but the merger
 * synthesises uv/vertexAo/color from userData rather than reading them.
 */
function assertValidPart(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const index = geometry.index;

  assert.ok(position.count > 0, `${label} must contain vertices.`);
  assert.equal(normal.count, position.count);
  assert.ok(index && index.count > 0, `${label} must contain indices.`);
  assert.equal(index.count % 3, 0);
  assert.ok(Array.from(index.array).every((value) => value >= 0 && value < position.count));
  assert.equal(
    (geometry.userData.baseUvs as Float32Array).length,
    position.count * 2,
    `${label} userData.baseUvs length`,
  );
  assert.equal(
    (geometry.userData.vertexAoBase as Float32Array).length,
    position.count,
    `${label} userData.vertexAoBase length`,
  );
  assert.equal(
    (geometry.userData.bakedShadowBase as Float32Array).length,
    position.count,
    `${label} userData.bakedShadowBase length`,
  );
}

/**
 * Wraps a plain geometry as a part, fabricating the three userData base arrays
 * with distinct patterned values so concatenation order is observable.
 */
function createSyntheticPart(
  id: string,
  section: PartSection,
  slot: MaterialSlot,
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  stoneCount: number,
): GeometryPart {
  const count = geometry.getAttribute("position").count;
  geometry.userData.baseUvs = Float32Array.from(
    { length: count * 2 },
    (_, index) => index * 0.5,
  );
  geometry.userData.vertexAoBase = Float32Array.from(
    { length: count },
    (_, index) => index * 0.25,
  );
  geometry.userData.bakedShadowBase = new Float32Array(count).fill(0.5);

  return { id, section, slot, geometry, matrix, stoneCount };
}

function countZeroNormals(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): number {
  let zero = 0;

  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    const length = Math.hypot(
      attribute.getX(vertex),
      attribute.getY(vertex),
      attribute.getZ(vertex),
    );

    if (length === 0) {
      zero += 1;
    }
  }

  return zero;
}

interface HashControlSection {
  readonly label: string;
  readonly target: Record<string, unknown>;
  readonly specs: readonly ControlSpec<object>[];
}

function geometryHashScenarios(): readonly {
  readonly label: string;
  readonly create: () => StructureConfig;
}[] {
  return [
    {
      label: "circular",
      create: () => createGeometryHashScenario("circular", "all"),
    },
    {
      label: "mass stepped parapet",
      create: () => createGeometryHashScenario("mass", "stepped"),
    },
    {
      label: "mass flat parapet",
      create: () => createGeometryHashScenario("mass", "sloped"),
    },
  ];
}

function createGeometryHashScenario(
  typeId: string,
  stairVariant: "all" | "stepped" | "sloped",
): StructureConfig {
  const scenario = createDefaultStructureConfig();
  scenario.typeId = typeId;

  if (typeId === "mass") {
    const mass = scenario.layouts.mass as MassLayoutConfig;
    mass.heightCurve = "custom";
    mass.cornicePlacement = "all";
    mass.stoneworkEnabled = true;
    mass.summitTreatment = "raised_pad";
    mass.summitBuildingEnabled = true;
    mass.summitRoofEnabled = true;
    mass.stairFrontEnabled = true;
    mass.stairSideTreatment = stairVariant === "sloped"
      ? "sloped_parapet"
      : "stepped_parapet";
  }

  return scenario;
}

function hashControlSections(config: StructureConfig): HashControlSection[] {
  const definition = getStructure(config.typeId);
  const sections: HashControlSection[] = [{
    label: "layout",
    target: config.layouts[definition.id] as Record<string, unknown>,
    specs: definition.layoutControls as readonly ControlSpec<object>[],
  }];

  for (const prop of definition.props) {
    switch (prop) {
      case "stone":
        sections.push({
          label: "stone",
          target: config.stones[definition.id] as unknown as Record<string, unknown>,
          specs: createStoneControls([]) as unknown as readonly ControlSpec<object>[],
        });
        break;
      case "bevel":
        sections.push({
          label: "bevel",
          target: config.bevels[definition.id] as unknown as Record<string, unknown>,
          specs: createBevelControls([]) as unknown as readonly ControlSpec<object>[],
        });
        break;
      case "pillar":
        sections.push(
          {
            label: "pillar",
            target: config.pillar as unknown as Record<string, unknown>,
            specs: PILLAR_LAYOUT_CONTROLS as unknown as readonly ControlSpec<object>[],
          },
          {
            label: "pillar.stone",
            target: config.pillar.stone as unknown as Record<string, unknown>,
            specs: PILLAR_STONE_CONTROLS as unknown as readonly ControlSpec<object>[],
          },
          {
            label: "pillar.bevel",
            target: config.pillar.bevel as unknown as Record<string, unknown>,
            specs: PILLAR_BEVEL_CONTROLS as unknown as readonly ControlSpec<object>[],
          },
        );
        break;
      case "fireBowl":
        sections.push({
          label: "fireBowl",
          target: config.fireBowl as unknown as Record<string, unknown>,
          specs: FIRE_BOWL_CONTROLS as unknown as readonly ControlSpec<object>[],
        });
        break;
      case "fire":
        sections.push({
          label: "fire",
          target: config.fire as unknown as Record<string, unknown>,
          specs: FIRE_CONTROLS as unknown as readonly ControlSpec<object>[],
        });
        break;
      case "offering":
        sections.push({
          label: "offering",
          target: config.offering as unknown as Record<string, unknown>,
          specs: OFFERING_CONTROLS as unknown as readonly ControlSpec<object>[],
        });
        break;
      case "materialPalette":
        break;
    }
  }

  return sections;
}

function mutateHashControl(
  target: Record<string, unknown>,
  spec: ControlSpec<object>,
): void {
  const current = target[spec.key];

  switch (spec.kind) {
    case "boolean":
      target[spec.key] = current !== true;
      return;
    case "list": {
      const options = Object.values(spec.options);
      const index = options.indexOf(current as string);
      target[spec.key] = options[(index + 1) % options.length];
      spec.onChange?.(target);
      return;
    }
    case "number": {
      const value = current as number;
      const count = Math.round((spec.max - spec.min) / spec.step) + 1;
      const currentTick = Math.round((value - spec.min) / spec.step);
      const nextTick = currentTick + 1 < count
        ? currentTick + 1
        : currentTick - 1;
      const decimals = spec.step.toString().split(".")[1]?.length ?? 0;
      target[spec.key] = Number(
        (spec.min + nextTick * spec.step).toFixed(decimals),
      );
      return;
    }
    case "bezier": {
      const value = current as [number, number, number, number];
      target[spec.key] = [value[0], value[1] + 0.25, value[2], value[3]];
    }
  }
}

function assertEffectiveHashValuesEqual(
  expected: StructureConfig,
  actual: StructureConfig,
): void {
  assert.equal(actual.typeId, expected.typeId);
  const actualSections = hashControlSections(actual);

  for (const section of hashControlSections(expected)) {
    const actualSection = actualSections.find(
      (candidate) => candidate.label === section.label,
    );
    assert.ok(actualSection);

    for (const spec of section.specs) {
      assert.deepEqual(
        actualSection.target[spec.key],
        section.target[spec.key],
        `${expected.typeId}.${section.label}.${spec.key} did not round trip`,
      );
    }
  }
}

function assertCompositionGeometryEqual(
  actual: THREE.BufferGeometry,
  expected: THREE.BufferGeometry,
  label: string,
): void {
  assert.deepEqual(
    Array.from(actual.getAttribute("position").array),
    Array.from(expected.getAttribute("position").array),
    `${label}: positions differ`,
  );
  assert.deepEqual(
    Array.from(actual.getIndex()?.array ?? []),
    Array.from(expected.getIndex()?.array ?? []),
    `${label}: indices differ`,
  );
}

/**
 * Proves that the complete config boundary reaches every control leaf, not just
 * one representative field from each section.
 */
function assertEveryControlParamIsValidated<T extends object>(
  createConfig: () => StructureConfig,
  specs: readonly ControlSpec<T>[],
  target: (config: StructureConfig) => T,
  label: string,
): void {
  for (const spec of specs) {
    const config = createConfig();
    const invalidValue: unknown = spec.kind === "boolean"
      ? "not-a-boolean"
      : spec.kind === "list"
        ? "__not_an_option__"
        : spec.kind === "bezier"
          ? [Number.NaN, 0, 1, 1]
          : Number.NaN;
    (target(config) as Record<string, unknown>)[spec.key] = invalidValue;
    assert.throws(
      () => validateActiveStructureConfig(config),
      undefined,
      `${label}.${spec.key} must be validated`,
    );
  }
}

function assertSpecCoverage<T extends object>(
  specs: readonly ControlSpec<T>[],
  defaults: Readonly<T>,
  label: string,
): void {
  for (const spec of specs) {
    assert.ok(
      spec.key in defaults,
      `${label}: spec "${spec.key}" has no matching default.`,
    );

    if (spec.kind === "number") {
      const value = defaults[spec.key] as unknown as number;
      assert.ok(
        typeof value === "number" && value >= spec.min && value <= spec.max,
        `${label}: default ${spec.key}=${String(value)} outside [${spec.min}, ${spec.max}].`,
      );
    }

    if (spec.kind === "bezier") {
      const value = defaults[spec.key] as unknown as number[];
      assert.ok(
        Array.isArray(value) && value.length === 4 && value.every(Number.isFinite),
        `${label}: default ${spec.key} is not four finite numbers.`,
      );
      // Only the handles' horizontal positions are bounded; vertical overshoot
      // is a legitimate curve shape.
      for (const index of [0, 2]) {
        const component = value[index] ?? Number.NaN;
        assert.ok(
          component >= 0 && component <= 1,
          `${label}: default ${spec.key}[${index}]=${String(component)} outside [0, 1].`,
        );
      }
    }

    if (spec.kind === "list") {
      const value = defaults[spec.key] as unknown as string;
      const allowed = Object.values(spec.options);
      assert.ok(
        allowed.length > 0,
        `${label}: list spec "${spec.key}" has no options.`,
      );
      assert.equal(
        new Set(allowed).size,
        allowed.length,
        `${label}: list spec "${spec.key}" has duplicate option values.`,
      );
      assert.ok(
        allowed.includes(value),
        `${label}: default ${spec.key}="${String(value)}" is not a listed option.`,
      );
    }
  }

  assert.doesNotThrow(
    () => validateControls({ ...defaults }, specs),
    `${label}: defaults must satisfy their own spec table.`,
  );
}

function groupMinimumY(geometry: THREE.BufferGeometry, materialIndex: number): number {
  const group = geometry.groups.find((candidate) => candidate.materialIndex === materialIndex);
  const position = geometry.getAttribute("position");
  const index = geometry.index;

  assert.ok(group, `Geometry must contain material group ${materialIndex}.`);
  assert.ok(index, "Geometry must be indexed.");

  let minimum = Number.POSITIVE_INFINITY;

  for (let offset = group.start; offset < group.start + group.count; offset += 1) {
    minimum = Math.min(minimum, position.getY(index.getX(offset)));
  }

  return minimum;
}
