import type { BladeApi, FolderApi } from "@tweakpane/core";
import type { StructureConfig } from "../config/structure-config";

export type VisibilityPredicate = (config: StructureConfig) => boolean;

type BladeRule = {
  blade: BladeApi;
  visible: VisibilityPredicate;
  /** Run when the blade goes from hidden to shown. */
  onShow?: () => void;
};

type FolderRule = {
  folder: FolderApi;
  children: BladeApi[];
};

/**
 * Drives conditional control visibility from enable flags and dependent
 * fields, so the pane only shows controls that currently have an effect.
 *
 * A registry owns one rendered structure tab bar. The pane replaces that bar
 * when the structure type changes, while controls within it are toggled through
 * `hidden` and retain their live config targets.
 *
 * Note this never targets tab *pages*: Tweakpane rebinds a page's hidden state
 * from its own `selected` flag on every tab click, so a value set here would be
 * silently overwritten.
 */
export class VisibilityRegistry {
  private readonly bladeRules: BladeRule[] = [];
  private readonly folderRules: FolderRule[] = [];

  /**
   * Shows `blade` only when `visible` holds.
   *
   * `onShow` runs on each hidden-to-shown transition, for a control that has to
   * re-measure itself: a view that sizes from its element while `display: none`
   * measures zero, and most of them never look again.
   */
  addBlade(
    blade: BladeApi,
    visible: VisibilityPredicate,
    onShow?: () => void,
  ): void {
    this.bladeRules.push(onShow ? { blade, visible, onShow } : { blade, visible });
  }

  addBlades(blades: readonly BladeApi[], visible: VisibilityPredicate): void {
    for (const blade of blades) {
      this.addBlade(blade, visible);
    }
  }

  /**
   * Hides `folder` automatically once every one of `children` is hidden, so a
   * folder whose contents are all inapplicable does not linger as an empty
   * header.
   */
  addFolder(folder: FolderApi, children: readonly BladeApi[]): void {
    this.folderRules.push({ folder, children: [...children] });
  }

  apply(config: StructureConfig): void {
    for (const rule of this.bladeRules) {
      const wasHidden = rule.blade.hidden;
      rule.blade.hidden = !rule.visible(config);

      if (wasHidden && !rule.blade.hidden) {
        rule.onShow?.();
      }
    }

    // After the blade pass, so folder visibility reads settled child state.
    for (const rule of this.folderRules) {
      rule.folder.hidden = rule.children.every((child) => child.hidden);
    }
  }
}
