# Checkpoint Gen

A low-poly procedural structure generator for Three.js. A *structure* composes
reusable props and generators into a single merged geometry. Two are registered:
the **circular** checkpoint, a seeded one-to-eight-way stone crossing with a
three-tier center whose entries use polar coordinates; and **mass**, which
resolves a footprint and an elevation profile into semantic patches and draws
them as plain solids.

## Structures

Structures are registered in `src/structure/registry.ts` and selected from the
`type` dropdown at the top of the control pane. A definition
(`src/structure/definition.ts`) declares its id and label, which shared props it
uses, which part sections it emits, its layout defaults, a declarative control
table, and a `build()` that emits parts plus anchors.

Adding one means a new folder under `src/structure/families/` plus one line in
`STRUCTURES`. Its layout folders, dropdown entry, validators, control gating and
per-section rebuild granularity all fall out of the definition — no edits to the
composer, the scene, or the pane.

Section names are per-structure rather than a fixed union: the circular
checkpoint's `layout` / `pillars` / `fireBowls` and mass's single `mass` section
have nothing in common, and neither has to know the other exists. Where a
structure's own controls need a scope to mean something different from the
shared prop table, it declares `sectionsByScope`.

## The structure kernel

`src/structure/kernel/` holds the semantic layer that the mass system — and
every system after it — resolves into. A **patch** is a bounded surface with a
local `u`/`v`/`d` domain, an architectural role, named edges, regions, and the
neighbours it shares boundaries with. Patches are collected into a
`StructureGraph` with stable path ids (`structure/mass_main/band_02/facade_front`)
and a diagnostics list.

The rule the whole design rests on: **tessellation, materials and everything
downstream read the graph and never write to it.** Retuning how something is
drawn therefore cannot invalidate the topology it was drawn from. Seeds are
hierarchical for the same reason — each subsystem derives its own stream by name,
so regenerating one does not disturb the others, and the test suite asserts that
changing the condition or material seed leaves the massing byte-identical.

Vocabularies (wall profiles, base and summit treatments, corner treatments,
footprint composition) are authored complete and only partly implemented. An
unimplemented member is a named `error`, never a silent fallback, so a profile
written today cannot quietly come to mean something else later.

`src/structure/mass/` resolves footprint plus elevation profile into bands. Two
separate things narrow a mass, and keeping them apart is what makes both
tunable: the **batter** leans a band's own faces inward over its rise, while the
**setback** steps the next band in from the crown of the one below. There is no
wall-profile control — a battered wall at zero degrees is a vertical wall, so the
angle alone decides, and the patch role and evaluator follow it. The rest of the
profile vocabulary is not a function of an angle and stays authored on the spec.

The requested summit ratio is met by the setback after whatever the batter
already took, and when the batter alone overshoots, the shortfall is reported
with the value actually achieved rather than absorbed.

Total height is shared out by a **shaping curve** (`kernel/curve.ts`): `linear`
gives every band the same rise, `custom` reads two handles as a cubic Bezier of
cumulative height against band position, so a curve that climbs early gives a
heavy base under progressively shallower terraces. Handles are confined to
[0, 1], across which the cubic's slope stays non-negative — so no combination the
pane can produce asks for a band of zero height. A hand-authored curve reaching
outside that range can fall; those bands are floored to a minimum rise and the
fall is reported.

Tessellation draws one lofted solid per band and one ring per terrace — only the
part the band above leaves exposed, so stacked bands never leave two coplanar
faces fighting for the same depth.

## Composition

`StructureComposer` merges every part into **one indexed geometry** with two
coalesced material groups (0 stone, 1 iron), rendered as a single mesh. Parts are
authored in local space and placed by a matrix, so no part geometry is ever
mutated or cloned, and each prop keeps the per-part seeding that makes its
masonry deterministic.

Parts are cached per section, so a control change regenerates only what it
actually invalidated rather than the whole composition. The animated flames, the
glow lights, and the loaded offering model stay separate objects, positioned from
**anchors** the generator returns alongside the geometry.

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
(`src/config/control-spec.ts`) — a number, a boolean, a list of named string
values, or a `point2` bound to a draggable pad — and both the Tweakpane binding
and the generator validator read that one table, so a slider and its guard can no
longer drift apart. A list control offers only the vocabulary members that are
actually implemented, which keeps the pane from being able to put the generator
into a state it will refuse. A spec may carry `visibleWhen`, hiding a field that
only means something under another field's setting — the curve handles appear
only while the height curve is custom — so a table stays self-describing rather
than needing the pane to know which of its controls gate which others.

Controls are context dependent. The pane is built once and toggles `hidden`, so
a control appears only when the active structure declares the prop it belongs to
and its enabling flag is set: bevel dimensions follow `bevel.enabled`, the whole
Flame and Glow groups follow the fire bowl, and offering placement follows
`offering.enabled`. A folder whose contents are all hidden hides itself. Tab
pages are never gated directly — Tweakpane rebinds a page's hidden state from
its own selection — so a tab a structure does not use shows an explanatory line.
The mass structure declares no props at all, so all of that gating falls out
without the pane knowing anything about it.

The Structure tab's Geometry folder reports the active structure's own section
plus a **validation** line: the worst diagnostic from the last build, with the
value the generator substituted when it repaired rather than refused.

Two Scene toggles serve the semantic layer. **Greybox shading** replaces both
surface materials with a neutral matte, so massing is judged on silhouette and
proportion rather than on how the stone reads. **Patch debug** draws the graph
itself — one frame per patch coloured by role, an outward normal tick, and an
outline per declared region — built from patch frames rather than from the mesh,
so a tessellation that disagrees with the patch it came from is visible.

The Fire Bowl tab controls whether bowls are generated, their overall scale,
and radial detail. Separate Flame controls set visibility, overall scale,
radius, height, base height, radial detail, animation speed, noise scale,
turbulence, and intensity; these values do not inherit the bowl scale. Glow
controls independently expose visibility, intensity, distance, and flicker. The
tab also reports the combined fire-bowl vertex and triangle counts across all
pillars, the instanced flame workload and draw count, and the number of
entry-paired glow lights.

The stone surface is loaded from `public/materials/stone.json` through
`material-designer-runtime` and baked at 512px. The generated mesh uses hard
box-projected UVs so tops, bevels, and vertical sides sample the baked maps
without triplanar blending.

Fire bowls use a separate hammered-metal graph from
`public/materials/hammered-iron.json`. If either graph cannot load, that surface
falls back independently to a standard stone or dark forged-iron material.

Lighting combines a cool hemisphere fill with a cool directional sun. The sun
casts three faded WebGPU CSM cascades that track the active camera, while the
structure geometry both casts and receives shadows. AO strength and crack
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

```sh
npm test
npm run build
```

`npm test` runs two suites. `scripts/geometry-sanity.ts` covers the merged
geometry, the props, the registry and the control tables — including the check
that every spec key exists in its defaults and that the default sits inside its
own range, which is what makes UI/validator range drift impossible to
reintroduce.

`scripts/structure-sanity.ts` covers the kernel. It asserts the invariants a
graph has to satisfy — positive dimensions, symmetric adjacency, monotonic band
elevations, rises summing to the requested height, regions inside their patch
domain, diagnostics carrying a code and an entity id, and the merged bounding box
agreeing with the extents the graph computes independently — then compares each
generated graph against a committed JSON fixture in `tests/fixtures/structure/`.

The fixtures are serialized semantics, not vertex-buffer hashes, so a retuned
proportion shows up as a readable diff on the numbers that changed. When a change
is intended, re-record with:

```sh
UPDATE_FIXTURES=1 npm test
```
