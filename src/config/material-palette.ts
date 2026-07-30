import type { StructureSurfaceSlot } from "../geometry/part";
import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "./control-spec";

export const MATERIAL_DOCUMENT_IDS = [
  "stone",
  "volcanic-stone",
  "cobblestone-setts",
  "dark-volcanic-stone",
  "eroded-rock",
  "flamed-basalt",
  "lichen-stone",
] as const;

export type MaterialDocumentId = (typeof MATERIAL_DOCUMENT_IDS)[number];
export type StructureMaterialPalette = Record<
  StructureSurfaceSlot,
  MaterialDocumentId
>;

export const MATERIAL_DOCUMENT_OPTIONS: Readonly<
  Record<string, MaterialDocumentId>
> = {
  Stone: "stone",
  "Volcanic stone": "volcanic-stone",
  "Cobblestone setts": "cobblestone-setts",
  "Dark volcanic stone": "dark-volcanic-stone",
  "Eroded rock": "eroded-rock",
  "Flamed basalt": "flamed-basalt",
  "Lichen stone": "lichen-stone",
};

export const DEFAULT_STRUCTURE_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  stone: "stone",
  trim: "stone",
  stairs: "stone",
  summit: "stone",
  interior: "stone",
  roof: "stone",
};

export const DEFAULT_MASS_MATERIAL_PALETTE: Readonly<
  StructureMaterialPalette
> = {
  stone: "dark-volcanic-stone",
  trim: "flamed-basalt",
  stairs: "cobblestone-setts",
  summit: "eroded-rock",
  interior: "volcanic-stone",
  roof: "lichen-stone",
};

const control = controlsFor<StructureMaterialPalette>();

export const MATERIAL_PALETTE_CONTROLS: readonly ControlSpec<
  StructureMaterialPalette
>[] = [
  control.list({
    key: "stone",
    label: "masonry",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
  control.list({
    key: "trim",
    label: "trim",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
  control.list({
    key: "stairs",
    label: "stairs",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
  control.list({
    key: "summit",
    label: "summit walls",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
  control.list({
    key: "interior",
    label: "interior floors",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
  control.list({
    key: "roof",
    label: "roof",
    group: "Surfaces",
    scopes: ["material"],
    options: MATERIAL_DOCUMENT_OPTIONS,
  }),
];

export function cloneMaterialPalette(
  source: Readonly<StructureMaterialPalette> =
    DEFAULT_STRUCTURE_MATERIAL_PALETTE,
): StructureMaterialPalette {
  return { ...source };
}

export function validateMaterialPalette(
  palette: StructureMaterialPalette,
): void {
  validateControls(palette, MATERIAL_PALETTE_CONTROLS);
}

export function materialDocumentUrl(id: MaterialDocumentId): string {
  return `${import.meta.env.BASE_URL}materials/${id}.json`;
}
