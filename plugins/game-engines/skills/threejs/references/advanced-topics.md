# Advanced Three.js Topics

Topics beyond simple scenes.

**Related guides:**

- [`gltf-loading-guide.md`](gltf-loading-guide.md) — loading 3D models (GLTF/GLB): basic/promise/fallback/batch loading, caching, cloning, normalization, troubleshooting
- [`game-patterns.md`](game-patterns.md) — game loops, screen effects, animation states, parallax
- [`graphics-recipes.md`](graphics-recipes.md) — PBR material values, onBeforeCompile shader injection, cheap visual tricks, sky dome
- [`debugging-and-profiling.md`](debugging-and-profiling.md) — black-screen triage, draw-call/FPS profiling, mobile, memory leaks

---

## Color Management & Tone Mapping

Modern Three.js (r152+) is color-managed by default, but a few settings decide whether a scene looks washed-out/blown-out or correct. Set these once on the renderer:

```javascript
const renderer = new THREE.WebGLRenderer({ antialias: true });

// r152+: output is sRGB by default, but be explicit when mixing CDN versions
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Tone mapping maps HDR lighting into displayable range. ACESFilmic is the
// safe cinematic default; without it, bright/PBR scenes blow out to white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0; // raise/lower overall brightness
```

**Texture color space matters too.** Color/albedo textures must be tagged sRGB; data textures (normal, roughness, metalness, AO) must stay linear — mis-tagging is the usual cause of "my model looks too dark/too bright":

```javascript
albedoTexture.colorSpace = THREE.SRGBColorSpace; // base color / emissive maps
normalTexture.colorSpace = THREE.NoColorSpace; // normal / roughness / metalness / AO
```

GLTF loaders set these correctly automatically — only set them by hand for textures you load yourself (`TextureLoader`).

---

## Post-Processing (Bloom, Vignette)

Use the EffectComposer, and **always end the chain with `OutputPass`** — since r152 it performs tone mapping + sRGB conversion. Without it the composer outputs linear un-tonemapped color (washed-out or blown-out); keep `renderer.toneMapping` set so `OutputPass` reads it.

```javascript
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

renderer.toneMapping = THREE.ACESFilmicToneMapping; // OutputPass applies this

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// UnrealBloomPass(resolution, strength, radius, threshold)
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45, // strength: 0.35–0.6
  0.3, // radius: 0.2–0.4
  0.85, // threshold: only pixels brighter than this bloom
);
composer.addPass(bloom);
composer.addPass(new OutputPass()); // ALWAYS last: tone mapping + sRGB

renderer.setAnimationLoop(() => {
  composer.render(); // instead of renderer.render()
});
// resize: composer.setSize(w, h) alongside renderer.setSize(w, h)
```

**Bloom discipline:** threshold `0.85` keeps mid-bright materials out, so only authored emissives (`emissiveIntensity > 1`) bloom. Bloom sells a glow you designed; it must never be the main source of detail — if a shape only reads because it glows, the geometry is missing.

**Vignette** — a compact ShaderPass, added before `OutputPass`:

```javascript
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.85 }, uSize: { value: 0.72 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uStrength, uSize; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0, smoothstep(uSize, uSize - 0.45, d), uStrength);
      gl_FragColor = c;
    }`,
};
composer.addPass(new ShaderPass(VignetteShader)); // before OutputPass
```

Keep `uStrength` subtle and never darken the play path.

**Mobile:** the composer allocates full-resolution HDR render targets, so cost scales with **DPR²**. Cap DPR before adding passes (`composer.setPixelRatio(Math.min(devicePixelRatio, 1.25))`), and on low-end devices skip the composer entirely (plain `renderer.render()`). Budget ≤ 2 passes desktop, 0–1 mobile beyond render+output.

---

## Custom Shaders (ShaderMaterial)

For fully custom **unlit** effects, write GLSL from scratch with `ShaderMaterial`. To add effects to a **lit PBR surface** (rim glow, dissolve, wind sway) don't rewrite the lighting — inject into `MeshStandardMaterial` with `onBeforeCompile` instead; see [`graphics-recipes.md`](graphics-recipes.md).

```javascript
const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const fragmentShader = `
    uniform float time;
    varying vec2 vUv;
    void main() {
        vec3 color = 0.5 + 0.5 * cos(time + vUv.xyx + vec3(0, 2, 4));
        gl_FragColor = vec4(color, 1.0);
    }
`;

const material = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: {
    time: { value: 0 },
  },
});

renderer.setAnimationLoop((time) => {
  material.uniforms.time.value = time * 0.001;
  renderer.render(scene, camera);
});
```

---

## Text and Sprites

For 2D text or labels in 3D space:

```javascript
// Canvas-based text sprite
function createTextSprite(message, scale = 1) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 256;
  canvas.height = 64;

  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "Bold 24px Arial";
  context.fillStyle = "white";
  context.textAlign = "center";
  context.fillText(message, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scale * 4, scale, 1);
  return sprite;
}

const label = createTextSprite("Hello Three.js!", 1);
label.position.set(0, 2, 0);
scene.add(label);
```

---

## Raycasting (Mouse Picking)

For clicking/touching 3D objects:

```javascript
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener("click", (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(scene.children);

  if (intersects.length > 0) {
    const object = intersects[0].object;
    // Do something with clicked object
    object.material.color.setHex(Math.random() * 0xffffff);
  }
});
```

---

## Environment Maps (Reflections)

**Metals and glossy surfaces render flat gray without an environment map** — there's nothing to reflect. This is the usual cause of "my metal doesn't look metallic."

Default: `RoomEnvironment` — a neutral studio IBL with **zero external assets**, so it always works in a generated game:

```javascript
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose(); // one bake at startup, near-zero cost per frame

// Now this actually reads as metal:
const material = new THREE.MeshStandardMaterial({
  color: 0xaeb4bd,
  metalness: 1,
  roughness: 0.1,
});
```

If you have a real HDR file (you usually don't in a generated game), load it with `RGBELoader`:

```javascript
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

new RGBELoader().load("environment.hdr", (texture) => {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = texture; // scene.background = texture for a visible backdrop
});
```

Concrete per-surface material values (`metalness`/`roughness`/`envMapIntensity`) are in [`graphics-recipes.md`](graphics-recipes.md).

---

## InstancedMesh (Many Similar Objects)

For rendering thousands of identical objects efficiently:

```javascript
const count = 1000;
const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
const material = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
const mesh = new THREE.InstancedMesh(geometry, material, count);

const dummy = new THREE.Object3D();
for (let i = 0; i < count; i++) {
  dummy.position.set(
    (Math.random() - 0.5) * 20,
    (Math.random() - 0.5) * 20,
    (Math.random() - 0.5) * 20,
  );
  dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
}

scene.add(mesh);
```

---

## Physics Integration (Cannon.js)

For physics-based interactions:

```html
<script type="module">
  import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
  import * as CANNON from "https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js";

  // Three.js setup
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Cannon.js world
  const world = new CANNON.World();
  world.gravity.set(0, -9.82, 0);

  // Sync mesh with physics body
  const geometry = new THREE.SphereGeometry(0.5);
  const material = new THREE.MeshStandardMaterial({ color: 0xff6600 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const body = new CANNON.Body({
    mass: 1,
    shape: new CANNON.Sphere(0.5),
    position: new CANNON.Vec3(0, 5, 0),
  });
  world.addBody(body);

  // Ground
  const groundBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const timeStep = 1 / 60;
  renderer.setAnimationLoop(() => {
    world.step(timeStep);
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
    renderer.render(scene, camera);
  });
</script>
```

---

## Installation with npm

For production apps, install Three.js via npm:

```bash
npm install three
```

```javascript
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Same API as CDN version
```

---

## TypeScript Support

Three.js includes TypeScript definitions:

```typescript
import * as THREE from "three";

const scene: THREE.Scene = new THREE.Scene();
const geometry: THREE.BoxGeometry = new THREE.BoxGeometry(1, 1, 1);
const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
  color: 0x44aa88,
});
const cube: THREE.Mesh = new THREE.Mesh(geometry, material);
scene.add(cube);
```

---

## Key Module Import Paths (r160+)

```javascript
// Core
import * as THREE from "three";

// Addons (three/addons/ in npm, examples/jsm/ in CDN)
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
```

---

## Performance Tips

1. **Reuse geometries and materials**: Create once, use many times
2. **Use InstancedMesh**: For 100+ identical objects
3. **Limit shadow map resolution**: 1024-2048 is usually sufficient
4. **Disable antialiasing**: For pixel art or performance-critical apps
5. **Use frustum culling**: Objects outside view are skipped (automatic)
6. **Merge geometries**: Combine static objects into one mesh
7. **Use LOD (Level of Detail)**: Switch to simpler geometries at distance

```javascript
// Geometry merging
const geometries = [];
for (let i = 0; i < 10; i++) {
  geometries.push(new THREE.BoxGeometry(1, 1, 1));
}
const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries);
```

---

## Debug Helpers

```javascript
// Grid helper
const gridHelper = new THREE.GridHelper(10, 10);
scene.add(gridHelper);

// Axes helper (RGB = XYZ)
const axesHelper = new THREE.AxesHelper(5);
scene.add(axesHelper);

// Stats.js for performance monitoring
import Stats from "https://unpkg.com/three@0.160.0/examples/jsm/libs/stats.module.js";
const stats = new Stats();
document.body.appendChild(stats.dom);

renderer.setAnimationLoop(() => {
  stats.begin();
  // render...
  stats.end();
});
```
