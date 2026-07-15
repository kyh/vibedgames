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
