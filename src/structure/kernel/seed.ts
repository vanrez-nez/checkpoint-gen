import { hashSeed } from "../../geometry/random";

/**
 * Hierarchical seeds.
 *
 * Every subsystem draws from its own stream so that regenerating one does not
 * disturb the others: retuning weathering must not silently reshuffle the room
 * plan underneath it. Each subsystem seed is derived from the root by name, and
 * any of them can be pinned independently through `overrides`.
 *
 * This is also the mechanism the anti-regression check leans on — a build with a
 * different `condition` seed must produce a byte-identical massing graph, and
 * that check passes before the condition system exists and keeps passing after.
 */
export const SEED_SUBSYSTEMS = [
  "massing",
  "plan",
  "facade",
  "construction",
  "material",
  "condition",
] as const;

export type SeedSubsystem = (typeof SEED_SUBSYSTEMS)[number];

export interface SeedSet {
  readonly root: number;
  /** Pinned subsystem seeds. Anything absent is derived from `root` by name. */
  readonly overrides: Readonly<Partial<Record<SeedSubsystem, number>>>;
}

export function createSeedSet(
  root: number,
  overrides: Readonly<Partial<Record<SeedSubsystem, number>>> = {},
): SeedSet {
  return { root, overrides };
}

export function subsystemSeed(seeds: SeedSet, subsystem: SeedSubsystem): number {
  return seeds.overrides[subsystem] ?? hashSeed(seeds.root, subsystem);
}

/**
 * A seed for one addressable thing inside a subsystem, named by its path. The
 * path is normally the entity's own id, so a band's variation is stable against
 * anything else in the structure changing.
 */
export function deriveSeed(
  seeds: SeedSet,
  subsystem: SeedSubsystem,
  ...path: readonly string[]
): number {
  return path.reduce(
    (seed, segment) => hashSeed(seed, segment),
    subsystemSeed(seeds, subsystem),
  );
}

/** Every resolved subsystem seed, for serialization and for the pane readout. */
export function resolvedSeeds(seeds: SeedSet): Record<SeedSubsystem, number> {
  const resolved = {} as Record<SeedSubsystem, number>;

  for (const subsystem of SEED_SUBSYSTEMS) {
    resolved[subsystem] = subsystemSeed(seeds, subsystem);
  }

  return resolved;
}
