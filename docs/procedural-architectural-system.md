# Procedural Architectural System

## A Surface-First Grammar for Platforms, Pyramids, Summit Buildings, and Pillar Halls

**Document status:** System specification  
**Primary domain:** Rectilinear monumental and ceremonial architecture  
**Core abstraction:** Semantic rectangular patches assembled into masses, cells, family-owned structures, and attachments
**Intended uses:** Procedural modeling, game environments, architectural variation, reusable asset generation, level-design tooling, and data-driven content pipelines

---

## 1. Purpose

This document formalizes a procedural architectural system capable of generating:

- Low ceremonial platforms and podiums.
- Multi-tier terraces and stepped pyramids.
- Continuous or segmented stair systems.
- Enclosed summit temples, gatehouses, palaces, and towers.
- Open pier-and-lintel screens, front galleries, and open-front pavilions.
- Pillars, piers, columns, beams, cornices, parapets, and roof structures.
- Masonry, surface ornament, weathering, vegetation, and coherent structural damage.
- Combinations of the above as one hierarchical monument.

The system is surface-first, but not surface-only. Its smallest addressable architectural domain is a semantic rectangular **patch**. Larger forms are constructed with four complementary composition systems:

1. **Mass system** — closed volumes such as platforms, pyramids, walls, towers, and roof blocks.
2. **Cell system** — enclosed or partially enclosed spatial units such as rooms, passages, and courtyards.
3. **Family assembly system** — structure-specific arrangements such as Pillar Hall screens, galleries, and pavilions.
4. **Surface system** — masonry, openings, moldings, reliefs, damage, and material treatment applied to generated patches.

These systems share coordinates, attachment rules, materials, edge treatments, and constraints. A pyramid is therefore not a unique primitive, and a temple is not a single predefined mesh. Both are compositions made from reusable architectural rules.

---

## 2. Design Principles

### 2.1 Rectangularity belongs to the parametric domain

Every patch begins with a stable rectangular coordinate domain, even when its final visible boundary is sloped, clipped, stepped, eroded, displaced, or partially missing.

Normalized coordinates use:

- `u ∈ [0, 1]` across the patch width.
- `v ∈ [0, 1]` across the patch height or depth.
- `n` along the patch normal.

This makes features independent of real-world scale:

```text
stair region      = u: 0.35–0.65
frieze band       = v: 0.72–0.88
collapsed region  = u: 0.70–1.00, v: 0.35–0.80
column spacing    = repeated across u
```

The final silhouette does not have to remain rectangular. The stable rectangular domain exists so rules remain predictable and composable.

### 2.2 Semantic geometry precedes render geometry

Generated geometry must retain architectural meaning. A wall is not merely a set of triangles; it is a facade patch with a base edge, crown edge, material family, neighboring patches, feature zones, and attachment anchors.

Semantic identity enables:

- Consistent placement.
- Rule validation.
- Damage propagation.
- LOD generation.
- Material assignment.
- Navigation generation.
- Regeneration of individual subsystems.
- Designer selection and editing.

### 2.3 Composition is hierarchical

A complete monument is a tree or directed acyclic graph of dependent components:

```text
Monument
├── site anchor
├── foundation mass
│   ├── elevation bands
│   ├── terraces
│   ├── stairs
│   └── summit patches
├── summit superstructures
│   ├── cell assemblies
│   └── family-owned structures
├── roofs and crowns
├── attachments
├── surface treatments
└── damage and environment
```

Children resolve against stable surfaces or anchors exposed by their parents.

### 2.4 Variation is constrained, not purely random

Random values must be sampled within architectural relationships. Examples:

- A stair terminates on a walkable upper surface.
- A beam spans compatible supports.
- A roof covers valid cells or bay ranges.
- A doorway connects two spaces or a space and the exterior.
- A crown emphasizes an already important bay.
- Damage cannot leave an unsupported intact roof unless the style explicitly permits a ruin-state exception.

### 2.5 Structure, appearance, and condition are separable

The generator should maintain independent but compatible layers:

```text
Architectural grammar  → topology and form
Construction grammar   → blocks, joints, courses, slabs
Style grammar          → proportions, profiles, ornament choices
Condition grammar      → erosion, collapse, cracks, missing elements
Material grammar       → stone type, color, roughness, staining
Environment grammar    → moss, roots, soil, debris, water effects
```

One architectural structure can therefore receive many construction, style, and condition treatments without changing its fundamental topology.

---

## 3. System Vocabulary

### 3.1 Core entities

| Entity | Definition |
|---|---|
| **Structure** | Root object containing all masses, spaces, family-owned structures, surfaces, attachments, and rules. |
| **Mass** | Closed or mostly closed architectural volume composed of patches. |
| **Patch** | Bounded semantic surface with a local frame and normalized coordinates. |
| **Region** | A normalized subdomain of a patch used by a feature or placement rule. |
| **Feature** | An operation that modifies, replaces, subdivides, decorates, or removes part of a patch. |
| **Edge** | Named patch boundary that can receive a trim, transition, connection, or damage rule. |
| **Band** | Horizontal or vertical architectural layer with a profile and semantic role. |
| **Cell** | Rectangular spatial unit representing a room, passage, solid block, court, or void. |
| **Bay** | Interval between supports or a logical subdivision of a facade. |
| **Support** | Vertical load-bearing member such as a pier, pillar, or column. |
| **Span** | Horizontal member connecting supports, walls, or structural anchors. |
| **Connector** | Traversable or topological connection between surfaces or cells. |
| **Attachment** | A child object anchored to a patch, edge, region, cell, support, or span. |
| **Profile** | Ordered cross-sections or offsets defining a shape through height or distance. |
| **Anchor** | Stable semantic placement point, line, plane, or frame exposed to child systems. |
| **Rule set** | Constraints and weighted choices applied to one class of entity. |
| **Style preset** | Coordinated parameter ranges and permitted motifs, not a finished structure. |

### 3.2 Patch roles

Recommended patch roles include:

```text
ground_interface
floor
summit_floor
terrace
landing
roof
roof_walkway
vertical_facade
battered_facade
stepped_facade
transition_band
base_plinth
cornice
frieze
parapet
curb
stair_tread
stair_riser
stair_side
opening_reveal
column_surface
beam_surface
interior_wall
ceiling
drain_channel
ruin_break
```

Roles should be extensible. Rules should query roles or tags instead of hard-coded object names.

---

## 4. Coordinate and Measurement Model

### 4.1 World and local frames

Each structure has:

- A world transform.
- A declared up axis.
- A front or primary approach direction.
- A footprint frame.
- A unit scale.

Each patch stores:

```text
origin
u_axis
v_axis
normal
u_length
v_length
orientation
handedness
```

The patch-to-world transformation maps normalized patch coordinates to real space:

```text
P(u, v, d) =
    origin
  + u_axis * (u * u_length)
  + v_axis * (v * v_length)
  + normal * d
```

A patch may replace the planar mapping with a parametric evaluator for sloped, stepped, or displaced geometry while preserving the same `u`, `v`, and `d` interface.

### 4.2 Units

Store dimensions in real units. Derived proportions may be expressed as ratios.

Recommended categories:

- **Absolute dimensions:** width, height, wall thickness, tread depth.
- **Relative dimensions:** stair width as a fraction of facade width.
- **Counts:** terrace count, bay count, block rows.
- **Target dimensions:** desired riser height or masonry block width.
- **Tolerances:** join tolerance, coplanarity tolerance, minimum visible thickness.

### 4.3 Orientation vocabulary

Avoid ambiguous labels such as `left` without a reference frame. Use:

```text
front
rear
side_positive_u
side_negative_u
top
bottom
inward
outward
clockwise
counterclockwise
approach_axis
```

Human-readable aliases may be derived from these for an editor.

---

## 5. Surface and Patch System

### 5.1 Patch definition

Every patch should contain:

```yaml
Patch:
  id: string
  role: PatchRole
  frame: LocalFrame
  dimensions:
    u: number
    v: number
    thickness: number
  shape:
    domain: rectangle
    boundary_mask: optional
    evaluator: planar | battered | stepped | custom
  edges:
    u_min: EdgeRef
    u_max: EdgeRef
    v_min: EdgeRef
    v_max: EdgeRef
  adjacency: [PatchRef]
  regions: [Region]
  features: [Feature]
  anchors: [Anchor]
  tags: [string]
  material_ref: MaterialRuleRef
  construction_ref: ConstructionRuleRef
  condition_ref: ConditionRuleRef
```

### 5.2 Regions

A region identifies all or part of a patch:

```yaml
Region:
  id: entrance_zone
  bounds:
    u: [0.35, 0.65]
    v: [0.00, 1.00]
  mask: optional
  priority: 100
  allowed_operations: [replace, cut, frame]
  exclusions: [corner_reserve]
```

Region types:

- Rectangular range.
- Repeated strips.
- Edge-relative band.
- Centered range.
- Corner range.
- Masked or noise-eroded range.
- Region derived from another feature.

Regions may overlap only when operation ordering and compatibility are declared.

### 5.3 Patch operations

Surface features use a small, composable operation vocabulary:

| Operation | Effect |
|---|---|
| `inset` | Moves a region inward and creates reveal surfaces. |
| `extrude` | Projects a region outward or inward. |
| `cut` | Creates an opening or removes material. |
| `replace` | Substitutes another generator, such as stairs, for the selected region. |
| `subdivide` | Produces bays, panels, courses, blocks, or tiles. |
| `repeat` | Places geometry or features at intervals. |
| `step` | Converts a region into discrete levels. |
| `slope` | Converts a region into a planar incline or batter. |
| `frame` | Adds members around a boundary. |
| `cap` | Closes or crowns a boundary. |
| `border` | Adds an edge-relative strip or molding. |
| `displace` | Perturbs visible geometry while preserving the semantic domain. |
| `clip` | Changes the visible boundary using a mask or profile. |
| `remove` | Deletes cells, blocks, or geometry inside a condition mask. |
| `attach` | Instantiates a child entity at anchors or within a region. |

### 5.4 Feature precedence

A predictable default order is:

1. Patch boundary and gross profile.
2. Structural replacement features.
3. Openings and connectors.
4. Architectural bands and edge treatments.
5. Panel and bay subdivision.
6. Masonry subdivision.
7. Ornament attachments.
8. Condition and damage.
9. Fine displacement and material variation.

Features may declare dependencies:

```yaml
depends_on: [facade_bays]
runs_before: [masonry]
runs_after: [portal_cut]
conflict_policy: clip | skip | replace | error
```

**Current implementation status:** rectangular
regions on planar patches can execute `cut`, `inset`, and `extrude`.
Dependencies and `runs_before` / `runs_after` references are resolved within one
patch, and overlapping features apply the declared `clip`, `skip`, `replace`, or
`error` policy. Cuts remove the
full wall depth; insets and extrusions change the real public wall boundary, so
their returns do not overlap a surviving base face. Cell portals, facade windows,
niches, panels, pilasters, friezes, and interior doors use this pipeline. The
facade-authored operations also name their semantic material owner. Tessellation
preserves that owner on opening reveals, inset backs and returns, and projected
fronts and sides while leaving adjacent wall faces unchanged. The
remaining operation vocabulary is typed and validated but returns a named
unimplemented error until its geometry reader is added.

### 5.5 Edge features

Edges are first-class because many architectural details follow boundaries:

- Base plinths.
- Coping stones.
- Terrace lips.
- Cornices.
- Parapets.
- Curbs.
- Drain channels.
- Stair stringers.
- Corner quoining.
- Roof eaves.
- Ruined break caps.

An edge feature should support:

```text
profile
projection
height or depth
continuity
corner join
termination
repetition
material override
damage inheritance
```

Corner joins may be:

```text
mitered
butted
overlapped
corner_block
wrapped
interrupted
ruined
```

---

## 6. Mass System

### 6.1 Mass definition

A mass is generated from:

```yaml
Mass:
  id: string
  footprint: Footprint
  elevation_profile: ElevationProfile
  transform: Transform
  patch_rules: PatchRules
  attachments: [Attachment]
  boolean_relations: optional
  tags: [string]
```

### 6.2 Footprints

The canonical footprint is a rectangle, but larger plans can be composed from rectangles.

Primitive footprint parameters:

```text
width
depth
aspect_ratio
orientation
origin
corner_chamfer
corner_clip
corner_radius
symmetry_axes
```

Composite footprint arrangements:

```text
single rectangle
square
offset rectangles
stepped plan
cross plan
T plan
L plan
U plan
twin platforms
perimeter platform
central court
multi-courtyard composition
```

Composite plans should retain their constituent rectangular domains rather than immediately collapsing into an anonymous polygon.

### 6.3 Elevation profiles

An elevation profile is an ordered series of vertical bands:

```yaml
ElevationBand:
  id: lower_body
  rise: 2.4
  setback:
    front: 0.6
    rear: 0.6
    side_positive_u: 0.5
    side_negative_u: 0.5
  wall_profile: battered
  lower_transition: plinth_simple
  upper_transition: cornice_heavy
  surface_role: battered_facade
```

Supported wall profiles:

```text
vertical
battered
stepped
terraced
concave
convex
compound
alternating
custom_section
```

The horizontal section may change by band. This permits asymmetrical setbacks, projecting stairs, rear service terraces, or offset summit areas.

### 6.4 Band transition types

Transitions between bands may be:

```text
none
flush joint
ledge
walkable terrace
simple slab
beveled molding
rounded molding
double molding
triple molding
inset band
projected coping
drainage channel
ruined break
```

### 6.5 Platforms and pyramids

Platforms and pyramids use the same mass grammar.

```text
Low platform:
    base → one shallow rise → coping → summit

Terraced platform:
    base → rise → terrace → rise → summit

Stepped pyramid:
    repeat(rise → ledge → setback) → summit

Temple pyramid:
    pyramid mass → summit connector → summit building
```

The semantic distinction is a preset or classification derived from proportion and band count, not a separate geometry class.

Useful parameters:

```text
terrace_count
total_height
band_height_distribution
setback_distribution
summit_target_size
batter_angle
terrace_walkability
frontality
axial_symmetry
side_symmetry
rear_access
base_apron
summit_curb
```

### 6.6 Base and summit treatments

Base vocabulary:

```text
none
simple_plinth
double_plinth
projected_footing
beveled_footing
rounded_footing
stepped_apron
buried_foundation
irregular_ground_transition
```

Summit vocabulary:

```text
open_floor
low_curb
parapet
drain_channel
stylobate
raised_pad
multiple_building_pads
courtyard
altar_pad
roofed_superstructure
```

The summit exposes placement regions, approach axes, no-build margins, drainage zones, and structural capacity tags.

---

## 7. Stairs and Connectors

### 7.1 Connector semantics

Stairs are not decorative surface patterns. A stair is a traversable connector between two horizontal surfaces:

```yaml
StairConnector:
  id: primary_stair
  lower_surface: PatchRef
  upper_surface: PatchRef
  direction: approach_axis
  width: 8.0
  alignment: centered
  elevation_mode: continuous
  step_rule:
    target_riser: 0.22
    target_tread: 0.34
  landings: []
  side_treatment: solid_parapet
  termination:
    lower: projecting
    upper: flush
```

### 7.2 Stair layout types

```text
front_centered
front_offset
twin_parallel
split
return
corner
side
rear
four_sided
wrapped
switchback
cross_axial
hidden_service
```

### 7.3 Elevation modes

- **Band-local:** Each terrace has a separate stair and landing.
- **Continuous:** One stair crosses several elevation bands without interruption.
- **Terrace-interrupted:** Stair flights stop at selected terraces.
- **Offset flights:** Successive flights shift laterally.
- **Split approach:** One lower flight branches into multiple upper flights.

### 7.4 Step resolution

The generator may accept:

- Exact step count.
- Target riser height.
- Target tread depth.
- Maximum slope.
- A style-specific rise/run ratio.

The system resolves a consistent integer count and reports deviations from targets.

### 7.5 Landings

Landing rules include:

```text
none
at_every_terrace
at_selected_bands
periodic_after_n_steps
ceremonial_deep_landing
split_landing
summit_forecourt
```

Landings are patches and may receive railings, stelae, braziers, portals, or damage.

### 7.6 Stair side treatments

```text
none
low_curb
projecting_stringer
solid_parapet
stepped_parapet
sloped_parapet
tapered_parapet
terraced_parapet
sculptural_terminal
serpent_like_profile
ruined_sidewall
```

Side treatments expose:

- Outer face.
- Inner face.
- Top cap.
- Lower terminal.
- Upper terminal.
- Optional attachment anchors.

### 7.7 Stair constraints

A valid stair connector must:

- Begin and end on compatible traversable patches.
- Fit inside its reserved facade and terrace regions.
- Clear parapets, columns, doorways, and roof supports.
- Maintain minimum edge margins.
- Match the intended approach direction.
- Avoid negative or vanishing tread depth.
- Provide landings wherever flights are intentionally interrupted.
- Propagate openings through terrace curbs when needed.

---

## 8. Cell-Based Summit Buildings

### 8.1 Cell definition

A cell is a spatial or volumetric rectangular unit:

```yaml
Cell:
  id: central_room
  footprint:
    x: 0
    y: 0
    width: 6
    depth: 5
  height: 4.5
  occupancy: room
  wall_thickness: 0.75
  floor_level: 0
  facade_rules: temple_primary
  roof_group: central_roof
  connections: [front_portal, rear_door]
  tags: [primary, axial]
```

Occupancy types:

```text
solid
room
passage
open
courtyard
shaft
stair_core
raised_tower
roof_void
ruined
```

### 8.2 Plan composition

Cells may form:

```text
single chamber
linear room sequence
three-bay building
central hall with side rooms
twin chamber
front porch plus sanctuary
gatehouse
U-shaped palace
perimeter rooms around a court
multi-courtyard compound
raised central tower with wings
```

Plan logic should identify:

- Exterior boundaries.
- Shared walls.
- Interior connections.
- Primary axis.
- Public-to-private depth.
- Courtyard edges.
- Roof-span groups.
- Load-bearing wall chains.

### 8.3 Cell merging

Adjacent cells may share walls or be merged into larger rooms. Merging rules specify:

```text
shared wall removal
partial opening
beam substitution
column substitution
floor continuity
ceiling continuity
roof group continuity
material continuity
```

### 8.4 Openings as connections

An opening is a topological connection:

```yaml
Opening:
  id: main_portal
  source: exterior_front
  destination: central_room
  wall: PatchRef
  position:
    alignment: centered
    offset: 0
  width: 2.8
  height: 3.8
  profile: corbelled
  depth: auto
  frame_treatment: stepped_frame
  threshold: raised
```

Opening profiles:

```text
rectangular
tapered
trapezoidal
stepped
corbelled
pointed_corbel
double_width
lintelled
screened
partially_blocked
ruined
```

Opening types:

```text
door
portal
window
clerestory
vent
niche
passage
screened_pier_opening
lattice_panel
roof_access
```

### 8.5 Height hierarchy

Height variation is semantic:

```text
secondary wing < primary wing ≤ central bay < crown
service cells ≤ public rooms
portal emphasis follows approach hierarchy
roof height follows span and importance
```

Useful role tags:

```text
secondary
primary
axial
terminal
corner
gateway
sanctuary
service
ceremonial
circulation
```

A generator should derive height ranges from these roles instead of assigning arbitrary independent heights.

### 8.6 Summit placement constraints

Cell assemblies must:

- Fit inside summit buildable regions.
- Respect summit setbacks and drainage margins.
- Preserve the stair arrival and forecourt.
- Align important portals with approach connectors.
- Reserve exterior circulation where required.
- Avoid walls over unsupported voids unless bridging is explicit.
- Expose roof and facade patches to downstream systems.

---

## 9. Pillar Hall System

### 9.1 Family definition

Pillar Hall is a dedicated structure family for the inspired square-pier and
lintel compositions this project currently builds. It is not a historical
reconstruction and does not carry a cultural label. It also does not sit on a
generic Frame graph: its rows, bays, pier profiles, decorative panels, spans,
and optional roof are owned and validated together by the family.

```yaml
PillarHall:
  archetype: linear_screen | front_gallery | open_pavilion
  platform: SteppedPlatform
  approach: FrontStair | none
  rows: [PillarRow]
  pier_profile: SteppedPierProfile
  lintels: [BayLintel]
  roof: ShallowSlab | none
```

### 9.2 Implemented archetypes

The first slice resolves three complete compositions:

```text
linear_screen
  low two-tier base
  one row, five bays by default
  continuous structural base with one full-depth centred plinth per pier
  two recessed decorated panel fields per bay and end buttresses
  exposed lintels, no stair, no roof

front_gallery
  three-tier platform and centred stair
  parallel front and rear rows, five bays by default
  shallow slab over the full gallery range

open_pavilion
  three-tier platform and broad centred stair
  open-front U plan: rear row plus both side rows
  exposed lintels, no front cross-row, no roof
```

These are authored presets, not labels inferred from geometry. Selecting an
archetype establishes a coherent starting composition; every exposed numeric
control remains editable afterward.

### 9.3 Bays

A bay is the open interval between neighbouring square piers. It owns its two
support references, resolved width, row, and lintel. Before bays are divided,
the resolver subtracts the actual outer extents of the pier profile, raised
panels, lintel/cornice depth, roof projection, and Linear Screen terminations
from the summit area. Bay counts are positive integers; they are not forced odd
because the stair is a platform connector, not a special entrance bay cut
through the upper assembly. A density constraint refuses combinations where
the remaining run and selected pier width leave no credible opening.

The U plan deduplicates its two rear corner supports across the rear and side
rows. That shared ownership is part of the family record, not an accidental
overlap in the mesh.

### 9.4 Stepped piers

Every support uses the same fixed proportional stack, scaled by authored pier
height and shaft width:

```text
foot         12% height, 1.55 x shaft width
lower panel  36% height, 1.30 x shaft width
shaft        30% height, 1.00 x shaft width
capital      14% height, 1.30 x shaft width
capstone      8% height, 1.65 x shaft width
```

The lower block derives one to four stacked panel fields from its resolved width
and height; the default proportions produce three near-square fields. The shaft
exposes one taller field on all four faces. Horizontal and vertical insets and
rail widths are clamped independently from each field's available dimensions.
Four shallow border rails leave the pier core visible behind each field, so
every centre is genuinely recessed relative to its indexed panel border without
requiring literal glyph sculpture.

### 9.5 Lintels and upper profiles

One rectangular lintel spans every resolved bay. Interior lintel pieces meet on
their shared support centre, while the two terminal pieces and continuous
cornice extend to one common end plane. This makes perpendicular Open Pavilion
rows close cleanly over their shared corner piers and keeps the exposed end
layers vertically aligned. `spanEndProjection` moves that common plane beyond
the square end implied by the cornice depth. Linear Screen and Open Pavilion
expose this upper work directly; Front Gallery uses it as the bearing line for
its shallow slab.

### 9.6 Decorative language

The first slice uses only stepped rectangular construction:

- layered pier feet, capitals, and capstones;
- recessed shaft and lower-block panel fields;
- a support-panel-support base rhythm on the Linear Screen, with every
  full-depth projecting plinth centred beneath and containing its pier footprint,
  and paired recessed fields filling each bay;
- stepped end buttresses;
- projecting cornice bands.

No motif claims an archaeological source. Literal reliefs, glyph sculpture,
figurative terminals, damage, and vegetation remain later attachment or surface
work.

### 9.7 Roof rule

Only Front Gallery emits a roof in this slice. It is one shallow rectangular
slab spanning the front and rear row range with a small projection. Linear
Screen and Open Pavilion deliberately remain roofless so their lintels and
capstones retain the silhouette shown by the reference direction.

### 9.8 Constraints and material ownership

A Pillar Hall is valid when every row fits its summit rectangle, the gallery row
depth remains inside the platform, bay openings clear the selected pier width,
and every span has both supports. Invalid combinations produce named recoverable
validation errors and leave the last valid composition active.

The graph owns `pillarHalls` records for rows, supports, bays, members, and the
optional family roof. It has no schema-version marker and no `frames` container.
`pedestal`, `pier`, `pierPanel`, and `lintel` are independent indexed material
slots; `stone`, `stairs`, `frieze`, `cornice`, and `roof` are reused shared
surfaces. The Mass family contains no Pillar Hall controls or geometry branch.

Contact ownership is resolved per exposed rectangle. Perpendicular lintels and
members may cover only part of a larger side, so the covered sub-rectangle is
removed while the remaining face is retained; a centroid hit is never allowed
to erase an entire quad. The topology fixtures require zero coincident faces,
zero buried faces, and no outward-facing holes for every archetype.

Generic infill grammars, missing-member masks, arches, round supports,
hypostyle grids, and arbitrary roof ranges are future research. They should not
be reintroduced as a generic core until a concrete family needs them and proves
the abstraction against more than one credible composition.

---

## 10. Pillars, Piers, and Columns

### 10.1 Profile-stack model

Supports are built from vertical profile sections rather than fixed models:

```yaml
SupportProfile:
  id: square_pier_heavy
  cross_section: square
  sections:
    - role: plinth
      height: 0.25
      width: 1.30
      depth: 1.30
      transition: step
    - role: base
      height: 0.35
      width: 1.10
      depth: 1.10
      transition: bevel
    - role: shaft
      height: 3.00
      width_bottom: 0.85
      width_top: 0.78
      depth_bottom: 0.85
      depth_top: 0.78
    - role: capital
      height: 0.40
      width: 1.15
      depth: 1.15
      transition: bracket
    - role: bearing_slab
      height: 0.20
      width: 1.35
      depth: 1.35
```

### 10.2 Cross-sections

```text
square
rectangle
circle
octagon
polygon
cross
clustered
custom_profile
```

Cross-sections may change by section to produce stepped bases, tapered shafts, or broad capitals.

### 10.3 Base vocabulary

```text
none
simple_block
plinth
double_plinth
stepped_base
beveled_base
round_base
square_pedestal
animal_foot_motif
buried_base
ruined_base
```

### 10.4 Shaft vocabulary

```text
square
rectangular
round
polygonal
tapered
segmented
fluted
paneled
carved
clustered
twisted
sculptural
partially_eroded
broken
```

### 10.5 Capital vocabulary

```text
none
simple_slab
double_slab
stepped_slab
bracket
corbel
mask_motif
animal_head_motif
feather_bundle_motif
geometric_block
ruined_capital
```

Named motifs belong to a style library and should not be selected without a compatible style preset.

### 10.6 Pilasters and engaged supports

Pilasters reuse the support profile but anchor to wall patches. Their depth is constrained by wall thickness and facade bands. They may:

- Align with bay boundaries.
- Border portals with engaged supports.
- Support a cornice visually or structurally.
- Divide a long facade.
- Continue through multiple vertical bands.
- Terminate at a frieze or capital.

---

## 11. Facade Grammar

### 11.1 Horizontal subdivision

Every exterior wall can be divided into bays:

```yaml
FacadeLayout:
  patch: front_facade
  margins:
    left: 0.08
    right: 0.08
  bays:
    - role: secondary
      weight: 1
      content: niche
    - role: primary
      weight: 1.4
      content: portal
    - role: secondary
      weight: 1
      content: niche
  symmetry: mirror
```

Bay roles:

```text
solid
entrance
window
niche
recess
relief_panel
lattice_panel
column_opening
pilaster
corner_reserve
ruined
```

Bay widths may be:

- Equal.
- Weighted.
- Center-emphasized.
- Alternating.
- Mirrored.
- Derived from cell widths.
- Derived from structural-row spacing.

### 11.2 Vertical subdivision

A facade is also divided into bands:

```text
foundation or plinth
base molding
lower wall body
opening zone
transition molding
frieze
upper wall body
cornice
parapet
crown or roof comb
```

Each band specifies:

```text
height or proportional weight
projection or inset
profile
material override
subdivision rule
permitted features
continuity across bays
corner behavior
```

### 11.3 Facade feature types

```text
portal
door
window
niche
recessed panel
projecting panel
relief field
lattice screen
pilaster
engaged column
molding
frieze
cornice
mask attachment
statue niche
drain outlet
banner socket
damage field
```

### 11.4 Symmetry and hierarchy

Symmetry modes:

```text
none
approximate
bilateral
rotational
four_sided
repeated_module
broken_by_condition
```

Architectural generation and damage generation should use different symmetry controls. A structure may be generated symmetrically and then receive asymmetrical decay.

### 11.5 Facade conflicts

Reserve zones before populating features:

- Opening clearance.
- Corner masonry.
- Beam bearing.
- Roof drainage.
- Stair arrival.
- Interior wall intersections.
- Pilaster centerlines.
- Damage exclusion or focus zones.

When two features conflict, resolve by declared priority rather than arbitrary generation order.

**Current implementation status:** planar Cell
facades resolve into graph-owned `FacadeRecord` entries with stable horizontal
bays, vertical bands, hierarchy, symmetry, target wall pairs, and executable
feature ids. Bay allocation supports fixed and weighted widths plus Cell-derived
partition widths; band allocation supports fixed heights plus weighted remainder.
The `plain` grammar preserves the established summit portal result while moving
portal surface authorship out of Cell. The `hierarchical` grammar proves reuse
with a primary portal, elevated window, niches and recessed panels, pilasters,
and a continuous frieze. Those six detail families resolve to independent
indexed material groups through the same feature operations in both bare and
masonry construction. Rectangular planar Cell walls are the current geometry
boundary; arches, curved apertures, and battered Mass-facade readers remain
future work.

---

## 12. Roofs, Parapets, and Crowns

### 12.1 Roof ownership

Roofs are independent assemblies that reference the cells, walls, or family-owned structures they cover. They should not be baked into each room or support.

### 12.2 Roof types

```text
flat_slab
stepped_slab
terraced_roof
projecting_eaves
corbelled_vault_mass
raised_central_roof
multi_level_roof
open_court_perimeter
partial_roof
ruined_roof
```

### 12.3 Roof span definition

```yaml
RoofAssembly:
  id: temple_roof
  covers: [cell_left, cell_center, cell_right]
  bearing_on: [wall_chain_front, wall_chain_rear]
  elevation: auto
  thickness: 0.65
  overhang:
    front: 0.35
    rear: 0.25
    sides: 0.20
  edge_treatment: heavy_cornice
  drainage: rear_scupper
  upper_features: [central_crown]
```

### 12.4 Parapets

Parapet types:

```text
none
solid_low
solid_high
stepped
perforated
lattice
crenellated
central_emphasis
corner_blocks
ruined
```

Parapets may follow the full roof perimeter, selected edges, or a facade hierarchy.

### 12.5 Crowns and roof combs

Crowns are upper masses attached to roof zones:

```text
central crown
paired crowns
continuous roof comb
perforated roof comb
stepped silhouette
framed panel crown
tower cap
ruined fragment
```

Rules:

- Align crowns to important bays, rooms, or axes.
- Keep their footprint within valid bearing regions.
- Coordinate their width with the mass beneath them.
- Expose front and rear patches for ornament and damage.
- Avoid arbitrary placement unrelated to the composition.

### 12.6 Drainage

Optional drainage features include:

```text
roof slope
perimeter channel
scupper
projecting drain
corner outlet
terrace drain
stair-side runoff
erosion streak origin
```

Drainage anchors can drive staining and localized erosion in the condition layer.

---

## 13. Attachments and Secondary Modules

### 13.1 Attachment model

Attachments are child entities anchored semantically:

```yaml
Attachment:
  id: altar_01
  generator: altar_block
  anchor:
    target: summit_forecourt
    placement: centered
    orientation: face_approach
  footprint_clearance: 0.5
  inherit:
    material_family: true
    condition_age: true
  constraints:
    avoid: [circulation_path, drainage_channel]
```

### 13.2 Anchor types

```text
point
edge
edge_interval
patch_center
patch_region
bay_center
bay_boundary
cell_center
cell_wall
support_top
support_face
span_face
roof_region
stair_terminal
corner
repeated_grid
```

### 13.3 Attachment categories

Structural:

```text
secondary mass
annex
buttress
stair
roof
bridge
support
beam
screen wall
```

Architectural:

```text
altar
shrine
stela
bench
raised pad
fire basin
obelisk
statue pedestal
stone ring
drain outlet
```

Decorative:

```text
relief panel
mask
banner
torch
offering
carved terminal
capstone
corner block
```

Environmental:

```text
debris pile
root cluster
vine
moss patch
soil accumulation
standing water
tree
fallen block
```

### 13.4 Placement patterns

```text
single centered
paired mirrored
at corners
at bay centers
at bay boundaries
along edge
regular grid
weighted scatter
clustered
aligned to approach
aligned to doorway
condition-driven
```

Attachments must reserve clearance and declare whether they affect navigation, collision, support, or damage propagation.

---

## 14. Masonry and Construction Grammar

### 14.1 Construction layers

Separate the ideal architectural surface from its construction representation:

```text
structural shell
visible facing stones
core or fill
capstones
corner stones
mortar or dry joints
debris from missing units
```

Not every LOD needs all layers.

### 14.2 Masonry patterns

```text
uniform_ashlar
large_cut_blocks
mixed_ashlar
cyclopean
polygonal
rubble
thin_layered
alternating_courses
header_stretcher
panelized_megalithic
plastered_over_masonry
```

### 14.3 Masonry parameters

```yaml
MasonryRule:
  pattern: mixed_ashlar
  target_block:
    width: [0.45, 1.10]
    height: [0.25, 0.55]
    depth: [0.20, 0.50]
  course_alignment: semi_regular
  joint:
    width: [0.008, 0.035]
    depth: [0.005, 0.025]
    continuity: broken
  staggering: 0.55
  corner_rule: enlarged_quoin
  edge_softening: 0.015
  seed: 43192
```

### 14.4 Course strategies

```text
uniform rows
variable row heights
locally aligned rows
continuous facade courses
band-specific courses
corner-locked courses
opening-framed courses
independent patch courses
```

Continuous architectural bands should usually override local masonry variation.

### 14.5 Joint quality

```text
precise
good
rough
open
eroded
filled
collapsed
vegetated
```

### 14.6 Corner construction

Corners require explicit logic:

```text
alternating interlock
large corner blocks
wrapped courses
butted faces
quoin strip
rounded erosion
collapsed corner
later repair
```

Without corner rules, independently subdivided patches will produce implausible seams.

### 14.7 Slabs, steps, and caps

Long horizontal elements may be represented as:

```text
single monolith
regular segments
unequal segments
centered keystone-like segment
corner-to-corner cap sequence
broken or replaced segments
```

### 14.8 Material treatment

Material parameters:

```text
stone family
base color range
mineral variation
roughness
porosity
edge polish
joint darkness
lichen coverage
moss coverage
water staining
soil staining
sun bleaching
biological growth
```

Material variation should correlate with block identity, orientation, height, drainage, exposure, and condition rather than using only world-space noise.

---

## 15. Damage and Condition Grammar

### 15.1 Condition stages

```text
new
maintained
weathered
abandoned
ruined
excavated
partially_reconstructed
```

A stage provides parameter ranges; it does not prescribe identical damage.

### 15.2 Damage hierarchy

Damage operates at multiple scales:

1. **Material scale:** discoloration, pitting, lichen, fine cracks.
2. **Block scale:** chipped corners, shifted stones, missing blocks.
3. **Element scale:** broken parapet, missing column, failed lintel.
4. **Assembly scale:** collapsed wall section, roof failure, terrace breach.
5. **Site scale:** subsidence, vegetation takeover, buried base, erosion.

### 15.3 Damage events

```text
corner_collapse
facade_breach
partial_terrace_collapse
missing_stair_section
broken_parapet
failed_cornice
wall_bulge
loose_blocks
ground_subsidence
vegetation_split
root_intrusion
roof_collapse
missing_support
fallen_span
blocked_opening
top_collapse
surface_spalling
water_erosion
later_repair
```

### 15.4 Event-based damage

Damage should be generated as coherent events:

```yaml
DamageEvent:
  id: northeast_corner_failure
  type: corner_collapse
  target: pyramid_mass
  origin:
    corner: rear_positive_u
    elevation: band_03
  extent:
    radius: 3.5
    falloff: irregular
  severity: 0.65
  propagation:
    downward: true
    to_attached_elements: true
  debris:
    generate: true
    destination: ground_and_lower_terraces
```

This produces related missing blocks, broken caps, exposed core, and debris rather than unrelated noise.

### 15.5 Structural propagation

Examples:

- Removing a support may break its adjacent spans and roof range.
- A failed cornice may damage masonry beneath it.
- A collapsed upper terrace deposits debris on lower terraces.
- Subsidence shifts connected walls and opens joints.
- Root intrusion follows joints, then displaces nearby blocks.

### 15.6 Damage masks

Damage masks can be:

```text
edge biased
corner biased
top exposed
water path
ground contact
opening stress
support failure
noise field
painted mask
event volume
```

### 15.7 Damage constraints

- Preserve intentional silhouettes unless a ruin preset permits major collapse.
- Generate debris volume proportionally to removed material.
- Avoid floating intact blocks.
- Expose plausible core or backing material beneath removed facing stones.
- Distinguish erosion from structural displacement.
- Allow designer-locked protected regions.
- Keep traversal routes valid when gameplay constraints require them.

---

## 16. Style and Variation System

### 16.1 Style presets

A style preset coordinates compatible ranges:

```yaml
StylePreset:
  id: rectilinear_monumental_generic
  massing:
    batter_angle: [12, 24]
    terrace_ratio: [0.08, 0.18]
  stairs:
    width_ratio: [0.20, 0.42]
    steepness: [moderate, steep]
  facade:
    symmetry: [bilateral, approximate]
    band_count: [3, 6]
  supports:
    preferred: [square_pier, rectangular_pier]
  roof:
    preferred: [flat_slab, stepped_slab]
  ornament_density: [low, medium]
  masonry: [mixed_ashlar, large_cut_blocks]
```

Historically named presets should be informed by archaeological and architectural research. The generator should not infer cultural authenticity solely from a few motifs or proportions.

### 16.2 Variation scopes

Parameters should declare where variation is sampled:

```text
global structure
mass
elevation band
facade
bay
cell
structural row
support family
individual support
patch
masonry course
individual block
damage event
```

### 16.3 Correlated variation

Use shared latent variables or rule groups:

```text
monumentality → wider stairs, larger blocks, heavier cornices
frontality → stronger axial alignment, richer front facade
openness → more open bays, fewer solid cells
vertical emphasis → smaller setbacks, taller central crown
condition age → more joint erosion, staining, and block loss
construction precision → tighter joints and more regular courses
```

### 16.4 Weighted choices

Weighted selection must support:

- Allowed and forbidden combinations.
- Prerequisites.
- Mutual exclusions.
- Minimum and maximum counts.
- Symmetry pairing.
- Unique primary features.
- Neighbor-dependent choices.
- Seeded determinism.

### 16.5 Controlled asymmetry

Useful asymmetry sources:

```text
offset secondary stair
unequal annex
changed bay infill
later addition
blocked doorway
localized repair
asymmetric weathering
partial collapse
vegetation cluster
```

Primary geometry can remain ordered while condition and historical layers introduce irregularity.

### 16.6 Deterministic seeds

Use hierarchical seeds:

```text
structure_seed
├── massing_seed
├── plan_seed
├── facade_seed
├── construction_seed
├── material_seed
└── condition_seed
```

Changing the condition seed should not unexpectedly rebuild the cell plan. Each subsystem should be regenerable independently where dependencies permit.

---

## 17. Hierarchy and Composition Model

### 17.1 Recommended structure graph

```text
Structure
├── Metadata
├── Site
│   ├── world transform
│   ├── approach axes
│   ├── ground interface
│   └── environment constraints
├── Primary masses
│   ├── footprints
│   ├── elevation profiles
│   ├── generated patches
│   └── connectors
├── Superstructures
│   ├── cell assemblies
│   ├── family-owned structures
│   └── secondary masses
├── Roof assemblies
├── Attachments
├── Surface systems
│   ├── facade grammar
│   ├── masonry
│   ├── trim
│   └── ornament
├── Condition systems
│   ├── damage events
│   ├── debris
│   └── vegetation
└── Outputs
    ├── render geometry
    ├── collision
    ├── navigation
    ├── semantic metadata
    └── LODs
```

### 17.2 Dependency direction

Typical dependencies flow downward:

```text
site
  → footprint
  → massing
  → patches
  → circulation
  → summit layout
  → cells and family structures
  → roofs
  → facade subdivisions
  → construction
  → attachments
  → damage
  → materials and export
```

Late systems may query earlier systems but should not silently mutate their topology. If damage changes topology, it produces an explicit condition-state variant derived from the intact structure.

### 17.3 Stable identifiers

All semantic entities need stable IDs. Suggested generated paths:

```text
monument/base/band_02/front_facade
monument/base/stair_primary/landing_01
monument/summit/temple/cell_center/front_wall
monument/summit/portico/row_front/support_03
```

IDs should survive material changes and condition regeneration whenever topology has not changed.

---

## 18. Canonical Data Schema

The following YAML is an illustrative, engine-neutral schema. It is intentionally explicit so it can be mapped to JSON, typed classes, ECS components, procedural node graphs, or editor assets.

```yaml
schema_version: "1.0"

structure:
  id: ceremonial_complex_001
  seed: 182736
  units: meters
  transform:
    position: [0, 0, 0]
    rotation: [0, 0, 0]
    scale: [1, 1, 1]

  axes:
    up: [0, 1, 0]
    front: [0, 0, 1]
    primary_approach: [0, 0, 1]

  style:
    preset: rectilinear_monumental_generic
    overrides:
      ornament_density: low
      construction_precision: medium

  site:
    ground_patch: site_ground
    base_clearance: 2.0
    orientation_mode: face_approach
    gameplay:
      preserve_primary_route: true

  masses:
    - id: main_podium
      footprint:
        type: rectangle
        width: 34.0
        depth: 26.0
        corner_chamfer: 0.0
      base:
        type: projected_footing
        projection: 0.6
        height: 0.35
      elevation_profile:
        - id: band_01
          rise: 1.8
          setback: {front: 0.8, rear: 0.8, sides: 0.8}
          wall_profile: battered
          upper_transition: simple_slab
        - id: band_02
          rise: 1.5
          setback: {front: 0.7, rear: 0.7, sides: 0.7}
          wall_profile: battered
          upper_transition: walkable_terrace
        - id: band_03
          rise: 1.3
          setback: {front: 0.6, rear: 0.6, sides: 0.6}
          wall_profile: battered
          upper_transition: heavy_capstone
      summit:
        treatment: low_curb
        buildable_margin: 1.5
        regions:
          - {id: forecourt, type: front_strip, depth: 5.0}
          - {id: building_pad, type: remaining_center}

  connectors:
    - id: primary_stair
      type: stair
      lower_surface: site_ground
      upper_surface: main_podium.summit
      elevation_mode: continuous
      direction: primary_approach
      alignment: centered
      width:
        mode: facade_ratio
        value: 0.30
      steps:
        target_riser: 0.22
        target_tread: 0.34
      landings:
        mode: selected_bands
        bands: [band_02]
      side_treatment:
        type: solid_parapet
        cap: simple_slab

  cell_assemblies:
    - id: summit_temple
      anchor:
        region: main_podium.summit.building_pad
        alignment: rear_center
        face: primary_approach
      plan:
        grid:
          columns: [5.0, 7.0, 5.0]
          rows: [4.0, 3.0]
        cells:
          - {id: left_room, grid: [0, 0], occupancy: room, role: secondary}
          - {id: central_hall, grid: [1, 0], occupancy: room, role: primary}
          - {id: right_room, grid: [2, 0], occupancy: room, role: secondary}
          - {id: rear_left, grid: [0, 1], occupancy: solid, role: secondary}
          - {id: rear_center, grid: [1, 1], occupancy: room, role: sanctuary}
          - {id: rear_right, grid: [2, 1], occupancy: solid, role: secondary}
      height_rules:
        secondary: 4.0
        primary: 5.0
        sanctuary: 5.5
      connections:
        - id: main_portal
          from: exterior_front
          to: central_hall
          profile: corbelled
          width: 2.6
          height: 3.8
        - id: inner_portal
          from: central_hall
          to: rear_center
          profile: rectangular
          width: 1.8
          height: 2.7

  frame_assemblies:
    - id: forecourt_portico
      enabled: false
      anchor:
        region: main_podium.summit.forecourt
      layout:
        type: single_row_portico
        bay_count: 5
        bay_width: 2.4
      supports:
        profile: square_pier_heavy
      bays:
        default: open
        center:
          role: entrance
          width_multiplier: 1.3
      entablature:
        bands: [bearing_slab, architrave, cornice]
      roof:
        type: flat_slab

  roofs:
    - id: temple_roof
      covers: [left_room, central_hall, right_room, rear_left, rear_center, rear_right]
      type: stepped_slab
      thickness: 0.6
      edge_treatment: heavy_cornice
      upper_features:
        - type: central_crown
          align_to: central_hall
          width_ratio: 0.65
          height: 2.5

  facade_rules:
    - id: temple_front
      target: summit_temple.front
      horizontal:
        derive_from_cells: true
        symmetry: bilateral
      vertical_bands:
        - {role: plinth, height: 0.35, profile: projected}
        - {role: wall_body, weight: 4}
        - {role: frieze, height: 0.65, profile: inset}
        - {role: cornice, height: 0.40, profile: projected}
      features:
        - {type: portal, source: main_portal}
        - {type: pilaster, placement: cell_boundaries}

  construction:
    default:
      masonry: mixed_ashlar
      corner_rule: enlarged_quoin
      course_alignment: semi_regular
      joints:
        width: [0.01, 0.03]
        quality: good
      visible_shell_depth: 0.35

  materials:
    default:
      family: pale_limestone
      roughness: [0.72, 0.90]
      color_variation: 0.08
      edge_softening: 0.015
      lichen_coverage: 0.12
      water_staining: drainage_driven

  attachments:
    - id: forecourt_altar
      generator: altar_block
      anchor:
        region: main_podium.summit.forecourt
        placement: centered
        orientation: face_primary_approach
      constraints:
        preserve_stair_arrival: true

  condition:
    stage: weathered
    seed: 99021
    events:
      - id: west_parapet_damage
        type: broken_parapet
        target: primary_stair.side_negative_u
        severity: 0.25
      - id: rear_corner_loss
        type: corner_collapse
        target: main_podium
        corner: rear_positive_u
        severity: 0.18
    preserve:
      - primary_stair.walkable_route
      - summit_temple.main_portal

  output:
    render_mesh: true
    collision_mesh: true
    navigation_mesh: true
    semantic_metadata: true
    lod_levels: [0, 1, 2, 3]
```

---

## 19. Generation Order

### Phase 1 — Resolve configuration

1. Load schema and version.
2. Merge style preset, structure parameters, and overrides.
3. Initialize hierarchical random seeds.
4. Validate units, axes, ranges, references, and required IDs.

### Phase 2 — Establish site

1. Resolve world transform and approach directions.
2. Sample or query the ground.
3. Create the ground interface and foundation anchors.
4. Reserve structure clearance and environmental exclusions.

### Phase 3 — Generate primary masses

1. Construct primitive or composite footprints.
2. Resolve elevation profiles.
3. Generate closed mass shells.
4. Create semantic facade, terrace, base, and summit patches.
5. Register patch adjacency and named edges.

### Phase 4 — Generate circulation

1. Resolve lower and upper surface references.
2. Reserve stair and landing regions.
3. Calculate step counts and flight geometry.
4. Cut or replace facade and terrace regions.
5. Generate side treatments.
6. Validate traversability and clearance.

### Phase 5 — Allocate summit zones

1. Compute buildable summit regions.
2. Reserve stair arrival and forecourt.
3. Reserve drainage and perimeter margins.
4. Place superstructure anchors.

### Phase 6 — Generate cell assemblies

1. Build the cell plan.
2. Resolve occupied, solid, open, and courtyard cells.
3. Merge shared walls.
4. Create floors, walls, and interior/exterior patches.
5. Connect cells with openings.
6. Derive facade bays from cell boundaries.

### Phase 7 — Generate family-owned structural assemblies

1. Resolve the selected archetype against its platform placement.
2. Generate its named rows and bays.
3. Instantiate the family-specific support profiles and panel records.
4. Generate lintels, cornices, and any archetype-owned roof.
5. Preserve independent semantic material ownership for each detail family.
6. Validate contacts, support topology, circulation, and the archetype silhouette.

### Phase 8 — Generate roofs and crowns

1. Group cells or bays into roof ranges.
2. Resolve bearing elevations.
3. Build roof slabs, eaves, parapets, and drainage.
4. Add crowns, roof combs, and upper masses.
5. Validate support and footprint constraints.

### Phase 9 — Apply facade grammar

1. Divide facades into horizontal bays.
2. Divide facades into vertical bands.
3. Apply portals, niches, panels, and pilasters.
4. Resolve feature conflicts and corner continuity.
5. Register new reveal, molding, and trim patches.

### Phase 10 — Apply construction grammar

1. Determine construction layers.
2. Subdivide patches into courses and blocks.
3. Resolve corners and opening surrounds.
4. Generate slabs, capstones, and joints.
5. Produce construction metadata for later damage.

### Phase 11 — Place attachments

1. Query eligible anchors and regions.
2. Apply hierarchy and symmetry rules.
3. Reserve clearances.
4. Place architectural and decorative modules.
5. Update navigation or collision reservations.

### Phase 12 — Apply condition

1. Establish age and maintenance state.
2. Generate coherent damage events.
3. Propagate structural consequences.
4. Remove, shift, crack, or erode affected elements.
5. Generate exposed cores and debris.
6. Place vegetation and soil accumulation.

### Phase 13 — Materials and final surfaces

1. Assign material families by semantic role.
2. Generate block-correlated variation.
3. Add drainage-driven streaks and exposure-driven weathering.
4. Apply fine displacement and edge wear.

**Current implementation status:** generated geometry retains a stable
per-vertex semantic material index and coalesces triangles into one draw group
per used slot. Facade portal reveals, window reveals, niches, recessed panels,
pilasters, and friezes are independently assignable. Pillar Hall pedestals,
piers, pier panels, lintels, friezes, cornices, and roofs are likewise
independent. Their defaults remain coordinated with adjacent stone, trim, and
roof materials, so indexed ownership does not change the approved look until an
assignment is edited.

### Phase 14 — Outputs and validation

1. Generate render geometry.
2. Generate collision and navigation.
3. Generate LODs.
4. Serialize semantic metadata.
5. Run geometric, topological, structural, and gameplay validation.
6. Report warnings and repairable violations.

---

## 20. Constraints and Validation

### 20.1 Geometric constraints

- All dimensions must be positive after profile resolution.
- Setbacks cannot invert a footprint unless explicitly permitted.
- Summit dimensions must satisfy child placement requirements.
- Patch normals and winding must be consistent.
- Coplanar joins must remain within tolerance.
- Trim projection cannot create unintended self-intersections.
- Features must fit their target regions or declare clipping behavior.

### 20.2 Topological constraints

- Mass shells should be watertight before intentional openings and ruin operations.
- Patch adjacency must agree on shared boundaries.
- Openings must connect valid source and destination spaces.
- Stairs must reference valid lower and upper surfaces.
- Shared cell walls should not be duplicated.
- Roofs must reference existing bearing entities.

### 20.3 Structural constraints

- Intact spans require adequate bearing.
- Roof fields require supports, bearing walls, or explicit cantilevers.
- A support cannot terminate below its bearing plane.
- Removed supports trigger a consequence rule.
- Upper masses must lie inside supportable footprints.
- Damage must distinguish stable ruins from unresolved invalid geometry.

### 20.4 Circulation constraints

- Primary approach remains connected from ground to target summit or portal.
- Required stair width and headroom are preserved.
- Openings and passages meet clearance rules.
- Attachments avoid protected circulation zones.
- Landings remain large enough for their function.
- Gameplay-preserved routes override optional damage.

### 20.5 Composition constraints

- Primary entrances align with declared approach axes unless deliberately offset.
- Major crowns align with important bays or spaces.
- Ornament density follows hierarchy.
- Secondary masses do not visually overpower primary masses unless tagged as dominant.
- Symmetry rules are applied before condition asymmetry.

### 20.6 Construction constraints

- Masonry joints should not form implausible continuous weak seams unless intentional.
- Corner blocks must reconcile adjacent facade courses.
- Opening lintels or corbelled profiles need adequate bearing.
- Facing stones must have plausible depth or an abstracted shell mode.
- Missing facing reveals a core rather than an empty volume.

### 20.7 Validation severity

```text
error   → generation cannot produce a valid result
warning → result is usable but violates a preferred rule
notice  → unusual condition or automatic repair was applied
```

Automatic repair should be explicit:

```text
reduce stair width
increase summit size
merge undersized bands
adjust step count
insert support
shorten roof range
skip conflicting attachment
clip facade feature
protect circulation from damage
```

The resolved value and reason should be recorded for reproducibility.

---

## 21. Worked Examples

### 21.1 Low ceremonial platform

**Intent:** Broad, low platform with a frontal stair and empty summit.

```text
Mass:
  rectangular footprint
  2–3 shallow battered elevation bands
  wide terraces
  projecting base apron
  simple upper coping

Connector:
  one centered front stair
  moderate rise/run
  solid or stepped side parapets

Summit:
  open floor
  low perimeter curb
  optional centered altar attachment

Construction:
  mixed cut limestone
  enlarged corner stones
  moderate erosion
```

Variation:

- Change footprint aspect ratio.
- Change band height distribution.
- Use a continuous or terrace-interrupted stair.
- Add twin altars, stelae, or no summit occupant.
- Alter masonry and condition without changing topology.

### 21.2 Stepped pyramid with summit temple

**Intent:** Strong axial monument with repeated terraces and an enclosed superstructure.

```text
Primary mass:
  5–9 repeated elevation bands
  medium-to-steep batter
  controlled setbacks
  small summit

Connector:
  continuous axial stair
  deep landings at selected terraces
  heavy parapets

Summit building:
  central hall
  side rooms
  rear sanctuary
  tall front portal

Roof:
  flat or stepped slab
  heavy cornice
  central crown or roof comb
```

Key constraints:

- Reserve summit depth for the stair arrival and temple forecourt.
- Align the main portal with the stair axis.
- Derive facade bays from the cell plan.
- Support the crown over the central room or wall chain.

### 21.3 Pillar Hall compositions

**Intent:** A low stepped platform supporting an inspired pier-and-lintel structure.

```text
Podium:
  2–4 elevation bands
  broad summit
  central stair

Pillar Hall:
  Linear Screen, Front Gallery, or Open Pavilion
  stepped square-pier profiles
  open bays with independent lintel spans
  inset pier panels and geometric base panels
  aligned pier plinths alternating with paired bay panels on Linear Screen

Roof:
  shallow slab on Front Gallery only
  exposed lintels on Linear Screen and Open Pavilion

Construction:
  layered support feet
  capstones and projecting cornice
  independent indexed detail surfaces
```

Variations:

- One-row Linear Screen.
- Two-row Front Gallery.
- Open-front U-plan Pavilion.

### 21.4 Three-bay gatehouse

**Intent:** Symmetrical summit building with a tall central portal and lower wings.

```text
Plan:
  left wing cell
  central passage cell
  right wing cell
  optional rear rooms

Height:
  central bay 1.2–1.8 times wing height
  narrower crown above central bay

Facade:
  lower plinth
  wall body
  central corbelled portal
  side doorways or niches
  transition molding
  frieze
  upper wall
  cornice
  parapet

Roof:
  wing roof spans
  raised central roof
  perforated or solid crown
```

This example demonstrates why cells, facade bands, openings, and roofs must be distinct but coordinated systems.

### 21.5 Palace around a courtyard

**Intent:** A more complex summit or ground-level compound.

```text
Plan:
  rectangular court
  cell strips on three or four sides
  multiple passages to the exterior
  hierarchy of public and private rooms

Edges:
  optional pier-and-lintel screens along courtyard edges
  covered gallery in front of major rooms

Roofs:
  grouped by cell strips
  open center court
  drainage directed toward controlled outlets

Facades:
  exterior facade grammar
  separate courtyard facade grammar
  major portals aligned to circulation paths
```

Complexity comes from composing rectangular cells, facade bands, and family-owned edge structures, not from replacing the core grammar.

---

## 22. Implementation Guidance

### 22.1 Separate semantic and render representations

Maintain:

```text
semantic graph
parametric construction state
render meshes
collision meshes
navigation surfaces
editor handles
```

Render meshes may be merged for performance while semantic entities remain addressable.

### 22.2 Non-destructive modifiers

Prefer a dependency graph in which each stage produces derived state:

```text
intact architecture
→ constructed architecture
→ conditioned architecture
→ optimized output
```

This permits:

- Editing an elevation band without repainting every block manually.
- Regenerating damage independently.
- Comparing intact and ruined states.
- Producing multiple LODs.

### 22.3 Editor-facing controls

Expose high-level intent first:

```text
overall footprint
total height
terrace count
summit size
primary approach
stair arrangement
superstructure type
openness
height emphasis
ornament density
construction precision
condition
seed
```

Advanced panels can expose profiles, individual bays, masonry, and damage events.

### 22.4 Designer locks

Any generated entity should be lockable:

```text
lock topology
lock dimensions
lock placement
lock style choice
lock seed
lock material
protect from damage
protect for traversal
```

Regeneration should preserve locked decisions and report conflicts.

### 22.5 LOD strategy

Example:

```text
LOD 0:
  individual blocks, deep joints, detailed damage, small attachments

LOD 1:
  grouped courses, simplified profiles, reduced debris

LOD 2:
  architectural shell, baked joints and reliefs, major damage silhouette

LOD 3:
  simplified massing, stairs as ramps or coarse steps, silhouette-only crowns
```

Semantic IDs should map across LODs where practical.

### 22.6 Export metadata

Recommended export data:

- Structure and component IDs.
- Patch roles and local frames.
- Material assignments.
- Traversable surfaces.
- Openings and room connectivity.
- Support and span relationships.
- Damage-event membership.
- Attachment anchors.
- LOD correspondence.
- Source seed and resolved parameters.

---

## 23. Extensibility

The system can grow without replacing its core abstractions.

### 23.1 Curved or irregular forms

Use rectangular parametric patches with custom evaluators, boundary masks, or tiled patch networks. Curvature changes surface evaluation, not feature addressing.

### 23.2 Non-rectangular plans

Represent them as:

- Compositions of rectangular cells.
- Clipped rectangular patches.
- Patch networks with explicit seams.
- Profile sweeps where a rectangular domain remains available.

### 23.3 Bridges and elevated passages

Treat them as connector masses or explicitly supported spans between compatible anchors.

### 23.4 Underground spaces

Cells may extend below the ground interface. Entrances remain connectors, and excavated surfaces receive separate construction and condition rules.

### 23.5 Multiple construction phases

Add historical layers:

```text
phase 1 core monument
phase 2 enlarged platform
phase 3 summit addition
phase 4 blocked doorway
phase 5 repair
phase 6 abandonment and collapse
```

Each phase creates or modifies semantic entities while preserving provenance.

---

## 24. Minimal Viable Generator

A practical first implementation can be staged.

### Version 1

- Rectangular footprint.
- Repeated elevation bands.
- Battered and vertical wall profiles.
- Summit patch.
- One centered continuous stair.
- Basic coping and plinth.
- Simple material assignment.

### Version 2

- Multiple stair modes and parapets.
- Patch regions and feature operations.
- Facade bays, bands, hierarchy, and planar Cell feature grammar.
- Masonry subdivision.
- Deterministic seeds.

### Version 3

- Cell plans.
- Openings and room connections.
- Roof groups and crowns.
- Summit placement constraints.

### Version 4

- Implemented: single-row and perimeter support grids, bays, lintels,
  entablatures, roof ranges, and square-pier profile stacks.
- Next: bay infill and additional grid layouts.
- Later in this version: missing/collapsed members and non-square support types.

### Version 5

- Attachments.
- Event-based damage.
- Debris and vegetation.
- Validation, designer locks, and LODs.

This order preserves the shared abstractions and avoids implementing isolated special-case generators.

---

## 25. Final System Summary

The complete procedural vocabulary is:

```text
Patch
  → semantic rectangular surface
  → regions, edges, operations, material, condition

Mass
  → footprint plus elevation profile
  → platforms, pyramids, walls, towers, roof blocks

Connector
  → relationship between surfaces or spaces
  → stairs, ramps, passages, portals

Cell
  → rectangular spatial unit
  → rooms, courts, gatehouses, temples, palaces

Pillar Hall
  → family-owned rows, stepped piers, bays, and lintels
  → screens, front galleries, open-front pavilions

Support profile
  → stacked cross-sections
  → pillars, piers, columns, pilasters

Facade grammar
  → horizontal bays plus vertical bands
  → openings, panels, moldings, hierarchy

Roof assembly
  → independent span over cells or family-owned supports
  → slabs, eaves, parapets, crowns, drainage

Attachment
  → child entity at a semantic anchor
  → altars, shrines, sculptures, drains, vegetation

Construction grammar
  → courses, blocks, joints, caps, corners

Condition grammar
  → coherent events and material aging
  → erosion, failure, collapse, debris, growth

Style and variation
  → constrained parameter ranges and weighted rules
  → coherent families rather than arbitrary combinations
```

The key architectural distinction is:

> A platform or pyramid is generated primarily from a footprint and an elevation profile; an enclosed superstructure is generated from a cellular plan and facade grammar; the current open superstructure is generated by its Pillar Hall family. All three share the same construction, material, and validation foundations without forcing one generic layout graph onto unrelated forms.

This arrangement is extensible to platforms, pyramids, summit buildings, Pillar Halls, courtyards, ruins, and multi-phase complexes while allowing each credible structure family to prove its own composition rules first.
