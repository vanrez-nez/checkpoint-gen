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

Total height is shared out by a **shaping curve** (`kernel/curve.ts`) of
cumulative height against band position, so a curve that climbs early gives a
heavy base under progressively shallower terraces.

`CURVE_SHAPES` holds the named distributions. They are described by where the
quantity concentrates rather than by what they are for — `front_loaded`,
`ends_emphasised` — because a curve is reused wherever something is shared across
a series, and the same shape will later drive setback falloff and bay rhythm. The
mass structure labels them for height: Linear, Heavy base, Tall crown, Base and
crown, Tall middle. Picking Custom instead exposes the curve directly, in a
`cubic-bezier` control from `@tweakpane/plugin-essentials`, with both handles
draggable on the graph itself.

Selecting a preset writes the curve it stands for into the config, so the stored
curve always states the one in use and switching to Custom starts from the preset
you were on rather than from wherever the editor was last left. Generation still
resolves a preset from its own table, so a hand-edited config that disagrees with
itself builds the preset it names.

As in CSS, each handle's `x` is bounded by the curve's domain while its `y` is
free. Across [0, 1] the cubic's slope stays non-negative, so an ordinary curve
can never ask for a band of zero height; a handle dragged past the top or bottom
can make the curve fall, and those bands are floored to a minimum rise with the
fall reported on the validation line.

A band may carry a **cornice**: a molding that projects past the wall and crowns
it. It takes over the top of the band rather than sitting on top of it, so
switching cornices on never moves a band's base, top or outline — the elevation
profile is decided first and stays decided. It is recorded per band in the graph,
because it changes the silhouette and the extents and later systems need to know
where a crown actually is, and the wall's crown edge records `treatment:
"cornice"` so it is addressable as the edge feature it is.

Which bands carry one is a rule — every band, the crown only, the terraces only,
or alternating — rather than a list, because bands are generated from a count and
a curve rather than authored one by one. Once bands are individually authorable,
the rule becomes their default and nothing downstream changes. A cornice may take
at most half the band it crowns; anything taller is shortened and reported.

The primary stair supports open sides, the established stepped parapets, and
**flat parapets**. A flat parapet is one ground-backed wall on each side whose
top follows the continuous stair incline rather than repeating every tread. Its
optional cornice is a single raked band with configurable projection and height;
it replaces the top of the wall rather than stacking decorative solids above it.
Square horizontal blocks finish the molding beyond the foot and onto the summit,
with the parapet body continuing beneath them to the ground and summit floor.
The endings are therefore supported parts of the wall rather than cantilevers,
and their endpoints do not expose diagonal cuts.

Masonry treads use an explicit **tiles per step** count. The count controls how
many stones span every tread; stone-size variation may redistribute their
individual widths, but the configured count remains exact and no longer follows
the mass wall's automatic target-stone-width rule.

Tessellation draws one lofted solid per band and one ring per terrace — only the
part the band above leaves exposed, so stacked bands never leave two coplanar
faces fighting for the same depth.

**Stonework** builds the mass out of blocks. A block's face sits exactly on the
surface the graph declares and the block reaches **back into** the wall by a real
bed depth, with the core inset by that same amount — so blocks plus core
reconstruct the band with nothing overlapping. The mass is drawn once, as stone,
and a joint looks into the core rather than through the building.

That direction matters. Lifting faces outward instead leaves the wall drawn
twice, once as a full solid and once as a skin floating on it, and pushes the
structure out past its own declared extents.

`kernel/masonry.ts` decides where the joints fall, in three levels that each
divide exactly and leave no remainder:

```
band wall  ──▶  courses      horizontal layers, worked out once per band and
                             shared by all four faces so course lines meet
                             around every corner
course     ──▶  runs         one per face, minus what the corner blocks take
run        ──▶  stones       lengths that sum to the run exactly; a fresh seed
                             per course staggers the joints
```

Every division goes through `normalizedSpans`, which varies its pieces but always
sums to the span it was given. Dividing by `round(length / target)` and living
with the difference is what drops stones at the ends of a run, and clipping a
course to the narrowest line it spans is what leaves a bare wedge up a raking
edge.

**At a terrace, the riser and the tread are the same stone.** The top course of
each band reaches back to carry a tread, so one block presents its outer face as
the riser and its top face as the tread — which is how a stepped mass is actually
built.

That coping is an *edge* stone, capped at a stone's length. Letting it span the
whole setback makes its top a slab several times the size of every other stone,
obvious the moment you look down at a terrace; the rest of the terrace is paved
normally so what you see from above matches what you see from the side.

Bed depth is also how deep the joints read, so keep it comparable to the joint
width. A block far deeper than its joints are wide buries almost all of its own
side area between its neighbours where nothing can see it — at four times the
joint, over ninety per cent is wasted. Sides with no joint beside them at all —
the ground course's underside, the edge a corner stone turns through — are not
drawn.

**Corners** are real blocks: a box sitting at the corner with a face on each
elevation, long on whichever axis runs through that course, alternating as the
courses rise.

A battered course is a trapezoid, and the rake goes to the two stones it actually
passes through: every stone is laid as a rectangle over the course's bottom edge,
and only where one runs past the top edge's extent is its top corner pulled back.
Interior stones come out exactly square; the end stones come out cut at the
batter, which is what a stone meeting a raking corner is.

None of this reaches the graph. A faced and a bare band are the same band, so
stonework lives entirely in the tessellator; the suite asserts that turning it on
leaves the serialized graph byte-identical, that the faced and bare builds occupy
exactly the same extents, and that facing costs no more geometry than it saves.

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
values, or a `bezier` curve — and both the Tweakpane binding and the generator
validator read that one table, so a slider and its guard can no longer drift
apart. A list control offers only the vocabulary members that are actually
implemented, which keeps the pane from being able to put the generator into a
state it will refuse. A spec may carry `visibleWhen`, hiding a field that only
means something under another field's setting — the curve appears only while the
height curve is custom — and `onChange`, reconciling fields it derives, which is
how selecting a curve preset writes that preset's handles. Both keep a table
self-describing rather than needing the pane to know which of its controls gate
or feed which others.

Not every control is a Tweakpane *binding*: the curve editor is a blade that owns
its own value, so `bindControls` adds it and writes back by hand. It also plots
itself from its element's size exactly once, when it first lands in the DOM,
which draws an empty box for a control that starts hidden — so a spec-bound
control may register an `onShow` hook that the visibility registry runs on each
hidden-to-shown transition.

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
