# The spec contract — what the validator and generator actually do

Everything here was learned by reading `forge/` source and burning review
cycles. The SKILL.md carries the loop; this file carries the contracts that are
not written down upstream. Verified against upstream **v1.5.1**; the entries
marked _(1.5)_ reversed between 1.4 and 1.5, so re-verify them on any pull.

## Field shapes (the validator rejects guesses)

- `suitability` is an enum: `pass` | `conditional` | `reject`.
- Every complexity/suitability score is an **integer 0–3**, not a float.
- `componentTree[].evidenceRefs` are **viewEvidence IDs**, not file paths.
- `featureReviewTargets[].tier` is `critical` | `important` | `detail`.
- `detailInventory` entries use `VALID_DETAIL_KINDS` (gloss, fastener, groove,
  ridge, …) — the list lives in `forge/stage2_spec/validate_sculpt_spec.py`,
  which is the source of truth for **every** enum, including the 15-value
  `primitive` enum (`box, capsule, cone, curve-sweep, cylinder, ellipsoid,
extrude, ground-blade, instanced-cluster, lathe, plane-card, sphere,
tapered-sweep, torus, tube`). The generator no longer keeps its own copy —
  an unknown primitive is now an error, not a silent `box`.

## Geometry: three mechanisms, not two

1. **`transform.scale`** — unit primitive scaled per axis. _(1.5)_ The scale
   is baked into the vertex data (`geometry.scale(...)`); the `__pivot` Group
   is emitted with `scale.set(1, 1, 1)` and only carries position/rotation.
2. **`attachment.localStart/localEnd`** — swept rod between two points;
   **replaces** the authored primitive with an oriented cylinder — _(1.5)_ but
   only when the primitive is in `ATTACHMENT_PRIMITIVES` (`cylinder, cone,
capsule, tube, curve-sweep`). A box/torus/profile with an attachment keeps
   its geometry; the attachment is then an anchor contract for
   `attachment_anchor.py`. There is no plate mode: flat straps are a box.
3. **`geometryDescriptor` profiles** — `latheProfile` (a barrel belly is a
   lathe, not a scaled cylinder), `extrude`, `tube`, `curve-sweep` (curved flat
   bars, e.g. a lever arm). The basic toolkit cannot build a swollen barrel or
   an S-curved arm; these can. **Flat circumferential straps** (barrel hoops)
   are a `torus` with `geometryDescriptor.torusTubeRatio` widened — the field
   exists only in generator source; without it hoops come out as thin rings
   where the reference shows wide flat bands.

Two placement contracts that silently misplace parts:

- _(1.5)_ **`socket.localPosition` is in the component's real, unscaled
  frame.** The socket is a child of the identity-scale `__pivot` Group, so a
  socket on the rim of a `[2, 1, 1]` box is at `x = 1.0`, not `0.5`. The
  pre-1.5 rule (unit space × scale) now lands sockets at half distance.
- _(1.5)_ **Child components live in the parent's unscaled frame** for the
  same reason — a child of a squashed parent is not squashed, and its
  position is in real units. Do not divide out the parent's scale.
- **`fidelityTier` is a third include path**: a meso part carrying the
  scaffold's copied `"blockout"` tier gets force-included at blockout. Give
  every part its own pass tier; never inherit the scaffold's.

**Openable containers**: an open `lathe` shell renders `FrontSide` — pull the
lid and the interior is see-through. Declare `DoubleSide` or add an interior
liner component at spec time, not after the pulled render exposes it.

## When an attachment is required (the real rule)

`validate_sculpt_spec.py` requires an attachment when a parented component's
role/animationRole/**name tokens** hit `ATTACHMENT_ROLES` (hinge, handle,
support, connector, arm, limb, …) **or** its primitive is round
(`cylinder, cone, capsule, tube, curve-sweep`). It is NOT "every meso child" —
rectangular plates neither need nor can meaningfully have one.

Consequences that bite:

- Merely **naming** a component `hinge-upper` or `handle` force-converts it to
  a swept rod via token matching. A ring handle should be a `torus` with role
  `pull-ring`, not "handle".
- Distinct `localStart`/`localEnd` replace whatever primitive you authored.

## Rig reality: pivots, hinges, sockets

**`actionProfile.pivot` is metadata.** The generator writes it to `userData`
and never applies `localPosition`/`axis`. The `__pivot` node sits at
`transform.position` with the mesh **centered on it** — with one _(1.5)_
exception: a round primitive carrying an `attachment` gets its `__pivot` at
`attachment.localStart` (the joint), the mesh oriented along the rod inside
it, so rotating that node swings the rod about its root. That is a real hinge
for free on rods (lever arms, pintles, limbs), still not for slabs.

To get a real off-center hinge, build the armature yourself:

- Give the swinging assembly a carrier component whose `transform.position` IS
  the hinge line (e.g. a door leaf's left edge), and make every swinging part
  its **child**, offset so geometry hangs off the hinge correctly.
- Keep the carrier's name canonical and stable — `"<leaf-id>__pivot"` is the
  node game code will `getObjectByName`. A rerun that renames the swing node is
  an API break, not a cosmetic change.
- Use the **canonical part-name lexicon** so reruns reproduce the rig API the
  way sockets already do (measured: sockets 100% stable across independent
  runs, ad-hoc pivot names 20%): `body`, `lid`, `leaf`, `head`, `rim`,
  `base-ring`, `plinth`, `jamb`, `lintel`, `strap-upper/lower`, `hoop-1..N`,
  `arm`, `knob`. Component id drives the pivot name — pick from the lexicon,
  never invent synonyms (`stave-shell` vs `barrel-body` broke a rerun).

**Sockets** reach the runtime as named `Object3D`s, but tooling (and
`contact.json`) finds them by the substring **`socket`** in the id. An id
without it silently reports `sockets: []`. For an articulated object, author a
minimum set: hinge/pintle, handle, latch — plus whatever gameplay needs
(spawn points, attachment lugs).

**Prove the rig, don't claim it.** Write a 10-line wrapper entry that imports
the factory, rotates the hinge carrier to its open pose, and render it through
the same camera into `runs/<pass>-pulled/`. A rig that has never been rendered
pulled is unverified.

## The authoring toolchain (scaffolds assume it; nothing names it)

| Script                                       | When                                 | Trap                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage1_intake/check_reference_admission.py` | before anything                      | the "intake gate"                                                                                                                                                                                                                                                                                                                                                          |
| `stage1_intake/build_detail_inventory.py`    | before spec authoring                | always pass `--out-dir` or crops land beside the reference                                                                                                                                                                                                                                                                                                                 |
| `stage1_intake/solve_camera_pose.py`         | frontal/ambiguous references         | fills `referenceCamera`                                                                                                                                                                                                                                                                                                                                                    |
| `stage1_intake/extract_part_color_recipe.py` | per material                         | confidence caps ~0.6 on clean crops while the threshold is 0.7 — `--allow-low-confidence` is the expected path; holed crops leak background color                                                                                                                                                                                                                          |
| `stage1_intake/extract_pbr_evidence.py`      | before material-pass claims          | `--out-dir public/pbr/<id> --url-prefix /pbr/<id>` serves + rewrites in one step; an unloaded roughnessMap renders chrome                                                                                                                                                                                                                                                  |
| `stage4_review/check_part_coverage.py`       | before each pass credit              | `--manifest runs/<pass>/parts.json` — `render_model.py` writes it on every run (nothing upstream produces one); `--warn-only` at blockout (meso parts are correctly absent and hard-fail otherwise); `mapsTo` must target component ids — material-id refs validate clean but dangle here; a hand-authored hinge carrier reports as `part-not-specified`, which is correct |
| `stage4_review/diagnose_render.py`           | before `orchestrate_passes.py check` | see the framing trap below; blockout hard-requires `--map-stripped-render`                                                                                                                                                                                                                                                                                                 |

There is **no recipe-propagation script** (do not look for `propagate_recipes.py`
— it doesn't exist): after extracting one `colorMaterialRecipe` per material,
propagation is a hand edit of the spec's same-material components. Likewise
`runtime/scripts/export_mesh_geometry.mjs`, which upstream's docs cite for
`meshes.json`, is not in the repo — `render_model.py --export-meshes` is the
exporter.

Crop-zoom 2–4 ambiguous regions of the reference (the detail-inventory crops
do this) and verify part adjacency **before** authoring — it is the only
defense against wrong-adjacency errors like a flange modeled under the wrong
block, and it catches identity features like a recessed barrel head that the
full frame hides.

## Strict quality is the generator's gate _(1.5)_

`generate_threejs_factory.py` runs `validate_sculpt_spec.py --strict-quality`
itself and refuses to write (exit 2, `BLOCKED` JSON, optional
`--blocked-report`) on **any** `quality:` warning — for every pass, including
blockout. A fresh scaffold fails 15 ways; a spec that reached lighting-pass
under 1.4 fails on `referencePbr` and lighting alone. What strict demands,
all before the first factory:

- `preSpecAssessment.objectClass.*` filled, `complexity.tier` and
  `specDepthDecision.requiredDepth` assessed, and
  `unknownsToResolveBeforeImplementation` **empty** — a non-empty list is
  itself the failure. Resolve each unknown into a `featureReviewTargets`
  entry or a review note, then clear it.
- `featureReviewTargets` replaced (the starter set is detected as generic).
- `qualityContract` minimums: macro ≥ 2, meso ≥ 3, micro groups ≥ 2,
  materialLayers ≥ 2 at `moderate`; `detailInventory` ≥ `targetMinDetails`.
- Every component: `colorMaterialRecipe`, `topologyClass` + rationale.
- Every material: usable `referencePbr` (maps extracted from reference
  crops), plus wear/AO/stain/scratch-style local entries, plus a
  reference-derived palette and roughness/normal response.
- `lightingFromPhoto`: ≥ 3 non-empty entries.

`--allow-nonstrict` produces **byte-identical** code (diffed) and only skips
the gate, but refuses `--pass-id` and builds the currently unlocked pass. It
is a legitimate way to get a proportion render while intake is unfinished; it
is not a way to credit a pass. Nothing in `append_review.py` or
`orchestrate_passes.py` re-checks strict, so the generator is the only place
the bar is enforced — do not route around it.

## Review gates

`append_review.py --action continue` on a visual pass hard-requires:
`--comparison-image`, `--ai-vision-score` ≥ the spec threshold, all **five**
named layer scores when `layerScoresRequired`, per-pass critical
`featureReviews` ≥ their minimum (default 0.8), and — for blockout — a
`--map-stripped-render`. Pass `--layer-scores-json`/`--feature-reviews-json`
as **file paths**: inline JSON longer than ~255 bytes is stat'd as a path and
dies with `ENAMETOOLONG`. Omit `--review-viewpoints-json` — it demands
thickness-axis/long-axis views the shared camera never produces.

Layer keys are fixed: `silhouetteProportion, componentStructure, formDetail,
materialSurface, lightingCamera`.

**Interior difference** _(1.5)_ — `orchestrate_passes.py status` now lists a
banded interior difference as required evidence on every visual pass:
`interior_difference.py <prev-pass>/front.png <pass>/front.png [--from --to]`.
It refuses when either mask fell back to whole-frame, so shoot both frames
through the same harness. Between two renders of the same door it reads
0.0044 — that is the noise floor.

**Turntable gate** _(1.5)_ — `turntable_gate.py` wants a 0/90/180/270 ring by
default and fails a missing azimuth. Two traps: (1) the shared masker gives up
below 3.5 % frame coverage and `silhouette_area_fraction` then reports **0**
on purpose (its billboard test), so a thin prop edge-on is DEGENERATE at
90°/270° whatever you do — shoot a diagonal ring instead
(`--views az45,az135,az225,az315`, `--required 45 --required 135 ...`); (2) on
an opaque backdrop the same fallback also marks the frame UNSEGMENTED, which
voids the hole check — render the ring with `--transparent` (alpha bypasses
the coverage floor).

**Self-intersection** — `self_intersection.py` is ray-parity over welded
meshes. Three's `BoxGeometry`/`CylinderGeometry` are unwelded per face, so it
flags every plank and rivet (31/31 on the door). Character-mesh gate only.

**Tier-1 gate.** `orchestrate_passes.py check` refuses to unlock until
`diagnose_render.py` passes mask-IoU/scale checks (IoU ≥ 0.85, scale delta
≤ 0.08) — and **from material-pass onward, a color gate too: max deltaE ≤ 20**
against the reference. The color gate is what refuses over-exposed albedo (see
below); it dominated both material and surface attempts in the validation run.
Trap: `render_model.py` frames with a fixed 1.25× margin, so a frame-filling
product-shot reference **guarantees failure** regardless of model quality.
Before running the diagnostic:

1. Align framing with the skill's `scripts/align_framing.py align` — it crops
   the render to the reference's fill/centring using the gate's own masker and
   records the crop math in a sidecar. Soft JPEG gradients can defeat the
   masker; it refuses and asks for `--ref-bbox` (eyeball the bounds via its
   `crop` mode) rather than silently over-measuring. Feed the aligned render to
   `make_comparison_sheet.py` too — an unaligned sheet shows the render ~40%
   too small on every comparison.
2. Match the camera pitch — product shots sit near 0–5°, the harness default
   is 12–22°; use `render_model.py --elevation` to align before comparing.

`append_review.py` will still credit a pass without tier-1; the two gate paths
disagree upstream. Run tier-1 when you want the quantitative silhouette
evidence (it is the only number that catches a proportion drift eyeballs
excuse), and say in the review notes which path credited the pass.

## Material-pass: the referencePbr contract

`generate_threejs_factory.py` **hard-blocks material-pass emission until EVERY
material has usable `referencePbr`** — including materials with no croppable
pixels (a groove color that exists only as 4px seam lines). The escape is a
synthesized crop from real pixels: stitch the darkest/cleanest columns of the
relevant zone into a crop and extract from that. Undocumented upstream.

**The double-exposure trap** (the biggest time sink of the validation run):
extracted "de-lit" albedo keeps the photo-lit crop's mean brightness, and the
render harness lights it again (ambient 1.5 + key 2.2) — wood blows out to
pale yellow/clipped white, and the tier-1 color gate refuses at deltaE > 20.
The fix is **linear-space exposure correction**: scale each emitted albedo map
so the rendered region mean matches the reference's measured region mean, and
record the factor in `referencePbr.exposureCorrection`. Two consequences:

- With `referencePbr` active, set `textureProjection.repeat` to **[1, 1]** —
  any repeat tiles the crop's baked lighting gradient into checkering/banding.
- Fix exposure in the maps, never by dimming the harness lights — the shared
  camera is the comparison constant.

**Lighting-pass limits**: the harness renders shadowless with no tone mapping,
so "contact shadow" and "exposure/tone-mapping" acceptance criteria can be
specified but not proven through it. Say so in the review notes; use the
`raking` view (grazing light) to evidence normal/height detail for
surface-pass on flat props.

One more scoring caveat: across a deep run the reviewer's scalar
`aiVisionScore` compresses (~0.74–0.78 while objective fidelity climbs) — gate
decisions on the layer scores and tier-1 numbers, not the scalar.

## Generated material clamps _(1.5)_

The emitted `createSculptMaterial` clamps what the spec says: albedo channels
to 30–240, IOR to 1–2.5, F0 ≥ 0.02, and **metalness to `0` below 0.5 or `1`
at/above** — there is no partial metal. Author "slightly metallic" as
roughness + clearcoat on a dielectric. A `textureless.declared: true`
material skips map generation entirely.

## Validator warnings you may defer

None. Every `quality:` warning blocks generation (see _Strict quality_
above); only non-`quality:` warnings are advisory.
