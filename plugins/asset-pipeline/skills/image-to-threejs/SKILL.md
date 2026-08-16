---
name: image-to-threejs
description: "Turn a generated reference image into a rigged, procedural Three.js prop — code, not a mesh file. Generate ONE clean product-shot reference with `vg generate`, author a component spec (parts, materials, pivots, sockets, colliders), emit a TypeScript factory, normalize it, and drop it into a Three.js game with its hinge/socket rig intact. Use for hero props that need to ANIMATE or come apart: chests, doors, levers, crates, weapons, machines. Triggers: 'make a 3d chest/door/prop', 'image to three.js code', 'procedural three.js model', 'model this object in code', 'openable chest', 'rigged prop'."
metadata:
  short-description: "Reference image -> component spec -> procedural Three.js factory with pivots + sockets."
---

# Image to Three.js

Rebuild an object as **procedural Three.js code** driven by one generated
reference image. The output is a TypeScript factory — primitives, procedural
materials, and a named pivot/socket rig — not a `.glb`.

This is the 3D sibling of `animated-spritesheets`: generate one clean image with
`vg generate`, run it through a staged pipeline, get a game-ready asset.

## Pick this or a mesh — they are not interchangeable

| Need                                                         | Use                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Prop that **hinges, opens, detaches, or breaks**             | **this skill** — the rig is the point                    |
| Prop you want to **tweak in code** (size, palette, variants) | **this skill** — it's source                             |
| Organic/photoreal shape, character, anything sculpted        | `vg generate` → Meshy (`model-catalog`, `regenerate-3d`) |
| Generic set dressing, many objects, ship today               | Kenney kit GLBs — free and instant                       |
| Whole scenes, crowds, LOD-heavy fills                        | **not this** — see the token budget below                |

**Budget before you start.** Upstream measures ~**80k–180k tokens per object**
and **150k–350k per character**, dominated by 5–8 render-review cycles. This is
for a handful of _hero_ props, never for populating a scene. The cheapest lever
is a good reference image — one avoided bad render saves 10k–20k tokens.

Every `create<Name>Model()` call allocates **fresh geometry and materials** — no
sharing between instances. Fine for hero props; for anything repeated, cache one
model and clone, or move to `InstancedMesh`.

## Setup

Upstream generator (Apache-2.0, Python 3.10+, stdlib only):

```bash
git clone https://github.com/img2threejs/img2threejs.git ~/.local/share/img2threejs
```

Upstream's README installs it into the agent's skills directory. **Don't** — it
ships its own top-level `SKILL.md`, so it would auto-load as a second, competing
pipeline doc alongside this one. It is a tool we shell out to, not a skill.

Run everything through `uv`; system python is often 3.9 and it needs 3.10+.

```bash
I2T=~/.local/share/img2threejs
run() { uv run --python 3.12 --no-project python "$I2T/$@"; }

# This skill's own directory, used by the commands further down.
SKILL=.claude/skills/image-to-threejs
```

## The loop

`forge/next.py <spec>` always tells you the current pass and the exact next
command. When lost, run it.

### 1. Reference image

One object, isolated, evenly lit. The intake gate rejects busy scenes, and every
ambiguity becomes a review cycle later.

```bash
vg generate run fal-ai/flux/dev \
  --prompt "A single <object>, <identity-defining features>, three-quarter view, centered, \
isolated on a plain flat light-grey background, even diffuse studio lighting, no cast shadow, \
full object visible with margin, sharp focus, product reference photo, no text, no props" \
  --image_size square_hd --download "./ref/<name>.{ext}" --json
```

**Look at what came back.** Models routinely ignore the view angle — a
"three-quarter view" request often returns dead-on frontal, which hides the depth
axis and makes every depth a guess. Re-roll; it is far cheaper than guessing.

### 2. Intake and assessment

```bash
run forge/stage1_intake/probe_image.py ref/<name>.jpg
run forge/stage1_intake/check_reference_admission.py ref/<name>.jpg
run forge/stage2_spec/new_pre_spec_assessment.py "<Name>" --image ref/<name>.jpg \
    --complexity moderate --out assessment.json

# STOP. Fill assessment.json from what you see BEFORE the next command —
# new_sculpt_spec.py copies the assessment into the spec at creation, so
# running straight through bakes an empty scaffold in.

run forge/stage2_spec/new_sculpt_spec.py "<Name>" --image ref/<name>.jpg \
    --assessment assessment.json --out spec.json
```

Both emit **scaffolds** — zeros, `"unassessed"`, and a single placeholder
component. That is the deal throughout: **the scripts enforce structure, you
supply every judgment.** Field shapes are strict (enums, integer 0–3 scores —
see `references/spec-contract.md`). Then author `componentTree` and
`materials` yourself.

> **Never re-run `new_sculpt_spec.py --force` on a live spec.** It reseeds the
> file and wipes `reviewHistory`, which is what credits completed passes — you
> silently drop back to blockout. Edit the spec in place instead.

### 3. Author the spec

Measure proportions off the reference instead of eyeballing them; it is the
difference between "a chest" and "the chest". Then check with `contact.json`
from the renderer: bounds `H/W` should match what you measured. Crop-zoom 2–4
ambiguous regions of the reference (`scripts/align_framing.py crop`, or the
detail-inventory grid from `build_detail_inventory.py --out-dir <dir>`) and
verify part adjacency before authoring — the full frame hides things like a recessed barrel head or which
block a flange sits under.

**Geometry is driven by three mechanisms, and mixing them up is the single
biggest time sink** (full contract: `references/spec-contract.md`):

| Mechanism                        | When it applies                                   | What it makes                                  |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `transform.scale`                | no `attachment` on the component                  | unit primitive scaled per axis                 |
| `attachment.localStart/localEnd` | component has an `attachment`                     | oriented cylinder swept between the two points |
| `geometryDescriptor` profiles    | `lathe`/`extrude`/`tube`/`curve-sweep` primitives | real profiles: barrel bellies, curved arms     |

- Geometry is emitted as **unit** primitives. **`dimensions` is documentation
  only** — it never sizes anything. `transform.scale` does.
- An `attachment` **replaces** the authored primitive with a swept cylinder
  (`baseRadius` default `0.06`, tapering to `endRadius` = `0.55 × baseRadius`).
  There is **no plate mode** — flat straps are a box component with no
  attachment; untapered bands set `baseRadius === endRadius`.
- Attachments are required only where the validator's role/**name-token**
  matching fires (`hinge`, `handle`, `arm`, `support`, …) or the primitive is
  round (`cylinder, cone, capsule, tube, curve-sweep`) — NOT on every meso
  child. Corollary: naming a part `hinge-upper` force-converts it to a rod.
  A ring handle is a `torus` with role `pull-ring`, never "handle".
- A swollen barrel is a **lathe**, not a scaled cylinder; an S-curved lever arm
  is a `curve-sweep`. Reaching for scale tricks where a profile exists is how
  the belly and the curve get lost.
- Child transforms live in the **parent's scaled space**. Divide out the
  parent's scale or a child of a squashed parent comes out squashed too.
- Multiple parentless macro parts are fine (they attach to an invisible
  Group). Only the scaffold's placeholder `root` **component** renders as a
  unit cube — delete or repurpose it; don't invent a giant carrier box.

**The rig is where the token spend pays off — but know what is real:**

- **`actionProfile.pivot` is metadata the generator never applies.** The
  `__pivot` node sits at `transform.position` with the mesh centered on it.
  A real off-center hinge is an **armature you author**: a carrier component
  whose `transform.position` IS the hinge line, with every swinging part as
  its child. Keep the carrier's name canonical (`"<leaf-id>__pivot"`) — a
  rerun that renames the swing node breaks every `getObjectByName` caller.
- **`sockets`** reach the runtime as named `Object3D`s, but tooling finds them
  by the substring `socket` in the id — an id without it silently reports
  `sockets: []`. Articulated objects get a minimum set: hinge/pintle, handle,
  latch.
- **Prove the rig**: render the hinge carrier rotated to its open pose through
  the same camera into `runs/<pass>-pulled/`. An unpulled rig is unverified.

Validate before generating:

```bash
run forge/stage2_spec/validate_sculpt_spec.py spec.json     # want: PASS
```

Field shapes the validator rejects guesses on (enums, integer 0–3 scores,
evidenceRefs as view IDs, the 14-value primitive enum) are catalogued in
`references/spec-contract.md`; `validate_sculpt_spec.py` itself is the enum
source of truth. Two errors bite every first run: `primitive` must come from
the enum, and `materialLayers` must point at your material ids, not the seeded
`"base"`. Warnings about `referencePbr`/`colorMaterialRecipe`/lighting are the
quality bar for material/lighting passes — defer them at blockout/structural.

### 4. Generate, normalize, render

`$SKILL` below is this skill's directory
(`plugins/asset-pipeline/skills/image-to-threejs`).

```bash
run forge/stage3_build/generate_threejs_factory.py spec.json \
    --out src/model/<name>-factory.generated.ts --pass-id blockout --force

node $SKILL/scripts/normalize_factory.mjs \
    src/model/<name>-factory.generated.ts

uv run --python 3.12 --no-project $SKILL/scripts/render_model.py \
    --project <vite-project> --factory src/model/<name>-factory.generated.ts \
    --export create<Name>Model --out-dir runs/blockout --views front,three-quarter
```

`generate_threejs_factory.py` needs `--force` on every regeneration over an
existing file — that is a normal loop step, unlike `new_sculpt_spec.py --force`,
which wipes your pass credits and is never routine.

`render_model.py` mounts the factory in a throwaway Vite entry, frames it by its
own bounding box, and shoots fixed angles — the gate wants a browser render and
upstream leaves producing one to you. Run it **twice per pass**: once lit, once
with `--map-stripped` (a whole-run material override that writes
`<view>-stripped.png` + `contact-stripped.json` beside the lit run's files, so
the two evidence sets never clobber each other). `contact.json` carries
mesh/material/geometry counts, socket and pivot names, and bounds.
`--elevation` overrides the camera pitch — match the reference's (product
shots sit near 0–5°; the defaults are 12–22°) before any silhouette
comparison, or IoU gates false-negative on framing alone. The `raking` view
(azimuth 15°, elevation 3°) is for surface-pass evidence on flat props, where
`side` is dead edge-on.

Before any visual compare or tier-1 run, align framing with
`scripts/align_framing.py align` (its `crop` mode is also the crop-zoom tool
the authoring step calls for). Details and traps: `references/spec-contract.md`.

**Always normalize.** Raw output is not shippable here:

- **~26–43% of the file is inlined spec JSON** on `userData.sculptComponent` and
  `userData.actionProfile`, on _both_ the pivot node and the mesh. It is
  authoring provenance and it all reaches the browser.
- It assumes a permissive tsconfig; ours raises ~28 errors on its internals. The
  normalizer marks the file generated-and-unchecked rather than rewriting
  internals that change upstream — safety is enforced at the typed import site.

Name it `<object>-factory.generated.ts` — the `.generated.ts` suffix is what
`.oxlintrc.json` ignores (keeping the generator's `Record<string, any>` out of
`pnpm lint`), and the object-named prefix keeps a second prop from colliding.
Pass `--keep-action-profile` if you read colliders or fracture groups at
runtime.

### 5. Review, then unlock the next pass

Passes are `locked-sequential`. To advance you must supply real evidence:

```bash
uv run --python 3.12 --no-project $SKILL/scripts/align_framing.py align \
    --reference ref/<name>.jpg --render runs/<pass>/front.png \
    --out runs/<pass>/front-aligned.png
run forge/stage4_review/make_comparison_sheet.py --reference ref/<name>.jpg \
    --render runs/<pass>/front-aligned.png --out runs/<pass>/compare.png

# Write layer-scores.json + feature-reviews.json as FILES in the run dir —
# inline JSON over ~255 bytes is stat'd as a path and dies with ENAMETOOLONG.
run forge/stage4_review/append_review.py spec.json --in-place \
  --pass-id <pass> --fidelity 0.78 --action continue --summary "..." \
  --matched "..." --mismatches "..." \
  --reference-screenshot ... --render-screenshot ... --comparison-image ... \
  --map-stripped-render runs/<pass>/front-stripped.png \
  --ai-vision-score 0.78 --camera-view front \
  --layer-scores-json runs/<pass>/layer-scores.json \
  --feature-reviews-json runs/<pass>/feature-reviews.json
```

Hard requirements on a visual-pass `continue` (full list:
`references/spec-contract.md`): comparison image, score ≥ threshold, all five
named layer scores, per-pass critical feature reviews ≥ 0.8, and — blockout
only — a genuinely stripped render (`front-stripped.png`, not the lit one).
Omit `--review-viewpoints-json`; it demands views the shared camera never
produces. There is also a **tier-1 quantitative gate**
(`diagnose_render.py` → `orchestrate_passes.py check`) with a framing trap the
contract file explains — normalize framing and match `--elevation` first, or a
correct model fails on IoU alone.

**Look at the comparison sheet and score it honestly.** Critical features carry
a hard minimum (0.8) and the gate will refuse you — that is the system working.
When it refuses, _fix the model_, don't inflate the number. Early passes legitimately
score near zero on `formDetail`; say so in the notes and explain what the global
number is weighted to, so the next agent can audit the call. A review history
containing an honestly-failed cycle (`refine-spec`, then a credited retry) is
evidence the gate discriminates — a spec where every review passed first try
reads as rubber-stamping.

Passes emit progressively: **blockout emits macro components only; meso parts
(strapping, plates, fittings) appear at structural-pass.** Before crediting,
run `check_part_coverage.py` — it reconciles spec-vs-built and catches parts
the generator silently skipped.

## Rendering gotchas that read as broken models

- **Metal renders pure black without an environment map.** A high-`metalness`
  PBR material has nothing to reflect. `render_model.py` supplies a
  `RoomEnvironment`; a game scene must too, or keep `metalness` ≲ 0.55.
- **Cylinder end caps sample the procedural field in polar UV**, so a lively
  `colorVariation.amplitude` becomes a radial starburst on every flat cap. Keep
  variation low (~0.03) on any material with a visible cap.
- **Coincident circular faces z-fight** into a moiré. Hold a cap ring clear of
  the shell's own end face, or move it fully outboard.
- A part at a parent's local origin sits **inside** the parent. Push it to the
  face (`±0.5` in the parent's local frame) to be seen.

## Wire it into the game

Reach the rig **by the generator's name contracts**, never by traversal order:

- pivots → `"<Component Name>__pivot"` (e.g. `"Domed Lid__pivot"`)
- sockets → `"<componentId>:<socketId>"`, and present in the graph as objects
  whose names contain `socket`

```ts
const model = createTreasureChestModel({ castShadow: true });
const lid = model.getObjectByName("Domed Lid__pivot");
lid.rotation.x = -1.75 * eased;
```

A `__pivot` node rotates about `transform.position` — which is only a hinge if
the spec put the carrier ON the hinge line (see step 3). Animate the pivot
node, never the mesh, and never re-centre or uniform-scale the model to fix
placement; both move the armature off its axes. Position the returned group
instead.

## Say which pass shipped

A blockout described as "a model of the reference" is over-claiming. State the
pass, and name what still does not match — the next agent needs to know whether
the gap is unfinished work or a deliberate stop.

## Related

`threejs` (consuming the model, `references/generated-assets.md`) ·
`model-catalog` / `regenerate-3d` (the mesh branch) · `model-prompting`
(reference-image prompt craft) · `animated-spritesheets` (the 2D sibling) ·
`game-feel` (what the rig is for).
