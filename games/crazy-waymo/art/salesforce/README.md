# Salesforce Tower

Reference-driven replacement for the former two-cylinder landmark. Production source: [sf-salesforce.ts](../../src/world/sf-salesforce.ts). Generated art direction: [reference.png](reference.png).

The design follows the tower's curving taper, rounded glass corners, floor sunshades and crown extending above occupied floors. The recessed lobby connects the tower to the street. Architectural context: [Pelli Clarke & Partners](https://pcparch.com/work/salesforce-tower).

## Runtime contract

- Local origin at ground; +Z is the lobby entrance. Existing placement, rotation, KIT_SCALE 13/8, reservation and collision solids stay unchanged.
- All vertices remain inside the old circular radius 4.2 and y = 0..49.5 envelope. Measured maximum radius 4.1735; y = 0..49.4350.
- 14,276 triangles. Six cached material buffers. Packed normals and linear colors: 0.573 MiB total geometry.
- `getSalesforceKit()` owns shared buffers and materials. `createSalesforceModel()` returns fresh Group/Mesh instances; callers must not dispose borrowed buffers.
- 32 perimeter divisions and 40 occupied facade bands. Horizontal ledges have top, underside and front faces. Continuous fins follow the curved profile. Selected panes carry deterministic night illumination.
- Crown glazing uses one transparent pass and does not cast opaque shadows. `setSalesforceNight(night)` follows the game clock beside parcel lighting; no timers or per-window draws.
- `test-sf-salesforce.mts` checks finite geometry, circular envelope, height, triangle budget, degenerate triangles, cache/node ownership, transparent shadows and bounded night emission.

## Reference workflow and review

The local image-to-threejs skill guided the isolated reference, visual assessment, crown/grid/lobby crops, complete component/material spec, typed procedural reconstruction and real browser review. [spec.json](spec.json) passes the installed upstream v1.5.1 strict-quality validator. [author-spec.py](author-spec.py) preserves the authored specification; smooth manufactured material zones have explicit textureless evidence.

Production geometry is handwritten strict TypeScript. No unchecked upstream factory ships. The full locked reference-fidelity pipeline is not claimed complete: the game's fixed envelope and readable grid spacing take priority over matching the generated image's perspective and denser glazing exactly. No extracted photographic PBR maps or measured reconstruction accuracy are claimed.

[runs/production/](runs/production/) contains canonical front/diagonal browser renders and tightly framed whole/lobby/crown/grid views. Day, night and stripped-material views establish the relief and crown openness. `grid-unshadowed.png` removes the faint closeup bands seen beneath ledges: those are preview shadow-map samples, not intersecting pane geometry. The neutral rig differs from game lighting; final gameplay captures are reviewed separately.

| Authored component                             | Runtime material batch |
| ---------------------------------------------- | ---------------------- |
| Curved curtain wall and panel joints           | salesforce-glass       |
| Selected occupied panes and entrance transom   | salesforce-lit         |
| Floor ledges, vertical grid and lobby mullions | salesforce-metal       |
| Upper transparent lattice veil                 | salesforce-crown       |
| Ground rim, entrance canopy and piers          | salesforce-stone       |
| Recessed lobby and mechanical crown core       | salesforce-dark        |

## Reproduce

From the game directory:

```sh
pnpm exec vite --config art/salesforce/preview/vite.config.ts art/salesforce/preview --port 5196
```

The event-driven preview renders once per view. `window.__salesforceReview.view("crown", "night", 28)` selects whole/lobby/crown/grid framing, day/night/stripped materials and azimuth. `shadows(false)` isolates surface geometry from shadow-map sampling. The shared skill renderer also accepts `createSalesforceModel` from this factory.
