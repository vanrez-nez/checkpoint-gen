import type { Block, SolidBuilder, Vertex3 } from "../../geometry/solid-builder";
import { rectIsValid } from "../kernel/frame";
import type { ElevationBandRecord, StairConnectorRecord } from "../kernel/graph";
import { divideRun, masonrySeed, type MasonryRule } from "../kernel/masonry";
import { stairSteps, type StairStep } from "./stair";

/**
 * The stair, laid up out of blocks.
 *
 * A step is a slice: an upright box one tread deep, standing in front of the
 * slice behind it. Stacking slices rather than resting slabs on each other is
 * what keeps every face decidable — a slice's back is always pressed against
 * the next slice and never emitted, its front is emitted whole and the part
 * below the neighbouring tread is buried inside that neighbour, and the sides
 * tile the stepped silhouette without ever overlapping. The flight needs no
 * core and no special caps: like the mass, it is blocks and nothing else.
 *
 * A slice runs down to the ground only while it stands in front of the mass.
 * Where the flight converges on the faces it climbs, each slice stops one
 * riser below the point the profile swallows it — hidden stone is not laid,
 * exactly as in the mass's culled interior, and a stair sunk to bedrock
 * through the body of the pyramid would fill that body with buried faces for
 * the coincidence detectors to trip over.
 *
 * With masonry on, each slice is divided along its width into stones with open
 * joints between them, so a tread reads as set stone and the joints of the
 * riser below it belong to the same stones. The stones stay square: a tread is
 * a walking surface and the flight's raking silhouette is the one line the
 * whole composition hangs on, so the wander that roughens a wall would only
 * read as broken steps here.
 */

export interface StairBuildOptions {
  /** Stonework for the steps; null lays each step as one monolith. */
  readonly masonry: MasonryRule | null;
  readonly seed: number;
}

export function buildStair(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  /** The bands of the mass the stair climbs, for the burial profile. */
  bands: readonly ElevationBandRecord[],
  options: StairBuildOptions,
): void {
  const steps = stairSteps(record);
  const profile = frontProfile(bands);
  const hasParapet = record.parapet !== null;

  for (const step of steps) {
    const bottomY = sliceBottom(profile, step, record);
    layStepSlice(builder, record, step, bottomY, options, hasParapet);

    if (record.parapet) {
      layParapetSlices(builder, record, step, bottomY, record.parapet);
    }
  }
}

/**
 * One stretch of the mass's front silhouette, outermost surface included —
 * a cornice's segment carries its outline, not the wall it springs from.
 */
interface ProfileSegment {
  readonly y0: number;
  readonly z0: number;
  readonly y1: number;
  readonly z1: number;
}

function frontProfile(bands: readonly ElevationBandRecord[]): ProfileSegment[] {
  const segments: ProfileSegment[] = [];

  for (const band of bands) {
    const cornice = band.cornice && rectIsValid(band.cornice.springing)
      ? band.cornice
      : null;

    if (cornice) {
      segments.push(
        {
          y0: band.bottomY,
          z0: band.lower.maxZ,
          y1: cornice.bottomY,
          z1: cornice.springing.maxZ,
        },
        {
          y0: cornice.bottomY,
          z0: cornice.outline.maxZ,
          y1: band.topY,
          z1: cornice.outline.maxZ,
        },
      );
      continue;
    }

    segments.push({
      y0: band.bottomY,
      z0: band.lower.maxZ,
      y1: band.topY,
      z1: band.upper.maxZ,
    });
  }

  return segments;
}

/**
 * Where a slice's body stops: the first elevation at which the mass's
 * silhouette pulls inside the slice's front plane. Below that, the mass itself
 * fills the slice's footprint. The *first* crossing from the ground up,
 * because a cornice bulging back past the plane higher up does not refill the
 * recess beneath it — a slice descending past a molding runs down its recess
 * and bears on whatever the profile presents below. On a vertical profile the
 * crossings are the terrace levels themselves, and the flight bears on each
 * terrace it passes.
 *
 * A coursed face wanders a joint's width around this ideal line. Where it
 * stands proud, the slice's foot is buried a little deeper; where it is inset,
 * the sliver of void left behind the riser's foot is sealed on every side —
 * mass stones behind, the next slice down in front — so nothing can see it.
 */
function sliceBottom(
  profile: readonly ProfileSegment[],
  step: StairStep,
  record: StairConnectorRecord,
): number {
  let buried = record.bottomY;

  for (const segment of profile) {
    if (segment.z0 < step.zFront - 1e-9) {
      buried = segment.y0;
      break;
    }

    if (segment.z1 < step.zFront - 1e-9) {
      const t = (segment.z0 - step.zFront) / (segment.z0 - segment.z1);
      buried = segment.y0 + t * (segment.y1 - segment.y0);
      break;
    }
  }

  return Math.min(
    Math.max(record.bottomY, buried),
    step.topY - record.riser,
  );
}

/** One step: a monolith, or a run of stones divided along the flight's width. */
function layStepSlice(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  step: StairStep,
  bottomY: number,
  options: StairBuildOptions,
  hasParapet: boolean,
): void {
  const { flightRect } = record;
  const { masonry } = options;

  if (!masonry) {
    builder.addBlock(
      slice(flightRect.minX, flightRect.maxX, step.zBack, step.zFront, bottomY, step.topY),
      {
        // Edges run front, max-x side, back, min-x side. The back is pressed
        // against the next slice up; the sides are pressed against the
        // parapets when there are any.
        sides: [true, !hasParapet, false, !hasParapet],
        top: true,
        bottom: false,
      },
    );
    return;
  }

  const widths = divideRun(
    record.width,
    masonry,
    masonrySeed(options.seed, record.id, `step_${step.index}`),
  );
  const joint = masonry.gap * 0.5;
  let cursor = flightRect.minX;

  for (let stone = 0; stone < widths.length; stone += 1) {
    const width = widths[stone] ?? 0;
    const first = stone === 0;
    const last = stone === widths.length - 1;
    // Joints only between stones: the outer ends stay flush with the flight's
    // declared edges, so the silhouette — and the extents the graph promises —
    // are exact rather than a joint short.
    const from = cursor + (first ? 0 : joint);
    const to = cursor + width - (last ? 0 : joint);
    cursor += width;

    if (to <= from) {
      continue;
    }

    builder.addBlock(
      slice(from, to, step.zBack, step.zFront, bottomY, step.topY),
      {
        // Both cheeks of every internal joint are drawn, as on the mass: a
        // joint with one cheek reads as a slot into nothing. The extreme ends
        // face the parapets, or open air when the sides are untreated.
        sides: [
          true,
          last ? !hasParapet : true,
          false,
          first ? !hasParapet : true,
        ],
        top: true,
        bottom: false,
      },
    );
  }
}

/**
 * The side treatment over one step: a stepped parapet is the same slice again,
 * carried one parapet-height above the tread. Only the topmost slice has a face
 * on the summit plane, and only the part of it above the summit floor is open
 * to anything — so that slice alone is laid as two blocks, the lower buried
 * against the mass and the upper presenting its back to the summit.
 */
function layParapetSlices(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  step: StairStep,
  bottomY: number,
  parapet: { readonly width: number; readonly height: number },
): void {
  const { flightRect, topY } = record;
  const spans: readonly (readonly [number, number])[] = [
    [flightRect.minX - parapet.width, flightRect.minX],
    [flightRect.maxX, flightRect.maxX + parapet.width],
  ];
  const capY = step.topY + parapet.height;
  const isLast = step.index === record.stepCount - 1;

  for (const [x0, x1] of spans) {
    if (!isLast) {
      builder.addBlock(
        slice(x0, x1, step.zBack, step.zFront, bottomY, capY),
        { sides: [true, true, false, true], top: true, bottom: false },
      );
      continue;
    }

    builder.addBlock(
      slice(x0, x1, step.zBack, step.zFront, bottomY, topY),
      // Capped by the block above, back buried in the mass behind the summit
      // edge — on a vertical wall that back would be coplanar with the crown
      // facade, which is exactly why it is never emitted.
      { sides: [true, true, false, true], top: false, bottom: false },
    );
    builder.addBlock(
      slice(x0, x1, step.zBack, step.zFront, topY, capY),
      // The stretch above the summit floor: its back is the face the parapet
      // terminal presents to the summit, and nothing stands behind it.
      { sides: [true, true, true, true], top: true, bottom: false },
    );
  }
}

/**
 * An upright box over a plan slice. The ring runs front edge first — from
 * min-x to max-x along the riser face — then round the back, so edge indices
 * mean front, max-x side, back, min-x side wherever a slice is laid.
 */
function slice(
  x0: number,
  x1: number,
  zBack: number,
  zFront: number,
  bottomY: number,
  topY: number,
): Block {
  const ring = [
    { x: x0, z: zFront },
    { x: x1, z: zFront },
    { x: x1, z: zBack },
    { x: x0, z: zBack },
  ];

  return {
    bottom: ring.map((point) => at(point, bottomY)),
    top: ring.map((point) => at(point, topY)),
  };
}

function at(point: { readonly x: number; readonly z: number }, y: number): Vertex3 {
  return { x: point.x, y, z: point.z };
}
