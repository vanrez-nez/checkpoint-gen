import type { Block, BlockFaces, SolidBuilder, Vertex3 } from "../../geometry/solid-builder";
import { rectIsValid, type Rect } from "../kernel/frame";
import type { ElevationBandRecord, StairConnectorRecord } from "../kernel/graph";
import { divideRunByCount, masonrySeed, type MasonryRule } from "../kernel/masonry";
import {
  stairArrivalCenter,
  stairBasis,
  stairLocalVertex,
  stairOutwardCoordinate,
  stairSteps,
  type StairStep,
} from "./stair";

/**
 * The stair, laid up out of blocks.
 *
 * A step is a slice: an upright box one tread deep, standing in front of the
 * slice behind it. The law is the mass shell's: **a face is drawn only where
 * the space just outside it is empty.** A slice knows exactly what covers it —
 * the slice in front presses on its front up to that slice's tread, the slice
 * behind covers its back, the mass swallows it below the profile crossing, the
 * parapets close its ends — so each slice is cut at those cover lines and
 * every face of every piece is either wholly visible or not emitted at all.
 * Emitting whole faces and letting the overlap hide inside neighbouring solid
 * was the earlier behaviour, and a third of the stair's faces were buried.
 *
 * A slice runs down to the ground only while it stands in front of the mass;
 * where the flight converges on the faces it climbs, it stops where the
 * profile swallows it — hidden stone is not laid.
 *
 * With masonry on, only the crown of a slice — the riser-and-tread strip you
 * can see — is divided into stones. The body below is a monolith: its joints
 * would sit inside sealed stone. One strip of it, the collar, keeps a front
 * face: it stands directly behind the previous crown's open joints and closes
 * the view through them, exactly as the mass's backing ring closes the view
 * through the perpends of the facing course.
 *
 * The stones stay square: a tread is a walking surface and the flight's raking
 * silhouette is the one line the whole composition hangs on, so the wander
 * that roughens a wall would only read as broken steps here.
 */

export interface StairBuildOptions {
  /** Stonework for the steps; null lays each step as one monolith. */
  readonly masonry: MasonryRule | null;
  readonly seed: number;
  /** Exact number of masonry tiles across every tread. */
  readonly tilesPerStep: number;
}

const EPS = 1e-9;
type StairParapet = NonNullable<StairConnectorRecord["parapet"]>;

/** Canonical plan domain used by every stair, independent of world facade. */
function localFlightRect(record: StairConnectorRecord): Rect {
  return {
    minX: -record.width * 0.5,
    maxX: record.width * 0.5,
    minZ: 0,
    maxZ: record.run,
  };
}

export function buildStair(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  /** The bands of the mass the stair climbs, for burial and back exposure. */
  bands: readonly ElevationBandRecord[],
  options: StairBuildOptions,
): void {
  const steps = stairSteps(record);
  const profile = facadeProfile(bands, record);
  const hasParapet = record.parapet !== null;
  const steppedParapet = record.sideTreatment === "stepped_parapet"
    ? record.parapet
    : null;

  for (const step of steps) {
    const bottomY = sliceBottom(profile, step, record);
    // Only the last slice backs onto the mass rather than onto another slice,
    // so only it can have exposed back faces — see backExposure.
    const back = step.index === record.stepCount - 1
      ? backExposure(profile, record)
      : null;

    layFlightSlice(builder, record, steps, step, bottomY, options, hasParapet, back);

    if (steppedParapet) {
      layParapetSlices(builder, record, steps, step, bottomY, steppedParapet, back);

      if (steppedParapet.cornice) {
        laySteppedCorniceSlice(builder, record, steps, step, steppedParapet);
      }
    }
  }

  if (steppedParapet?.cornice) {
    laySteppedParapetEndings(builder, record, steps, steppedParapet);
  }

  if (record.sideTreatment === "sloped_parapet" && record.parapet) {
    laySlopedParapets(builder, record, steps, profile);
  }
}

/**
 * One stretch of the addressed facade's silhouette, outermost surface included —
 * a cornice's segment carries its outline, not the wall it springs from.
 */
interface ProfileSegment {
  readonly y0: number;
  readonly v0: number;
  readonly y1: number;
  readonly v1: number;
}

function facadeProfile(
  bands: readonly ElevationBandRecord[],
  record: StairConnectorRecord,
): ProfileSegment[] {
  const segments: ProfileSegment[] = [];
  const arrival = stairArrivalCenter(record);
  const outward = stairBasis(record.direction).outward;
  const arrivalV = arrival.x * outward.x + arrival.z * outward.z;
  const localV = (rect: Rect): number => (
    stairOutwardCoordinate(rect, record.direction) - arrivalV
  );

  for (const band of bands) {
    const cornice = band.cornice && rectIsValid(band.cornice.springing)
      ? band.cornice
      : null;

    if (cornice) {
      segments.push(
        {
          y0: band.bottomY,
          v0: localV(band.lower),
          y1: cornice.bottomY,
          v1: localV(cornice.springing),
        },
        {
          y0: cornice.bottomY,
          v0: localV(cornice.outline),
          y1: band.topY,
          v1: localV(cornice.outline),
        },
      );
      continue;
    }

    segments.push({
      y0: band.bottomY,
      v0: localV(band.lower),
      y1: band.topY,
      v1: localV(band.upper),
    });
  }

  return segments;
}

/**
 * The first elevation, scanning up from the ground, at which the silhouette
 * pulls strictly inside local `v` — strictly, so a vertical wall lying exactly on
 * the plane never counts as crossed. Null when the profile never does.
 */
function profileCrossingUp(
  profile: readonly ProfileSegment[],
  v: number,
): number | null {
  for (const segment of profile) {
    if (segment.v0 < v - EPS) {
      return segment.y0;
    }

    if (segment.v1 < v - EPS) {
      const t = (segment.v0 - v) / (segment.v0 - segment.v1);
      return segment.y0 + t * (segment.y1 - segment.y0);
    }
  }

  return null;
}

/**
 * The first elevation at or above `fromY` where the silhouette reaches back
 * out to local `v`. Within a segment the profile only narrows, so a return can only
 * happen at a segment boundary — a terrace re-entry never occurs, but a
 * cornice jumping back out past the plane does, and it is what bounds the
 * exposed interval from above.
 */
function profileReturnY(
  profile: readonly ProfileSegment[],
  v: number,
  fromY: number,
  fallback: number,
): number {
  for (const segment of profile) {
    if (segment.y0 < fromY - EPS) {
      continue;
    }

    if (segment.v0 >= v - EPS) {
      return segment.y0;
    }
  }

  return fallback;
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
  const buried = profileCrossingUp(profile, step.vFront) ?? record.bottomY;

  return Math.min(
    Math.max(record.bottomY, buried),
    step.topY - record.riser,
  );
}

/**
 * The y-interval over which the last slice's back, at the flight's upper edge,
 * faces open air rather than solid mass.
 *
 * It exists only when a crown cornice set that edge to the molding's outer lip:
 * the wall beneath the lip recedes, leaving a laterally open niche between the
 * stair's back plane and the facade, and the backs facing it must be real. The
 * interval ends where the cornice itself returns to the plane — its own front
 * faces live there, and a stair back on top of them would be a coincident
 * pair. On vertical profiles the strict crossing never fires; on battered
 * profiles without a cornice the silhouette stays outside the plane all the
 * way down. Both give null, and no back is emitted below the summit.
 */
function backExposure(
  profile: readonly ProfileSegment[],
  record: StairConnectorRecord,
): { readonly lo: number; readonly hi: number } | null {
  const v = 0;
  const lo = profileCrossingUp(profile, v);

  if (lo === null) {
    return null;
  }

  const hi = Math.min(profileReturnY(profile, v, lo, record.topY), record.topY);

  return hi - lo > EPS ? { lo, hi } : null;
}

/** One y-span of a slice, with the faces that span presents. */
interface FaceSpec {
  readonly front?: boolean;
  readonly back?: boolean;
  /** The positive-u and negative-u side faces (joints and silhouettes). */
  readonly maxX?: boolean;
  readonly minX?: boolean;
  readonly top?: boolean;
}

/**
 * Lays one y-span of a slice, split further wherever the exposed-back interval
 * cuts through it so `back` can hold exactly there and nowhere else. Spans
 * with no height and pieces with no faces are not laid at all.
 */
function laySpan(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  x0: number,
  x1: number,
  step: StairStep,
  y0: number,
  y1: number,
  spec: FaceSpec,
  back: { readonly lo: number; readonly hi: number } | null,
): void {
  const cuts = [y0, y1];

  if (back) {
    if (back.lo > y0 + EPS && back.lo < y1 - EPS) {
      cuts.push(back.lo);
    }

    if (back.hi > y0 + EPS && back.hi < y1 - EPS) {
      cuts.push(back.hi);
    }
  }

  cuts.sort((a, b) => a - b);

  for (let piece = 0; piece < cuts.length - 1; piece += 1) {
    const from = cuts[piece]!;
    const to = cuts[piece + 1]!;

    if (to - from <= EPS) {
      continue;
    }

    const exposedBack = back !== null
      && from >= back.lo - EPS
      && to <= back.hi + EPS;
    const faces: BlockFaces = {
      sides: [
        spec.front === true,
        spec.maxX === true,
        (spec.back === true) || exposedBack,
        spec.minX === true,
      ],
      // Only the topmost piece of the span may show the span's top.
      top: spec.top === true && piece === cuts.length - 2,
      bottom: false,
    };

    if (!faces.sides.some(Boolean) && faces.top !== true) {
      continue;
    }

    builder.addBlock(
      slice(record, x0, x1, step.vBack, step.vFront, from, to),
      faces,
    );
  }
}

/**
 * One flight slice, cut at its cover lines.
 *
 * The crown — from the previous slice's tread to this one's — is all that
 * shows a front and a top, and all that is divided into stones. Below it, the
 * bare shaft shows only its stepped-silhouette ends; the masonry shaft
 * additionally keeps its collar strip fronted, because the previous crown's
 * joints open onto it.
 */
function layFlightSlice(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  steps: readonly StairStep[],
  step: StairStep,
  bottomY: number,
  options: StairBuildOptions,
  hasParapet: boolean,
  back: { readonly lo: number; readonly hi: number } | null,
): void {
  const flightRect = localFlightRect(record);
  const { masonry } = options;
  const coverTop = step.index > 0 ? steps[step.index - 1]!.topY : bottomY;
  const ends: FaceSpec = { maxX: !hasParapet, minX: !hasParapet };

  if (!masonry) {
    laySpan(
      builder,
      record,
      flightRect.minX,
      flightRect.maxX,
      step,
      bottomY,
      coverTop,
      ends,
      back,
    );
    laySpan(
      builder,
      record,
      flightRect.minX,
      flightRect.maxX,
      step,
      coverTop,
      step.topY,
      { ...ends, front: true, top: true },
      back,
    );
    return;
  }

  // The monolithic body: sealed below the reach of the previous crown's
  // joints, fronted where those joints open onto it.
  const collarBottom = Math.min(
    Math.max(step.index > 1 ? steps[step.index - 2]!.topY : bottomY, bottomY),
    coverTop,
  );
  laySpan(
    builder,
    record,
    flightRect.minX,
    flightRect.maxX,
    step,
    bottomY,
    collarBottom,
    ends,
    back,
  );
  laySpan(
    builder,
    record,
    flightRect.minX,
    flightRect.maxX,
    step,
    collarBottom,
    coverTop,
    { ...ends, front: true },
    back,
  );

  const widths = divideRunByCount(
    record.width,
    options.tilesPerStep,
    masonry.sizeVariation,
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

    laySpan(builder, record, from, to, step, coverTop, step.topY, {
      front: true,
      top: true,
      // Both cheeks of every internal joint are drawn, as on the mass: a
      // joint with one cheek reads as a slot into nothing. The extreme ends
      // face the parapets, or open air when the sides are untreated.
      maxX: last ? !hasParapet : true,
      minX: first ? !hasParapet : true,
    }, back);
  }
}

/**
 * The wall below one stepped-parapet cap: the stair slice carried up to the
 * underside of its optional cornice, cut at what covers each stretch.
 * From the ground up: pressed against the flight and the previous parapet
 * slice (outer silhouette only), then the balustrade's inner wall above the
 * tread, then the crown strip above the previous cap — the only part that
 * fronts and caps. When the parapet is shallower than a riser the middle
 * stretch flips: it is the exposed front strip of the silhouette instead of an
 * inner wall, and skipping it outright would hole the parapet on every step.
 * The stretch above the summit floor is the terminal, and its back faces the
 * summit.
 */
function layParapetSlices(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  steps: readonly StairStep[],
  step: StairStep,
  bottomY: number,
  parapet: StairParapet,
  back: { readonly lo: number; readonly hi: number } | null,
): void {
  const { topY } = record;
  const flightRect = localFlightRect(record);
  const isLast = step.index === record.stepCount - 1;
  const bodyHeight = parapet.height - (parapet.cornice?.height ?? 0);
  const capY = step.topY + bodyHeight;
  const previousCap = step.index > 0
    ? steps[step.index - 1]!.topY + bodyHeight
    : bottomY;
  const frontStartsAt = parapet.cornice && step.index > 0
    ? steps[step.index - 1]!.topY + parapet.height
    : capY;
  const lower = Math.min(previousCap, step.topY);
  const upper = Math.max(previousCap, step.topY);
  // The terminal above the summit always shows its back — it faces open air
  // over the floor. Below the summit the profile's exposed interval rules,
  // exactly as on the flight. Spans never straddle the summit plane, because
  // the tread of the last step *is* the summit, so it is always a span bound.
  const backFor = (spanBottom: number): { readonly lo: number; readonly hi: number } | null => {
    if (!isLast) {
      return null;
    }

    if (spanBottom >= topY - EPS) {
      return parapet.cornice ? null : { lo: spanBottom, hi: capY };
    }

    return back;
  };

  const sides: readonly (readonly [number, number, boolean])[] = [
    // Span, and whether the inner face — the one toward the flight — is the
    // span's positive-u face.
    [flightRect.minX - parapet.width, flightRect.minX, true],
    [flightRect.maxX, flightRect.maxX + parapet.width, false],
  ];

  for (const [x0, x1, innerIsMaxX] of sides) {
    const faces = (of: {
      readonly outer?: boolean;
      readonly inner?: boolean;
      readonly front?: boolean;
      readonly top?: boolean;
    }): FaceSpec => ({
      front: of.front,
      top: of.top,
      maxX: innerIsMaxX ? of.inner : of.outer,
      minX: innerIsMaxX ? of.outer : of.inner,
    });
    const layBodySpan = (
      y0: number,
      y1: number,
      of: {
        readonly outer?: boolean;
        readonly inner?: boolean;
        readonly front?: boolean;
        readonly top?: boolean;
      },
    ): void => {
      const wantsFront = of.front === true;

      if (!parapet.cornice || !wantsFront) {
        laySpan(
          builder,
          record,
          x0,
          x1,
          step,
          y0,
          y1,
          faces(of),
          backFor(y0),
        );
        return;
      }

      const split = Math.min(y1, Math.max(y0, frontStartsAt));
      laySpan(
        builder,
        record,
        x0,
        x1,
        step,
        y0,
        split,
        faces({ ...of, front: false, top: false }),
        backFor(y0),
      );
      laySpan(
        builder,
        record,
        x0,
        x1,
        step,
        split,
        y1,
        faces(of),
        backFor(split),
      );
    };

    laySpan(
      builder,
      record,
      x0,
      x1,
      step,
      bottomY,
      lower,
      faces({ outer: true }),
      backFor(bottomY),
    );
    layBodySpan(
      lower,
      upper,
      step.topY <= previousCap
        // The balustrade wall above the tread: inner and outer show, the front
        // is pressed against the previous, taller parapet slice.
        ? { outer: true, inner: true }
        // A parapet shallower than a riser: this stretch is the exposed front
        // strip of the silhouette, its inner side still pressed on the flight.
        : {
          outer: true,
          front: step.index > 0 || parapet.cornice === undefined,
        },
    );
    layBodySpan(
      upper,
      capY,
      {
        outer: true,
        inner: true,
        front: step.index > 0 || parapet.cornice === undefined,
        top: parapet.cornice === undefined,
      },
    );
  }
}

/**
 * One horizontal cornice cap over one parapet tread.
 *
 * The block replaces the top band of the wall. Its projected soffit is one
 * face and its top stays level. The visible cap remains one rectangular form;
 * its two overhangs and supported centre are separate ownership strips so no
 * soffit is buried in the wall. Where a cornice is taller than the riser, the
 * next cap hides its lower front portion; splitting only at that cover line
 * avoids a coincident face without changing the stepped silhouette.
 */
function laySteppedCorniceSlice(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  steps: readonly StairStep[],
  step: StairStep,
  parapet: StairParapet,
): void {
  const cornice = parapet.cornice;

  if (!cornice) {
    return;
  }

  const bodyTop = step.topY + parapet.height - cornice.height;
  const capY = step.topY + parapet.height;
  const previousCap = step.index > 0
    ? steps[step.index - 1]!.topY + parapet.height
    : capY;
  const frontFrom = Math.min(capY, Math.max(bodyTop, previousCap));
  const flightRect = localFlightRect(record);
  const sides: readonly (readonly [number, number])[] = [
    [
      flightRect.minX - parapet.width,
      flightRect.minX,
    ],
    [
      flightRect.maxX,
      flightRect.maxX + parapet.width,
    ],
  ];

  for (const [wallX0, wallX1] of sides) {
    // The two projected strips own their soffits and the exposed part of the
    // rear step. The supported centre owns neither. This is the smallest block
    // decomposition that closes the overhang without burying a full soffit in
    // the wall or overlapping the next slice.
    const strips: readonly (readonly [number, number, boolean])[] = [
      [wallX0 - cornice.projection, wallX0, true],
      [wallX0, wallX1, false],
      [wallX1, wallX1 + cornice.projection, true],
    ];
    const nextBodyTop = step.index < record.stepCount - 1
      ? steps[step.index + 1]!.topY + parapet.height - cornice.height
      : bodyTop;
    const backTo = Math.min(capY, Math.max(bodyTop, nextBodyTop));
    const cuts = [...new Set([bodyTop, frontFrom, backTo, capY])]
      .sort((a, b) => a - b);

    for (let strip = 0; strip < strips.length; strip += 1) {
      const [x0, x1, projected] = strips[strip]!;

      for (let piece = 0; piece < cuts.length - 1; piece += 1) {
        const y0 = cuts[piece]!;
        const y1 = cuts[piece + 1]!;

        if (y1 - y0 <= EPS) {
          continue;
        }

        builder.addBlock(
          slice(record, x0, x1, step.vBack, step.vFront, y0, y1),
          {
            // The foot and summit endings close the terminal faces. At an
            // internal transition, the front shows above the preceding cap
            // and only the overhang shows behind the supporting wall.
            sides: [
              step.index > 0 && y0 >= frontFrom - EPS,
              strip === strips.length - 1,
              projected
                && step.index < record.stepCount - 1
                && y1 <= backTo + EPS,
              strip === 0,
            ],
            top: piece === cuts.length - 2,
            bottom: projected && piece === 0,
          },
        );
      }
    }
  }
}

/**
 * Square horizontal blocks finish a stepped cornice at the foot and summit.
 * Each has a wall below it down to the ground or arrival floor, matching the
 * supported endings of the continuous parapet rather than cantilevering.
 */
function laySteppedParapetEndings(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  steps: readonly StairStep[],
  parapet: StairParapet,
): void {
  const cornice = parapet.cornice;
  const firstStep = steps[0];

  if (!cornice || !firstStep) {
    return;
  }

  const bodyHeight = parapet.height - cornice.height;
  const flightRect = localFlightRect(record);
  const sides: readonly (readonly [number, number])[] = [
    [flightRect.minX - parapet.width, flightRect.minX],
    [flightRect.maxX, flightRect.maxX + parapet.width],
  ];

  laySupportedCorniceEndings(builder, record, sides, cornice, {
    lowerBodyTop: firstStep.topY + bodyHeight,
    lowerCapY: firstStep.topY + parapet.height,
    upperBodyTop: record.topY + bodyHeight,
    upperCapY: record.topY + parapet.height,
  });
}

/**
 * Two ground-backed walls with one continuous raked crown.
 *
 * Unlike the stepped treatment, the wall is not repeated over every tread:
 * each side is one block whose outer and inner elevations rise directly from
 * the ground line to the parapet cap. The back face is omitted from that block
 * where the mass owns it, then restored only over the crown-cornice niche and
 * above the summit. An optional cornice is one more raked block per side. It
 * takes over the top band and projects across the wall. One square horizontal
 * block finishes it beyond the stair foot and another finishes it on the
 * summit. Each ending carries a wall block down to its supporting floor, so
 * neither cap cantilevers in open air or exposes a raw diagonal cut.
 */
function laySlopedParapets(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  steps: readonly StairStep[],
  profile: readonly ProfileSegment[],
): void {
  const { parapet } = record;
  const flightRect = localFlightRect(record);
  const lastStep = steps[steps.length - 1];

  if (!parapet || !lastStep) {
    return;
  }

  const cornice = parapet.cornice;
  const bodyTopOffset = parapet.height - (cornice?.height ?? 0);
  const back = backExposure(profile, record);
  const sides: readonly (readonly [number, number])[] = [
    [flightRect.minX - parapet.width, flightRect.minX],
    [flightRect.maxX, flightRect.maxX + parapet.width],
  ];

  for (const [x0, x1] of sides) {
    builder.addBlock(
      groundBackedRakedBlock(x0, x1, record, bodyTopOffset),
      {
        // A lower ending owns the front closure when the cornice is present.
        sides: [cornice === undefined, true, false, true],
        top: cornice === undefined,
        bottom: false,
      },
    );

    // A crown cornice can leave a laterally open niche below the arrival.
    if (back) {
      laySpan(
        builder,
        record,
        x0,
        x1,
        lastStep,
        back.lo,
        back.hi,
        { back: true },
        null,
      );
    }

    if (!cornice) {
      // Without a cornice there is no horizontal ending to close the wall, so
      // the terminal above the summit still owns its exposed back.
      laySpan(
        builder,
        record,
        x0,
        x1,
        lastStep,
        record.topY,
        record.topY + bodyTopOffset,
        { back: true },
        null,
      );
      continue;
    }

    const corniceX0 = x0 - cornice.projection;
    const corniceX1 = x1 + cornice.projection;
    builder.addBlock(
      rakedBandBlock(
        corniceX0,
        corniceX1,
        record,
        bodyTopOffset,
        parapet.height,
      ),
      {
        // The horizontal terminals own the front and back closures.
        sides: [false, true, false, true],
        top: true,
        // The projected portions read as a soffit. The supported middle has no
        // competing wall top because the cornice took that band over.
        bottom: true,
      },
    );
  }

  if (cornice) {
    laySupportedCorniceEndings(builder, record, sides, cornice, {
      lowerBodyTop: record.bottomY + bodyTopOffset,
      lowerCapY: record.bottomY + parapet.height,
      upperBodyTop: record.topY + bodyTopOffset,
      upperCapY: record.topY + parapet.height,
    });
  }
}

/**
 * The shared square foot and summit endings for either parapet profile.
 * The wall-width block bears on the floor; the projected cornice replaces its
 * top and owns the exposed soffit.
 */
function laySupportedCorniceEndings(
  builder: SolidBuilder,
  record: StairConnectorRecord,
  sides: readonly (readonly [number, number])[],
  cornice: { readonly projection: number },
  levels: {
    readonly lowerBodyTop: number;
    readonly lowerCapY: number;
    readonly upperBodyTop: number;
    readonly upperCapY: number;
  },
): void {
  const flightRect = localFlightRect(record);

  for (const [x0, x1] of sides) {
    const corniceX0 = x0 - cornice.projection;
    const corniceX1 = x1 + cornice.projection;
    const terminalLength = corniceX1 - corniceX0;

    builder.addBlock(
      horizontalBlock(
        record,
        x0,
        x1,
        flightRect.maxZ,
        flightRect.maxZ + terminalLength,
        record.bottomY,
        levels.lowerBodyTop,
      ),
      {
        // Its back is welded to the parapet wall. The cornice above owns the
        // top, and the ground owns the bottom.
        sides: [true, true, false, true],
        top: false,
        bottom: false,
      },
    );
    builder.addBlock(
      horizontalBlock(
        record,
        corniceX0,
        corniceX1,
        flightRect.maxZ,
        flightRect.maxZ + terminalLength,
        levels.lowerBodyTop,
        levels.lowerCapY,
      ),
      {
        // Its back is pressed against the parapet cornice.
        sides: [true, true, false, true],
        top: true,
        bottom: true,
      },
    );
    builder.addBlock(
      horizontalBlock(
        record,
        x0,
        x1,
        flightRect.minZ - terminalLength,
        flightRect.minZ,
        record.topY,
        levels.upperBodyTop,
      ),
      {
        // Its front is welded to the parapet wall. The summit floor owns
        // the bottom and the cornice owns the top.
        sides: [false, true, true, true],
        top: false,
        bottom: false,
      },
    );
    builder.addBlock(
      horizontalBlock(
        record,
        corniceX0,
        corniceX1,
        flightRect.minZ - terminalLength,
        flightRect.minZ,
        levels.upperBodyTop,
        levels.upperCapY,
      ),
      {
        // Its front is pressed against the parapet cornice.
        sides: [false, true, true, true],
        top: true,
        bottom: true,
      },
    );
  }
}

/** One wall side from a horizontal ground bed to a continuous raked top. */
function groundBackedRakedBlock(
  x0: number,
  x1: number,
  record: StairConnectorRecord,
  topOffset: number,
): Block {
  const { bottomY, topY } = record;
  const flightRect = localFlightRect(record);

  return {
    bottom: rakedRing(
      record,
      x0,
      x1,
      flightRect.minZ,
      flightRect.maxZ,
      bottomY,
      bottomY,
    ),
    top: rakedRing(
      record,
      x0,
      x1,
      flightRect.minZ,
      flightRect.maxZ,
      topY + topOffset,
      bottomY + topOffset,
    ),
  };
}

/** A constant-height band following the same raked line as the wall crown. */
function rakedBandBlock(
  x0: number,
  x1: number,
  record: StairConnectorRecord,
  bottomOffset: number,
  topOffset: number,
): Block {
  const { bottomY, topY } = record;
  const flightRect = localFlightRect(record);

  return {
    bottom: rakedRing(
      record,
      x0,
      x1,
      flightRect.minZ,
      flightRect.maxZ,
      topY + bottomOffset,
      bottomY + bottomOffset,
    ),
    top: rakedRing(
      record,
      x0,
      x1,
      flightRect.minZ,
      flightRect.maxZ,
      topY + topOffset,
      bottomY + topOffset,
    ),
  };
}

/** An axis-aligned terminal molding with a genuinely horizontal top and soffit. */
function horizontalBlock(
  record: StairConnectorRecord,
  x0: number,
  x1: number,
  vBack: number,
  vFront: number,
  bottomY: number,
  topY: number,
): Block {
  return {
    bottom: rakedRing(
      record,
      x0,
      x1,
      vBack,
      vFront,
      bottomY,
      bottomY,
    ),
    top: rakedRing(record, x0, x1, vBack, vFront, topY, topY),
  };
}

/**
 * Ring order matches an ordinary stair slice: front edge, positive-x side,
 * back edge, negative-x side. Rear and front may sit at different elevations,
 * which turns the ring into one plane following the flight.
 */
function rakedRing(
  record: StairConnectorRecord,
  x0: number,
  x1: number,
  vBack: number,
  vFront: number,
  backY: number,
  frontY: number,
): Vertex3[] {
  return [
    stairLocalVertex(record, x0, frontY, vFront),
    stairLocalVertex(record, x1, frontY, vFront),
    stairLocalVertex(record, x1, backY, vBack),
    stairLocalVertex(record, x0, backY, vBack),
  ];
}

/**
 * An upright box over a plan slice. The ring runs front edge first — from
 * negative-u to positive-u along the riser face — then round the back, so edge
 * indices mean front, positive-u side, back, negative-u side everywhere.
 */
function slice(
  record: StairConnectorRecord,
  x0: number,
  x1: number,
  vBack: number,
  vFront: number,
  bottomY: number,
  topY: number,
): Block {
  return {
    bottom: rakedRing(record, x0, x1, vBack, vFront, bottomY, bottomY),
    top: rakedRing(record, x0, x1, vBack, vFront, topY, topY),
  };
}
