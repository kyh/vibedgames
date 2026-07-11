# Graphics Recipes

Concrete material values, shader injection patterns, and cheap visual tricks. Every recipe is copy-pasteable and mobile-conscious. Prerequisite: an environment map and a tone-mapped renderer (see [`advanced-topics.md`](advanced-topics.md)) — without them PBR values below won't read.

The rule for all of it: **effects clarify gameplay, never hide missing geometry.** If a shape only reads because it glows, the geometry is missing.

---

## PBR Material Recipes

Copy the config, tune `color` to your palette. `envMapIntensity` assumes a `RoomEnvironment` env map. Use `MeshStandardMaterial` unless a `MeshPhysicalMaterial`-only feature (clearcoat, transmission, sheen) is visible during play.

```javascript
// Painted metal (car body, ship hull) — dielectric paint over metal, read via clearcoat
new THREE.MeshPhysicalMaterial({
  color: 0x1f6feb,
  metalness: 0.0,
  roughness: 0.5,
  clearcoat: 0.9,
  clearcoatRoughness: 0.15,
  envMapIntensity: 1.0,
});

// Bare brushed metal (steel, gun frame) — needs the env map to look metallic at all
new THREE.MeshStandardMaterial({
  color: 0xaeb4bd,
  metalness: 1.0,
  roughness: 0.4,
  envMapIntensity: 1.1,
});

// Rubber / tire — near-black, kills reflection
new THREE.MeshStandardMaterial({
  color: 0x0a0a0b,
  metalness: 0.0,
  roughness: 0.92,
  envMapIntensity: 0.35,
});

// Matte plastic (housings, crates)
new THREE.MeshStandardMaterial({
  color: 0xd23b3b,
  metalness: 0.0,
  roughness: 0.62,
  envMapIntensity: 0.6,
});

// Glossy ceramic / clean hull — clearcoat for the wet-look premium read
new THREE.MeshPhysicalMaterial({
  color: 0xf5f5f5,
  metalness: 0.0,
  roughness: 0.12,
  clearcoat: 1.0,
  clearcoatRoughness: 0.05,
  envMapIntensity: 1.0,
});

// Emissive signal (beacon, pickup core) — dark base so only the glow reads; >1 intensity feeds bloom
new THREE.MeshStandardMaterial({
  color: 0x101010,
  emissive: 0x18e0ff,
  emissiveIntensity: 2.5,
  metalness: 0.0,
  roughness: 0.4,
});

// Cloth / fabric — high roughness + sheen for the soft edge highlight
new THREE.MeshPhysicalMaterial({
  color: 0x3a4a6b,
  metalness: 0.0,
  roughness: 0.9,
  sheen: 1.0,
  sheenRoughness: 0.5,
  sheenColor: new THREE.Color(0x8899bb),
  envMapIntensity: 0.5,
});
```

**Separate roles by roughness/metalness contrast (matte vs glossy, metal vs plastic), not hue alone.** Two objects with different colors but identical material response read as the same "stuff."

### Glass: real vs fake

```javascript
// REAL refractive glass — transmission
new THREE.MeshPhysicalMaterial({
  metalness: 0.0,
  roughness: 0.05,
  transmission: 1.0,
  thickness: 0.5,
  ior: 1.5,
  envMapIntensity: 1.0,
});
```

**Cost warning:** every transmissive material triggers an **extra full-scene render into a transmission buffer every frame**. Reserve it for one or two hero surfaces (cockpit canopy, potion vial) at close range. Never use it on repeated or instanced props.

```javascript
// CHEAP fake glass — one transparent draw call, no extra render target.
// Use for repeated windows, visors, shields.
new THREE.MeshPhysicalMaterial({
  color: 0x88ccff,
  metalness: 0.0,
  roughness: 0.1,
  transparent: true,
  opacity: 0.25,
  clearcoat: 1.0,
  envMapIntensity: 1.5,
  depthWrite: false,
});
```

Add the fresnel rim below for a readable edge.

---

## onBeforeCompile: Inject Into PBR Materials

To add rim glow, dissolve, scrolling emissive, or wind sway to a lit surface, inject GLSL into a stock `MeshStandardMaterial` — you keep the whole PBR lighting pipeline for free instead of rewriting it in a `ShaderMaterial`. Three rules make this safe:

- **Cache key (silent-failure gotcha):** any material whose `onBeforeCompile` injects code **must set `customProgramCacheKey`** returning a string unique to that injection. Without it Three.js can hand back a cached program compiled from a different, un-injected material of the same type — your code silently never runs, and it costs hours.
- **Animating uniforms:** `onBeforeCompile` fires **once** per compiled program, so stash the shader (`material.userData.shader = shader`) and write uniforms each frame: `if (m.userData.shader) m.userData.shader.uniforms.uTime.value = t;`.
- **Sharing:** reuse one material instance across meshes and its uniforms update once for all. For per-object variation, use separate instances (same cache key still reuses the program) or drive it from `instanceMatrix`.

### Fresnel rim glow

`vNormal` and `vViewPosition` (view space) already exist in the Standard fragment shader; `saturate` is defined in `<common>`.

```javascript
material.onBeforeCompile = (shader) => {
  shader.uniforms.uRimColor = { value: new THREE.Color(0x33ccff) };
  shader.uniforms.uRimPower = { value: 3.0 };
  shader.uniforms.uRimStrength = { value: 1.5 };
  shader.fragmentShader =
    "uniform vec3 uRimColor;\nuniform float uRimPower;\nuniform float uRimStrength;\n" +
    shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       float fres = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), uRimPower);
       totalEmissiveRadiance += uRimColor * fres * uRimStrength;`,
    );
};
material.customProgramCacheKey = () => "fresnel-rim";
```

Use for shields, invulnerability states, and silhouette separation from a busy background. Cost: a few ALU ops, no extra passes.

### Scrolling emissive panels

Inject a private UV varying so it works without any texture assigned.

```javascript
material.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uPanelColor = { value: new THREE.Color(0x18e0ff) };
  material.userData.shader = shader;
  shader.vertexShader =
    "varying vec2 vPanelUv;\n" +
    shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n vPanelUv = uv;",
    );
  shader.fragmentShader =
    "uniform float uTime;\nuniform vec3 uPanelColor;\nvarying vec2 vPanelUv;\n" +
    shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       float scroll = fract(vPanelUv.y * 6.0 - uTime * 0.5);
       float band = smoothstep(0.46, 0.5, scroll) * smoothstep(0.54, 0.5, scroll);
       totalEmissiveRadiance += uPanelColor * band * 2.0;`,
    );
};
material.customProgramCacheKey = () => "scroll-emissive";
```

Energy conduits, charge bars, boost lanes. Scroll direction/speed should encode state (charging up, draining down).

### Wind sway (foliage, flags)

`transformed` is object space, displaced before `<project_vertex>` applies `instanceMatrix` — so read the instance translation for per-instance phase. Assumes model origin at the base, up = +Y.

```javascript
material.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  material.userData.shader = shader;
  shader.vertexShader =
    "uniform float uTime;\n" +
    shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
     #ifdef USE_INSTANCING
       float phase = instanceMatrix[3].x + instanceMatrix[3].z;
     #else
       float phase = 0.0;
     #endif
     float h = max(position.y, 0.0); // base stays planted, tips move most
     transformed.x += sin(uTime * 1.5 + phase) * 0.08 * h;
     transformed.z += cos(uTime * 1.1 + phase) * 0.05 * h;`,
    );
};
material.customProgramCacheKey = () => "wind-sway";
```

Grass cards, banners, antennae — background life only. **Never sway collidable/interactable geometry**; visuals drifting off the collider reads as a hitbox bug.

### Dissolve / spawn

Threshold-discard with a glowing edge. Drive `uProgress` 0→1 to despawn, 1→0 to spawn.

```javascript
material.onBeforeCompile = (shader) => {
  shader.uniforms.uProgress = { value: 0 };
  shader.uniforms.uEdgeColor = { value: new THREE.Color(0xff6a00) };
  material.userData.shader = shader;
  shader.vertexShader =
    "varying vec3 vDisPos;\n" +
    shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n vDisPos = position;",
    );
  shader.fragmentShader =
    `uniform float uProgress;\nuniform vec3 uEdgeColor;\nvarying vec3 vDisPos;
     float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }\n` +
    shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `float n = hash13(floor(vDisPos * 12.0));
       if (n < uProgress) discard;
       float edge = smoothstep(uProgress, uProgress + 0.08, n);
       gl_FragColor.rgb += uEdgeColor * (1.0 - edge) * 3.0; // post-tonemap add feeds bloom
       #include <dithering_fragment>`,
    );
};
material.customProgramCacheKey = () => "dissolve";
```

Enemy death, teleport-in, pickup spawn. `discard` disables early-Z — keep it on spawning objects, not the whole scene. Spawn and destroy must look different (edge color/direction telegraphs which).

---

## Gradient Sky Dome

Cheaper than a cubemap for stylized outdoor scenes: a `BackSide` sphere with a horizon→zenith lerp plus a sun disc and halo. One draw call, no textures, and a flat clear-color background stops reading as "sparse."

```javascript
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(500, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x3a6fb0) },
      uHorizon: { value: new THREE.Color(0xcfe4f5) },
      uSunColor: { value: new THREE.Color(0xfff2cc) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.28, 0.6).normalize() },
    },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir;
      uniform vec3 uTop, uHorizon, uSunColor, uSunDir;
      void main(){
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.6));
        float d = clamp(dot(normalize(vDir), normalize(uSunDir)), 0.0, 1.0);
        col += uSunColor * (pow(d, 800.0) + pow(d, 8.0) * 0.25); // disc + halo
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
);
sky.frustumCulled = false;
scene.add(sky);
```

Gotcha: a raw `ShaderMaterial` **bypasses tone mapping and sRGB conversion** — author sky colors in display space, and nudge them brighter if the scene runs ACES. Keep the horizon value distinct from anything silhouetted against it.

---

## Cheap Visual Tricks

Each is one draw call or less, mobile-safe, and solves a constant real need.

- **Fake contact shadow** — a flat `PlaneGeometry` under the object with a radial-gradient `CanvasTexture`, `{ transparent: true, depthWrite: false }`; scale/fade alpha with the object's height. Grounds hovering or moving props with **no shadow pass at all** — the cheapest fix for "everything looks like it's floating."

  ```javascript
  function makeContactShadow(radius = 1) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(0,0,0,0.4)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 2, radius * 2),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.01; // just above the ground plane
    return mesh;
  }
  ```

- **Polygon-offset decals** — a coplanar decal mesh z-fights with the surface under it. Fix: `{ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, transparent: true }` on the decal material. Panel lines, numbers, faction glyphs, scorch marks. +1 draw call each — instance repeats.
- **Vertex-color AO** — bake occlusion into the mesh: darken a `color` attribute in cavities/creases, material `{ vertexColors: true }`. Static props and terrain get contact darkness for one attribute, zero extra draw calls.
- **Matcap background props** — `new THREE.MeshMatcapMaterial({ matcap })` bakes lighting into one texture; needs no lights or env map. The cheapest lit-looking material for background/stylized props. It **ignores scene lights**, so never use it where a dynamic light or state glow must show.
- **Emissive LOD signals** — far pickups/beacons keep reading by swapping `emissiveIntensity` by distance instead of adding geometry. Keep the signal color constant across the swap so identity survives.
