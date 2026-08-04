import { PILLAR_HALL_PRESETS, clonePillarHallLayout, resolvePillarHallGraph } from "../src/structure/families/pillar-hall/config";
const graph = resolvePillarHallGraph(clonePillarHallLayout(PILLAR_HALL_PRESETS.open_pavilion));
const hall = graph.pillarHalls[0]!;
const get = (id: string) => hall.members.find((m) => m.id.endsWith(id))!;
for (const kind of ["lintel", "cornice"]) {
  const rear = get(`row_rear/${kind}`);
  const right = get(`row_right/${kind}`);
  console.log(kind.padEnd(8),
    `rear  Z [${rear.rect.minZ.toFixed(3)}, ${rear.rect.maxZ.toFixed(3)}]  X [${rear.rect.minX.toFixed(3)}, ${rear.rect.maxX.toFixed(3)}]`);
  console.log("        ",
    `right Z [${right.rect.minZ.toFixed(3)}, ${right.rect.maxZ.toFixed(3)}]  X [${right.rect.minX.toFixed(3)}, ${right.rect.maxX.toFixed(3)}]`);
  console.log("         gap between right's -Z end and rear's +Z face:",
    (right.rect.minZ - rear.rect.maxZ).toFixed(3), "m");
}
