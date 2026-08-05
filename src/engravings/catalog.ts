import {
  EMPTY_ENGRAVING_CATALOG,
  type EngravingCatalog,
  type EngravingLayer,
} from "./document";

/**
 * The loaded project's engravings, as a module-level fact.
 *
 * Which engravings exist is a property of the build's assets, in the same way
 * that which structures exist is a property of the registry. Threading it as a
 * parameter would put an asset argument on `validateActiveStructureConfig`, on
 * every control spec factory and on the sanity scripts, none of which load
 * assets or should have to know that something does.
 *
 * It starts empty and stays empty if the file is missing or unreadable, which
 * leaves every slot feature offering nothing but "None" — a visible state with
 * an explanation already in the console, rather than a crash at boot.
 */
let catalog: EngravingCatalog = EMPTY_ENGRAVING_CATALOG;

export function setEngravingCatalog(value: EngravingCatalog): void {
  catalog = value;
}

export function engravingCatalog(): EngravingCatalog {
  return catalog;
}

export function getEngravingLayer(id: string): EngravingLayer | undefined {
  return catalog.layers.get(id);
}
