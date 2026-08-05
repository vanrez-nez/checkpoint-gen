import { controlsFor, validateControls, type ControlSpec } from "../config/control-spec";
import type { StructureDefinition } from "../structure/definition";
import { engravingCatalog } from "./catalog";
import { ENGRAVING_FITS, type EngravingFit } from "./decal-geometry";

/** The document choice that leaves a feature's slots as bare prepared stone. */
export const NO_ENGRAVING = "none";

export const ENGRAVING_FIT_OPTIONS: Readonly<Record<string, EngravingFit>> = {
  Contain: "contain",
  Stretch: "stretch",
};

/**
 * What one slot-bearing feature carries.
 *
 * Assignment is per feature rather than per resolved slot because a feature is
 * something the family authored and named, while a slot is something the
 * resolver produced: change the bay count and every slot id moves, but "band
 * wall" is still band wall. Every slot a feature resolves therefore takes the
 * same engraving, which is also how a run of bays reads as one scheme rather
 * than as a row of unrelated panels.
 */
export interface EngravingAssignment {
  /** A layer id from the loaded catalog, or `NO_ENGRAVING`. */
  document: string;
  fit: EngravingFit;
  /** Metres taken off every side of a slot before the engraving is fitted. */
  margin: number;
  normalStrength: number;
  aoIntensity: number;
}

/**
 * Filling is the default, and containing is the opt-in.
 *
 * The other way round looks more careful and is unusable. `contain` keeps a
 * motif's proportions by shrinking it to the slot's short axis, and most of
 * what the families publish is a running band — a cornice twenty metres long
 * and a hand's width tall, a plinth strip, a roof fascia, a ribbon round a
 * stela. Containing a square glyph in one of those centres a twelve-centimetre
 * speck: correct arithmetic, and indistinguishable from a feature that does
 * nothing. Even a single feature is not safe to decide for, since a mass's band
 * wall publishes both a two-metre panel and a summit-pad strip a third of a
 * metre tall.
 *
 * So the default is the one that is always visible, and `npm test` holds every
 * default assignment to covering at least a tenth of every slot its feature
 * resolves, on every family and every archetype. Motifs shaped for a band —
 * `ribbon-jaguar` is authored 32 by 128 — fill one without distortion, and
 * repeating a small motif along a long band is what the tiling system will be
 * for.
 */
export const DEFAULT_ENGRAVING_ASSIGNMENT: Readonly<EngravingAssignment> = {
  document: NO_ENGRAVING,
  fit: "stretch",
  margin: 0.02,
  normalStrength: 1,
  aoIntensity: 1,
};

/** One structure's assignments, keyed by slot feature id. */
export type StructureEngravings = Record<string, EngravingAssignment>;

const MIN_MARGIN = 0;
const MAX_MARGIN = 0.5;
const MARGIN_STEP = 0.005;
const MAX_NORMAL_STRENGTH = 3;
const MAX_AO_INTENSITY = 2;
const STRENGTH_STEP = 0.05;

const control = controlsFor<EngravingAssignment>();

/**
 * One feature's engraving controls.
 *
 * The group is the feature's own label, so these land in the folder that
 * already holds its border and insets rather than in a parallel tree the user
 * has to keep in step with it. A feature is one place.
 *
 * Two of the layer's own properties are deliberately absent. Moisture is
 * authored per engraving and belongs to the motif rather than to where the
 * motif was placed; the corner radius likewise. Both would be settings that
 * override the artist for no reason anyone could state.
 */
export function engravingControls(
  label: string,
): readonly ControlSpec<EngravingAssignment>[] {
  const engraved = (assignment: EngravingAssignment) =>
    assignment.document !== NO_ENGRAVING;

  return [
    control.list({
      key: "document",
      label: "engraving",
      name: `${label} engraving`,
      group: label,
      scopes: ["engraving"],
      options: engravingDocumentOptions(),
    }),
    control.list({
      key: "fit",
      label: "fit",
      name: `${label} engraving fit`,
      group: label,
      scopes: ["engraving"],
      options: ENGRAVING_FIT_OPTIONS,
      visibleWhen: engraved,
    }),
    control.number({
      key: "margin",
      label: "margin",
      name: `${label} engraving margin`,
      group: label,
      min: MIN_MARGIN,
      max: MAX_MARGIN,
      step: MARGIN_STEP,
      scopes: ["engraving"],
      visibleWhen: engraved,
    }),
    // Both strengths reach past one on purpose. A large motif resolves to only
    // a few texels per authored cell, and its relief needs lifting before it
    // reads at all against a coarse stone.
    control.number({
      key: "normalStrength",
      label: "relief",
      name: `${label} engraving relief`,
      group: label,
      min: 0,
      max: MAX_NORMAL_STRENGTH,
      step: STRENGTH_STEP,
      scopes: ["engraving"],
      visibleWhen: engraved,
    }),
    control.number({
      key: "aoIntensity",
      label: "cavity",
      name: `${label} engraving cavity`,
      group: label,
      min: 0,
      max: MAX_AO_INTENSITY,
      step: STRENGTH_STEP,
      scopes: ["engraving"],
      visibleWhen: engraved,
    }),
  ];
}

/**
 * The document list, with "None" first.
 *
 * Built per call rather than once, because the catalog is loaded from disk
 * after this module is evaluated and a table captured at import time would
 * always be empty. `None` has to be one of the values or the default fails
 * validation before a single engraving has been chosen.
 */
export function engravingDocumentOptions(): Readonly<Record<string, string>> {
  return { None: NO_ENGRAVING, ...engravingCatalog().options };
}

export function cloneStructureEngravings(
  definition: StructureDefinition,
  source?: Readonly<StructureEngravings>,
): StructureEngravings {
  const engravings: StructureEngravings = {};

  for (const feature of definition.slotFeatures ?? []) {
    engravings[feature.id] = {
      ...DEFAULT_ENGRAVING_ASSIGNMENT,
      ...source?.[feature.id],
    };
  }

  return engravings;
}

/**
 * Checks one structure's assignments.
 *
 * A document that is no longer in the catalog is a real possibility rather than
 * a hypothetical: the project file is a build asset that another program
 * rewrites, so a saved selection can outlive the layer it named. That has to be
 * a named rejection the pane can restore from, not a decal that silently fails
 * to appear.
 */
export function validateStructureEngravings(
  definition: StructureDefinition,
  engravings: StructureEngravings,
): void {
  for (const feature of definition.slotFeatures ?? []) {
    const assignment = engravings[feature.id];

    if (!assignment) {
      throw new Error(
        `Missing engraving assignment for "${feature.id}" `
        + `on structure "${definition.id}".`,
      );
    }

    validateControls(assignment, engravingControls(feature.label));
  }
}

export { ENGRAVING_FITS, type EngravingFit };
