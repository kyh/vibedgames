# Debugging & Profiling Three.js

A scene that builds but renders black, or runs at 12fps on a phone, is the most common Three.js failure. This is the triage order and the fixes.

**Verify objectively, not by eyeballing.** Use [`../scripts/check-canvas.mjs`](../scripts/check-canvas.mjs) to confirm a running build actually draws non-blank pixels — it loads the page in headless Chromium, screenshots the canvas, and reports pixel variance. A green check beats "looks fine to me," and it catches black-screen regressions in CI / before `vg deploy`.

```bash
# run from the threejs skill directory (the script lives in scripts/)
node scripts/check-canvas.mjs http://localhost:5173 --out /tmp/frame.png
# exit 0 = rendered; 1 = blank/solid or uncaught page error; 2 = error
```

---

## Black screen — triage in this order

Work top-down; each is more common than the one below it.

1. **Nothing added to the scene** — `scene.add(mesh)` missing. Silent. Add an `AxesHelper(5)` and `GridHelper(10,10)`; if you don't even see those, it's camera/renderer, not your mesh.
2. **No light + a lit material** — `MeshStandardMaterial`/`MeshPhongMaterial` render black with no light. Add an `AmbientLight`, or temporarily swap to `MeshNormalMaterial` (needs no light) to confirm geometry is there.
3. **Camera inside/behind the object, or facing away** — default camera sits at origin, same as a mesh. Move it (`camera.position.set(0,2,5); camera.lookAt(0,0,0)`).
4. **Near/far plane clipping** — object beyond `far` or nearer than `near`, or `near` set to 0 (breaks depth). Use `near: 0.1`, `far` sized to your scene.
5. **Canvas has zero size** — a flex/grid parent collapsed the canvas to 0×0. Check `renderer.domElement.getBoundingClientRect()`; ensure the container has explicit dimensions.
6. **Render loop never runs / renders once before assets load** — confirm `renderer.setAnimationLoop` is set; GLTF loads async, so a one-shot `render()` fires before the model arrives.
7. **Color space / tone mapping crushing everything to black** — extreme exposure or an HDR environment with `toneMappingExposure: 0`. Reset `renderer.toneMappingExposure = 1`.
8. **WebGL context failed** — check the console for `WebGL context lost` / creation failure (headless without GPU, too-large textures). `renderer.getContext()` is null on failure.

---

## Performance — measure before optimizing

Add `Stats` and read `renderer.info` before changing anything. Optimizing the wrong thing is the default outcome of guessing.

```javascript
import Stats from "three/addons/libs/stats.module.js";
const stats = new Stats();
document.body.appendChild(stats.dom);

// once per second, log the numbers that actually predict cost:
console.log(renderer.info.render); // { calls, triangles, ... }
console.log(renderer.info.memory); // { geometries, textures }
```

**Draw calls (`render.calls`) are usually the bottleneck, not triangles.** A modern GPU eats millions of triangles but chokes on thousands of draw calls.

### Render budget starting points

Measure the **worst active-play view**, not the menu. These are starting contracts, not hard limits — overrun deliberately, but know you did. `check-canvas.mjs` compares these numbers automatically when the page exposes diagnostics (see below).

| Metric (worst active-play view)       | Desktop | Mobile |
| ------------------------------------- | ------- | ------ |
| Draw calls (`info.render.calls`)      | ≤ 300   | ≤ 150  |
| Triangles (`info.render.triangles`)   | ≤ 750k  | ≤ 300k |
| Geometries (`info.memory.geometries`) | ≤ 300   | ≤ 200  |
| Textures (`info.memory.textures`)     | ≤ 60    | ≤ 40   |
| Shadow-casting lights                 | ≤ 2     | 1      |
| Shadow map size                       | ≤ 2048  | ≤ 1024 |
| DPR cap                               | 2       | 1.5–2  |
| Post passes (beyond render+output)    | ≤ 2     | 0–1    |

To let headless checks read these numbers, expose a diagnostics snapshot and refresh it once a second:

```javascript
window.__GAME_DIAGNOSTICS__ = { renderer: {} };
setInterval(() => {
  const { render, memory } = renderer.info;
  window.__GAME_DIAGNOSTICS__.renderer = {
    calls: render.calls,
    triangles: render.triangles,
    geometries: memory.geometries,
    textures: memory.textures,
  };
}, 1000);
```

### Fixes, highest-leverage first

| Symptom                                         | Fix                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| High draw calls, many identical objects         | **`InstancedMesh`** — one call for thousands (see `advanced-topics.md`)                                              |
| High draw calls, many _static_ distinct objects | **Merge geometries** (`BufferGeometryUtils.mergeGeometries`) into one mesh                                           |
| Many materials                                  | Share material instances; atlas textures so meshes can batch                                                         |
| Heavy in the distance                           | **LOD** — swap to low-poly past a distance (`advanced-topics.md`)                                                    |
| Shadows tank FPS                                | Lower `shadow.mapSize` (1024), shrink the shadow camera frustum to the play area, or bake/disable for distant lights |
| Post-processing cost                            | Render bloom/SSAO at half resolution; drop passes on mobile                                                          |
| GC stutter every few seconds                    | You're allocating in the loop — hoist `new Vector3()`/geometry creation out (the #1 cause)                           |
| Fine on desktop, melts on phone                 | **DPR uncapped** — `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`; a 3× phone renders 9× the pixels         |

---

## Mobile-specific

- **DPR cap** (above) — single biggest mobile win.
- **Resize handling** — listen for `resize` _and_ orientation change; update `camera.aspect`, `updateProjectionMatrix()`, `renderer.setSize()`. A stretched scene after rotation means this is missing.
- **Touch vs pointer** — use `pointerdown`/`pointermove` (covers mouse + touch) rather than `mousedown`. Register listeners on the canvas, and call `preventDefault` to stop scroll/zoom hijacking the game.
- **Audio suspended** — `AudioContext` starts suspended; resume on first gesture (see [`generated-assets.md`](generated-assets.md)).
- **Power preference** — `new WebGLRenderer({ powerPreference: "high-performance" })` on mobile GPUs.

---

## Auditing a scene you didn't just write

Debugging starts from a symptom. An audit doesn't: nothing is obviously broken, so the failure mode is fixing whatever you happened to read first. Rank by **where the code runs**.

**Severity follows the render loop.** A line inside `setAnimationLoop`, a RAF callback, or an R3F `useFrame` runs 60 times a second; the same line in a menu handler runs once. Before judging anything, build a **hot-path map** — every frame-loop body, every pointer-move handler, and every function they call. A finding inside that map outranks a worse-looking one outside it.

```bash
rg -n 'setAnimationLoop|requestAnimationFrame|useFrame|frameloop=' src/   # where the loop lives
rg -n 'new (THREE\.)?(Vector[234]|Quaternion|Matrix4|Euler|Color|Raycaster)\(' src/
rg -n 'new (THREE\.)?\w*(Geometry|Material|Texture|RenderTarget)\(' src/  # each needs a dispose()
```

A grep hit is a lead, not a finding — confirm each at its `file:line`. Inside the hot-path map it's HIGH; outside it's usually noise.

**HIGH — runs every frame, or leaks GPU memory**

- Allocation inside the loop — hoist a module-scope scratch object and mutate it in place (§ Performance, "GC stutter")
- Undisposed geometry / material / texture / render target, **including objects replaced mid-game**, not just torn down at exit (§ Memory leaks)
- `scene.traverse` every frame, or raycasting the whole scene on every pointer move — cache the list, raycast a filtered target array
- Physics bodies that outlive the entity that owned them (§ Physics & collision, #6)

**MEDIUM — per-render or per-interaction waste**

- Identical meshes drawn individually instead of through `InstancedMesh` (§ Performance, fixes table)
- Uncapped device pixel ratio (§ Mobile-specific)
- Assets loaded per instance instead of through one shared, cached loader ([`gltf-loading-guide.md`](gltf-loading-guide.md))
- Debug tooling still in the production bundle — the `vg new --engine threejs` template ships `lil-gui` and `stats.js` on purpose, and shipping them is easy to miss

**What no tool will flag — check these by hand**

- `dispose()` coverage for every imperatively created GPU resource
- Event listeners and `ResizeObserver`s on the canvas or window with no cleanup
- Color space set on the renderer _and_ on every color texture ([`advanced-topics.md`](advanced-topics.md))
- Shadows or post-processing enabled globally when only part of the scene needs them

Do not "fix" authored feel. A camera that lags on purpose, a deliberately flat-lit style, a capped frame budget — those are design decisions. If it looks wrong but reads as deliberate, raise it as a question rather than patching it.

### React Three Fiber

`vg new --engine react-r3f` scaffolds R3F, where the same failures wear different clothes:

| Vanilla Three.js                           | React Three Fiber                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Allocation inside `setAnimationLoop`       | Allocation inside `useFrame` — hoist to `useMemo` or module scope                                     |
| _(no equivalent)_                          | `setState` inside `useFrame` re-renders the tree 60×/s — mutate refs, keep state for discrete changes |
| Every `dispose()` is manual                | R3F owns anything in the declarative tree; imperatively created objects are still yours               |
| Rebuilding a geometry each frame           | Geometry/material without `useMemo`, or inline `args` whose identity changes each render              |
| `InstancedMesh`                            | `<Instances>`                                                                                         |
| One shared, cached loader                  | `useLoader` / `useTexture` / `useGLTF`                                                                |
| Stop calling `render()` when nothing moves | `frameloop="demand"` + `invalidate()` — for showcases and viewers, not games                          |

Plain-array props (`position={[x, y, z]}`) are fine — R3F handles them. A fresh object as a prop (`new THREE.Vector3()` inline) is not.

For the React half of an R3F app — the component tree outside the canvas — `npx react-doctor@latest --verbose` scans read-only and reports React-level problems. It sees nothing Three.js-specific, so it complements the list above rather than replacing it.

---

## Visual defects — sweep with evidence

A scene can render, hit every budget, and still look wrong. These defects never reach the console, so hunt them deliberately — and against **frames**, never against source. `vg playtest` (see the `playtest` skill) drives a real browser:

```bash
vg playtest open http://localhost:5173
vg playtest screenshot /tmp/first.png
```

Capture the first stable frame, then capture again after moving the camera and interacting: several rows below only fail at a grazing angle or after a transition. With no browser available, check the causes from source and label each finding **inferred, not observed** — reading code and guessing is how you "fix" a defect that was never there.

A row fails only when the evidence shows the failure condition.

| Area                   | Exercise it like this                                         | Fails when                                                                              | Usual cause                                                            |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Render sanity          | Load, wait for a stable frame                                 | Black canvas, WebGL context error, or content that never appears                        | § Black screen                                                         |
| Geometry               | Move along seams, edges, boundaries                           | Gaps, missing faces, visible backfaces, two surfaces flickering at one depth            | Z-fighting → `graphics-recipes.md`; backfaces → material `side`        |
| Transparency and depth | Cross depth order with overlapping or transmissive surfaces   | Wrong sort order, halos, flicker at grazing angles                                      | `depthWrite: false` + `renderOrder` (`graphics-recipes.md`)            |
| Textures               | View mapped surfaces close, far, and at a grazing angle       | Missing, stretched, seams, moiré, or washed-out color                                   | Color space (`advanced-topics.md`); moiré → anisotropy                 |
| Materials and lighting | Change light direction and view direction on lit surfaces     | Surfaces that ignore light direction; metals with nothing to reflect                    | `metalness: 1` needs `scene.environment` (`advanced-topics.md`)        |
| Shadows                | Move casters, receivers, and the light through their range    | Acne, detached or floating shadows, flicker at rest, shadows outliving their caster     | `graphics-recipes.md` § Shadow Acne                                    |
| Camera                 | Follow the subject through movement and transitions           | Subject leaves frame, camera clips into geometry, foreground blocks the play area       | [`controllers-and-camera.md`](controllers-and-camera.md)               |
| Scale and contact      | Compare object scale and resting contact against surroundings | Objects float above, sink into, or intersect their support, or sit at implausible scale | Model normalization ([`gltf-loading-guide.md`](gltf-loading-guide.md)) |
| Image stability        | Pan the camera slowly at the resolutions you support          | Silhouettes, thin geometry, or highlights that crawl, sparkle, or ghost                 | `graphics-recipes.md` § Texture Shimmer                                |
| Resize and DPR         | Change viewport size, zoom, and device pixel ratio            | Distortion, blur, stretched output, or content leaving the viewport                     | Resize handler + `updateProjectionMatrix` (§ Mobile-specific)          |

After fixing, re-shoot every failed row **from the same viewpoint and interaction** as the original evidence — a different angle proves nothing about the defect you were chasing.

---

## Memory leaks

Three.js does **not** garbage-collect GPU resources when you `scene.remove()`. Removing a mesh leaves its geometry, material, and textures resident. Watch `renderer.info.memory` climb across level reloads — if `geometries`/`textures` only ever grow, you're leaking.

```javascript
function disposeObject(obj) {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        for (const key in m) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
  obj.parent?.remove(obj);
}
```

Also unregister the entity's **animation mixer and physics body** when removing it (see `game-patterns.md` and `gameplay-systems.md`), or they keep updating ghosts.

---

## Physics & collision

When "the physics is broken," check these in order — each is a distinct bug with a distinct signature:

1. **Collider doesn't match the visual mesh** — the player clips walls or bounces off air. Render debug shapes at collider positions (a wireframe `BoxHelper`/capsule mesh synced to each body) and compare. Colliders are primitives sized from measured bounds (`generated-assets.md`), and they drift if you scale the mesh after creating the collider.
2. **Fast objects tunnel through walls** — a bullet/dasher skips past a thin collider between steps. Enable CCD **only on the fast bodies** (`RigidBodyDesc.setCcdEnabled(true)` in Rapier) — CCD everywhere wastes CPU. Or thicken the wall collider.
3. **Kinematic platforms move the mesh but not the body** — the player falls through a "moving" platform. You must call `setNextKinematicTranslation()` on the body each step; setting `mesh.position` animates only the visual.
4. **Sensors never fire** — Rapier sensor colliders need active events: `.setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)`, and you must drain the event queue each step.
5. **Fixed-step accumulator wired to the render delta** — physics stepped with a variable `dt` explodes under frame drops (jitter, launches). Step at a fixed `1/60` inside an accumulator loop (`gameplay-systems.md`); never `world.step(renderDelta)`.
6. **Restart leaks bodies** — after a restart the world gets slower and collisions double-fire: old bodies were never removed. The physics world owns body lifecycle; on restart remove every body/collider (or rebuild the world), don't just clear the scene graph.

Diagnostics snippet — log once a second alongside `renderer.info`:

```javascript
console.log({
  bodies: world.bodies.len(), // Rapier
  colliders: world.colliders.len(),
});
// If these climb across restarts, you're leaking bodies (see #6).
```

---

## Quick reference: what to check first

| Problem                                            | First thing to check                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Black screen                                       | scene.add → light → camera position (`check-canvas.mjs` to confirm objectively)               |
| Low FPS                                            | `renderer.info.render.calls`, then DPR cap                                                    |
| FPS drops over time                                | allocation in the loop, then undisposed resources                                             |
| Bad on mobile only                                 | DPR cap, then resize handling                                                                 |
| Stretched after rotate                             | resize handler updating aspect + setSize                                                      |
| Clipping through walls / falling through platforms | collider-vs-mesh match, then CCD / kinematic body updates                                     |
| Surfaces flash/flicker as the camera moves         | z-fighting — coplanar meshes or `near` too small; fixes in `graphics-recipes.md` § Z-Fighting |
