import type { BindingApi, FolderApi, TabPageApi } from "@tweakpane/core";
import type { ControlSpec, RebuildScope } from "../config/control-spec";

export type Dispatch = (
  scopes: readonly RebuildScope[],
  reframe: boolean,
) => void;

export interface BoundControl<T> {
  readonly spec: ControlSpec<T>;
  readonly binding: BindingApi;
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
    const params = spec.kind === "number"
      ? {
        label: spec.label ?? spec.key,
        min: spec.min,
        max: spec.max,
        step: spec.step,
      }
      : { label: spec.label ?? spec.key };
    const binding = folder.addBinding(target, spec.key, params) as BindingApi;

    binding.on("change", () => {
      dispatch(spec.scopes ?? [], spec.reframe === true);
    });

    return { spec, binding };
  });
}

/** Finds a bound control by key, for attaching a visibility rule to it. */
export function findControl<T>(
  controls: readonly BoundControl<T>[],
  key: Extract<keyof T, string>,
): BindingApi {
  const found = controls.find((control) => control.spec.key === key);

  if (!found) {
    throw new Error(`No bound control for "${key}".`);
  }

  return found.binding;
}
