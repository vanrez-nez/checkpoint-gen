# Checkpoint Gen

A low-poly procedural checkpoint generator for Three.js. It builds a seeded,
one-to-eight-way stone crossing with a three-tier circular center and merges the
result into one geometry. Entries use polar coordinates: the first points north
and the rest are distributed at equal angles around the checkpoint.

Every entrance is flanked by a pair of procedural masonry pillars at
the junction between the circular checkpoint and its approach. Pillars have a
stepped base, subdivided shaft, and a capital composed of a neck, cornice, and
cap. One shared pillar configuration controls the set, while an entry/side
seed produces stable variation for every individual post.

Each pillar can carry a procedural forged-iron fire bowl. The bowl is built as
an empty double-sided hemisphere with a rolled rim, upper and lower flat guard
rings, eight curved support straps, and four feet. Its parts are merged into the
pillar buffer geometry as a second material group, so each pillar remains one
mesh while stone and iron retain independent surfaces.

Use the in-browser controls to adjust its overall radius, entry layout, paving
density, and restrained stone variation.

Top-edge detail is generated per configuration as either hard edges or a
seeded planar chamfer. Chamfer width varies independently along each stone edge,
while depth and variation remain configurable. Only the top perimeter is
clipped; the vertical and bottom edges stay hard.

The pillar controls expose total height, shaft width, base-step count, vertical
shaft courses, and cross-section subdivisions. Their stone gap, size variation,
displacement, seed, and bevel controls are independent of the checkpoint. The
checkpoint and pillar meshes remain separate but share the active stone
material, lighting, view helpers, and camera framing.

The Fire Bowl tab controls whether bowls are generated, their overall scale,
and radial detail. It also reports the combined fire-bowl vertex and triangle
counts across all pillars.

The checkpoint surface is loaded from `public/materials/stone.json` through
`material-designer-runtime` and baked at 512px. The generated mesh uses hard
box-projected UVs so tops, bevels, and vertical sides sample the baked maps
without triplanar blending.

Fire bowls use a separate hammered-metal graph from
`public/materials/hammered-iron.json`. If either graph cannot load, that surface
falls back independently to a standard stone or dark forged-iron material.

Lighting combines a cool hemisphere fill with a cool directional sun. The sun
casts three faded WebGPU CSM cascades that track the active camera, while the
checkpoint geometry both casts and receives shadows.

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
