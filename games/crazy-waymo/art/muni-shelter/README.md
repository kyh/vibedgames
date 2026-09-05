# Muni shelter

Reference-driven street prop for Crazy Waymo. Built with the local image-to-threejs skill and installed upstream v1.5.1. No Blender assets.

Production source: `../../src/world/sf-street-kit.ts`. `getMuniShelterKit()` returns six cached material batches; `createMuniShelterModel()` exposes the same geometry as named pieces for review. The game places the cached kit through `furniture.ts`, then bakes it into the city. The factory is strict TypeScript. The unchecked upstream intermediate was removed; its hash remains in `generator-provenance.json`.

## Runtime contract

- Origin: ground between feet. Local +Z: roadway/open entrance.
- Bounds: 4.400 × 2.797 × 1.900 world units.
- 9,736 triangles. Six materials. No texture downloads.
- 242 named review meshes become six shared merged buffers.
- Four glazed-frame posts, two bench feet. Placement samples every foot and adds concrete shoes beneath a level shelter. Slopes exceeding 0.8u across the feet retain the stop pole alone.
- Road-facing yaw: `atan2(tz * side, -tx * side)`.
- Parcel clearance uses full ring/rotated-box intersections with 0.6u facade clearance. Each stop tries up to nine nearby curb locations, staying on the same road edge. Invalid sites retain a pole. The fix first shipped in revision 88 and passes the installed revision 90 audit.
- Construction budget, finite geometry, envelope and shared-cache identity are checked by `tools/test-sf-street-kit.mts` through `pnpm test`.

## Evidence and review

`reference.png` is the supplied generated reference. Canopy, bench and route crops informed the component spec before generation. `spec.json` passes the upstream strict-quality schema check. `author-spec.py` preserves review history while rebuilding the authoring component specification.

`runs/blockout/` retains the macro-only browser render, stripped front and comparison referenced by the review history. Redundant framing intermediates were removed. This rejected first pass established proportions but omitted the steel frame, bench slats and signs.

`runs/production/` contains front, three-quarter, rear-quarter and stripped-material browser captures of the strict factory. `compare.png` places the reference on the left. Physical additions include a thick wave roof, dark soffit with ribs, beveled steel frame, glazing clamps, bolted feet, fourteen separate bench slats, curved bench cheeks, three dividers and geometric municipal signage.

`runs/production/turntable.json` passes all four required diagonal views, with no silhouette collapse. Duplicate ring captures were consolidated into the production directory; their images were byte-identical. Through-openings are expected for an open shelter. This test establishes volumetric coverage, not reference likeness.

The upstream part-name check reports 13 naming mismatches after the strict reconstruction. Its raw report is retained. `component-coverage.json` maps all 19 authored component IDs to actual production piece names and coordinates. This is a documented semantic reconciliation, not a passing upstream part-name gate.

The full locked reference-fidelity pipeline is **not credited complete**. The production comparison was scored 0.79 overall: silhouette 0.82, structure 0.88, form 0.82, material 0.62, lighting/camera 0.58. The fixed review lighting washes the enamel and metal; its camera is not solved against the reference. Microscopic photographic surface grain is omitted for the arcade art direction. Smooth manufactured material zones carry explicit textureless evidence in the spec; no extracted PBR maps or exact photographic reconstruction are claimed. `reviewHistory` records both reviews honestly.

The skill framing helper cropped a square before resizing into this 3:2 reference, cutting off the roof ends. The retained comparison uses a uniform fit of the entire subject. It does not repaint model pixels or distort aspect. The production aligned-image sidecar records source bounds, scale and placement; the one-off packaging script is no longer needed.

## Reproduce browser captures

From repository root, with the existing game dependencies installed:

```sh
uv run --cache-dir /private/tmp/waymo-uv-cache --python 3.12 --no-project \
  plugins/asset-pipeline/skills/image-to-threejs/scripts/render_model.py \
  --project games/crazy-waymo/art/muni-shelter/preview \
  --factory ../../../src/world/sf-street-kit.ts --export createMuniShelterModel \
  --out-dir games/crazy-waymo/art/muni-shelter/runs/production \
  --views front,three-quarter,az135,az225,az315 --elevation 12 --transparent
```

Repeat with `--map-stripped` for neutral geometry evidence. The isolated preview disables HMR so world-generation reload rules cannot interrupt captures. Regenerating the temporary upstream blockout from `spec.json` is possible, but it is not the production source and must not replace the strict factory.
