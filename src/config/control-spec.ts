/**
 * Declarative descriptions of the tunable fields on a config section.
 *
 * A spec table is the single source of truth for a field's range: the Tweakpane
 * binder reads `min`/`max`/`step` to build the slider, and `validateControls`
 * reads the same numbers to guard the generator. Before this existed the two
 * were hand-maintained lists that had already drifted apart in three places.
 */

/** What a control change invalidates. Maps to part sections in checkpoint-config. */
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
  /** Whether changing this control should re-frame the camera. */
  readonly reframe?: boolean;
}

export interface NumberControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /**
   * Enforced only when true. `step` is never enforced for non-integers, since
   * float steps do not survive binary representation.
   */
  readonly integer?: boolean;
}

export interface BooleanControlSpec<T> extends BaseControlSpec<T> {
  readonly kind: "boolean";
}

export type ControlSpec<T> = NumberControlSpec<T> | BooleanControlSpec<T>;

/**
 * Builds spec constructors bound to one config type, so tables read as
 * `control.number({ key: "radius", ... })` without repeating the type argument.
 */
export function controlsFor<T extends object>(): {
  number: (spec: Omit<NumberControlSpec<T>, "kind">) => NumberControlSpec<T>;
  boolean: (spec: Omit<BooleanControlSpec<T>, "kind">) => BooleanControlSpec<T>;
} {
  return {
    number: (spec) => ({ kind: "number", ...spec }),
    boolean: (spec) => ({ kind: "boolean", ...spec }),
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
