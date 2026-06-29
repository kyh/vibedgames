---
name: threejs
description: "Build 3D browser apps AND games with Three.js (r150+, ES modules): scene setup, geometries, materials, lighting, animation, GLTF models, physics (Rapier/cannon-es/arcade), character controllers, follow/third-person cameras, fixed-timestep loops, post-processing, and performance/debugging. Use for 'create a three.js scene/app/showcase', any 3D web content, and turning a scene into a game — 'add physics to my three.js game', 'third-person/character controller', 'follow camera', 'jump and gravity', 'collide with / pick up objects', 'structure my 3d game'. Trigger: threejs, three.js, 3D scene, WebGL scene, GLTF/GLB, OrbitControls, Rapier, cannon-es, 3D game, third-person controller. For 2D games use `phaser`; for engine-agnostic feel/balance/level craft use the game-craft skills."
---

# Three.js

Build performant 3D browser apps and games with Three.js using modern ES module patterns (r150+). This file covers scene setup inline; physics, controllers, gameplay architecture, and deep topics live in `references/`.

**Core principles:**

1. **Scene Graph First**: everything added to `scene` renders. Use `Group` for hierarchical transforms (parent transforms affect children).
2. **Primitives as building blocks**: built-in geometries (Box, Sphere, Torus) cover most simple cases.
3. **Animation as transformation**: change position/rotation/scale over time in `renderer.setAnimationLoop`.
4. **Performance through simplicity**: fewer objects, fewer draw calls, reusable geometries/materials.
5. **A scene is not a game**: gameplay needs a fixed-timestep loop, a controller driven by input, collision, and a follow camera — see the Reference Files below before building one.

---

## Reference Files

Scene setup is inline below. Read the relevant reference before working on that area:

| When you're working on...                                              | Read first                              |
| ---------------------------------------------------------------------- | --------------------------------------- |
| Turning a scene into a playable game (fixed-timestep loop, structure)  | `references/gameplay-systems.md`        |
| Physics or collision (Rapier / cannon-es / arcade overlap)             | `references/physics.md`                 |
| Movement controllers + follow/third-person camera                      | `references/controllers-and-camera.md`  |
| Loading/caching/normalizing GLTF/GLB models                            | `references/gltf-loading-guide.md`      |
| Game loop, state machine, object pooling, screen effects               | `references/game-patterns.md`           |
| Dropping generated GLB models / SFX into a running scene               | `references/generated-assets.md`        |
| Post-processing, shaders, instancing, env maps, color management       | `references/advanced-topics.md`         |
| Black screen, low FPS, mobile issues, memory leaks                     | `references/debugging-and-profiling.md` |

**Verify it actually renders.** `scripts/check-canvas.mjs` loads a build in headless Chromium and fails on a blank canvas or uncaught page error — run it in CI / before `vg deploy` (details in `references/debugging-and-profiling.md`).

### Physics: pick the lightest tool (decide early)

| Approach            | Use when                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| Arcade / custom     | Pickups, triggers, hand-tuned jumps — overlap checks, no dependency        |
| cannon-es           | A few dozen dynamic rigid bodies, pure-JS simplicity                       |
| **Rapier**          | Serious games: stable stacking, many bodies, a real character controller   |
| None                | Showcases, product viewers, data viz, background effects                   |

Recipes for all three are in `references/physics.md`; don't simulate things that want authored feel.

---

## Quick Start: Essential Setup

### Minimal HTML Template

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Three.js App</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      body {
        overflow: hidden;
        background: #000;
      }
      canvas {
        display: block;
      }
    </style>
  </head>
  <body>
    <script type="module">
      import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

      // Scene setup
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000,
      );
      const renderer = new THREE.WebGLRenderer({ antialias: true });

      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      document.body.appendChild(renderer.domElement);

      // Your 3D content here
      // ...

      camera.position.z = 5;

      // Animation loop
      renderer.setAnimationLoop((time) => {
        renderer.render(scene, camera);
      });

      // Handle resize
      window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });
    </script>
  </body>
</html>
```

---

## Geometries

Built-in primitives cover most simple app needs. Use `BufferGeometry` only for custom shapes.

**Common primitives**:

- `BoxGeometry(width, height, depth)` - cubes, boxes
- `SphereGeometry(radius, widthSegments, heightSegments)` - balls, planets
- `CylinderGeometry(radiusTop, radiusBottom, height)` - tubes, cylinders
- `TorusGeometry(radius, tube)` - donuts, rings
- `PlaneGeometry(width, height)` - floors, walls, backgrounds
- `ConeGeometry(radius, height)` - spikes, cones
- `IcosahedronGeometry(radius, detail)` - low-poly spheres (detail=0)

**Usage**:

```javascript
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
```

---

## Materials

Choose material based on lighting needs and visual style.

**Material selection guide**:

- `MeshBasicMaterial` - No lighting, flat colors. Use for: UI, wireframes, unlit effects
- `MeshStandardMaterial` - PBR lighting. Default for realistic surfaces
- `MeshPhysicalMaterial` - Advanced PBR with clearcoat, transmission. Glass, water
- `MeshNormalMaterial` - Debug, rainbow colors based on normals
- `MeshPhongMaterial` - Legacy, shininess control. Faster than Standard

**Common material properties**:

```javascript
{
    color: 0x44aa88,           // Hex color
    roughness: 0.5,            // 0=glossy, 1=matte (Standard/Physical)
    metalness: 0.0,            // 0=non-metal, 1=metal (Standard/Physical)
    emissive: 0x000000,        // Self-illumination color
    wireframe: false,          // Show edges only
    transparent: false,        // Enable transparency
    opacity: 1.0,              // 0=invisible, 1=opaque (needs transparent:true)
    side: THREE.FrontSide      // FrontSide, BackSide, DoubleSide
}
```

---

## Lighting

No light = black screen (except BasicMaterial/NormalMaterial).

**Light types**:

- `AmbientLight(intensity)` - Base illumination everywhere. Use 0.3-0.5
- `DirectionalLight(color, intensity)` - Sun-like, parallel rays. Cast shadows
- `PointLight(color, intensity, distance)` - Light bulb, emits in all directions
- `SpotLight(color, intensity, angle, penumbra)` - Flashlight, cone of light

**Typical lighting setup**:

```javascript
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

const mainLight = new THREE.DirectionalLight(0xffffff, 1);
mainLight.position.set(5, 10, 7);
scene.add(mainLight);

const fillLight = new THREE.DirectionalLight(0x88ccff, 0.5);
fillLight.position.set(-5, 0, -5);
scene.add(fillLight);
```

**Shadows** (advanced, use when needed):

```javascript
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

mainLight.castShadow = true;
mainLight.shadow.mapSize.width = 2048;
mainLight.shadow.mapSize.height = 2048;

mesh.castShadow = true;
mesh.receiveShadow = true;
```

---

## Animation

Transform objects over time using the animation loop.

**Animation patterns**:

1. **Continuous rotation**:

```javascript
renderer.setAnimationLoop((time) => {
  mesh.rotation.x = time * 0.001;
  mesh.rotation.y = time * 0.0005;
  renderer.render(scene, camera);
});
```

2. **Wave/bobbing motion**:

```javascript
renderer.setAnimationLoop((time) => {
  mesh.position.y = Math.sin(time * 0.002) * 0.5;
  renderer.render(scene, camera);
});
```

3. **Mouse interaction**:

```javascript
const mouse = new THREE.Vector2();

window.addEventListener("mousemove", (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
});

renderer.setAnimationLoop(() => {
  mesh.rotation.x = mouse.y * 0.5;
  mesh.rotation.y = mouse.x * 0.5;
  renderer.render(scene, camera);
});
```

---

## Camera Controls

Import OrbitControls from examples for interactive camera movement:

```html
<script type="module">
  import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
  import { OrbitControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js";

  // ... scene setup ...

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
</script>
```

---

## Common Scene Patterns

### Rotating Cube (Hello World)

```javascript
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x00ff88 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

renderer.setAnimationLoop((time) => {
  cube.rotation.x = time * 0.001;
  cube.rotation.y = time * 0.001;
  renderer.render(scene, camera);
});
```

### Floating Particle Field

```javascript
const particleCount = 1000;
const geometry = new THREE.BufferGeometry();
const positions = new Float32Array(particleCount * 3);

for (let i = 0; i < particleCount * 3; i += 3) {
  positions[i] = (Math.random() - 0.5) * 50;
  positions[i + 1] = (Math.random() - 0.5) * 50;
  positions[i + 2] = (Math.random() - 0.5) * 50;
}

geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
const material = new THREE.PointsMaterial({ color: 0xffffff, size: 0.1 });
const particles = new THREE.Points(geometry, material);
scene.add(particles);
```

### Animated Background with Foreground Object

```javascript
// Background grid
const gridHelper = new THREE.GridHelper(50, 50, 0x444444, 0x222222);
scene.add(gridHelper);

// Foreground object
const mainGeometry = new THREE.IcosahedronGeometry(1, 0);
const mainMaterial = new THREE.MeshStandardMaterial({
  color: 0xff6600,
  flatShading: true,
});
const mainMesh = new THREE.Mesh(mainGeometry, mainMaterial);
scene.add(mainMesh);
```

---

## Colors

Three.js uses hexadecimal color format: `0xRRGGBB`

Common hex colors:

- Black: `0x000000`, White: `0xffffff`
- Red: `0xff0000`, Green: `0x00ff00`, Blue: `0x0000ff`
- Cyan: `0x00ffff`, Magenta: `0xff00ff`, Yellow: `0xffff00`
- Orange: `0xff8800`, Purple: `0x8800ff`, Pink: `0xff0088`

---

## Anti-Patterns to Avoid

- **Wrong OrbitControls path** → `THREE.OrbitControls` is undefined in modern Three.js. Import from `three/addons/controls/OrbitControls.js` (or the unpkg `examples/jsm/` path).
- **Forgetting `scene.add(object)`** → object won't render, silent failure.
- **Old `requestAnimationFrame` instead of `setAnimationLoop`** → more verbose, doesn't handle WebXR. Use `renderer.setAnimationLoop((time) => { ... })`.
- **Creating geometries in the animation loop** → memory allocation, frame-rate collapse. Create once, reuse; transform only position/rotation/scale.
- **Too many segments on primitives** → wasted vertices. `SphereGeometry(1, 32, 16)`, not `(1, 128, 64)`.
- **No pixelRatio cap** → 4K/5K runs at full res. Use `Math.min(window.devicePixelRatio, 2)`.
- **Everything in one function / hardcoded values** → split into `createScene()`/`createLights()`/`createMeshes()`; hoist constants into a `CONFIG` object.

---

## Variation Guidance

Each app should feel context-appropriate, not templated. Vary by scenario:

- **Portfolio/showcase**: elegant, smooth animations, muted colors
- **Game/interactive**: bright colors, snappy controls, particle effects
- **Data visualization**: clean lines, grid helpers, clear labels
- **Background effect**: subtle, slow movement, dark/gradient backgrounds
- **Product viewer**: realistic lighting, PBR materials, smooth orbit

Vary geometry (not always a cube), material style, color palette, and animation style. Avoid converging on the default green cube at z=5 with a directional light at (1,1,1).

Use ES modules from the `three` package or CDN — CommonJS and the global `THREE` are legacy.

---

## See Also

See the **Reference Files** table near the top for the full map of `references/` (gameplay systems, physics, controllers/camera, GLTF loading, game patterns, generated assets, advanced topics, debugging) and `scripts/check-canvas.mjs`. For 2D games use the `phaser` skill; for engine-agnostic feel/balance/level/onboarding craft use the `game-craft` skills.
