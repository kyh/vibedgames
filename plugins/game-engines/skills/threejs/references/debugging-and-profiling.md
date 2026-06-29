# Debugging & Profiling Three.js

A scene that builds but renders black, or runs at 12fps on a phone, is the most common Three.js failure. This is the triage order and the fixes.

**Verify objectively, not by eyeballing.** Use [`../scripts/check-canvas.mjs`](../scripts/check-canvas.mjs) to confirm a running build actually draws non-blank pixels — it loads the page in headless Chromium, screenshots the canvas, and reports pixel variance. A green check beats "looks fine to me," and it catches black-screen regressions in CI / before `vg deploy`.

```bash
node check-canvas.mjs http://localhost:5173 --out /tmp/frame.png
# exit 0 = rendered something; exit 1 = blank; exit 2 = error
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

**Draw calls (`render.calls`) are usually the bottleneck, not triangles.** A modern GPU eats millions of triangles but chokes on thousands of draw calls. Budget rough targets: **< 100–200 draw calls** for mobile, triangles in the low millions.

### Fixes, highest-leverage first

| Symptom | Fix |
| --- | --- |
| High draw calls, many identical objects | **`InstancedMesh`** — one call for thousands (see `advanced-topics.md`) |
| High draw calls, many *static* distinct objects | **Merge geometries** (`BufferGeometryUtils.mergeGeometries`) into one mesh |
| Many materials | Share material instances; atlas textures so meshes can batch |
| Heavy in the distance | **LOD** — swap to low-poly past a distance (`advanced-topics.md`) |
| Shadows tank FPS | Lower `shadow.mapSize` (1024), shrink the shadow camera frustum to the play area, or bake/disable for distant lights |
| Post-processing cost | Render bloom/SSAO at half resolution; drop passes on mobile |
| GC stutter every few seconds | You're allocating in the loop — hoist `new Vector3()`/geometry creation out (the #1 cause) |
| Fine on desktop, melts on phone | **DPR uncapped** — `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`; a 3× phone renders 9× the pixels |

---

## Mobile-specific

- **DPR cap** (above) — single biggest mobile win.
- **Resize handling** — listen for `resize` *and* orientation change; update `camera.aspect`, `updateProjectionMatrix()`, `renderer.setSize()`. A stretched scene after rotation means this is missing.
- **Touch vs pointer** — use `pointerdown`/`pointermove` (covers mouse + touch) rather than `mousedown`. Register listeners on the canvas, and call `preventDefault` to stop scroll/zoom hijacking the game.
- **Audio suspended** — `AudioContext` starts suspended; resume on first gesture (see `threejs-gameplay` `generated-assets.md`).
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

Also unregister the entity's **animation mixer and physics body** when removing it (see `game-patterns.md` and `threejs-gameplay`), or they keep updating ghosts.

---

## Quick reference: what to check first

| Problem | First thing to check |
| --- | --- |
| Black screen | scene.add → light → camera position (`check-canvas.mjs` to confirm objectively) |
| Low FPS | `renderer.info.render.calls`, then DPR cap |
| FPS drops over time | allocation in the loop, then undisposed resources |
| Bad on mobile only | DPR cap, then resize handling |
| Stretched after rotate | resize handler updating aspect + setSize |
