# Checkpoint Gen

A low-poly procedural structure generator for Three.js. A *structure* composes
reusable props and generators into a single merged geometry. Four are registered:
the **circular** checkpoint, a seeded one-to-eight-way stone crossing with a
three-tier center whose entries use polar coordinates; **mass**, which
resolves a footprint and an elevation profile into semantic patches and draws
them as plain solids; **Pillar Hall**, an inspired pier-and-lintel family
with Linear Screen, Front Gallery, and open-front Pavilion archetypes; and
**Stela**, free-standing carved monoliths whose real product is an addressable
slot table for ornament that arrives later.

## Structures

Structures are registered in `src/structure/registry.ts` and selected from the
`type` dropdown at the top of the control pane. A definition
(`src/structure/definition.ts`) declares its id and label, which shared props it
uses, which part sections it emits, its layout defaults, a declarative control
table, a `controlTabs` layout, and a `build()` that emits parts plus anchors.

Adding one means a new folder under `src/structure/families/` plus one line in
`STRUCTURES`. Its layout folders, dropdown entry, validators, control gating and
per-section rebuild granularity all fall out of the definition — no edits to the
composer, the scene, or the pane.

Section names are per-structure rather than a fixed union: the circular
checkpoint's `layout` / `pillars` / `fireBowls` and mass's single `mass` section
have nothing in common, and neither has to know the other exists. Where a
structure's own controls need a scope to mean something different from the
shared prop table, it declares `sectionsByScope`.

### Geometry codes

The URL fragment is an unversioned current-schema code for the selected structure. It
contains the structure type plus every value from that structure's layout and
declared prop controls, including values currently hidden behind a disabled
feature. The codec is `proc-seed`'s `defineCodec` — a dense mixed-radix
encoding shared with this project's sibling repo, so both speak the same
seeding and encoding law. Every field is always explicit, packed into one
arbitrary-precision integer and rendered as base62, so there is nothing
implicit to interpret and no frozen "defaults" object a decoder needs to agree
with the encoder about. A structure-type digit always comes first — exactly
one base62 character, since the registry stays well under 62 entries — and
selects which structure's own field list decodes the rest of the payload.

Being dense costs length. The tradeoff is a schema with no field-
count ceiling — `defineCodec` packs into an arbitrary-precision integer, not a
fixed bit width.

Scene state is deliberately outside this boundary. Camera/view state, global
lighting, every material-palette selection and texture scale, the Scene tab's
material tuning, diagnostics and tools neither change the code nor get overwritten
when one is restored. Inactive structure families are excluded too. Pasting a code
into the address bar switches to that structure and regenerates it in place, while
control edits update the current history entry rather than adding one entry per
slider movement.

Codec field order comes from the registered control tables and is the complete
wire schema. There is deliberately no migration layer or compatibility prefix:
adding, removing, reordering, or retuning fields may invalidate older links.
Decoding always targets the generator version currently running.

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

The executable **Surface feature pipeline** is cut-first and depth-aware. A
region states which typed operations it permits and which same-patch regions it
excludes; a feature carries dependencies, relative ordering and an explicit `clip`, `skip`,
`replace` or `error` conflict policy. A feature may also name the semantic
material owned by the surfaces its operation exposes. Compilation is a pure graph reader: it
topologically orders the features, resolves overlaps into deterministic
rectangular fragments and reports named diagnostics without changing the patch.

`cut`, `inset`, and `extrude` execute over rectangular regions on planar patches.
The wall reader resolves them together as a `u`/`v`/depth grid: a cut removes the
full wall depth, an inset stops the wall behind its base plane, and an extrusion
continues it forward. This partitions the real wall volume rather than layering
decoration over an unchanged face, so jambs, sills, soffits, recess returns, and
projecting sides each have one owner. The other operation names remain typed but
deliberately produce an unimplemented error.

Facade operations use that ownership to emit independent indexed material
groups without splitting the building into detail meshes. Portal and window
reveals, niches, recessed panels, pilasters, and friezes each have one stable
slot; surrounding wall planes remain summit-wall material. Bare and masonry
readers preserve the same face assignments.

`src/structure/facade/` resolves every summit-building exterior wall into stable
horizontal bays and vertical bands. Fixed dimensions are allocated before
weighted remainder, bilateral rules are validated, and a three-bay Cell plan can
project its partition ownership into facade bay widths. The default `plain`
grammar still produces the established centred portals, but those portals are
now exterior connection intents placed by Facade rather than regions authored
inside Cell. The opt-in `hierarchical` grammar adds a primary entrance, elevated
window, niches and recessed panels, bay-boundary pilasters, and a continuous
frieze through the same three Surface operations. This first reader is limited
to rectangular planar Cell facades; arched openings and battered Mass facades
remain explicit later work.

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

Front, rear, left, and right stairs are enabled independently, with at most one
centred flight on each facade. Enabled stairs share their width, riser, tread,
tiling, parapet, and cornice settings. Each one reserves its own facade strip and
exposes the clearance between its arrival and the configured summit footprint
as a forecourt.

The summit allocation is authoritative in the graph: the building width and
depth ratios resolve one centred `building_pad` directly against the full
summit. The same world-space rectangle drives the forecourts, raised pad, child
placement anchor, and building footprint, so no second margin or ratio can
shrink it again. An **open floor** places that anchor directly on the summit. A
configurable **raised pad** instead extrudes that same rectangle by its pad
height, marks the footprint below as occupied, and moves the placement patch and
anchor to the pad top. The summit surface beneath the pad is omitted rather than
left as hidden supporting geometry.

An optional **summit building** consumes the complete placement footprint as one
exterior envelope. Its plan is configurable as a single chamber, a front/rear
twin chamber, or a three-bay gatehouse. Multi-room plans own each shared
partition once and cut configurable-width, configurable-height connections
through both semantic wall faces and the generated wall blocks. Wall height,
wall thickness, and the exterior portal dimensions remain real dimensions.
Every enabled stair requests one exterior connection on the matching building
wall. Facade grammar places its centred portal, while Cell supplies the room or
rooms it must reach; with no stairs the building remains closed to the exterior.

The graph records each room and floor independently, the shared partitions,
room connections, exterior and interior wall patches, roof-bearing wall crowns,
and portal destinations. Openings are constructed from piers and headers with
explicit jamb and soffit patches—not as booleans or rectangles drawn over solid
walls. The existing summit surface becomes the room floors and thresholds, and
wall footprints are not emitted as hidden supporting geometry in the bare
tessellation.

An optional **flat summit roof** is a separate assembly carried by those
roof-bearing wall crowns. Its slab thickness and projection are real dimensions,
and an optional top cornice uses the same projection-and-height convention as
the other moldings: either zero dimension leaves it absent. The graph records
the covered cell and every room in its roof group, exterior and partition
bearing patches, ceiling, slab edges, projected soffits, top surface, and
cornice surfaces. Tessellation removes the wall-crown contact faces before
laying the roof, so the ceiling and overhangs remain visible without a
coincident interface or a hidden support slab.

Every stair supports open sides, stepped parapets, and **flat parapets**. Both
parapet styles accept the same configurable cornice projection and height. On a
stepped parapet the cornice repeats as one horizontal cap per tread; on a flat
parapet it is one raked band following the continuous incline. In both cases it
replaces the top of the wall rather than stacking above it. Square horizontal
blocks finish the molding beyond the foot and onto the summit, with the parapet
body continuing beneath them to the ground and summit floor. The endings are
therefore supported parts of the wall rather than cantilevers, and their
endpoints do not expose raw cuts. Either style's wall is its own material
surface, dressed apart from the flight it flanks while its cornice stays trim.

Mass can use those square end blocks as explicit **fire-bowl slots**. Bottom and
top terminals are enabled independently from the Fire tab. A slot exists only
when the stair has a resolved parapet cornice and its square footprint—parapet
width plus twice the cornice projection—is at least `0.45 m`. Bowl geometry uses
the independent `iron` material slot, and its widest ring is automatically
limited to 90% of that available square. The shared bowl scale may request a
smaller result but cannot make it overhang the terminal. Flames remain one per
bowl, while each left/right terminal pair shares one glow light centred between
them. The light can then move outward along that stair's X/Z axis and vertically
around its flame-derived height without disturbing the pair calculation.

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

### Stelae

The stela family builds free-standing carved monoliths — tablets, banded columns
and markers — and its product is not really the silhouette. It is the **slot
table**: named, addressable rectangles with a plane, a metric extent and a depth
budget, which a later ornament system fills with geometry or with a texture cut
to fit. Content changes far more often than form and arrives from a different
pipeline, so the form system publishes a contract and stays out of it. See
`docs/stelae-system.md`.

Two decisions carry most of the weight. The first is that **a slot publishes two
outlines**. A face patch's frame is a parallelogram — the same frame every
battered facade here uses — so a slot holding a constant fraction of a narrowing
face is a trapezoid in that domain, not a rectangle. `boundary` gives its four
real corners for a consumer that can follow the taper; `inscribed` gives the
largest axis-aligned rectangle for one that needs a rectangle. Publishing only
the first would make a texture mapper overrun the stone; publishing only the
second would quietly shrink every field on a tapered body.

The second is that **damage never deletes the slot table**. Slots are emitted
before condition runs and annotated after, so a truncated stela addresses exactly
the slots its intact twin does, by the same ids, with `condition`, `inscribed`
and `depth_budget` changed. The alternative — dropping lost slots — renumbers the
composition every time a condition slider moves, which would break ornament
authored against it. That ordering is a phase ordering, not a convention, and the
suite compares the two graphs slot for slot.

The solid is a linear stack of concentric boxes plus **appliques** laid over its
faces, and keeping those two apart is what removes the need for a general contact
solver: a stacked element can only be covered by its immediate neighbour, and an
applique never emits the face it presses against. A ribbon running a face end to
end is subtracted from that face rather than laid over it — the buried-face probe
samples a quad at its centroid, and a surface nothing can ever see is a defect
whether or not anyone notices.

**A frame is neither.** It is a recess cut into a band, so the border is stone
that was never cut away — one continuous piece, with nothing at its corners to
mitre. Four rails laid on the face would be four solids meeting at four corners,
each shading over its own height, and every corner would show the seam. Cutting
it instead needs no boolean: the band's plan is partitioned by every pocket edge,
so each cell is a whole box that is either kept or removed, and every face is
decided by asking whether its neighbouring cell survived. Ribbon edges join that
partition too, so a cell is never half-hidden behind one.

The recess is also what makes a slot visible in the mesh. The pocket floor and
walls are the only geometry inside a slot's outline, which is what the **tint
slots** debug toggle repaints — a check by eye that what was reserved is what got
carved. It reclassifies faces and changes no topology, and the suite asserts
exactly that.

**Bevels are a surface treatment, not a proportion.** Like masonry, they never
reach the graph: the resolver states rectangles and the tessellator turns each
one into the polygon it actually draws, so an arris adjustment cannot invalidate
the topology it was applied to — the suite asserts the serialized graph is
byte-identical with bevels on and off. One segment gives a flat chamfer, more
give a faceted quarter-round, and everything is drawn through that one polygon
path so an unbevelled stela is simply its four-sided case.

Bevels also forced a fix in the shared box projection. Each face takes its UVs
from whichever world axis its normal points most strongly along, and a face that
does not square up to that axis is foreshortened by the cosine between them — a
facet turned 45 degrees covers only 71% of the axis it projects onto, so its
texture stretched by 1.41 across it. Dividing that cosine back out restores the
world scale at every angle and is exactly 1 on a face that already squares up,
including a battered one, so nothing outside the bevels changed. The suite
measures one UV unit per metre of run at four face angles.

Rounded crowns are **lofted, not stacked**: each course rises from the arc width
at its foot to the width at its head, so consecutive courses share an outline.
Constant-width courses each finish in a horizontal ledge, and a crown built that
way reads as a staircase however fine the steps are.

The body is one stone by definition, so no masonry is laid over it. A base may be
built rather than carved, and that is the family's one departure from the shared
construction grammar.

## Composition

`StructureComposer` merges every part into **one indexed geometry** with one
coalesced draw group per used semantic material slot, rendered as a single mesh.
The stable slots are masonry, trim, stairs, stair walls, summit walls, interior
floors, roof, pillars, iron, the Pillar Hall's indexed pedestal, pier, pier panel
and lintel, and the stela's body, frame and crown. The array index *is* the draw
group index, so the list is append-only. Every emitted face owns one `surfaceMaterial` vertex value; culling
and merging preserve it, then the merger buckets whole triangles into the
corresponding indexed group. The same attribute is ready for a future
texture-array shader without changing generator topology. Parts are authored in
local space and placed by a matrix, so no part geometry is ever mutated or
cloned, and each prop keeps the per-part seeding that makes its masonry
deterministic.

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
the fragment color ramp without per-pixel noise. One flickering point light per
entrance provides a localized glow for its pair of bowls. Glow-light shadow
casting is disabled by default and can be enabled from the Fire controls. At
startup the WebGPU renderer checks both sampled-texture and sampler limits and
requests higher device limits only when the adapter supports them. A standard
16-sampler device uses the reduced two-cascade sun shadow pipeline described
below; the control stays unavailable only when even that pipeline cannot fit.

Use the in-browser controls to adjust its overall radius, entry layout, paving
density, and restrained stone variation.

Top-edge detail is generated per configuration as either hard edges or a
seeded planar chamfer. Chamfer width varies independently along each stone edge,
while depth and variation remain configurable. Only the top perimeter is
clipped; the vertical and bottom edges stay hard.

The pillar controls expose total height, shaft width, base-step count, vertical
shaft courses, and cross-section subdivisions. Their stone gap, size variation,
displacement, seed, and bevel controls are independent of the checkpoint shell,
and so is their dressing: pillars own the `pillars` slot, so they take their own
material and texture scale while still living in the same merged geometry and
sharing lighting, view helpers, and camera framing.

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

Before any render state or cached geometry changes, the complete active config
is validated: the selected family's layout and surface values, shared props,
view, illumination, and color fields. Mass validation also resolves the
cross-field structural rules, because a width or height may be inside its own
slider range while its combination with batter, summit size, or stairs produces
no buildable mass. An invalid edit restores the last valid values in place, so
the existing Tweakpane bindings remain usable without a reload. The compact
status row still shows the latest result, while the validation log records
rejected control values and structural diagnostics for inspection.

Not every control is a Tweakpane *binding*: the curve editor is a blade that owns
its own value, so `bindControls` adds it and writes back by hand. It also plots
itself from its element's size exactly once, when it first lands in the DOM,
which draws an empty box for a control that starts hidden — so a spec-bound
control may register an `onShow` hook that the visibility registry runs on each
hidden-to-shown transition.

Controls are context dependent. Each structure definition partitions its layout
folder groups and declared props among `controlTabs`; the pane replaces the tab
bar from that schema when the type changes. The circular structure therefore
owns Structure, Pillars, Fire, Offering, and Materials pages, while Mass owns
Structure, Stairs, Summit, and Materials. Pillar Hall owns Structure, Details,
and Materials. Scene is global and appended to any
tab bar. The definition validator requires every layout group and prop to appear
on exactly one page, preventing an unrelated tab or an unbound control group from
leaking into a new structure.

Within the active pages, controls still toggle `hidden` from their enabling
fields: bevel dimensions follow `bevel.enabled`, the whole Flame and Glow groups
follow the fire bowl, and offering placement follows `offering.enabled`. A
folder whose contents are all hidden hides itself. Tab pages themselves are
never gated directly because Tweakpane rebinds a page's hidden state from its own
selection.

Immediately below the FPS panel, global readonly fields report the selected
structure type's stones, vertices, triangles, generation time, and validation
status. They update when the type or its geometry changes and stay outside the
type-specific tab bar. The status shows the worst diagnostic from the last
build, with the value the generator substituted when it repaired rather than
refused.

Two Scene toggles serve the semantic layer. **Greybox shading** replaces every
surface slot with a neutral matte, so massing is judged on silhouette and
proportion rather than on how the stone reads. **Patch debug** draws the graph
itself — one frame per patch coloured by role, an outward normal tick, and an
outline per declared region — built from patch frames rather than from the mesh,
so a tessellation that disagrees with the patch it came from is visible.

The Fire Bowl tab controls whether bowls are generated, their overall scale,
and radial detail. Separate Flame controls set visibility, overall scale,
radius, height, base height, radial detail, animation speed, noise scale,
turbulence, and intensity; these values do not inherit the bowl scale. Glow
controls independently expose visibility, intensity, attenuation range,
horizontal distance in the structure's X/Z plane, a signed vertical offset from
the flame-derived light height, and flicker. The
tab also reports the combined fire-bowl vertex and triangle counts across all
pillars, the instanced flame workload and draw count, and the number of
entry-paired glow lights.

Each structure exposes only the **material surfaces** it actually has, and the
Materials tab gives each one its own folder holding a Material Designer document
and a texture scale. The circular checkpoint dresses its plate, its pillars, its
fire bowls, and the offering statue apart; Mass dresses masonry, trim, stairs,
stair walls, summit walls, interior floors, and roof, plus independently indexed
portal reveals, window reveals, niches, recessed panels, pilasters, and friezes.
Pillar Hall adds independently indexed pedestals, stepped piers, recessed pier
panels, lintels, friezes, cornices, and its optional gallery roof. Linear Screen
alternates one full-depth projecting plinth centred beneath every pier with two
recessed panel fields per bay, backed by a continuous structural base and
flanked by end buttresses. Each pier carries an aspect-ratio-derived stack of
one to four lower fields beneath one taller shaft panel on every face; the
default proportions resolve to three lower fields. Row centre-lines are inset
from the summit using the actual pier, span, roof, and termination extents before
the available run is divided into bays. Lintel and cornice ends share one
resolved plane at row ends and corners; the **Span end projection** control moves
that plane outward without misaligning the stacked span layers.
Documents are loaded lazily, cached by id, and baked at 512px, so surfaces that
select the same document share one material and one bake rather than paying for
it twice. Changing an assignment
updates mesh materials without regenerating geometry or reframing the camera.

The offering statue is a surface like any other even though it is a loaded model
rather than a generated part, so its material and tiling live in the palette next
to everything else, and its placement controls stay on the Offering tab. Fire
bowls default to the hammered-metal graph in
`public/materials/hammered-iron.json`. If any graph cannot load, only that
surface falls back to the standard stone, dark forged-iron, or statue material.

Texture scale is a UV concern rather than a material one, which is what allows one
document to dress several surfaces at different densities: the generated mesh uses
hard box-projected UVs, and each surface's scale is applied to the vertices that
name it, keyed off the same `surfaceMaterial` attribute the draw groups come from.
Nothing is resampled and no material is duplicated. Every surface defaults to 1 —
the density the builders authored — under the Scene tab's material scale, which
remains a master multiplier over all of them. Triplanar blending stays off, so
tops, bevels, and vertical sides sample the baked maps directly.

Lighting combines a cool hemisphere fill with a cool directional sun. The sun
normally casts three faded WebGPU CSM cascades that track the active camera. On
a 16-sampler device it uses two cascades so all eight optional fire-glow shadow
maps still fit the fragment-stage binding budget. Structure geometry both casts
and receives shadows. Local point shadows use a close near plane plus depth and
normal bias so nearby terraces do not expose cube-shadow seams. AO strength and crack
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
