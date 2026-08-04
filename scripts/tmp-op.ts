import {
  PILLAR_HALL_PRESETS, PILLAR_HALL_SLOT_FEATURE_IDS,
  clonePillarHallLayout, clonePillarHallSlots, resolvePillarHallGraph,
} from "../src/structure/families/pillar-hall/config";
import type { PillarHallArchetype } from "../src/structure/families/pillar-hall/types";

for (const archetype of ["linear_screen", "front_gallery", "open_pavilion"] as PillarHallArchetype[]) {
  const slots = clonePillarHallSlots(PILLAR_HALL_PRESETS[archetype].slots);
  for (const id of PILLAR_HALL_SLOT_FEATURE_IDS) slots[id] = { ...slots[id], enabled: true };
  const graph = resolvePillarHallGraph({ ...clonePillarHallLayout(PILLAR_HALL_PRESETS[archetype]), slots });
  const hall = graph.pillarHalls[0]!;
  const byPart = new Map<string, number>();
  for (const s of hall.slots) byPart.set(`${s.part}/${s.faceRole}`, (byPart.get(`${s.part}/${s.faceRole}`) ?? 0) + 1);
  console.log(archetype.padEnd(14), JSON.stringify(Object.fromEntries([...byPart].sort())));
  if (archetype === "open_pavilion") {
    for (const kind of ["lintel", "cornice"] as const) {
      for (const m of hall.members.filter((x) => x.kind === kind)) {
        const faces = hall.slots.filter((s) => s.patchId.startsWith(m.id + "/")).map((s) => s.face);
        console.log("   ", kind.padEnd(8), m.id.split("/").slice(-2).join("/").padEnd(22), faces.sort().join(",") || "(none)");
      }
    }
  }
}
