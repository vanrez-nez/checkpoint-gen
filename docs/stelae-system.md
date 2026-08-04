# Stela System

## A Composition and Slot Grammar for Free-Standing Carved Monoliths

**Document status:** Family specification, authored ahead of implementation
**Parent document:** `procedural-architectural-system.md`
**Core abstraction:** A vertical stack of ground interface, base, body and crown, subdivided into bands and bays, publishing addressable ornament slots
**Intended uses:** Tablets, markers, banded columns, boundary stones, ruined monoliths, and any later system that needs a stable surface to carve or map onto

---

## 1. Purpose and scope

A stela is a free-standing carved monolith: a single upright stone that carries
ornament on its faces. This family resolves the **form** — the stack, the
proportions, the frames, the endings, and the condition — and it resolves the
**slots** that ornament will later occupy. It does not resolve ornament.

The distinction is the whole point of the family. Glyphs, reliefs, figures,
masks and inscriptions are content. Content changes far more often than form,
arrives from a different pipeline, and may be delivered either as geometry or as
a texture cut to fit. If the form system tried to own content it would have to
be regenerated every time a motif changed. Instead the form system publishes a
contract — named rectangles with a known plane, a known metric extent, and a
known depth budget — and content systems read it.

This family carries no cultural label and is not a reconstruction. It is a
rectilinear composition grammar in the same sense as the Mass and Pillar Hall
families, and the reference direction that shaped it is a silhouette direction,
not a source claim.

Out of scope, deliberately and permanently for this document:

- glyph, relief, figure and inscription content of any kind;
- non-rectilinear body plans beyond the crown vocabulary;
- mesh-level carving, boolean subtraction, or displacement sculpting;
- stela groups, alignments, rows and plaza arrangements;
- placement of a resolved stela onto a host platform.

The last two are named in §17 as future research rather than as omissions.

---

## 2. Relationship to the core system

A stela is a structure family in the Pillar Hall sense: its base, body, frame,
crown and slots are owned and validated together, and no generic layout graph
sits beneath them. It reuses the kernel rather than reimplementing it.

Reused unchanged:

| Kernel entity | Use in this family |
|---|---|
| **Patch** | Every face, crown surface and base surface resolves to a patch with a local frame, named edges and adjacency. |
| **Region** | An ornament slot is published as a patch region with an empty operation list — the kernel's existing "reservation only" state. |
| **Anchor** | Every slot also publishes a placement anchor of kind `ornament`, at the region centre, facing the region's orientation. |
| **Edge** | Frame rails, crown returns and base copings are edge treatments, not separate entities. |
| **Band and bay** | Faces subdivide exactly as facade walls do: bands stack along `v`, bays divide along `u`, fixed dimensions allocate before weighted remainder. |
| **Masonry rule** | Applies to a constructed base only. See §6.2. |
| **Seed subsystems** | `massing` shapes the stack, `facade` shapes the bands and bays, `condition` shapes damage, `construction` shapes a coursed base. |
| **Diagnostics** | Every constraint in §12 reports a named `stela.*` code rather than clamping silently. |

Owned by the family:

```text
StelaRecord
StelaGroundRecord
StelaBaseRecord
StelaBodyRecord
StelaFaceRecord
StelaBandRecord
StelaBayRecord
StelaFrameRecord
StelaCrownRecord
OrnamentSlotRecord
StelaDamageRecord
```

The rule that governs the direction of every relationship here is the project's
standing one: **tessellation, materials, condition and any later ornament system
read the graph and never write to it.** A slot table is therefore an output of
form resolution and an input to everything downstream, never a negotiation
between them.

---

## 3. Family vocabulary

| Term | Definition |
|---|---|
| **Stela** | The whole free-standing monument: ground interface, base, body, crown and slot table. |
| **Ground interface** | The contact between the monument and the terrain, including any buried length. |
| **Base** | The supporting stack beneath the body — plinth, pedestal or socket. May be a separate constructed element. |
| **Body** | The monolith itself. The only mandatory part, and the only part that is by definition a single stone. |
| **Crown** | The top ending of the body, from a flat cut to a capital and capstone. |
| **Face** | One of the body's vertical sides, named by orientation and typed by role. |
| **Band** | A horizontal division of a face, spanning a `v` interval. |
| **Register** | A band of role `register` — a tall body division intended to carry a field. |
| **Ribbon** | A narrow linear band of ornament, horizontal or vertical, beside the main planes. |
| **Bay** | A vertical division of a band, spanning a `u` interval. |
| **Frame** | Raised or recessed border work that bounds a field and makes it read as a field. |
| **Field** | The large planar area inside a frame — the main ornament plane. |
| **Slot** | A resolved, addressable rectangle reserved for ornament, with a plane, an extent and a depth budget. |
| **Depth budget** | How far ornament may project from, or cut into, a slot without breaking the form. |
| **Condition** | The stage and damage events applied to a resolved form, independently of it. |

---

## 4. Family definition

```yaml
Stela:
  archetype: tablet | framed_tablet | banded_column
  ground: StelaGround
  base: StelaBase | none
  body: StelaBody
  frame: StelaFrame | none
  crown: StelaCrown
  faces: [StelaFace]
  slots: [OrnamentSlot]
  condition: StelaCondition
```

---

## 5. Implemented archetypes

The first slice resolves three complete compositions:

```text
tablet
  broad thin body, two primary faces and two narrow returns
  simple plinth base, rounded or flat crown
  one full-height field per primary face, no register division
  no ribbons, light frame or none

framed_tablet
  broad thin body with a heavy raised border on the primary face
  stepped pedestal base, flat crown with a shallow projecting cap
  three stacked registers, one framed field each
  one full-height vertical ribbon on each narrow return

banded_column
  square body, four comparable faces
  socket block base, capital and capstone crown
  four registers separated by wrapping horizontal ribbons
  one framed field per face per register, one crown face slot
```

These are authored presets, not labels inferred from geometry. Selecting an
archetype establishes a coherent starting composition; every exposed numeric
control remains editable afterward.

**Condition is not an archetype.** A tall tablet with a lost top, heavy surface
loss and a buried foot is `tablet` carrying a `truncated_body` event, a
`spalled_face` mask and a `partial_burial` ground contact. It is not a fourth
preset. Keeping form and condition on separate axes is what allows the same
resolved slot table to describe the monument before and after damage, and it is
the family's expression of the core principle that structure, appearance and
condition are separable.

---

## 6. The vertical assembly

Every stela is the same four-part stack, resolved bottom to top:

```text
ground_interface
base
body
crown
```

Each part is a treatment over a shared contact plane. The base's top plane is
the body's bottom plane; the body's top plane is the crown's bottom plane. A
part set to `none` collapses to a zero-height treatment and hands its contact
plane straight through, so the stack never develops a gap or a special case.

### 6.1 Ground interface

```yaml
StelaGround:
  contact: flush | sunk | mounded | socketed
  burial_depth: number
  apron_width: number
```

`burial_depth` extends the body or base below the ground plane. Buried length is
resolved geometry — it exists in the graph so that an excavated or subsided
variant reveals real surface rather than a cut plane — but it carries no slots.
A slot whose band falls entirely below the ground plane is omitted.

### 6.2 Base

Base vocabulary:

```text
none
flush_ground
simple_plinth
double_plinth
stepped_pedestal
socket_block
projecting_footing
battered_footing
buried_base
rubble_packing
```

A base is a stacked-rect profile expressed as ratios of body width and total
base height, so it scales with the body rather than being authored in absolute
metres. `stepped_pedestal` resolves as:

```text
socket course   34% base height, 1.45 x body width
riser           44% base height, 1.30 x body width
neck            22% base height, 1.12 x body width
```

`socket_block` is a single course whose top face carries a recess the body sits
into; the recess depth is real, and the body's visible height is reduced by it.

**Masonry applies to the base and never to the body.** The body is one stone by
definition, so course lines across it would contradict the form. A base is the
one part of a stela that may be built rather than carved, and `stepped_pedestal`,
`double_plinth` and `rubble_packing` accept a masonry rule; every other base
member and the whole body and crown are monolithic. This is the family's only
departure from the shared construction grammar, and it is a deliberate one.

Base faces may carry slots of kind `base_face`. A base narrower in projection
than the minimum usable slot extent exposes none, which is a normal omission and
not a validation error.

### 6.3 Body

```yaml
StelaBody:
  cross_section: tablet | square | rectangular
  width: number
  thickness: number
  height: number
  taper: none | tapered | battered
  taper_ratio: number
  edge_treatment: square | chamfered | rounded
  edge_size: number
```

Cross-section decides face roles, not dimensions:

```text
tablet        thickness well under width; two broad faces and two narrow returns
square        width and thickness comparable; four faces of equal standing
rectangular   between the two; no face dominates, but pairs differ
```

`taper` narrows the body with height. `tapered` reduces width and thickness
together by `taper_ratio` at the top; `battered` leans each face inward over its
rise while keeping the top parallel to the bottom. Both produce trapezoidal
faces, and both are the reason §9 requires a slot to publish two boundaries.

The face evaluator normalises `u` per `v`, so `u = 0` and `u = 1` always land on
the real side edges of a tapered face. A rectangle in the parametric domain is
therefore a trapezoid in world space, and a consumer that treats the domain
rectangle as a real rectangle will overrun the stone near the top.

`edge_treatment` shapes the vertical arris where two faces meet. A chamfered or
rounded edge consumes `edge_size` from both adjoining faces before bands and
bays are allocated. The chamfer strip itself is not a slot in this slice.

### 6.4 Crown

Crown vocabulary:

```text
flat
rounded
pointed
gabled
stepped_cap
corbel_cap
flared_cap
capital_and_capstone
notched
t_shaped
tenon
```

| Member | Profile | Exposes `crown_face` |
|---|---|---|
| `flat` | Horizontal cut at the body's top plane. | yes, the top surface |
| `rounded` | Semicircular or segmental arc across the body width. | no |
| `pointed` | Two straight rakes meeting on the centreline. | no |
| `gabled` | Rakes meeting a short horizontal ridge. | yes, the ridge |
| `stepped_cap` | Two or three receding horizontal courses. | yes, the top course |
| `corbel_cap` | A single projecting slab with a stepped underside. | yes |
| `flared_cap` | A slab whose sides splay outward with height. | yes |
| `capital_and_capstone` | A three-part stack; see below. | yes, the capstone top |
| `notched` | Flat with a rectangular notch cut on the centreline. | yes, both shoulders |
| `t_shaped` | Flat with shoulders projecting past the body width. | yes |
| `tenon` | Flat with a reduced projecting boss, for insertion elsewhere. | no |

`capital_and_capstone` resolves as a proportional stack against the body's
resolved top width:

```text
neck        18% crown height, 1.00 x body top width
capital     52% crown height, 1.24 x body top width
capstone    30% crown height, 1.42 x body top width
```

`broken` is deliberately absent from this vocabulary. A lost top is a damage
event applied to an authored crown, not a crown you can select. Selecting it
would make it impossible to say what the monument looked like intact, which is
exactly what the slot table has to survive.

---

## 7. Face subdivision

A face subdivides the way a facade wall does, and it uses the facade grammar's
vocabulary rather than a parallel one. Bands stack along `v`; each band divides
into bays along `u`.

Face roles:

```text
primary
secondary
return
```

Face roles describe body faces only. A crown or base surface is addressed by its
stack part and its orientation rather than by a face role, because a capstone top
and a pedestal riser have nothing in common with each other and less with a body
face. `top` is the orientation of every horizontal surface in the stack.

`tablet` and `framed_tablet` resolve `front` as `primary`, `rear` as
`secondary`, and both sides as `return`. `banded_column` resolves all four body
faces as `primary`. Role, not geometry, decides what a face may carry: a
`return` accepts ribbons and refuses fields, and a `secondary` accepts a field
at a lower default hierarchy than a `primary` does.

Band roles:

```text
base_return
register
ribbon
frieze
crown_return
margin
```

Bay roles:

```text
field
ribbon
cartouche
margin
corner_reserve
```

Band continuity extends the facade grammar's pair with a third member:

```text
per_bay
continuous
wrapping
```

`wrapping` is a band that runs at an identical `v` interval around every body
face and closes on itself. It is the girdle that separates registers on a banded
column, and it needs its own member because `continuous` only promises
continuity across the bays of one face. A wrapping band's members on different
faces share a band id and differ only in their face reference.

Exactly one of `height` and `weight` is positive on a band rule, and exactly one
of `width` and `weight` on a bay rule — the existing contract, unchanged.

---

## 8. Frames

A frame is what makes a field a field. Without one, a face is a plane with a
notional rectangle drawn on it and nothing in the silhouette says where ornament
stops.

```yaml
StelaFrame:
  style: none | raised_border | recessed_field | double_border | corner_blocks | banded_border
  border_width: number
  border_depth: number
  inset_u: number
  inset_v: number
  return: square | stepped | sloped
  scope: per_face | per_register | per_slot
```

Frames are built as four raised rails that leave the face behind them visible,
rather than as a cut into the face. The centre is then genuinely recessed
relative to its own border without the face being duplicated or subtracted, and
the rails carry their own material slot. This is the same construction the
Pillar Hall uses for its pier panels, and it is chosen for the same reason: a
raised border and a cut recess look alike in a render and behave very
differently under damage, materials and level of detail.

`return` shapes the transition from rail to field. `sloped` is the angled return
visible on heavy tablet borders; it is a surface of the frame, not a slot.

Rules:

- `border_width` and both insets clamp independently against each target
  rectangle's own dimensions. A frame is never allowed to invert its field.
- A frame whose borders would consume its field is **omitted**, and the band
  keeps its unframed rectangle. This is a normal omission, not a validation
  error.
- `banded_border` makes the four rails themselves addressable, emitting one
  `ribbon` slot per rail. This is how a border carries a running motif.
- `corner_blocks` reserves square corners at a higher priority than the rails,
  so a corner motif is never split across two rails.
- `scope` decides how many frames a face gets: one around the whole face, one
  per register, or one per resolved slot.

---

## 9. Ornament slots

This is the contract the rest of the family exists to produce.

### 9.1 Slot kinds

```text
field
ribbon
cartouche
crown_face
base_face
```

- **`field`** — a large planar area on a `primary` or `secondary` face, inside a
  frame when one resolves. The main ornament plane.
- **`ribbon`** — a narrow linear strip, running horizontally or vertically, at a
  base, along a frame rail, between registers, or down a return. Narrow enough
  that its content is a repeating or running motif rather than a composition.
- **`cartouche`** — a small framed unit inside a field, for a motif repeated on a
  grid. Emitted only when a field's bay rule asks for it.
- **`crown_face`** / **`base_face`** — slots on the non-body parts of the stack,
  typed separately because their planes are not vertical and their content rules
  differ.

### 9.2 The slot record

```yaml
OrnamentSlot:
  id: structure/stela_01/face_front/register_02/field
  kind: field | ribbon | cartouche | crown_face | base_face
  part: base | body | crown
  face: front | rear | side_positive_u | side_negative_u | top
  face_role: primary | secondary | return | none
  band_id: string
  bay_id: string
  frame_id: string | none
  patch_id: string
  region_id: string
  anchor_id: string
  plane: LocalFrame
  boundary: {u_min, u_max, v_min, v_max}
  inscribed: {u_min, u_max, v_min, v_max}
  extent: {u_bottom, u_top, v}
  aspect: number
  depth_budget: {relief, recess}
  flow: horizontal | vertical | none
  continuity: per_face | wrapping
  hierarchy: number
  condition: intact | partial | lost
  tags: [string]
```

### 9.3 What a slot is, and what it is not

**A slot is a rectangle, a frame reference and a depth budget, and nothing
else.** It carries no motif, no style, no content and no opinion about what
belongs in it. Two consumers with nothing in common — a geometry ornament
generator and a texture atlas mapper — must both be able to work from this
record alone.

That requirement produces the record's two boundaries. `boundary` is the slot's
rectangle in the face's parametric domain, which on a tapered face is a
trapezoid in world space. `inscribed` is the largest world-axis-aligned
rectangle that fits inside it, expressed in the same domain coordinates. A
geometry consumer that can follow a taper uses `boundary`; a texture consumer
that needs a rectangle uses `inscribed`. Neither has to re-derive the taper, and
neither can accidentally overrun the stone.

`extent` reports metres: `u_bottom` and `u_top` are the real widths at the
slot's bottom and top edges, equal on an untapered face, and `v` is the real
height measured along the face rather than vertically. `aspect` is computed from
`inscribed` so that a consumer choosing between motif variants gets a number
that matches the rectangle it will actually fill.

### 9.4 Depth budget

`depth_budget` is the family's guarantee to its consumers. It is computed from
resolved geometry and is never authored directly.

`relief` is how far ornament may stand proud of the slot plane:

```text
relief = min(
  frame_border_depth,
  clear_distance_to_nearest_projecting_member,
  style_relief_cap
)
```

Ornament that overtops its own frame stops the frame from reading as a frame,
and ornament that reaches a wrapping ribbon or a crown overhang collides with
it. Both caps are geometric facts about the resolved form, so the slot states
them rather than leaving each consumer to rediscover them.

`recess` is how far ornament may cut into the stone:

```text
recess = (thickness_on_this_axis - min_core_thickness) / 2
```

Opposed faces split their axis. The two broad faces of a tablet each get half of
what remains after a minimum core survives, and on a square body the front/rear
pair and the two side faces split their own axes independently. This is what
keeps two deeply carved faces from meeting in the middle of the stone.

### 9.5 Publication and stability

Every slot is published three ways, and all three are readers of the same
resolution:

1. as a `PatchRegion` on its face's patch, with an empty `allowedOperations`
   list — the kernel's existing reservation-only state;
2. as a `PatchAnchor` of kind `ornament` at the region centre, oriented to the
   face;
3. as an `OrnamentSlot` record in the family's own container, holding the
   metric and depth information a region cannot express.

Slot ids follow the core identifier law: they survive a material change, a
condition regeneration and a re-seed, as long as the band and bay topology they
name has not changed. Changing a register count changes ids, because it changes
what the id means. Changing a stone material does not.

### 9.6 Omission

A slot whose `inscribed` rectangle falls below the minimum usable extent is not
emitted:

```text
min_field_extent    0.12 m on both axes
min_ribbon_width    0.04 m on the narrow axis
min_ribbon_length   0.20 m on the running axis
```

**This is a normal omission and not a validation error.** A narrow return simply
has no room for a ribbon, exactly as a narrow stair terminal has no room for a
fire bowl. Reporting it as an error would make ordinary proportions unbuildable.

---

## 10. Layout and allocation rules

Vertical and horizontal allocation follow the facade grammar's order — fixed
before weighted — applied to the whole stack:

```text
1. subtract burial depth from total height
2. subtract base height and crown height
3. subtract edge treatment from each face's usable width
4. subtract fixed-height bands: ribbons, friezes, base and crown returns
5. distribute the remaining height across weighted register bands
6. subtract frame border width and inset from each band rectangle
7. subtract fixed-width bays and corner reserves
8. distribute the remaining width across weighted bays
9. compute depth budgets against the resolved neighbours
10. emit the surviving rectangles as slots
```

Additional rules:

- **Symmetry** is `none` or `bilateral` about the body's vertical centreline.
  Bilateral symmetry constrains bay allocation on a face, not band allocation.
- **A wrapping band resolves one `v` interval and applies it to every face.**
  Its width is then resolved per face, because a tapered or rectangular body
  presents different widths on different faces at the same height.
- **A register density constraint refuses combinations** where the requested
  register count, ribbon heights and frame borders leave no register above the
  minimum field extent. This is an error, not an omission: the author asked for
  registers and got none.
- **A `return` face refuses `field` bays.** A return that is wide enough to hold
  a field is a sign the body should be `rectangular` rather than `tablet`, and
  the diagnostic says so.
- **Frames are subtracted before bays, never after.** Allocating bays first and
  then insetting them produces bays that no longer sum to the band, which is
  what leaves an uneven margin at one end of a run.

---

## 11. Condition and damage grammar

Condition follows the core grammar: a stage supplies parameter ranges, and
events supply the actual damage.

Stages, reused unchanged:

```text
new
maintained
weathered
abandoned
ruined
excavated
partially_reconstructed
```

Family event vocabulary:

```text
weathered_surface
edge_loss
corner_loss
chipped_field
spalled_face
crack_network
split_body
broken_crown
truncated_body
missing_base
tilt
partial_burial
```

```yaml
StelaDamage:
  id: crown_loss
  type: truncated_body
  target: structure/stela_01/body
  origin: {face: front, v: 0.82}
  extent: {falloff: irregular, spread: 0.35}
  severity: 0.7
  propagation: {to_slots: true, to_crown: true, to_base: false}
  debris: {generate: true, destination: ground}
```

The rule that everything downstream depends on:

> **Damage never deletes the slot table.** A damaged slot stays addressable and
> changes its `condition` to `partial` or `lost`. A `partial` slot narrows its
> `inscribed` rectangle to the area that survives and reduces its depth budget
> accordingly; a `lost` slot keeps its id, its plane and its extent, and reports
> that nothing can be placed there.

An ornament system can therefore place content on a ruined stela without
re-resolving it, and the same authored composition can be shown intact and
ruined side by side with the slot ids matching. If damage were allowed to remove
slots, every condition change would silently renumber the composition.

Damage is driven by the `condition` seed alone. A change to that seed must leave
the ground, base, body and crown massing byte-identical — the anti-regression
rule the Mass family already asserts, applied here from the start.

---

## 12. Constraints and validation

A stela is valid when:

- the base footprint contains the body footprint at their shared plane;
- the crown is fully supported by the body's top plane, except where a member's
  vocabulary explicitly projects past it (`corbel_cap`, `flared_cap`, `t_shaped`,
  `capital_and_capstone`);
- band heights sum to the body height and bay widths sum to their band;
- taper does not invert: the top width and thickness stay positive;
- every slot lies inside its face and no two slots on a face overlap;
- a wrapping band closes around all four faces at one `v` interval;
- burial depth is less than the total stack height;
- the minimum core thickness survives both opposed recess budgets.

Each failure reports a named diagnostic:

```text
stela.base_smaller_than_body
stela.crown_unsupported
stela.band_allocation_mismatch
stela.bay_allocation_mismatch
stela.taper_inverted
stela.slot_overlap
stela.slot_outside_face
stela.wrapping_band_not_closed
stela.burial_exceeds_height
stela.core_thickness_exhausted
stela.register_density
stela.field_on_return_face
```

Invalid combinations produce recoverable named errors and leave the last valid
composition active. Omissions — a frame too small to resolve, a slot below
minimum extent, a base too shallow for a face slot — are not errors and are not
reported as such.

The topology fixtures require zero coincident faces, zero buried faces, and no
outward-facing holes for every archetype, matching the Pillar Hall requirement.

---

## 13. Material ownership

New indexed material slots, appended to the shared table because the index in
that table is the draw-group index:

```text
stelaBody
stelaFrame
stelaField
stelaCrown
```

Reused shared surfaces: `stone` for a constructed base's masonry, `pedestal` for
base members, `cornice` for projecting crown caps, `trim` for edge treatments.

The graph owns a `stelae` container holding the family records listed in §2. It
has no schema-version marker, in keeping with every other container. The Mass
and Pillar Hall families contain no stela controls and no stela geometry branch,
and this family contains no platform, cell or pillar controls.

Contact ownership is resolved per exposed rectangle, as in the Pillar Hall: a
frame rail or a crown member may cover only part of a larger face, so the
covered sub-rectangle is removed while the remaining face is retained. A
centroid hit is never allowed to erase a whole quad.

---

## 14. Canonical data schema

The following is illustrative and engine-neutral. It is intentionally explicit
so it can be mapped to JSON, typed classes, ECS components or editor assets.

```yaml
stela:
  id: stela_01
  seed: 1704
  units: meters
  archetype: banded_column
  transform: {position: [0, 0, 0], rotation_y: 0}

  ground:
    contact: sunk
    burial_depth: 0.25
    apron_width: 0.0

  base:
    treatment: socket_block
    height: 0.55
    projection_ratio: 1.38
    socket_depth: 0.12
    masonry: none
    faces: {slots: true, band_role: base_return}

  body:
    cross_section: square
    width: 0.85
    thickness: 0.85
    height: 3.60
    taper: tapered
    taper_ratio: 0.94
    edge_treatment: chamfered
    edge_size: 0.035
    min_core_thickness: 0.30

  crown:
    treatment: capital_and_capstone
    height: 0.72
    sections:
      - {role: neck, height_ratio: 0.18, width_ratio: 1.00}
      - {role: capital, height_ratio: 0.52, width_ratio: 1.24}
      - {role: capstone, height_ratio: 0.30, width_ratio: 1.42}
    crown_face: true

  faces:
    - {orientation: front, role: primary}
    - {orientation: rear, role: primary}
    - {orientation: side_positive_u, role: primary}
    - {orientation: side_negative_u, role: primary}

  bands:
    - {id: base_return, role: base_return, height: 0.18, continuity: wrapping}
    - {id: register_01, role: register, weight: 1, continuity: per_bay}
    - {id: ribbon_01, role: ribbon, height: 0.14, continuity: wrapping}
    - {id: register_02, role: register, weight: 1, continuity: per_bay}
    - {id: ribbon_02, role: ribbon, height: 0.14, continuity: wrapping}
    - {id: register_03, role: register, weight: 1, continuity: per_bay}
    - {id: ribbon_03, role: ribbon, height: 0.14, continuity: wrapping}
    - {id: register_04, role: register, weight: 1, continuity: per_bay}
    - {id: crown_return, role: crown_return, height: 0.10, continuity: wrapping}

  bays:
    register: [{id: field, role: field, weight: 1, hierarchy: 3}]
    ribbon: [{id: run, role: ribbon, weight: 1, hierarchy: 1}]

  frame:
    style: raised_border
    border_width: 0.055
    border_depth: 0.022
    inset_u: 0.03
    inset_v: 0.03
    return: sloped
    scope: per_register

  symmetry: bilateral

  condition:
    stage: weathered
    seed: 88
    events:
      - {type: weathered_surface, severity: 0.35}
      - {type: edge_loss, target: chamfer, severity: 0.4}

  output:
    emit_slots: true
    emit_anchors: true
    emit_patches: true
```

---

## 15. Generation order

### Phase 1 — Resolve configuration

Apply the archetype preset, overlay authored values, derive subsystem seeds,
validate control ranges.

### Phase 2 — Ground interface

Resolve contact type, burial depth and apron. Establish the stack's bottom
plane.

### Phase 3 — Base profile

Resolve the base member stack against body width and base height. Emit base
patches and, where the treatment allows it, a masonry rule.

### Phase 4 — Body volume

Resolve cross-section, width, thickness and height. Establish the body's bottom
and top planes against the base and the crown.

### Phase 5 — Taper and edge treatment

Apply taper to the top footprint. Subtract edge treatment from each face's
usable width. Emit face patches with their evaluators.

### Phase 6 — Face roles

Assign a role to each face from the cross-section, and derive which slot kinds
each face may carry.

### Phase 7 — Bands

Allocate fixed-height bands, then distribute the remainder across weighted
registers. Resolve wrapping bands once and apply their interval to every face.

### Phase 8 — Bays

Allocate fixed-width bays and corner reserves per band, then distribute the
remainder across weighted bays. Apply bilateral symmetry where requested.

### Phase 9 — Frames

Resolve frames at their declared scope. Clamp border width and inset against
each target rectangle. Omit frames that would consume their field.

### Phase 10 — Crown

Resolve the crown member stack against the body's resolved top width. Emit crown
patches and the `crown_face` surface where the vocabulary exposes one.

### Phase 11 — Slot emission

Compute each surviving rectangle's boundary, inscribed rectangle, metric extent
and aspect. Compute depth budgets against resolved neighbours and the core
thickness rule. Drop rectangles below the minimum usable extent.

### Phase 12 — Construction

Resolve masonry courses on a constructed base only.

### Phase 13 — Condition

Apply the stage and its damage events to the resolved form, driven by the
`condition` seed alone.

### Phase 14 — Slot condition update

Mark each slot `intact`, `partial` or `lost` from the damage that reached it,
narrowing `inscribed` and reducing `depth_budget` on partials.

### Phase 15 — Publication and validation

Emit regions and anchors onto face patches, write the family records, and run
every §12 constraint.

Slot emission is Phase 11 and slot condition update is Phase 14. That ordering
is what makes "damage never deletes the slot table" mechanical rather than
aspirational: the table exists in full before any damage runs, and damage can
only annotate it.

---

## 16. Worked examples

### 16.1 Framed tablet

**Intent:** A broad tablet whose heavy raised border and stacked registers do the
composing, so ornament fills three clearly bounded fields rather than one open
plane.

```text
Ground:
  flush contact
  no burial

Base:
  stepped pedestal
  three courses, projection 1.30 x body width

Body:
  tablet cross-section
  thin relative to width, no taper
  square edges

Bands:
  base return
  three weighted registers
  thin margin bands between registers
  crown return

Frame:
  raised border, sloped return
  scope per register

Crown:
  flat with a shallow projecting cap

Slots:
  three fields on the front face, one per register
  one full-height vertical ribbon on each return
  one base face slot on the pedestal riser
```

Key constraints:

- Reserve border width on all four sides of each register before the field is
  measured.
- Keep the return ribbons narrower than the minimum field extent, so a return
  can never be mistaken for a primary face.
- Cap field relief at the border depth, so no field overtops its own frame.

### 16.2 Banded column

**Intent:** A square shaft read as a stack of registers, with wrapping ribbons
doing the separating and a capital and capstone finishing the silhouette.

```text
Ground:
  sunk contact, shallow burial

Base:
  socket block, body seated in a real recess

Body:
  square cross-section
  slight taper
  chamfered vertical edges

Bands:
  base return
  four weighted registers
  three wrapping ribbons between them
  crown return

Frame:
  raised border, scope per register

Crown:
  capital and capstone
  crown face exposed on the capstone top

Slots:
  sixteen fields, four per face
  three wrapping ribbon runs, each closing around four faces
  one crown face slot
```

Key constraints:

- A wrapping ribbon resolves one `v` interval and four widths, because the taper
  makes each face narrower than the one below at the same height.
- Every field publishes a trapezoidal boundary and an inscribed rectangle; the
  taper is small but the top registers are measurably narrower.
- Split the recess budget across the front/rear and side pairs independently so
  four carved faces still leave a core.

### 16.3 Weathered tablet

**Intent:** The same authored form as a plain tablet, shown after long exposure,
demonstrating that condition is an axis rather than a preset.

```text
Archetype:
  tablet, unchanged

Ground:
  partial burial reaching the first register

Condition:
  stage weathered
  truncated body at the crown
  spalled face across the upper primary field
  corner loss on both upper arrises
  crack network on the rear face

Slots:
  crown face slot present, condition lost
  upper field present, condition partial, inscribed rectangle narrowed
  lower field present, condition intact
  buried base face slot omitted
```

Key constraints:

- The slot ids are identical to the intact form's. Only `condition`, `inscribed`
  and `depth_budget` differ.
- The buried base slot is omitted at Phase 11 because it falls below the ground
  plane, not marked `lost` at Phase 14 — omission and loss are different states
  and mean different things to a consumer.
- Regenerating with a different `condition` seed must leave the massing graph
  byte-identical.

---

## 17. Current implementation status

**Nothing in this document is implemented.** There is no `stelae` container on
the graph, no family folder, no registry entry, no control tab and no fixture.
This specification is authored ahead of its code, as the Pillar Hall vocabulary
and the surface operation vocabulary were.

When it is implemented, the project's standing discipline applies without
exception: every vocabulary in this document ships as a `FOO` / `IMPLEMENTED_FOO`
pair, and a named-but-unbuilt member produces a coded error rather than falling
back to a neighbour. A `corbel_cap` that quietly resolves as a `stepped_cap`
would mean a composition authored today silently changes meaning the day the
real reader lands, which is precisely the failure this rule exists to prevent.

A first implementation slice should resolve the three archetypes in §5
completely rather than resolving all of §6 partially. The Pillar Hall precedent
is the right one: prove the composition on concrete presets, and let the
vocabulary that no preset exercises stay a named error until a preset needs it.

Deliberately left as future research, and not to be generalized into the core
until a second concrete family proves the abstraction:

- curved, stepped and polygonal body plans;
- stela groups, rows, alignments and plaza arrangements;
- socket-and-tenon assembly between a stela and a host platform or terrace,
  including placement from a host `PatchAnchor`;
- chamfer strips as addressable slots;
- ornament content generation of any kind, whether geometry or texture;
- a shared slot abstraction across families. Slots here are stela slots. If the
  Pillar Hall's pier panels and a stela's fields turn out to want the same
  record, that is a discovery to be made from two working implementations, not
  a design to be imposed on the first.
