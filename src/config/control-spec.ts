/**
 * Declarative descriptions of the tunable fields on a config section.
 *
 * A spec table is the single source of truth for a field's range: the Tweakpane
 * binder reads `min`/`max`/`step` to build the slider, and `validateControls`
 * reads the same numbers to guard the generator. Before this existed the two
 * were hand-maintained lists that had already drifted apart in three places.
 */

/** What a control change invalidates. Maps to part sections in structure-config. */
export type RebuildScope =
  | "layout"
  | "pillars"
  | "bowls"
  | "fire"
  | "offering"
  | "material"
  | "illumination"
  | "view";

interface BaseControlSpec<T> {
  readonly key: Extract<keyof T, string>;
  /** Text shown in the pane. Defaults to the key. */
  readonly label?: string;
  /** Subject of validation errors, e.g. "Entry count". Defaults to label ?? key. */
  readonly name?: string;
  /** Folder title this control belongs to. */
  readonly group: string;
  readonly scopes?: readonly RebuildScope[];
  /**
   * Hides the control when this returns false, for a field that only means
   * something under some other field's setting — the bezier handles matter only
   * while the height curve is custom. Evaluated against the config section the
   * spec table binds to, so a table stays self-describing rather than needing the
   * pane to know which of its controls gate which others.
   */
  readonly visibleWhen?: (target: T) => boolean;
  /**
   * Reconciles fields this control derives, run after it changes and before the
   * rebuild. Selecting a named curve preset writes that preset's handles into
   * the curve field, so the config always states the curve actually in use and
   * switching to Custom starts from the preset you were on rather than from
   * wherever the editor was last left.
   */
  readonly onChange?: (target: T) => void;
}

export interface NumberControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /**
   * Optional Tweakpane-only increment. The stored/encoded value still uses
   * `step`; this is for a semantic subset such as positive odd bay counts,
   * where changing the codec grid would break existing geometry codes.
   */
  readonly inputStep?: number;
  /**
   * Enforced only when true. `step` is never enforced for non-integers, since
   * float steps do not survive binary representation.
   */
  readonly integer?: boolean;
}

export interface BooleanControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "boolean";
}

/**
 * A closed set of named string values — wall profile, base treatment, summit
 * treatment. `options` maps the label shown in the dropdown to the stored value,
 * matching Tweakpane's own option shape, and is the same table `validateControls`
 * checks against, so an option can never be selectable but invalid.
 */
export interface ListControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "list";
  readonly options: Readonly<Record<string, string>>;
}

/**
 * A cubic Bezier, shown as one curve editor with both handles draggable on the
 * curve itself. Bound to a `[x1, y1, x2, y2]` field, the same order and meaning
 * as CSS `cubic-bezier`, with the endpoints pinned at (0, 0) and (1, 1).
 */
export interface BezierControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "bezier";
}

export type ControlSpec<T> =
  | NumberControlSpec<T>
  | BooleanControlSpec<T>
  | ListControlSpec<T>
  | BezierControlSpec<T>;

/** The shape a `bezier` control binds to: `[x1, y1, x2, y2]`. */
export type BezierValue = [number, number, number, number];

export function isBezierValue(value: unknown): value is BezierValue {
  return Array.isArray(value)
    && value.length === 4
    && value.every((component) => typeof component === "number");
}

/**
 * Builds spec constructors bound to one config type, so tables read as
 * `control.number({ key: "radius", ... })` without repeating the type argument.
 */
export function controlsFor<T extends object>(): {
  number: (spec: Omit<NumberControlSpec<T>, "kind">) => NumberControlSpec<T>;
  boolean: (spec: Omit<BooleanControlSpec<T>, "kind">) => BooleanControlSpec<T>;
  list: (spec: Omit<ListControlSpec<T>, "kind">) => ListControlSpec<T>;
  bezier: (spec: Omit<BezierControlSpec<T>, "kind">) => BezierControlSpec<T>;
} {
  return {
    number: (spec) => ({ kind: "number", ...spec }),
    boolean: (spec) => ({ kind: "boolean", ...spec }),
    list: (spec) => ({ kind: "list", ...spec }),
    bezier: (spec) => ({ kind: "bezier", ...spec }),
  };
}

export function controlName<T>(spec: ControlSpec<T>): string {
  return spec.name ?? spec.label ?? spec.key;
}

/**
 * Validates a config section against its spec table, reproducing the message
 * shapes the hand-written validators used so existing error assertions hold.
 */
export function validateControls<T extends object>(
  target: T,
  specs: readonly ControlSpec<T>[],
): void {
  for (const spec of specs) {
    const value = target[spec.key];
    const name = controlName(spec);

    if (spec.kind === "boolean") {
      if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be a boolean.`);
      }

      continue;
    }

    if (spec.kind === "list") {
      const allowed = Object.values(spec.options);

      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new RangeError(
          `${name} must be one of ${allowed.join(", ")}.`,
        );
      }

      continue;
    }

    if (spec.kind === "bezier") {
      if (!isBezierValue(value) || !value.every(Number.isFinite)) {
        throw new TypeError(`${name} must be four finite numbers.`);
      }

      // The handles' horizontal positions are confined to the curve's own
      // domain, matching the control. Their vertical positions are deliberately
      // not: overshoot is a legitimate shape, and what it means is the caller's
      // to decide.
      for (const [index, component] of [[0, value[0]], [2, value[2]]] as const) {
        if (component < 0 || component > 1) {
          throw new RangeError(
            `${name} handle ${index / 2 + 1} x must be between 0 and 1.`,
          );
        }
      }

      continue;
    }

    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || value < spec.min
      || value > spec.max
      || (spec.integer === true && !Number.isInteger(value))
      || (spec.integer === true && spec.step > 1 && value % spec.step !== 0)
    ) {
      throw new RangeError(rangeMessage(spec, name));
    }
  }
}

function rangeMessage<T>(spec: NumberControlSpec<T>, name: string): string {
  if (spec.integer !== true) {
    return `${name} must be between ${spec.min} and ${spec.max}.`;
  }

  return spec.step > 1
    ? `${name} must be a multiple of ${spec.step} from ${spec.min} to ${spec.max}.`
    : `${name} must be an integer from ${spec.min} to ${spec.max}.`;
}

/** Throws unless `value` is a finite number greater than zero. */
export function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be greater than zero.`);
  }
}
