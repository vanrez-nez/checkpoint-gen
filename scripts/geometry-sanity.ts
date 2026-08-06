import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  resolveMassLayout,
  type MassLayoutConfig,
} from "../src/structure/families/mass/config";
import {
  MAX_FIRE_BOWL_SLOT_FILL,
  resolveMassFireBowlSlots,
} from "../src/structure/families/mass/fire-bowl-slots";
import {
  PILLAR_HALL_LAYOUT_CONTROLS,
  type PillarHallLayoutConfig,
} from "../src/structure/families/pillar-hall/config";
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
  restoreStructureConfig,
  sectionsForScopes,
  snapshotStructureConfig,
  validateActiveStructureConfig,
  type StructureConfig,
} from "../src/config/structure-config";
import {
  applyStructureHash,
  encodeStructureHash,
  isStructureHash,
} from "../src/config/structure-hash";
import {
  applySessionState,
  writeSessionState,
} from "../src/config/session-state";
import { validateControls, type ControlSpec } from "../src/config/control-spec";
import {
  DEFAULT_CIRCULAR_MATERIAL_PALETTE,
  DEFAULT_MASS_MATERIAL_PALETTE,
  DEFAULT_PILLAR_HALL_MATERIAL_PALETTE,
  DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  DEFAULT_TEXTURE_SCALE,
  MATERIAL_DOCUMENT_IDS,
  MATERIAL_SURFACE_CONTROLS,
  MATERIAL_SURFACE_IDS,
  cloneMaterialPalette,
  dressingDiffers,
} from "../src/config/material-palette";
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
import { createBoxProjectedUvs, finalizeGeometry } from "../src/geometry/finalize";
import { HostShadingSampler } from "../src/geometry/host-shading";
import { SolidBuilder } from "../src/geometry/solid-builder";
import { TriangleBvh } from "../src/geometry/bvh";
import { subdivideLongEdges } from "../src/geometry/subdivide";
import {
  overlappingTerminals,
  summitTerminalCaps,
} from "../src/structure/connector/terminal";
import {
  DETAIL_LEVELS,
  DETAIL_PROFILES,
  type DetailLevel,
} from "../src/structure/kernel/detail";
import { bakeSunVisibility } from "../src/geometry/sun-bake";
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
import {
  DEFAULT_SAMPLERS_PER_SHADER_STAGE,
  DEFAULT_SAMPLED_TEXTURES_PER_SHADER_STAGE,
  FULL_SUN_SHADOW_CASCADES,
  MAX_REQUESTED_SAMPLED_TEXTURES,
  MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES,
  REDUCED_SUN_SHADOW_CASCADES,
  fireGlowShadowBindingCount,
  fireGlowShadowCascadeCount,
  requestedSamplerLimit,
  requestedSampledTextureLimit,
  supportsFireGlowShadows,
} from "../src/scene/webgpu-limits";
import { ValidationLog } from "../src/ui/validation-log";
import { stairBasis, stairWorldToLocal } from "../src/structure/connector/stair";

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

const validationLogTimes = [
  new Date("2026-08-01T12:00:00"),
  new Date("2026-08-01T12:00:01"),
  new Date("2026-08-01T12:00:02"),
];
const validationLog = new ValidationLog(
  () => validationLogTimes.shift() ?? new Date("2026-08-01T12:00:03"),
  2,
);
validationLog.diagnostics([]);
const initialValidationLog = validationLog.mirror.text;
validationLog.diagnostics([]);
assert.equal(
  validationLog.mirror.text,
  initialValidationLog,
  "Unchanged structural diagnostics must not spam the validation log.",
);
validationLog.rejected(
  "Main row bay count (frontBayCount) = 9",
  "The front row has too many bays for the current pier width. (pillar_hall.bays_too_dense)",
);
validationLog.diagnostics([{
  severity: "notice",
  code: "pillar_hall.test_repair",
  entityId: "pillar_hall/supports",
  message: "A test repair was applied.",
  resolved: "wider bays",
}]);
assert.doesNotMatch(validationLog.mirror.text, /No structural diagnostics/);
assert.match(validationLog.mirror.text, /pillar_hall\.bays_too_dense/);
assert.match(validationLog.mirror.text, /entity: pillar_hall\/supports/);
assert.match(validationLog.mirror.text, /resolved: wider bays/);
validationLog.clear();
assert.equal(validationLog.mirror.text, "No validation events yet.");

// --- structure geometry codes ---------------------------------------------
// Every field is explicit in the unversioned current-schema code. The first
// character is the structure selector; there is no migration prefix.
const circularDefaultCode = encodeStructureHash(config);
assert.ok(circularDefaultCode.length <= 60);
assert.ok(isStructureHash(circularDefaultCode));

const massDefaultHashConfig = createDefaultStructureConfig();
massDefaultHashConfig.typeId = "mass";
const massDefaultCode = encodeStructureHash(massDefaultHashConfig);
// 210 before the summit pad was split off the band wall. A whole slot feature —
// enabled, border, both insets, relief, texture scale — cost two characters,
// which is the dense mixed radix behaving as advertised and worth knowing when
// judging the next one.
assert.ok(massDefaultCode.length <= 215);
// The other families have room today; the assert is what keeps it visible when
// the next batch of per-feature settings lands.
{
  const hallCode = createDefaultStructureConfig();
  hallCode.typeId = "pillar_hall";
  assert.ok(encodeStructureHash(hallCode).length <= 130);
  const stelaCode = createDefaultStructureConfig();
  stelaCode.typeId = "stela";
  assert.ok(encodeStructureHash(stelaCode).length <= 120);
}
assert.doesNotMatch(massDefaultCode, /^g\d/);
assert.equal(
  applyStructureHash(createDefaultStructureConfig(), massDefaultCode),
  massDefaultCode,
);
assert.notEqual(massDefaultCode, circularDefaultCode);

const oneEditHashConfig = createDefaultStructureConfig();
oneEditHashConfig.typeId = "mass";
(oneEditHashConfig.layouts.mass as MassLayoutConfig).footprintWidth = 30;
assert.notEqual(encodeStructureHash(oneEditHashConfig), massDefaultCode);

const sceneOnlyHashConfig = createDefaultStructureConfig();
const sceneIndependentCode = encodeStructureHash(sceneOnlyHashConfig);
sceneOnlyHashConfig.view.wireframe = !sceneOnlyHashConfig.view.wireframe;
sceneOnlyHashConfig.view.patchDebug = !sceneOnlyHashConfig.view.patchDebug;
// Deliberately included: the slot tint declares the "layout" scope so it can
// reach the builder, which makes it the one debug control that could plausibly
// leak into a geometry code. It must not.
sceneOnlyHashConfig.view.slotDebug = !sceneOnlyHashConfig.view.slotDebug;
// Deliberately included for the same reason, and one step stronger: the detail
// level rewrites the geometry outright. It still must not enter the code — a
// structure laid at a coarser level is the same structure, and a code that
// carried the level would make two of them where there is one.
sceneOnlyHashConfig.view.detailLevel = "bare";
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
materialOnlyHashConfig.materialPalettes.mass!.stone.document = "stone";
materialOnlyHashConfig.materialPalettes.mass!.roof.document = "flamed-basalt";
materialOnlyHashConfig.materialPalettes.mass!.stone.textureScale = 2.5;
assert.equal(
  encodeStructureHash(materialOnlyHashConfig),
  materialIndependentCode,
  "Surface dressing must not enter a structure geometry code.",
);
const invalidMaterialConfig = createDefaultStructureConfig();
invalidMaterialConfig.materialPalettes.circular!.stone.document =
  "not-a-material" as never;
assert.throws(
  () => validateActiveStructureConfig(invalidMaterialConfig),
  /Main structure material must be one of/,
);
const invalidTextureScaleConfig = createDefaultStructureConfig();
invalidTextureScaleConfig.materialPalettes.circular!.pillar.textureScale = 9;
assert.throws(
  () => validateActiveStructureConfig(invalidTextureScaleConfig),
  /Pillars texture scale must be between 0.1 and 8/,
);
assertCompositionGeometryEqual(
  new StructureComposer().build(massDefaultHashConfig).geometry,
  new StructureComposer().build(materialOnlyHashConfig).geometry,
  "Material palette changes must not regenerate different geometry",
);
const massSurfaceComposition = new StructureComposer().build(
  massDefaultHashConfig,
);

// Mass owns bowl placement independently of pillars. Each enabled terminal is
// a square slot derived from the resolved parapet width and cornice projection.
const slottedMassConfig = createDefaultStructureConfig();
slottedMassConfig.typeId = "mass";
const slottedMassLayout = slottedMassConfig.layouts.mass as MassLayoutConfig;
slottedMassLayout.stairFireBowlBottomEnabled = true;
slottedMassLayout.stairFireBowlTopEnabled = true;
const slottedMassGraph = resolveMassLayout(slottedMassLayout);
const massBowlSlots = resolveMassFireBowlSlots(
  slottedMassLayout,
  slottedMassGraph,
  slottedMassConfig.fireBowl,
);
// The foot of every flight keeps both of its own slots: the flights diverge on
// the way down, so nothing there can collide.
assert.equal(
  massBowlSlots.filter((slot) => slot.level === "bottom").length,
  slottedMassGraph.connectors.length * 2,
);

// The summit is where they converge. At this layout every adjacent pair of
// parapet caps overlaps, and each overlap is one pier carrying one bowl — so
// the count is stated against the collisions rather than against the stairs.
const massTerminalOverlaps = overlappingTerminals(
  slottedMassGraph.connectors.flatMap(summitTerminalCaps),
).length;
assert.ok(
  massTerminalOverlaps > 0,
  "The default mass summit is expected to collide its terminals; if that has "
  + "changed, this assertion is measuring the wrong thing rather than passing.",
);
assert.equal(
  massBowlSlots.filter((slot) => slot.level === "top").length,
  massTerminalOverlaps,
);
assert.equal(
  massBowlSlots.length,
  slottedMassGraph.connectors.length * 2 + massTerminalOverlaps,
);
for (const slot of massBowlSlots) {
  const connector = slottedMassGraph.connectors.find((entry) => entry.id === slot.connectorId)!;
  const parapet = connector.parapet!;
  const outward = stairBasis(connector.direction).outward;
  const expectedWidth = parapet.width + parapet.cornice!.projection * 2;
  assert.ok(Math.abs(slot.availableWidth - expectedWidth) < 1e-9);
  assert.equal(slot.bowlScale, Math.min(slottedMassConfig.fireBowl.scale, MAX_FIRE_BOWL_SLOT_FILL));

  if (slot.merged) {
    // A merged pier stands on a corner and belongs to neither flight, so it
    // faces their bisector. Only its being a direction at all is checkable
    // here; which direction is the merge's business.
    assert.ok(
      Math.abs(Math.hypot(slot.outwardX, slot.outwardZ) - 1) < 1e-9,
      `Merged slot ${slot.id} does not carry a unit outward direction.`,
    );
  } else {
    assert.equal(slot.outwardX, outward.x);
    assert.equal(slot.outwardZ, outward.z);
  }
  const bowl = createFireBowlGeometry(
    { ...slottedMassConfig.fireBowl, scale: slot.bowlScale },
    slot.referenceWidth,
  );
  const bounds = bowl.geometry.boundingBox!;
  assert.ok(bounds.max.x - bounds.min.x <= slot.availableWidth * MAX_FIRE_BOWL_SLOT_FILL + 1e-6);
  assert.ok(bounds.max.z - bounds.min.z <= slot.availableWidth * MAX_FIRE_BOWL_SLOT_FILL + 1e-6);
  // Position is checked against the owning flight's own terminal, which only
  // means anything for a slot that stands on one. A merged pier sits where two
  // caps overlap and is verified against both of them in detail-sanity instead.
  if (!slot.merged) {
    const local = stairWorldToLocal(connector, slot);
    assert.ok(Math.abs(
      Math.abs(local.u) - (connector.width * 0.5 + parapet.width * 0.5)
    ) < 1e-9);
    assert.ok(Math.abs(
      local.v - (slot.level === "bottom"
        ? connector.run + expectedWidth * 0.5
        : -expectedWidth * 0.5)
    ) < 1e-9);
  }

  assert.ok(Math.abs(
    slot.y - (slot.level === "bottom"
      ? connector.bottomY + parapet.height
      : connector.topY + parapet.height)
  ) < 1e-9);
  bowl.geometry.dispose();
}

const slottedMassComposition = new StructureComposer().build(slottedMassConfig);
// One bowl per slot, merged piers included, so the composition follows the
// slot table rather than a count of stairs.
assert.equal(slottedMassComposition.sections.fireBowls.partCount, massBowlSlots.length);
assert.equal(slottedMassComposition.anchors.flames.length, massBowlSlots.length);
// A glow still lights each terminal: one between the pair at every foot, and
// one on each merged summit pier — which is why the total is unchanged by the
// merge even though the bowl count fell.
assert.equal(
  slottedMassComposition.anchors.glows.length,
  slottedMassGraph.connectors.length + massTerminalOverlaps,
);
for (const glow of slottedMassComposition.anchors.glows) {
  const pair = massBowlSlots.filter(
    (slot) => (slot.merged
      ? `${slot.id}/fire_glow`
      : `${slot.connectorId}/${slot.level}/fire_glow`) === glow.label,
  );
  assert.ok(
    pair.length === 2 || (pair.length === 1 && pair[0]!.merged),
    `Glow ${glow.label} lights ${pair.length} bowls; only a merged pier may light one.`,
  );

  if (pair.length === 1) {
    assert.ok(Math.abs(glow.x - pair[0]!.x) < 1e-9);
    assert.ok(Math.abs(glow.z - pair[0]!.z) < 1e-9);
    continue;
  }

  assert.ok(Math.abs(glow.x - (pair[0]!.x + pair[1]!.x) * 0.5) < 1e-9);
  assert.ok(Math.abs(glow.y - (pair[0]!.y + pair[1]!.y) * 0.5) < 1e-9);
  assert.ok(Math.abs(glow.z - (pair[0]!.z + pair[1]!.z) * 0.5) < 1e-9);
  const connector = slottedMassGraph.connectors.find(
    (entry) => entry.id === pair[0]!.connectorId,
  )!;
  assert.ok(Math.abs(stairWorldToLocal(connector, glow).u) < 1e-9);
  const outward = stairBasis(connector.direction).outward;
  assert.equal(glow.outwardX, outward.x);
  assert.equal(glow.outwardZ, outward.z);
}
assert.ok(
  slottedMassComposition.geometry.groups.some(
    (group) => group.materialIndex === materialSlotIndex("iron"),
  ),
);

const bottomOnlyMassLayout: MassLayoutConfig = {
  ...slottedMassLayout,
  stairFireBowlTopEnabled: false,
};
assert.equal(
  resolveMassFireBowlSlots(
    bottomOnlyMassLayout,
    resolveMassLayout(bottomOnlyMassLayout),
    slottedMassConfig.fireBowl,
  ).length,
  slottedMassGraph.connectors.length * 2,
);

const steppedSlotLayout: MassLayoutConfig = {
  ...slottedMassLayout,
  stairRearEnabled: false,
  stairLeftEnabled: false,
  stairRightEnabled: false,
  stairSideTreatment: "stepped_parapet",
  stairSteppedParapetCorniceProjection: 0.2,
  stairSteppedParapetCorniceHeight: 0.2,
};
const steppedSlotGraph = resolveMassLayout(steppedSlotLayout);
const steppedSlots = resolveMassFireBowlSlots(
  steppedSlotLayout,
  steppedSlotGraph,
  slottedMassConfig.fireBowl,
);
assert.equal(steppedSlots.length, 4);
const steppedConnector = steppedSlotGraph.connectors[0]!;
assert.ok(steppedSlots.filter((slot) => slot.level === "bottom").every((slot) =>
  Math.abs(
    slot.y
      - (steppedConnector.bottomY + steppedConnector.riser + steppedConnector.parapet!.height)
  ) < 1e-9));

const disabledMassBowlConfig = structuredClone(slottedMassConfig);
disabledMassBowlConfig.fireBowl.enabled = false;
const disabledMassBowls = new StructureComposer().build(disabledMassBowlConfig);
assert.equal(disabledMassBowls.sections.fireBowls.partCount, 0);
assert.equal(disabledMassBowls.anchors.flames.length, 0);
assert.equal(disabledMassBowls.anchors.glows.length, 0);

const crampedMassLayout: MassLayoutConfig = {
  ...slottedMassLayout,
  stairParapetWidth: 0.2,
  stairParapetCorniceProjection: 0.05,
};
assert.equal(
  resolveMassFireBowlSlots(
    crampedMassLayout,
    resolveMassLayout(crampedMassLayout),
    slottedMassConfig.fireBowl,
  ).length,
  0,
  "A parapet terminal below the minimum usable square must expose no bowl slots.",
);
const bottomSlotControl = MASS_LAYOUT_CONTROLS.find(
  (spec) => spec.key === "stairFireBowlBottomEnabled",
)!;
assert.equal(bottomSlotControl.visibleWhen?.(DEFAULT_MASS_LAYOUT), true);
assert.equal(bottomSlotControl.visibleWhen?.(crampedMassLayout), false);

const noCorniceMassLayout: MassLayoutConfig = {
  ...slottedMassLayout,
  stairParapetCorniceProjection: 0,
};
assert.equal(
  resolveMassFireBowlSlots(
    noCorniceMassLayout,
    resolveMassLayout(noCorniceMassLayout),
    slottedMassConfig.fireBowl,
  ).length,
  0,
  "A parapet without a resolved cornice must expose no bowl slots.",
);
assert.deepEqual(
  massSurfaceComposition.geometry.groups.map((group) => group.materialIndex),
  [
    materialSlotIndex("stone"),
    materialSlotIndex("stairs"),
    materialSlotIndex("parapet"),
    materialSlotIndex("summit"),
    materialSlotIndex("interior"),
    materialSlotIndex("roof"),
    materialSlotIndex("iron"),
    materialSlotIndex("portalReveal"),
    materialSlotIndex("cornice"),
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
assert.throws(() => applyStructureHash(createDefaultStructureConfig(), "0"));
assert.throws(
  () => applyStructureHash(createDefaultStructureConfig(), `${circularDefaultCode}A`),
  /invalid|corrupted/,
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

for (const typeId of ["circular", "mass", "pillar_hall"]) {
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
massRoundTripLayout.stairFireBowlBottomEnabled = true;
massRoundTripLayout.stairFireBowlTopEnabled = true;
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
// Box projection must hold its world scale whatever way a face turns. A face
// that does not square up to the axis it projects onto is foreshortened by the
// cosine between them, and without dividing that back out a bevel facet at 45
// degrees stretches its texture by 1.41 across itself.
for (const [label, normal, run] of [
  ["axis-aligned side", [1, 0, 0], [0, 0, 1]],
  ["battered side", [1, 0.25, 0], [0, 0, 1]],
  ["45 degree facet", [1, 0, 1], [-Math.SQRT1_2, 0, Math.SQRT1_2]],
  ["30 degree facet", [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)], [-0.5, 0, Math.cos(Math.PI / 6)]],
] as const) {
  const probe = new THREE.BufferGeometry();
  probe.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, run[0], run[1], run[2]], 3),
  );
  const unit = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  probe.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute([unit.x, unit.y, unit.z, unit.x, unit.y, unit.z], 3),
  );
  const uvs = createBoxProjectedUvs(probe);
  const span = Math.hypot(uvs[2]! - uvs[0]!, uvs[3]! - uvs[1]!);
  assert.ok(
    Math.abs(span - 1) < 1e-6,
    `${label}: one metre of face should span one UV unit, got ${span.toFixed(4)}.`,
  );
}

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
  () => validateOfferingConfig({
    ...DEFAULT_OFFERING_CONFIG,
    rotationDegrees: 181,
  }),
  /rotation/,
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

// --- host shading ----------------------------------------------------------
/**
 * A decal reads the stone it lies on rather than assuming it is unshaded.
 *
 * `mergeDecalQuads` fills a decal's occlusion and crack-shadow arrays with ones,
 * which was justified by a claim that a prepared field is already at one.
 * Measured against what the families emit, a wall averages 0.62 and 0.39 — so a
 * decal keeping the ones reads as a brighter plate laid on the stone instead of
 * as carving in it. These check the lookup that fixes that.
 */
{
  /** One unit quad in the z = 0 plane, facing +z, with a gradient up it. */
  const hostGeometry = new THREE.BufferGeometry();
  hostGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ], 3));
  hostGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  // Bottom corners dark, top corners light, exactly as `DEFAULT_FACE_SHADING`
  // lays a side quad out.
  hostGeometry.userData.vertexAoBase = Float32Array.from([0.28, 0.28, 0.72, 0.72]);
  hostGeometry.userData.bakedShadowBase = Float32Array.from([0.06, 0.06, 0.38, 0.38]);

  const sampler = HostShadingSampler.from(hostGeometry)!;
  assert.ok(sampler, "A geometry with an index must yield a sampler.");

  // Dead centre of the quad, standing 6 mm off it: halfway up the gradient.
  const middle = sampler.sample(0.5, 0.5, 0.006, 0, 0, 1, 0.006)!;
  assert.ok(middle, "A decal directly in front of stone must find it.");
  assert.ok(
    Math.abs(middle.ambientOcclusion - 0.5) < 1e-5,
    `Halfway up a 0.28-to-0.72 gradient is 0.5, not ${middle.ambientOcclusion}.`,
  );
  assert.ok(
    Math.abs(middle.bakedShadow - 0.22) < 1e-5,
    `Halfway up a 0.06-to-0.38 gradient is 0.22, not ${middle.bakedShadow}.`,
  );

  // Near the bottom edge it must read the bottom of the gradient, or the
  // interpolation is not actually barycentric.
  const low = sampler.sample(0.5, 0.02, 0.006, 0, 0, 1, 0.006)!;
  assert.ok(low.ambientOcclusion < 0.32, `Near the base must be dark; got ${low.ambientOcclusion}.`);

  /**
   * A miss keeps its one rather than going black. An applique standing free of
   * the structure has no host behind it, and must not be blackened for it.
   */
  assert.equal(
    sampler.sample(5, 5, 0.006, 0, 0, 1, 0.006),
    null,
    "A point with no stone behind it must report no shading, not a dark one.",
  );

  /**
   * The nearest surface wins. This is the whole reason the decal hierarchy is a
   * separate class from the occlusion one: once a face can be sunk into its
   * member, the ray crosses the pocket's own return before reaching the floor,
   * and an any-hit traversal would sample the return.
   */
  const layered = new THREE.BufferGeometry();
  layered.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, -0.5, 1, 0, -0.5, 1, 1, -0.5, 0, 1, -0.5,
  ], 3));
  layered.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  layered.userData.vertexAoBase = Float32Array.from([1, 1, 1, 1, 0, 0, 0, 0]);
  layered.userData.bakedShadowBase = Float32Array.from([1, 1, 1, 1, 0, 0, 0, 0]);

  const near = HostShadingSampler.from(layered)!.sample(0.5, 0.5, 0.006, 0, 0, 1, 0.006)!;
  assert.equal(
    near.ambientOcclusion,
    1,
    "The nearer of two surfaces must be the one sampled.",
  );

  hostGeometry.dispose();
  layered.dispose();
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

// One block may expose several semantic surfaces. Per-face overrides follow
// authored face order even when SolidBuilder normalizes the block winding.
const faceMaterialBuilder = new SolidBuilder();
faceMaterialBuilder.withMaterial("summit", () => {
  faceMaterialBuilder.addBlock(
    block(4),
    {
      sides: [true, true, true, true],
      top: true,
      bottom: true,
      materials: {
        sides: ["portalReveal", "windowReveal", "niche", "panel"],
        top: "pilaster",
        bottom: "frieze",
      },
    },
  );
});
assert.deepEqual(
  [...new Set(faceMaterialBuilder.blockFaces.map(
    (start) => faceMaterialBuilder.surfaceMaterials[start],
  ))].sort((a, b) => (a ?? 0) - (b ?? 0)),
  [
    "portalReveal",
    "windowReveal",
    "niche",
    "panel",
    "pilaster",
    "frieze",
  ].map((slot) => materialSlotIndex(slot as MaterialSlot)).sort((a, b) => a - b),
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

// One coalesced group per dressed surface — shell, pillars, bowls — rather than
// mergeGeometries' one group per input part.
assert.deepEqual(
  composition.geometry.groups.map((group) => group.materialIndex),
  [
    materialSlotIndex("stone"),
    materialSlotIndex("pillar"),
    materialSlotIndex("iron"),
  ],
  "The circular checkpoint must dress its shell, pillars and bowls apart.",
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
for (const glow of composition.anchors.glows) {
  assert.ok(Math.abs(Math.hypot(glow.outwardX ?? 0, glow.outwardZ ?? 0) - 1) < 1e-9);
  assert.ok(
    glow.x * (glow.outwardX ?? 0) + glow.z * (glow.outwardZ ?? 0) > 0,
    "Circular glow directions must point away from the structure centre.",
  );
}
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

// Bowls off drops the iron group along with every fire anchor; the surfaces that
// did produce geometry keep their own groups.
const noBowlConfig = createDefaultStructureConfig();
noBowlConfig.fireBowl.enabled = false;
const noBowlComposition = new StructureComposer().build(noBowlConfig);
assert.deepEqual(
  noBowlComposition.geometry.groups.map((group) => group.materialIndex),
  [materialSlotIndex("stone"), materialSlotIndex("pillar")],
);
assert.equal(
  noBowlComposition.geometry.groups.reduce((sum, group) => sum + group.count, 0),
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
  // Flames need bowl placements; bowls may be pillar-mounted or structure-owned.
  if (definition.props.includes("fire")) {
    assert.ok(definition.props.includes("fireBowl"), `${definition.id}: fire needs fireBowl`);
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
    // A slot feature's label is a layout group like any other: it is the title
    // of its own folder, so a tab has to claim it or the folder has no page.
    new Set([
      ...definition.layoutControls.map((control) => control.group),
      ...(definition.slotFeatures ?? []).map((feature) => feature.label),
    ]),
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
const massDefinition = getStructure("mass");
assert.deepEqual(
  sectionsForScopes(["layout"], massDefinition),
  new Set(["mass", "fireBowls"]),
  "A full Mass layout rebuild must include its structure-owned bowl slots.",
);
assert.deepEqual(
  sectionsForScopes(["bowls"], massDefinition),
  new Set(["fireBowls"]),
  "Mass bowl controls must rebuild only the bowl-slot section.",
);
assert.deepEqual(
  massControlTabs.map((tab) => tab.label),
  ["Structure", "Stairs", "Summit", "Fire", "Materials"],
);
assert.deepEqual(
  getStructure("pillar_hall").controlTabs.map((tab) => tab.label),
  ["Structure", "Details", "Materials"],
);
assert.deepEqual(
  massControlTabs.find((tab) => tab.id === "stairs")?.layoutGroups,
  ["Stair"],
);
assert.deepEqual(
  massControlTabs.find((tab) => tab.id === "summit")?.layoutGroups,
  [
    "Summit",
    "Summit building",
    "Facade",
    "Roof",
    "Summit pad slots",
    "Summit wall slots",
    "Roof fascia slots",
    "Roof cornice slots",
  ],
);
assert.ok(
  massControlTabs.every(
    (tab) => !["Pillars", "Offering"].includes(tab.label),
  ),
);

// --- control specs ---------------------------------------------------------
// Every spec must describe a real field whose default sits inside its own
// range. This is what makes the UI/validator range drift that existed before
// impossible to reintroduce.
assertSpecCoverage(CIRCULAR_LAYOUT_CONTROLS, DEFAULT_CIRCULAR_LAYOUT, "circular layout");
assertSpecCoverage(MASS_LAYOUT_CONTROLS, DEFAULT_MASS_LAYOUT, "mass layout");
assert.equal(DEFAULT_MASS_LAYOUT.stairFireBowlBottomEnabled, true);
assert.equal(DEFAULT_MASS_LAYOUT.stairFireBowlTopEnabled, true);
assertSpecCoverage(createStoneControls(["layout"]), DEFAULT_STONE_CONFIG, "circular stone");
assertSpecCoverage(createStoneControls(["layout"]), DEFAULT_MASS_STONE_CONFIG, "mass stone");
assertSpecCoverage(createBevelControls(["layout"]), DEFAULT_BEVEL_CONFIG, "circular bevel");
assertSpecCoverage(PILLAR_LAYOUT_CONTROLS, DEFAULT_PILLAR_CONFIG, "pillar layout");
assertSpecCoverage(PILLAR_STONE_CONTROLS, DEFAULT_PILLAR_CONFIG.stone, "pillar stone");
assertSpecCoverage(PILLAR_BEVEL_CONTROLS, DEFAULT_PILLAR_CONFIG.bevel, "pillar bevel");
assertSpecCoverage(FIRE_BOWL_CONTROLS, DEFAULT_FIRE_BOWL_CONFIG, "fire bowl");
assertSpecCoverage(FIRE_CONTROLS, DEFAULT_FIRE_CONFIG, "fire");
assert.deepEqual(
  {
    bowlScale: DEFAULT_FIRE_BOWL_CONFIG.scale,
    bowlRadialSegments: DEFAULT_FIRE_BOWL_CONFIG.radialSegments,
    flameScale: DEFAULT_FIRE_CONFIG.scale,
    flameRadius: DEFAULT_FIRE_CONFIG.radius,
    flameHeight: DEFAULT_FIRE_CONFIG.height,
    flameBaseHeight: DEFAULT_FIRE_CONFIG.baseHeight,
    flameRadialSegments: DEFAULT_FIRE_CONFIG.radialSegments,
    speed: DEFAULT_FIRE_CONFIG.speed,
    noiseScale: DEFAULT_FIRE_CONFIG.noiseScale,
    turbulence: DEFAULT_FIRE_CONFIG.turbulence,
    intensity: DEFAULT_FIRE_CONFIG.intensity,
    glowIntensity: DEFAULT_FIRE_CONFIG.glowIntensity,
    glowRange: DEFAULT_FIRE_CONFIG.glowDistance,
    glowHorizontalDistance: DEFAULT_FIRE_CONFIG.glowHorizontalDistance,
    glowVerticalDistance: DEFAULT_FIRE_CONFIG.glowVerticalDistance,
    glowFlicker: DEFAULT_FIRE_CONFIG.glowFlicker,
  },
  {
    bowlScale: 0.5,
    bowlRadialSegments: 16,
    flameScale: 2.05,
    flameRadius: 0.095,
    flameHeight: 0.56,
    flameBaseHeight: 0.14,
    flameRadialSegments: 16,
    speed: 7,
    noiseScale: 4.8,
    turbulence: 2,
    intensity: 5,
    glowIntensity: 0.6,
    glowRange: 3,
    glowHorizontalDistance: 0,
    glowVerticalDistance: 0,
    glowFlicker: 0.25,
  },
  "Fire defaults must match the approved pane values.",
);
assertSpecCoverage(OFFERING_CONTROLS, DEFAULT_OFFERING_CONFIG, "offering");
assertSpecCoverage(VIEW_CONTROLS, DEFAULT_VIEW_CONFIG, "view");
assertSpecCoverage(ILLUMINATION_CONTROLS, DEFAULT_ILLUMINATION_CONFIG, "illumination");

// Every surface a structure could dress must be described and defaulted, in both
// palettes, so declaring a new one on a family cannot expose an unbound control.
for (const surfaceId of MATERIAL_SURFACE_IDS) {
  for (const [label, palette] of [
    ["structure", DEFAULT_STRUCTURE_MATERIAL_PALETTE],
    ["circular", DEFAULT_CIRCULAR_MATERIAL_PALETTE],
    ["mass", DEFAULT_MASS_MATERIAL_PALETTE],
    ["pillar hall", DEFAULT_PILLAR_HALL_MATERIAL_PALETTE],
  ] as const) {
    assertSpecCoverage(
      MATERIAL_SURFACE_CONTROLS[surfaceId],
      palette[surfaceId],
      `${label} ${surfaceId} surface`,
    );
  }

  // The baseline palette is what an untuned family is dressed from, so it must
  // stay at the density the builders authored. A family that wants otherwise
  // says so in its own palette, as circular does for the statue.
  assert.equal(
    DEFAULT_STRUCTURE_MATERIAL_PALETTE[surfaceId].textureScale,
    DEFAULT_TEXTURE_SCALE,
    `${surfaceId} must default to the generated texture density.`,
  );
}
assert.equal(DEFAULT_CIRCULAR_MATERIAL_PALETTE.offering.textureScale, 2);

// Every selectable document must be a file the runtime can actually fetch.
for (const documentId of MATERIAL_DOCUMENT_IDS) {
  assert.ok(
    existsSync(new URL(`../public/materials/${documentId}.json`, import.meta.url)),
    `Material document "${documentId}" has no file in public/materials.`,
  );
}

// --- validators ------------------------------------------------------------
assert.doesNotThrow(() => validateActiveStructureConfig(
  createDefaultStructureConfig(),
));
const defaultMassConfig = createDefaultStructureConfig();
defaultMassConfig.typeId = "mass";
assert.doesNotThrow(() => validateActiveStructureConfig(defaultMassConfig));
const defaultPillarHallConfig = createDefaultStructureConfig();
defaultPillarHallConfig.typeId = "pillar_hall";
assert.doesNotThrow(() => validateActiveStructureConfig(defaultPillarHallConfig));

// Tweakpane writes into its bound object before dispatch validates the whole
// composition. A rejected semantic edit must therefore restore the last valid
// values in place, or that invalid value poisons every subsequent pane edit.
const recoveryConfig = createDefaultStructureConfig();
recoveryConfig.typeId = "pillar_hall";
const recoveryLayout = recoveryConfig.layouts.pillar_hall as PillarHallLayoutConfig;
assert.doesNotThrow(() => validateActiveStructureConfig(recoveryConfig));

const recoverySnapshot = snapshotStructureConfig(recoveryConfig);
const layoutsReference = recoveryConfig.layouts;
const layoutReference = recoveryLayout;
const stoneSurfaceReference = recoveryConfig.materialPalettes.pillar_hall!.stone;
recoveryLayout.platformWidth = 4;
recoveryLayout.frontBayCount = 9;
recoveryLayout.pierWidth = 1.2;
stoneSurfaceReference.document = "stone";
assert.throws(
  () => validateActiveStructureConfig(recoveryConfig),
  /pillar_hall\.bays_too_dense/,
);

restoreStructureConfig(recoveryConfig, recoverySnapshot);
assert.deepEqual(recoveryConfig, recoverySnapshot);
assert.strictEqual(recoveryConfig.layouts, layoutsReference);
assert.strictEqual(recoveryConfig.layouts.pillar_hall, layoutReference);
assert.strictEqual(
  recoveryConfig.materialPalettes.pillar_hall!.stone,
  stoneSurfaceReference,
);
assert.doesNotThrow(() => validateActiveStructureConfig(recoveryConfig));
recoveryLayout.frontBayCount = 6;
assert.doesNotThrow(
  () => validateActiveStructureConfig(recoveryConfig),
  "A valid edit after recovery must be accepted without reloading.",
);

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
  () => {
    const current = createDefaultStructureConfig();
    current.typeId = "pillar_hall";
    return current;
  },
  PILLAR_HALL_LAYOUT_CONTROLS,
  (current) => current.layouts.pillar_hall,
  "pillar hall layout",
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
for (const surfaceId of MATERIAL_SURFACE_IDS) {
  assertEveryControlParamIsValidated(
    createDefaultStructureConfig,
    MATERIAL_SURFACE_CONTROLS[surfaceId],
    (current) => current.materialPalettes.circular![surfaceId],
    `${surfaceId} surface`,
  );
}
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
validateFireConfig({ ...DEFAULT_FIRE_CONFIG, glowVerticalDistance: -3 });
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, glowVerticalDistance: -3.05 }),
  /Fire glow vertical distance/,
);
assert.equal(
  requestedSampledTextureLimit(DEFAULT_SAMPLED_TEXTURES_PER_SHADER_STAGE),
  null,
);
assert.equal(
  requestedSampledTextureLimit(MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES),
  MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES,
);
assert.equal(
  requestedSampledTextureLimit(MAX_REQUESTED_SAMPLED_TEXTURES * 2),
  MAX_REQUESTED_SAMPLED_TEXTURES,
);
assert.equal(
  requestedSamplerLimit(DEFAULT_SAMPLERS_PER_SHADER_STAGE),
  null,
);
assert.equal(
  fireGlowShadowCascadeCount(48, DEFAULT_SAMPLERS_PER_SHADER_STAGE),
  REDUCED_SUN_SHADOW_CASCADES,
);
assert.equal(
  fireGlowShadowCascadeCount(48, MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES),
  FULL_SUN_SHADOW_CASCADES,
);
assert.equal(fireGlowShadowBindingCount(FULL_SUN_SHADOW_CASCADES), 17);
assert.equal(fireGlowShadowBindingCount(REDUCED_SUN_SHADOW_CASCADES), 16);
assert.equal(
  supportsFireGlowShadows(
    DEFAULT_SAMPLED_TEXTURES_PER_SHADER_STAGE,
    DEFAULT_SAMPLERS_PER_SHADER_STAGE,
    REDUCED_SUN_SHADOW_CASCADES,
  ),
  true,
);
assert.equal(supportsFireGlowShadows(48, 15, REDUCED_SUN_SHADOW_CASCADES), false);

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
assert.equal(structureMesh.geometry.groups.length, 3);

// Texture scale is per surface: raising the pillars' scale re-tiles the pillar
// vertices in place and leaves every other surface at its own density.
const circularSurfaces = getStructure("circular").materialSurfaces ?? ["stone"];
const scaledPalette = cloneMaterialPalette(sceneConfig.materialPalettes.circular);
scaledPalette.pillar.textureScale = 4;
void scene.setStructureMaterialPalette(scaledPalette, circularSurfaces);
assertSurfaceTextureScale(structureMesh.geometry, "pillar", 4);
assertSurfaceTextureScale(structureMesh.geometry, "stone", 1);
assertSurfaceTextureScale(structureMesh.geometry, "iron", 1);

// The Scene tab's material scale is a master multiplier over those densities.
scene.setMaterialScale(2);
assertSurfaceTextureScale(structureMesh.geometry, "pillar", 8);
assertSurfaceTextureScale(structureMesh.geometry, "stone", 2);
scene.setMaterialScale(DEFAULT_VIEW_CONFIG.materialScale);
void scene.setStructureMaterialPalette(
  cloneMaterialPalette(sceneConfig.materialPalettes.circular),
  circularSurfaces,
);
assertSurfaceTextureScale(structureMesh.geometry, "pillar", 1);

// What counts as re-dressing a surface, and what merely re-tiles it.
//
// The distinction decides whether every decal is disposed and rebuilt, so it is
// the difference between a texture-scale drag costing a UV rewrite and costing
// a pipeline compile per batch. Asserted here rather than through the scene
// because `setStructureMaterialPalette` returns early without a renderer, and
// there is no renderer in Node — so the branch itself is unreachable from a
// test and only the decision behind it can be pinned.
{
  const base = cloneMaterialPalette(sceneConfig.materialPalettes.circular);
  const surfaces = new Set(circularSurfaces);

  assert.equal(
    dressingDiffers(base, cloneMaterialPalette(base), surfaces, circularSurfaces),
    false,
    "An identical palette re-dresses nothing.",
  );

  const rescaled = cloneMaterialPalette(base);
  rescaled.pillar.textureScale = 3.5;
  assert.equal(
    dressingDiffers(base, rescaled, surfaces, circularSurfaces),
    false,
    "Texture scale is a UV concern; it must not invalidate a decal's material.",
  );

  const redressed = cloneMaterialPalette(base);
  redressed.pillar.document = base.pillar.document === "lichen-stone"
    ? "flamed-basalt"
    : "lichen-stone";
  assert.equal(
    dressingDiffers(base, redressed, surfaces, circularSurfaces),
    true,
    "A different document means a different material clone, so decals are stale.",
  );

  // A structure switch, where the decals belong to the family being left.
  assert.equal(
    dressingDiffers(base, base, surfaces, [...circularSurfaces, "offering"]),
    true,
    "A surface appearing must re-dress, whatever the documents say.",
  );
  assert.equal(
    dressingDiffers(base, base, new Set(["stone"] as const), circularSurfaces),
    true,
    "A surface disappearing must re-dress too.",
  );
}

// Fire retuning must not rebuild geometry or recreate the flame batch.
const firstGlowLight = scene.scene.children.find((child) => child.type === "PointLight");
const firstPointLight = firstGlowLight as THREE.PointLight;
const firstGlowAnchor = composition.anchors.glows[0]!;
assert.equal(firstPointLight.castShadow, false);
assert.equal(firstPointLight.distance, DEFAULT_FIRE_CONFIG.glowDistance);
assert.equal(firstPointLight.shadow.camera.near, 0.01);
assert.equal(firstPointLight.shadow.camera.far, DEFAULT_FIRE_CONFIG.glowDistance);
assert.equal(firstPointLight.shadow.mapSize.width, 512);
assert.equal(firstPointLight.shadow.mapSize.height, 512);
assert.equal(firstPointLight.shadow.bias, -0.0002);
assert.equal(firstPointLight.shadow.normalBias, 0.02);
assert.ok(Math.abs(firstPointLight.position.x - firstGlowAnchor.x) < 1e-9);
assert.ok(Math.abs(
  firstPointLight.position.y
    - (
      firstGlowAnchor.y
      + DEFAULT_FIRE_CONFIG.baseHeight
      + DEFAULT_FIRE_CONFIG.height * DEFAULT_FIRE_CONFIG.scale * 0.35
      + DEFAULT_FIRE_CONFIG.glowVerticalDistance
    ),
) < 1e-9);
assert.ok(Math.abs(firstPointLight.position.z - firstGlowAnchor.z) < 1e-9);
const flameObject = scene.scene.getObjectByName("Fire bowl flames") as THREE.Mesh;
const flameGeometry = flameObject.geometry;
const structureGeometry = structureMesh.geometry;
sceneConfig.fire.speed = 5;
sceneConfig.fire.noiseScale = 6;
sceneConfig.fire.turbulence = 1.5;
sceneConfig.fire.intensity = 2;
sceneConfig.fire.glowIntensity = 1.2;
sceneConfig.fire.glowDistance = 4.5;
sceneConfig.fire.glowHorizontalDistance = 0.75;
sceneConfig.fire.glowVerticalDistance = 0.6;
sceneConfig.fire.glowCastShadow = true;
const tunedFireStats = scene.updateFireEffects(sceneConfig);
assert.equal(tunedFireStats.flames.count, 8);
assert.equal(scene.scene.getObjectByName("Fire bowl flames"), flameObject);
assert.equal(flameObject.geometry, flameGeometry);
assert.equal(structureMesh.geometry, structureGeometry);
assert.equal(
  scene.scene.children.find((child) => child.type === "PointLight"),
  firstGlowLight,
);
assert.equal(firstPointLight.intensity, 1.2);
assert.equal(firstPointLight.distance, 4.5);
assert.equal(firstPointLight.shadow.camera.far, 4.5);
assert.ok(Math.abs(
  firstPointLight.position.x
    - (firstGlowAnchor.x + (firstGlowAnchor.outwardX ?? 0) * 0.75),
) < 1e-9);
assert.ok(Math.abs(
  firstPointLight.position.y
    - (
      firstGlowAnchor.y
      + sceneConfig.fire.baseHeight
      + sceneConfig.fire.height * sceneConfig.fire.scale * 0.35
      + 0.6
    ),
) < 1e-9);
assert.ok(Math.abs(
  firstPointLight.position.z
    - (firstGlowAnchor.z + (firstGlowAnchor.outwardZ ?? 0) * 0.75),
) < 1e-9);
assert.equal(firstPointLight.castShadow, true);
sceneConfig.fire.glowCastShadow = false;
scene.updateFireEffects(sceneConfig);
assert.equal(
  scene.scene.children.find((child) => child.type === "PointLight"),
  firstGlowLight,
);
assert.equal(firstPointLight.castShadow, false);

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

const massFireStats = scene.rebuild(slottedMassConfig);
// Twelve rather than sixteen: the four summit terminal collisions each carry a
// single bowl on the merged pier instead of two a few centimetres apart.
assert.equal(massFireStats.flames.count, massBowlSlots.length);
assert.equal(
  massFireStats.glowLightCount,
  slottedMassGraph.connectors.length + massTerminalOverlaps,
);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  slottedMassGraph.connectors.length + massTerminalOverlaps,
);

const disabledFlameConfig = createDefaultStructureConfig();
disabledFlameConfig.fire.enabled = false;
const explicitlyDisabledFireStats = scene.updateFireEffects(disabledFlameConfig);
assert.equal(explicitlyDisabledFireStats.flames.count, 0);
assert.equal(explicitlyDisabledFireStats.glowLightCount, 0);
scene.dispose();

const limitedShadowConfig = createDefaultStructureConfig();
limitedShadowConfig.fire.glowCastShadow = true;
const limitedShadowScene = new MainScene(limitedShadowConfig, {
  fireGlowShadowsSupported: false,
});
assert.equal(limitedShadowScene.getStats().glowLightCount, 4);
assert.ok(
  limitedShadowScene.scene.children
    .filter((child) => child.type === "PointLight")
    .every((child) => !(child as THREE.PointLight).castShadow),
);
limitedShadowScene.dispose();

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

// The sun bake: a hierarchy that answers occlusion, a refinement that gives
// flat faces somewhere to record it, and the trace that fills it in.

const bvhQuad = TriangleBvh.build(Float32Array.from([
  -1, 1, -1, 1, 1, -1, 1, 1, 1,
  -1, 1, -1, 1, 1, 1, -1, 1, 1,
]));

assert.ok(
  bvhQuad.occludes(0, 0, 0, 0, 1, 0, 10),
  "A quad directly overhead must block a ray cast straight up.",
);
assert.ok(
  !bvhQuad.occludes(0, 0, 0, 0, -1, 0, 10),
  "A quad overhead must not block a ray cast straight down.",
);
assert.ok(
  !bvhQuad.occludes(5, 0, 5, 0, 1, 0, 10),
  "A ray rising outside the quad's footprint must pass.",
);
assert.ok(
  !bvhQuad.occludes(0, 0, 0, 0, 1, 0, 0.5),
  "An occluder past maxDistance must not register.",
);
assert.ok(
  !TriangleBvh.build(new Float32Array(0)).occludes(0, 0, 0, 0, 1, 0, 10),
  "An empty hierarchy must occlude nothing rather than throw.",
);

const coarseFloor = buildTestQuad(8);
const refined = subdivideLongEdges(coarseFloor.geometry, 0.75);

assert.ok(
  refined.addedVertices > 0 && refined.geometry !== coarseFloor.geometry,
  "An 8-unit quad must be refined at a 0.75 edge bound.",
);
assert.equal(
  longestEdgeOf(refined.geometry) <= 0.75 + 1e-6,
  true,
  "Every edge must satisfy the bound once refinement settles.",
);

for (const name of ["position", "normal", "uv", "vertexAo", "color", "surfaceMaterial"]) {
  assert.equal(
    refined.geometry.getAttribute(name)?.count,
    refined.geometry.getAttribute("position")?.count,
    `Attribute "${name}" must keep one entry per vertex through subdivision.`,
  );
}

for (const base of ["baseUvs", "vertexAoBase", "bakedShadowBase"]) {
  const values = refined.geometry.userData[base] as Float32Array;
  const expected = refined.geometry.getAttribute("position")!.count
    * (base === "baseUvs" ? 2 : 1);
  assert.equal(
    values.length,
    expected,
    `userData.${base} must be interpolated alongside the attributes.`,
  );
}

assert.equal(
  refined.geometry.groups.reduce((total, group) => total + group.count, 0),
  refined.geometry.getIndex()?.count,
  "Draw groups must still cover every index after regrouping.",
);

// A geometry already inside the bound is handed back untouched, so the dense
// stonework never pays for a copy it does not need.
const fineFloor = buildTestQuad(0.5);
assert.equal(
  subdivideLongEdges(fineFloor.geometry, 0.75).geometry,
  fineFloor.geometry,
  "A geometry already within the bound must be returned as-is.",
);

// A roof directly above the floor, with the sun straight overhead: the floor
// must come back dark and the roof lit.
const shelteredFloor = buildTestQuad(4);
// Wider than the floor on purpose: a ray leaving a floor corner that lies
// exactly on the roof's boundary edge is a genuine coin-flip for any
// ray-triangle test, and the assertion below is about occlusion, not about
// which way that coin lands.
const roof = buildTestQuad(6, 3);
const bakeReport = bakeSunVisibility(
  [{ geometry: shelteredFloor.geometry }, { geometry: roof.geometry }],
  { direction: new THREE.Vector3(0, 1, 0) },
  () => 0,
);

const floorVisibility = shelteredFloor.geometry.userData.sunVisibilityBase as Float32Array;
const roofVisibility = roof.geometry.userData.sunVisibilityBase as Float32Array;

assert.equal(
  floorVisibility.every((value) => value === 0),
  true,
  "A floor under a roof must bake fully occluded.",
);
assert.equal(
  roofVisibility.every((value) => value === 1),
  true,
  "The roof itself must bake fully lit.",
);
assert.equal(
  bakeReport.vertices,
  floorVisibility.length + roofVisibility.length,
  "The report must account for every vertex it wrote.",
);

// Facing away from the sun is darkness the normal already states, and the
// bake must say so without needing an occluder to prove it.
const litFloor = buildTestQuad(4);
bakeSunVisibility(
  [{ geometry: litFloor.geometry }],
  { direction: new THREE.Vector3(0, -1, 0) },
  () => 0,
);
assert.equal(
  (litFloor.geometry.userData.sunVisibilityBase as Float32Array).every((value) => value === 0),
  true,
  "An upward face lit from below must bake dark on orientation alone.",
);

coarseFloor.geometry.dispose();
refined.geometry.dispose();
fineFloor.geometry.dispose();
shelteredFloor.geometry.dispose();
roof.geometry.dispose();
litFloor.geometry.dispose();

// The settings the geometry code deliberately excludes.
//
// Worth asserting precisely because they are the fields no code round trip can
// catch: every other test here proves a value survives being encoded, and these
// are the ones that are *not* encoded, so their only witness is this.
const sessionStore = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (key: string) => sessionStore.get(key) ?? null,
    setItem: (key: string, value: string) => void sessionStore.set(key, value),
    removeItem: (key: string) => void sessionStore.delete(key),
  },
};

const sessionSource = createDefaultStructureConfig();
sessionSource.illumination.keyAzimuth = 31;
sessionSource.illumination.shadowMode = "dynamic";
sessionSource.illumination.keyColor = "#ff8800";
sessionSource.view.detailLevel = "coarse";
sessionSource.view.materialScale = 1.75;
// The two fields that live in the session but are scoped to a geometry rebuild,
// because only the builder can apply them. They are the reason the pane writes
// this on every change instead of on a scope predicate: `slotDebug` is scoped
// `layout` and `engravingResolution` is scoped `engraving`, so anything keyed on
// "is this a session scope" drops both while looking entirely correct.
sessionSource.view.slotDebug = true;
sessionSource.view.engravingResolution = "high";
sessionSource.materialPalettes.mass!.stone!.document = "lichen-stone";
sessionSource.materialPalettes.mass!.stone!.textureScale = 2.5;
writeSessionState(sessionSource);

const sessionTarget = createDefaultStructureConfig();
const restoredIllumination = sessionTarget.illumination;
const restoredView = sessionTarget.view;
const restoredPalette = sessionTarget.materialPalettes.mass!;
applySessionState(sessionTarget);

assert.equal(sessionTarget.illumination, restoredIllumination,
  "Restoring must keep the live objects the pane is bound to.");
assert.equal(sessionTarget.view, restoredView);
assert.equal(sessionTarget.materialPalettes.mass, restoredPalette);
assert.equal(sessionTarget.illumination.keyAzimuth, 31);
assert.equal(sessionTarget.illumination.shadowMode, "dynamic");
assert.equal(sessionTarget.illumination.keyColor, "#ff8800");
assert.equal(sessionTarget.view.detailLevel, "coarse");
assert.equal(sessionTarget.view.materialScale, 1.75);
assert.equal(sessionTarget.view.slotDebug, true);
assert.equal(sessionTarget.view.engravingResolution, "high");
assert.equal(sessionTarget.materialPalettes.mass!.stone!.document, "lichen-stone");
assert.equal(sessionTarget.materialPalettes.mass!.stone!.textureScale, 2.5);

// The two halves must partition the settings, not overlap: a field carried by
// both would be restored twice from two sources that can disagree, and which
// one won would depend on the order two calls happen to be made in.
const sessionOnlyGeometry = createDefaultStructureConfig();
const geometryBefore = encodeStructureHash(sessionOnlyGeometry);
applySessionState(sessionOnlyGeometry);
assert.equal(
  encodeStructureHash(sessionOnlyGeometry),
  geometryBefore,
  "Restoring session settings must not move a single field of the geometry code.",
);

// A stored blob outlives the schema that wrote it. Each of these is a shape the
// storage can genuinely hold after an edit to the config, and none of them may
// cost the sitting.
//
// The warnings these raise are the point of the exercise, so they are counted
// rather than printed — a rejection that stayed silent would be the actual bug,
// and letting nine expected ones through would bury a tenth that was not.
const realWarn = console.warn;
let sessionWarnings = 0;
console.warn = () => { sessionWarnings += 1; };

for (const [label, stored] of [
  ["unparseable", "{not json"],
  ["not an object", "[1, 2, 3]"],
  ["empty", "{}"],
  ["unknown keys only", '{"view":{"noSuchField":9}}'],
  ["out of range", '{"view":{"materialScale":9999}}'],
  ["wrong type", '{"illumination":{"keyIntensity":"bright"}}'],
  ["retired list value", '{"illumination":{"shadowMode":"strobe"}}'],
  ["unknown structure", '{"materialPalettes":{"ziggurat":{"stone":{}}}}'],
  ["retired document", '{"materialPalettes":{"mass":{"stone":{"document":"jade"}}}}'],
] as const) {
  sessionStore.set("checkpoint-gen.session", stored);
  const survivor = createDefaultStructureConfig();
  applySessionState(survivor);
  validateActiveStructureConfig(survivor);
  assert.equal(survivor.view.materialScale, 1,
    `Stored ${label} settings must leave the defaults intact.`);
  assert.equal(survivor.illumination.keyIntensity, 0.6);
  assert.equal(
    survivor.materialPalettes.mass!.stone!.document,
    DEFAULT_MASS_MATERIAL_PALETTE.stone.document,
  );
}

// A section that fails takes only itself down. Nothing else in the blob is
// implicated by one bad field, and the alternative — dropping the sitting —
// would mean a retired stone cost you your lighting.
sessionStore.set(
  "checkpoint-gen.session",
  '{"view":{"materialScale":9999},"illumination":{"keyAzimuth":44}}',
);
const partial = createDefaultStructureConfig();
applySessionState(partial);
console.warn = realWarn;
assert.equal(partial.view.materialScale, 1, "The bad section rolls back whole.");
assert.equal(partial.illumination.keyAzimuth, 44, "The good section still lands.");
assert.equal(
  sessionWarnings,
  6,
  "Every rejected section must say so, and only those: four invalid values and "
  + "one retired document in the loop, plus the partial blob's bad view. The "
  + "four shapes carrying nothing to reject — unreadable as an object, empty, "
  + "unknown keys, unknown structure — are dropped in silence, because none of "
  + "them describes a setting anyone chose.",
);

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
    {
      label: "pillar hall",
      create: () => createGeometryHashScenario("pillar_hall", "all"),
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
    mass.stairWidthRatio = 0.05;
    mass.stairParapetWidth = 0.25;
    mass.stairSteppedParapetCorniceProjection = 0;
    mass.stairParapetCorniceProjection = 0.1;
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
      const actualValue = actualSection.target[spec.key];
      const expectedValue = section.target[spec.key];

      // Every other control kind is written pre-aligned to its own step (the
      // codec throws rather than silently rounding), so round-trips exactly.
      // A bezier control has no such grid of its own — the codec's is a
      // quantization it never had before — so its round-trip is only accurate
      // to that grid's own step, not bit-exact.
      if (spec.kind === "bezier") {
        const actualBezier = actualValue as readonly number[];
        const expectedBezier = expectedValue as readonly number[];
        assert.equal(actualBezier.length, expectedBezier.length);

        for (let index = 0; index < expectedBezier.length; index += 1) {
          assert.ok(
            Math.abs((actualBezier[index] ?? 0) - (expectedBezier[index] ?? 0))
              <= 1 / 1024 + 1e-9,
            `${expected.typeId}.${section.label}.${spec.key}[${index}] did not round `
            + `trip within the bezier codec's step.`,
          );
        }

        continue;
      }

      assert.deepEqual(
        actualValue,
        expectedValue,
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

/**
 * Asserts one surface's vertices carry exactly the generated UVs at `expected`
 * density, which is what proves texture scale is applied per surface rather than
 * across the whole merged geometry.
 */
function assertSurfaceTextureScale(
  geometry: THREE.BufferGeometry,
  slot: MaterialSlot,
  expected: number,
): void {
  const baseUvs = geometry.userData.baseUvs as Float32Array;
  const uv = geometry.getAttribute("uv");
  const slots = geometry.getAttribute("surfaceMaterial");
  const target = materialSlotIndex(slot);
  let compared = 0;

  for (let index = 0; index < uv.count; index += 1) {
    if (slots.getX(index) !== target) {
      continue;
    }

    for (const [axis, value] of [[0, uv.getX(index)], [1, uv.getY(index)]] as const) {
      const base = baseUvs[index * 2 + axis] ?? 0;

      // A UV that is zero cannot show a scale, so it proves nothing either way.
      if (Math.abs(base) < 1e-6) {
        continue;
      }

      const wanted = base * expected;
      assert.ok(
        Math.abs(value - wanted) <= Math.abs(wanted) * 1e-5 + 1e-6,
        `${slot} uv[${index}].${axis === 0 ? "x" : "y"}=${value} is not `
        + `${base} at scale ${expected}.`,
      );
      compared += 1;
    }
  }

  assert.ok(compared > 0, `No ${slot} vertex carried a scalable UV.`);
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

/**
 * An upward-facing quad of the given span, centred on the origin at height `y`.
 *
 * Deliberately the coarsest thing the pipeline can emit — two triangles, four
 * vertices — because that is exactly the case the sun bake exists to handle.
 */
function buildTestQuad(span: number, y = 0) {
  const half = span / 2;

  return finalizeGeometry({
    positions: [
      -half, y, -half,
      half, y, -half,
      half, y, half,
      -half, y, half,
    ],
    indices: [0, 2, 1, 0, 3, 2],
    ambientOcclusion: [1, 1, 1, 1],
    bakedShadow: [1, 1, 1, 1],
  });
}

function longestEdgeOf(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();

  assert.ok(index, "Edge measurement needs an indexed geometry.");

  const first = new THREE.Vector3();
  const second = new THREE.Vector3();
  let longest = 0;

  for (let offset = 0; offset < index.count; offset += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      first.fromBufferAttribute(position, index.getX(offset + edge));
      second.fromBufferAttribute(position, index.getX(offset + (edge + 1) % 3));
      longest = Math.max(longest, first.distanceTo(second));
    }
  }

  return longest;
}
