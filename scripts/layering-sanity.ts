/**
 * The dependency direction, asserted rather than intended.
 *
 * The project is meant to layer `ui/ → config/ → structure/ → geometry/`, with
 * no arrow pointing back up. It did not: `structure/definition.ts` imported
 * `controlsFor` as a runtime value, every family's config called
 * `validateControls` from inside its resolver — on the geometry build path —
 * and `structure/composer.ts` imported `config/structure-config.ts`, which
 * imports `structure/registry.ts` straight back down. None of that was visible
 * from any one file, which is exactly why it accumulated.
 *
 * So the layering is a test now. It runs first in `npm test` because it takes
 * about a fifth of a second and the suite it precedes takes ninety.
 *
 * ## Why type edges count
 *
 * An `import type` is erased, so it costs a bundler nothing — and this still
 * calls it a violation. If `StoneConfig` may be type-imported from
 * `config/sections.ts`, then it stays in `config/sections.ts` forever and the
 * UI layer goes on defining the shapes the generator takes as input. The point
 * of the boundary is which module *owns* a concept, not which bytes ship.
 *
 * The one place the distinction is real is the geometry-leaf check, below.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly typeOnly: boolean;
}

/**
 * Every `from "…"` in a module, with each edge marked erased or real.
 *
 * Classified by the *statement* prefix, not by whether every binding carries a
 * `type` marker. Under `verbatimModuleSyntax` — which this project has on —
 * `import { type A } from "x"` still emits `import {} from "x"`, so it is a
 * genuine runtime edge. Reading it as erased would make this whole file lie in
 * the one direction that matters.
 */
function edgesOf(file: string): Edge[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const pattern = /(^|\n)\s*(import|export)(\s+type)?\b[^;'"]*?from\s*["']([^"']+)["']/g;
  const edges: Edge[] = [];

  for (const match of source.matchAll(pattern)) {
    const typeOnly = match[3] !== undefined;
    const target = resolveSpecifier(file, match[4]!);

    if (target) {
      edges.push({ from: file, to: target, typeOnly });
    }
  }

  return edges;
}

/**
 * A relative specifier as a repo-relative path, or null for a package.
 *
 * `allowImportingTsExtensions` is on, so some specifiers already carry `.ts`
 * and some do not; a directory import resolves to its `index.ts`.
 */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const base = resolve(ROOT, dirname(from), specifier);

  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(ROOT, candidate);
    }
  }

  throw new Error(`${from} imports "${specifier}", which resolves to nothing.`);
}

interface Survey {
  /** Every edge that leaves the allowed region, as `from → to`. */
  readonly edges: Set<string>;
  /** How each in-region module was first reached, for explaining a failure. */
  readonly routes: Map<string, readonly Edge[]>;
}

/**
 * Walks the allowed region and records every edge that leaves it.
 *
 * Two things this deliberately does not do. It does not expand *through* an
 * offending module: that module is the violation, and what it imports in turn
 * is its own layer's business — recursing would report one bad edge as the
 * dozen modules sitting behind it. And it does not dedupe crossings by their
 * target: three different files importing `config/sections.ts` are three edges
 * to delete, not one, so the frontier is keyed on the edge rather than on where
 * it lands.
 */
function survey(
  entries: readonly string[],
  allowed: readonly string[],
  options: { readonly runtimeOnly?: boolean } = {},
): Survey {
  const inRegion = (file: string): boolean =>
    allowed.some((prefix) => file.startsWith(prefix));
  const routes = new Map<string, readonly Edge[]>();
  const edges = new Set<string>();
  const queue: string[] = [];

  for (const entry of entries) {
    if (!routes.has(entry)) {
      routes.set(entry, []);
      queue.push(entry);
    }
  }

  while (queue.length > 0) {
    const file = queue.shift()!;
    const route = routes.get(file)!;

    for (const edge of edgesOf(file)) {
      if (!inRegion(edge.to)) {
        if (options.runtimeOnly !== true || !edge.typeOnly) {
          edges.add(`${edge.from} → ${edge.to}`);
          routes.set(edge.to, [...route, edge]);
        }

        continue;
      }

      if (!routes.has(edge.to)) {
        routes.set(edge.to, [...route, edge]);
        queue.push(edge.to);
      }
    }
  }

  return { edges, routes };
}

/** Prints the shortest route to each offender, so a failure is actionable. */
function explain(
  routes: Map<string, readonly Edge[]>,
  allowed: readonly string[],
): string {
  const lines: string[] = [];

  for (const [file, route] of routes) {
    if (allowed.some((prefix) => file.startsWith(prefix)) || route.length === 0) {
      continue;
    }

    const hops = route
      .map((edge) => `${edge.to}${edge.typeOnly ? " [type]" : ""}`)
      .join("\n       → ");
    lines.push(`  ${route[0]!.from}\n       → ${hops}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1. The generation layer
// ---------------------------------------------------------------------------

/**
 * Where geometry generation begins.
 *
 * `mass/tessellate.ts` is here on its own account, not only through the
 * families: it is the shared tessellator that three of the four use, and it
 * imports two of them back (`buildPillarHall`, `buildStela`), so it can reach
 * further than its position in the tree suggests.
 */
const GENERATION_ENTRIES = [
  "src/structure/registry.ts",
  "src/structure/composer.ts",
  "src/structure/families/mass/index.ts",
  "src/structure/families/stelae/index.ts",
  "src/structure/families/pillar-hall/index.ts",
  "src/structure/families/circular/index.ts",
  "src/structure/mass/tessellate.ts",
];

/**
 * `props/` is allowed, and the walk is transitive, so this cannot be gamed by
 * routing through a prop: `props/fire-bowl/config.ts → config/control-spec` is
 * still reported, because `config/control-spec.ts` is what fails the prefix.
 */
const GENERATION_ALLOWED = [
  "src/geometry/",
  "src/structure/",
  "src/props/",
];

/**
 * The upward edges that exist today.
 *
 * Asserted for **set equality**, not as a suppression list. A new violation
 * fails, and so does one that has been fixed but left here — so the way to
 * finish a step of the decoupling is to delete lines from this list and watch
 * the suite agree.
 */
const KNOWN_VIOLATIONS: readonly string[] = [
  "src/props/fire-bowl/config.ts → src/config/control-spec.ts",
  "src/props/pillar/config.ts → src/config/control-spec.ts",
  "src/props/pillar/config.ts → src/config/sections.ts",
  "src/structure/composer.ts → src/config/structure-config.ts",
  "src/structure/definition.ts → src/config/control-spec.ts",
  "src/structure/definition.ts → src/config/material-palette.ts",
  "src/structure/definition.ts → src/config/sections.ts",
  "src/structure/families/circular/config.ts → src/config/control-spec.ts",
  "src/structure/families/circular/config.ts → src/config/sections.ts",
  "src/structure/families/circular/index.ts → src/config/material-palette.ts",
  "src/structure/families/circular/index.ts → src/config/sections.ts",
  "src/structure/families/mass/config.ts → src/config/control-spec.ts",
  "src/structure/families/mass/config.ts → src/config/material-palette.ts",
  "src/structure/families/mass/config.ts → src/config/sections.ts",
  "src/structure/families/mass/index.ts → src/config/material-palette.ts",
  "src/structure/families/pillar-hall/config.ts → src/config/control-spec.ts",
  "src/structure/families/pillar-hall/config.ts → src/config/material-palette.ts",
  "src/structure/families/pillar-hall/config.ts → src/config/sections.ts",
  "src/structure/families/pillar-hall/index.ts → src/config/material-palette.ts",
  "src/structure/families/stelae/config.ts → src/config/control-spec.ts",
  "src/structure/families/stelae/config.ts → src/config/material-palette.ts",
  "src/structure/families/stelae/index.ts → src/config/material-palette.ts",
];

const generation = survey(GENERATION_ENTRIES, GENERATION_ALLOWED);
const found = [...generation.edges].sort();
const known = [...KNOWN_VIOLATIONS].sort();

const appeared = found.filter((edge) => !known.includes(edge));
const fixed = known.filter((edge) => !found.includes(edge));

assert.deepEqual(
  appeared,
  [],
  `Generation must not reach config/ or ui/. New upward edges:\n${appeared.join("\n")}`
  + `\n\nRoutes:\n${explain(generation.routes, GENERATION_ALLOWED)}`,
);

assert.deepEqual(
  fixed,
  [],
  "These upward edges are gone — delete them from KNOWN_VIOLATIONS:\n"
  + fixed.join("\n"),
);

// ---------------------------------------------------------------------------
// 2. Geometry is a leaf
// ---------------------------------------------------------------------------

/**
 * Runtime only, and this is the one place that distinction earns its keep.
 *
 * `geometry/part.ts` type-imports `DetailLevel` from the structure kernel, and
 * that is deliberate: a part records the level it was generated at, so the name
 * of that level belongs to whoever defines the ladder. Nothing is emitted, and
 * the geometry layer stays independently loadable.
 */
const geometryFiles = readdirSync(join(ROOT, "src/geometry"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `src/geometry/${name}`);

const geometryLeaf = survey(geometryFiles, ["src/geometry/"], { runtimeOnly: true });

assert.deepEqual(
  [...geometryLeaf.edges].sort(),
  [],
  "geometry/ must not import the rest of the app at runtime:\n"
  + explain(geometryLeaf.routes, ["src/geometry/"]),
);

console.log(
  `Layering sanity passed: ${generation.routes.size} modules reachable from generation, `
  + `${known.length} known upward edges remaining.`,
);
