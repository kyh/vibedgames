# 3D effects in three.js

The laws in `SKILL.md` hold in 3D: mechanics first, fast in and slow out,
scale of importance, replace don't layer. This file is what a 3D scene adds:
effects have depth, so they clip floors; they face a moving camera, so flat
cards and `THREE.Line` break; and they feed an HDR bloom chain that one bad
pixel can black out.

Prebuilt helpers live in the `threejs` skill: `modules/vfx.ts`
(`beatEnvelope`, `crossedCues`, `createDepthPrepass` + `DEPTH_FADE_GLSL`,
`CameraFacingStrip`, `layLightning`, `worldToScreenUv`, `SHOCKWAVE_SHADER`).
Copy what the effect uses. Weapon and slash trails already have hard-won
rules in `threejs/references/game-patterns.md` → "Weapon trails"; materials
and `onBeforeCompile` in `threejs/references/graphics-recipes.md`.

## 1. Brief each signature effect

Before any code, one line per effect (ability, weapon, explosion, shield):

- **Shape family** (§3), different from every other effect in the kit.
- **Three values**: a dark rim, a saturated body, a hot core above the bloom
  threshold. Never a single glowing colour.
- **Duration and beats** (§2), and the **socket** it starts from (hand,
  muzzle, blade tip, thruster, ground under the target).
- **Clearance**: what it must never cover. Hitboxes, telegraphs, the HUD and
  the player's next decision stay readable through the whole effect.

## 2. Five beats

The 2D grammar (anticipation → overload → processing) split finer, because a
3D effect has room to show _where_ it will land:

| Beat         | Share of life | What it does                                                                                         |
| ------------ | ------------- | ---------------------------------------------------------------------------------------------------- |
| Anticipation | 15–25%        | Energy gathers at the socket: inward motes, a sigil, a rising sound. Says who is acting.             |
| Telegraph    | 10–20%        | The threat's shape on the ground or in the air: lane, cone, ring outline, low interior alpha.        |
| Hold + peak  | 5–12%         | A 50–110 ms dip toward zero, then 1–3 frames at 2.5–3× the core. Hitstop and shake land on the peak. |
| Payload      | 30–45%        | The signature shape carries the gameplay read: damage zone, beam, dome, swarm.                       |
| Aftermath    | 15–25%        | Hot edge erodes to soot, embers drift, a scorch stays, lights decay to exactly 0.                    |

- The dip before the peak is what makes plain geometry feel explosive. An
  effect that only ramps up and fades is flat however good its shader is.
- Snap open in 30–70 ms, decay over 400–1200 ms. No symmetric sine fades.
- Drive everything from **effect age**, as pure functions of `t`
  (`beatEnvelope(age)`, ballistic `p0 + v0·t + ½g·t²`), not integrated
  per-frame drift. Then pause, hitstop, slow motion, scrubbing and
  screenshots all agree, and one curve drives light, bloom, camera and sound.

## 3. Shape families, not spinning rings

Left alone, every effect becomes a glowing torus and a sphere of points.
Give each effect in a kit its own family:

| Family                | Silhouette                                       | Fits                                         |
| --------------------- | ------------------------------------------------ | -------------------------------------------- |
| Rail / lance          | long ground lane, collimated beam, chevron gates | railguns, snipes, dashes, piercing shots     |
| Cone / wedge (45–75°) | volumetric fan from the emitter                  | flamethrowers, breath, shotgun, shock cones  |
| Cage / grid           | hard rectilinear pillars, scan planes            | traps, hacks, stasis, shield walls           |
| Tendrils              | tapered tubes that grow (`drawRange`)            | roots, corruption, snares                    |
| Tether                | links sagging along a catenary                   | grapples, shackles, tow beams                |
| Wave crest            | asymmetric curl plus a splash crown              | water, lava, acid surges, slams              |
| Swarm                 | 40–180 instanced bodies streaming                | homing missiles, flocks, blade storms        |
| Vertical drop         | a monolith falling onto the target               | meteors, orbital strikes, guillotines        |
| Dome / curved wall    | open cupola with a bright base seam              | forcefields, time bubbles, wards             |
| Singularity           | black core, bright photon ring, infalling debris | black holes, void rifts, pulls               |
| Fault line            | jagged ground fissure with raised slabs          | quakes, ice spikes, mine chains              |
| Arcs                  | stepped camera-facing bolts between nodes        | chain lightning, tesla coils, short circuits |

A recoloured ring is one variant, not a second effect.

## 4. Layers inside one effect

A signature effect is 3–5 layers that share geometry and materials: a dark
backing for contrast, the carved shell or ribbon, instanced debris or
glints, the socket anticipation, a pooled light for a few frames, and at
most one screen-space pass (§8). "Replace, don't layer" still governs the
effect list: a weak effect is replaced, never joined by a second one.

## 5. Ground it: soft particles and contact rims

A transparent mesh that meets a floor shows a hard straight line. Sample the
opaque scene's depth and fade toward it, or brighten toward it for a seam.

- Split the scene: `opaqueRoot` (terrain, characters, props) and `vfxRoot`
  (everything transparent that reads depth).
- `createDepthPrepass(renderer, vfxRoot)` renders depth with `vfxRoot`
  hidden. Sampling `tDepth` while writing it is a feedback loop
  (`GL_INVALID_OPERATION`, black frame), which is why it hides the group.
- In the material: `#include <packing>`, then `DEPTH_FADE_GLSL`, then

  ```glsl
  float gap = sceneDepthGap();
  alpha *= smoothstep(0.0, 0.85, gap);                     // soft smoke / beam
  col += uHot * (1.0 - smoothstep(0.0, 0.55, gap)) * 2.2;  // dome contact rim
  ```

- Low tier: `setEnabled(false)`; the gap reads 99 and edges go hard, nothing
  breaks.
- `logarithmicDepthBuffer` breaks this; so does any effect drawn with
  `depthTest: false`.

## 6. Shaders that never black out

Bloom blurs across the whole frame, so one NaN or Inf fragment spreads into
a black or white screen, often only at one camera angle.

- `pow(x, y)` is undefined for `x < 0` on ANGLE/Metal, even `pow(x, 2.0)`.
  Square with `x * x`; guard fractional powers with `pow(max(1e-4, x), p)`.
- `normalize(v + vec3(1e-5))` on anything that can collapse to zero.
- `max(d, 1e-4)` under every divide; `smoothstep(e0, e1, x)` needs `e0 < e1`.
- Cap the hot core near 4–6× in the shader, so a halo stays a halo.
- three r186's `EffectComposer` already renders in `HalfFloatType`, so HDR
  survives to bloom. For MSAA pass your own target:
  `new EffectComposer(renderer, new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 }))`.
- Bloom threshold at about 1.0 or above, radius 0.2–0.35, strength
  0.25–0.45, so only hot cores and edges bloom and a lit wall never does.
  Every effect must read with bloom **off**: dark rim, bright core, crisp
  shape.

Building blocks:

```glsl
// Four-stop ramp with a hot eroding edge; uDissolve runs 0→1 through the aftermath.
float body = smoothstep(uDissolve, uDissolve + 0.14, energy);
float edge = smoothstep(uDissolve, uDissolve + 0.04, energy)
           * (1.0 - smoothstep(uDissolve + 0.04, uDissolve + 0.16, energy));
vec3 col = mix(uRim, uBody, smoothstep(0.15, 0.52, energy));
col = mix(col, uInner, smoothstep(0.52, 0.82, energy));
col = mix(col, uHot * uBoost, smoothstep(0.82, 0.98, energy));
col += uHot * edge * uBoost * 0.9;
alpha *= body;

// Two-phase flow: advect noise along a flow field, crossfading half-cycles so it
// never stretches or pops when the loop wraps.
vec2 flow = (texture2D(uFlow, flowUv).rg * 2.0 - 1.0) * uFlowStrength;
float p0 = fract(uTime * 0.65);
float p1 = fract(uTime * 0.65 + 0.5);
vec4 n = mix(texture2D(uNoise, uv + flow * p0), texture2D(uNoise, uv + flow * p1),
             abs(p0 * 2.0 - 1.0));

// A crisp glowing line from any SDF distance: sigils, reticles, hex rings.
float glowLine(float d, float sharpness) { float x = d * sharpness; return exp(-(x * x)); }
```

Textures: bake four small ones once at startup and share them across every
effect, at most 384 px on desktop and 256 px on mobile: an RGBA noise atlas
(warped FBM, streaks, shreds, Voronoi ridges), a curl-noise flow map, a
smoke puff with top-lit shading, and a four-point star glint that replaces
square point sprites. Wrap the noise lattice modulo its period at every
octave, or rings and domes show a seam where U wraps.

## 7. Geometry that moves

- **UVs follow motion**: U along the length or angle, V across width or
  radius, so one scroll in the shader flows the right way on every mesh.
- **Faceted shards**: `geometry.toNonIndexed()` then
  `computeVertexNormals()`, for sharp specular facets on ice, rock, glass.
- **Camera-facing strips** for lightning and beams: `CameraFacingStrip`
  re-extrudes its points toward the camera each frame, buffers sized once,
  culling off. `THREE.Line` is 1 px in WebGL whatever `linewidth` says.
- **Lightning**: `layLightning(strip.points, a, b, jitter, rng)` with the rng
  reseeded from `Math.floor(age * 24)`, so bolts snap at 24 fps on a 120 Hz
  screen. The `sin(u·π)` envelope keeps both ends on their sockets.
- **Trails**: a fixed ring buffer of 16–32 samples; append only after the
  anchor moves past a minimum step; on teleport, reset or scrub, collapse
  the ring onto the anchor or the trail stretches across the map.
- **Bursts**: one `InstancedMesh` per particle family, per-particle
  parameters seeded once. Outward: ballistic in `age`, clamp to the ground,
  stretch along velocity. Inward suction for anticipation: radius
  `R·(1 − p)^1.6` with `p = fract(age·rate + phase)`. Hide dead slots with a
  zero-scale matrix; set `instanceMatrix.needsUpdate` once per frame.

## 8. One screen-space pass

Shockwave refraction and heat haze go in one `ShaderPass` after
`OutputPass` (`SHOCKWAVE_SHADER`), dormant at zero strength.

- Each frame before `composer.render()`, aim it:
  `const onScreen = worldToScreenUv(blastPosition, camera, pass.uniforms.uTarget.value)`.
  Fade it out when `onScreen` is false; a point behind the camera
  projects mirrored.
- `uWaveProgress` 0→1 over 300–500 ms from the peak; strength from
  `beatEnvelope`. Haze stays local to the source and low.
- 1–3 frame stylised impact frames (inverted or duotone, speed lines) are
  for crits, parries, ultimates and boss phases only, and are off under
  reduced motion.

## 9. Couple it to the actor

An effect floating in front of a rigid character looks pasted on.

- Read sockets from bones each frame (`skeleton root.updateMatrixWorld(true)`
  once, then `bone.getWorldPosition(tmp)`), never from a guessed offset.
- Anticipation at the socket: a small displaced core, a sigil quad, motes
  spiralling in, and for twin emitters a bolt or helix between them.
- On release, a star flare and a pooled `PointLight` that snaps up and decays
  to exactly 0. No light stays on between effects.
- Light the caster and target with the effect's colour through a Fresnel rim
  uniform (`graphics-recipes.md` → "Fresnel rim glow") instead of more lights.
- Push a wind impulse into capes, hair and antennae: a gentle pull during
  anticipation, a radial blast at the peak.
- Recoil and knockback follow the impact vector.

## 10. Sound on the same clock

Fire sounds from the effect's timeline, not `setTimeout`:
`crossedCues(cues, previousAge, age)` returns each cue once, and nothing on a
pause, reset or scrub, so sounds never stack. Author short cues per beat
(charge, launch, impact, tail). During hitstop or slow motion set each
source's `playbackRate` to the time scale and duck the music under the peak
(`audio` skill for the chain and mix).

## 11. Budgets and tiers

At peak combat, inside the game's render budget
(`threejs/references/debugging-and-profiling.md`):

| Item                            | Desktop             | Mobile                        |
| ------------------------------- | ------------------- | ----------------------------- |
| Extra draw calls from effects   | ≤ 45                | ≤ 20                          |
| Shared effect textures          | 4, ≤ 384 px         | 4, ≤ 256 px                   |
| Pooled point lights for effects | ≤ 3, at 0 when idle | 0–1; prefer a fake floor card |
| Full-screen transparent layers  | ≤ 3 stacked         | 1–2                           |
| Depth prepass                   | on                  | off                           |
| Screen-space pass               | full                | shockwave only, or off        |

Tiers degrade without touching shaders: desktop DPR 2, MSAA 4, prepass on,
bloom on; mid DPR 1.5, no MSAA, prepass off; low DPR 1.25, no composer at
all (plain `renderer.render`), a short CSS flash stands in for big impacts.

Allocate everything at init: geometries, instance matrices, strip buffers,
scratch vectors. No `new Vector3()`, `new BufferGeometry()` or new material
inside `update`, and no `Math.random()` on any effect path. `dispose()` frees
every geometry, material, texture and render target.

## 12. Make it testable and check it moving

Effects honour the `playtest` hooks (`references/canvas-determinism.md`):
`seed(n)` seeds every trajectory and bolt, `setPausedForScreenshot(true)`
freezes effect age while rendering continues (so a still can catch the
peak), `setReducedMotion(true)` kills impact frames, chromatic fringe and
heavy shake but keeps shapes, telegraphs and washes. Expose named states for
the beats that matter (`vfx-anticipation`, `vfx-peak`, `vfx-aftermath`).

Then check it **moving**, not only in stills: step the clock through one cast
and capture every few frames (the FX contact sheet in
`canvas-determinism.md`, or the stepped clock in `trailer` →
`references/capture-hooks.md`). Look for: anticipation that reads, a visible
dip before the peak, soft floor contacts, no blowout or black frame with
bloom on, the same shape with bloom off, every light back at 0 afterwards,
and `renderer.info` at peak versus idle on desktop and a phone.

---

Draws on [threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills)
(MIT, © 2026 Majid Manzarpour), rewritten for this skill set; the module is a
fresh implementation.
