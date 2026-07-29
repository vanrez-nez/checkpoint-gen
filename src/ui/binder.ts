import type { BindingApi, BladeApi, FolderApi, TabPageApi } from "@tweakpane/core";
import { CubicBezier, type CubicBezierApi } from "@tweakpane/plugin-essentials";
import type { BezierValue, ControlSpec, RebuildScope } from "../config/control-spec";

export type Dispatch = (scopes: readonly RebuildScope[]) => void;

export interface BoundControl<T> {
  readonly spec: ControlSpec<T>;
  /**
   * `BladeApi` rather than `BindingApi`, because not every control is a binding:
   * the cubic-bezier editor is a blade that owns its own value, so it is added
   * and written back by hand. Everything downstream only touches `hidden`, which
   * both share.
   */
  readonly binding: BladeApi;
  /**
   * Set when the control has to re-measure itself after being shown. See
   * `addBezierBlade`; most controls need nothing here.
   */
  readonly onShow?: () => void;
}

/**
 * Folders keyed by title, shared across calls so several spec tables can
 * contribute to one folder — the circular layout's "tier rise" belongs in the
 * same Stones folder as the shared masonry controls.
 */
export type FolderRegistry = Map<string, FolderApi>;

export function createFolderRegistry(): FolderRegistry {
  return new Map();
}

function resolveFolder(
  parent: TabPageApi | FolderApi,
  registry: FolderRegistry,
  title: string,
): FolderApi {
  const existing = registry.get(title);

  if (existing) {
    return existing;
  }

  const folder = parent.addFolder({ title });
  registry.set(title, folder);
  return folder;
}

/**
 * Binds a spec table into the pane, routing every change through `dispatch`
 * with the scopes the spec declares. This replaces the per-control change
 * closures the pane used to hand-write for all 60-odd bindings.
 */
export function bindControls<T extends object>(
  parent: TabPageApi | FolderApi,
  target: T,
  specs: readonly ControlSpec<T>[],
  dispatch: Dispatch,
  registry: FolderRegistry,
): BoundControl<T>[] {
  return specs.map((spec) => {
    const folder = resolveFolder(parent, registry, spec.group);
    const label = spec.label ?? spec.key;
    const notify = () => {
      spec.onChange?.(target);
      dispatch(spec.scopes ?? []);
    };

    if (spec.kind === "bezier") {
      return { spec, ...addBezierBlade(folder, target, spec.key, label, notify) };
    }

    const binding = folder.addBinding(
      target,
      spec.key,
      { label, ...bindingParams(spec) },
    ) as BindingApi;

    binding.on("change", notify);

    return { spec, binding };
  });
}

/**
 * The cubic-bezier editor as one curve rather than a pair of coordinate pads.
 *
 * It is a blade, not a binding, so it holds its own value and the current one is
 * written back into the config on every change. The editor confines each
 * handle's x to the curve's domain but leaves y free, so a curve that overshoots
 * or dips is reachable here — which is the caller's business to interpret, not
 * this function's to prevent.
 */
function addBezierBlade<T extends object>(
  folder: FolderApi,
  target: T,
  key: Extract<keyof T, string>,
  label: string,
  notify: () => void,
): { readonly binding: BladeApi; readonly onShow: () => void } {
  const initial = target[key] as unknown as BezierValue;
  const blade = folder.addBlade({
    view: "cubicbezier",
    label,
    value: [...initial],
    expanded: true,
    picker: "inline",
  }) as CubicBezierApi;

  let redrawing = false;

  blade.on("change", (event) => {
    if (redrawing) {
      return;
    }

    const { x1, y1, x2, y2 } = event.value;
    (target as Record<string, unknown>)[key] = [x1, y1, x2, y2] satisfies BezierValue;
    notify();
  });

  return {
    binding: blade,
    /**
     * Catches the editor up with the config, which may have moved on while it
     * was hidden — a curve preset selected from a sibling control writes the
     * handles it stands for, and revealing the editor should show that curve
     * rather than whatever was last dragged.
     *
     * It also has to redraw unconditionally. The graph plots itself from its
     * element's size, once, when it first lands in the DOM, so a control that
     * starts hidden measures zero and draws an empty box it never revisits.
     * Redrawing is only reachable through a value change, so the value is pushed
     * off and back; the guard above keeps that round trip from reading as an
     * edit.
     */
    onShow(): void {
      const [x1, y1, x2, y2] = target[key] as unknown as BezierValue;
      redrawing = true;
      blade.value = new CubicBezier(x1, y1, x2, y2 + 1);
      blade.value = new CubicBezier(x1, y1, x2, y2);
      redrawing = false;
    },
  };
}

/** The pane parameters a binding spec's kind implies, beyond its label. */
function bindingParams<T>(
  spec: Exclude<ControlSpec<T>, { kind: "bezier" }>,
): Record<string, unknown> {
  switch (spec.kind) {
    case "number":
      return { min: spec.min, max: spec.max, step: spec.step };
    case "list":
      return { options: spec.options };
    case "boolean":
      return {};
  }
}

/** Finds a bound control by key, for attaching a visibility rule to it. */
export function findControl<T>(
  controls: readonly BoundControl<T>[],
  key: Extract<keyof T, string>,
): BladeApi {
  const found = controls.find((control) => control.spec.key === key);

  if (!found) {
    throw new Error(`No bound control for "${key}".`);
  }

  return found.binding;
}
