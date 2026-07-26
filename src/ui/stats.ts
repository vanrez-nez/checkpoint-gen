/**
 * Plain mirror objects for the readonly stat bindings. Tweakpane monitors an
 * object property, so stats are written into these and surfaced by a single
 * `pane.refresh()`.
 */
export interface StatMirrors {
  shell: { stones: number; vertices: number; triangles: number };
  pillars: { parts: number; stones: number; vertices: number; triangles: number };
  bowls: { parts: number; vertices: number; triangles: number };
  flames: {
    count: number;
    vertices: number;
    triangles: number;
    draws: number;
    glowLights: number;
  };
  offering: { meshes: number; vertices: number; triangles: number };
  totals: { parts: number; stones: number; vertices: number; triangles: number };
}

export interface StatRow {
  readonly target: object;
  readonly key: string;
  readonly label: string;
}

export function createStatMirrors(): StatMirrors {
  return {
    shell: { stones: 0, vertices: 0, triangles: 0 },
    pillars: { parts: 0, stones: 0, vertices: 0, triangles: 0 },
    bowls: { parts: 0, vertices: 0, triangles: 0 },
    flames: { count: 0, vertices: 0, triangles: 0, draws: 0, glowLights: 0 },
    offering: { meshes: 0, vertices: 0, triangles: 0 },
    totals: { parts: 0, stones: 0, vertices: 0, triangles: 0 },
  };
}

export function statRow(target: object, key: string, label: string): StatRow {
  return { target, key, label };
}
