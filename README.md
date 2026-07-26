# Checkpoint Gen

A low-poly procedural checkpoint generator for Three.js. A checkpoint *type*
composes reusable props into a single merged geometry. The circular type builds a
seeded, one-to-eight-way stone crossing with a three-tier center; its entries use
polar coordinates, the first pointing north and the rest distributed at equal
angles.

## Checkpoint types

Types are registered in `src/checkpoint/registry.ts` and selected from the `type`
dropdown at the top of the control pane. A definition
(`src/checkpoint/type.ts`) declares its id and label, which shared props it uses,
its layout defaults, a declarative control table, and a `build()` that emits
parts plus anchors.

Adding a type means a new folder under `src/checkpoint/types/` plus one line each
in `CHECKPOINT_TYPES`, `CheckpointLayouts`, and `createDefaultCheckpointConfig`.
Its layout folders, dropdown entry, validators, and control gating all fall out
of the definition — no edits to the composer, the scene, or the pane.

## Composition

`CheckpointComposer` merges every part — the shell, all pillars, and all fire
bowls — into **one indexed geometry** with two coalesced material groups
(0 stone, 1 iron), rendered as a single mesh. Parts are authored in local space
and placed by a matrix, so no part geometry is ever mutated or cloned, and each
prop keeps the per-part seeding that makes its masonry deterministic.

Parts are cached per section (`layout`, `pillars`, `fireBowls`), so a control
change regenerates only what it actually invalidated rather than the whole
composition. The animated flames, the glow lights, and the loaded offering model
stay separate objects, positioned from **anchors** the generator returns
alongside the geometry.

Every entrance is flanked by a pair of procedural masonry pillars at
the junction between the circular checkpoint and its approach. Pillars have a
stepped base, subdivided shaft, and a capital composed of a neck, cornice, and
cap. One shared pillar configuration controls the set, while an entry/side
seed produces stable variation for every individual post.

Each pillar can carry a procedural forged-iron fire bowl. The bowl is built as
an empty double-sided hemisphere with a rolled rim, upper and lower flat guard
rings, eight curved support straps, and four feet. It is a sibling part of the
pillar rather than part of it: `buildPillarParts` sizes it from the shaft width
and mounts it at the pillar top via a matrix, and the composer assigns it to the
iron material group.

Every enabled bowl contains an animated vertex-displaced cone flame ported from
the sibling `cheap-fire` experiment. All flames share one instanced mesh,
geometry, and TSL material, so the complete set renders in one draw call. The
two scrolling FBM samples run only in the vertex stage; interpolated heat drives
the fragment color ramp without per-pixel noise. One unshadowed flickering point
light per entrance provides a localized glow for its pair of bowls.

Use the in-browser controls to adjust its overall radius, entry layout, paving
density, and restrained stone variation.

Top-edge detail is generated per configuration as either hard edges or a
seeded planar chamfer. Chamfer width varies independently along each stone edge,
while depth and variation remain configurable. Only the top perimeter is
clipped; the vertical and bottom edges stay hard.

The pillar controls expose total height, shaft width, base-step count, vertical
shaft courses, and cross-section subdivisions. Their stone gap, size variation,
displacement, seed, and bevel controls are independent of the checkpoint shell,
though both live in the same merged geometry and share the active stone
material, lighting, view helpers, and camera framing.

## Controls

Every tunable field is described once by a `ControlSpec`
(`src/config/control-spec.ts`), and both the Tweakpane binding and the generator
validator read that one table — a slider and its guard can no longer drift apart.

Controls are context dependent. The pane is built once and toggles `hidden`, so
a control appears only when the active type declares the prop it belongs to and
its enabling flag is set: bevel dimensions follow `bevel.enabled`, the whole
Flame and Glow groups follow the fire bowl, and offering placement follows
`offering.enabled`. A folder whose contents are all hidden hides itself. Tab
pages are never gated directly — Tweakpane rebinds a page's hidden state from
its own selection — so a tab a type does not use shows an explanatory line.

The Fire Bowl tab controls whether bowls are generated, their overall scale,
and radial detail. Separate Flame controls set visibility, overall scale,
radius, height, base height, radial detail, animation speed, noise scale,
turbulence, and intensity; these values do not inherit the bowl scale. Glow
controls independently expose visibility, intensity, distance, and flicker. The
tab also reports the combined fire-bowl vertex and triangle counts across all
pillars, the instanced flame workload and draw count, and the number of
entry-paired glow lights.

The checkpoint surface is loaded from `public/materials/stone.json` through
`material-designer-runtime` and baked at 512px. The generated mesh uses hard
box-projected UVs so tops, bevels, and vertical sides sample the baked maps
without triplanar blending.

Fire bowls use a separate hammered-metal graph from
`public/materials/hammered-iron.json`. If either graph cannot load, that surface
falls back independently to a standard stone or dark forged-iron material.

Lighting combines a cool hemisphere fill with a cool directional sun. The sun
casts three faded WebGPU CSM cascades that track the active camera, while the
checkpoint geometry both casts and receives shadows. AO strength and crack
shadow are re-derived from `userData` base arrays on the merged geometry, so
they retune without regenerating anything.

## Local Dev Proxy

Run the Vite dev server through a stable localhost hostname:

```sh
npm run dev:proxy
```

This runs `scripts/devsite.sh`, which:

- derives a hostname from the project folder, for example `checkpoint-gen.localhost`
- assigns a stable port from the project path
- writes a Caddy route under `~/.local/share/devsite/routes/`
- starts or reloads Caddy
- runs Vite on `127.0.0.1:<stable-port>` with `--strictPort`

Open the printed URL, usually:

```txt
http://checkpoint-gen.localhost
```

To override the hostname slug:

```sh
npm run dev:proxy -- my-name
```

Caddy must be installed and available on `PATH`.

## Validation

Run the deterministic geometry checks and production build with:

```sh
npm test
npm run build
```
