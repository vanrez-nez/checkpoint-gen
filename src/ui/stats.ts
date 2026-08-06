/**
 * Plain mirror objects for the readonly stat bindings. Tweakpane monitors an
 * object property, so stats are written into these and surfaced by a single
 * `pane.refresh()`.
 */
export interface StatMirrors {
  /**
   * The active structure at the top of the pane.
   *
   * `stones` is read from its first declared section — sections are declared in
   * merge order and a structure's shell comes first, so this reports the
   * circular checkpoint's paving and the mass structure's massing without
   * either being named here.
   *
   * `vertices` and `triangles` are the resident mesh instead, because there is
   * no per-section answer to give: the sun bake subdivides the merged geometry,
   * so every section count is a pre-subdivision one and none of them can move
   * when the shadow detail does. The Composition folder still totals what the
   * composer produced, which is what the section rows above it sum to.
   */
  structure: {
    stones: number;
    vertices: number;
    triangles: number;
    generationMs: number;
    sunBakeMs: number;
    /** Which detail level the resident geometry came from. */
    detail: string;
  };
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
  /**
   * The structural validator's verdict on the last build, in one line. Errors
   * and repairs are reported while tuning rather than only in the test suite,
   * because a repaired build is one whose result differs from what was asked
   * for, and that is exactly what you need to see while asking for it.
   */
  validation: { status: string };
}

export interface StatRow {
  readonly target: object;
  readonly key: string;
  readonly label: string;
}

export function createStatMirrors(): StatMirrors {
  return {
    structure: {
      stones: 0,
      vertices: 0,
      triangles: 0,
      generationMs: 0,
      sunBakeMs: 0,
      detail: "full",
    },
    pillars: { parts: 0, stones: 0, vertices: 0, triangles: 0 },
    bowls: { parts: 0, vertices: 0, triangles: 0 },
    flames: { count: 0, vertices: 0, triangles: 0, draws: 0, glowLights: 0 },
    offering: { meshes: 0, vertices: 0, triangles: 0 },
    totals: { parts: 0, stones: 0, vertices: 0, triangles: 0 },
    validation: { status: "ok" },
  };
}

/**
 * One line for the whole diagnostic list: the worst severity present, how many
 * there are, and the first message, since that is almost always the one that
 * explains the rest.
 */
export function summarizeDiagnostics(
  diagnostics: readonly {
    readonly severity: "error" | "warning" | "notice";
    readonly message: string;
    readonly resolved?: string;
  }[],
): string {
  if (diagnostics.length === 0) {
    return "ok";
  }

  for (const severity of ["error", "warning", "notice"] as const) {
    const matching = diagnostics.filter((entry) => entry.severity === severity);
    const first = matching[0];

    if (!first) {
      continue;
    }

    const count = matching.length > 1 ? ` (${matching.length})` : "";
    const resolution = first.resolved === undefined ? "" : ` → ${first.resolved}`;
    return `${severity}${count}: ${first.message}${resolution}`;
  }

  return "ok";
}

export function statRow(target: object, key: string, label: string): StatRow {
  return { target, key, label };
}
