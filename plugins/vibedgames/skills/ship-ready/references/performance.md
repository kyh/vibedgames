# Performance: steady frames on ordinary machines

A steady 60 beats an average of 90 that drops to 30. Players feel the tail,
not the mean.

## Measure honestly

- **Count frames the browser actually presented**, from
  `requestAnimationFrame` timestamps on the built game, through the real menu
  into real play. Log tier, renderer (WebGL/WebGPU), render scale and pixel
  ratio beside every number.
- **Bare runs only.** No screenshot, `readPixels`, profiler overlay or test
  hook that changes behaviour during a timing run. Those slow the frame they
  measure.
- **A/B by interleaving.** Call a change faster only from paired runs of both
  builds alternated in one session on a quiet machine. On a GPU shared with
  other work, compare measured cost (ms per pass), not frame rate.
- **Every slow frame has an owner.** Split frame time by system (input,
  simulation, AI, physics, render, post) and by render pass, so a frame over
  budget names its cause. Keep the unattributed share small.
- **Pin adaptive quality while benchmarking**, or the number measures the
  adapter.

## Written budgets

Write them before optimising, and keep them in one file:

| Budget                            | Starting point (desktop / phone)  |
| --------------------------------- | --------------------------------- |
| Frame time median                 | 16.7 ms / 16.7–33 ms              |
| p99 frame time                    | ≤ 2× median                       |
| Draw calls per frame              | ≤ 300 / ≤ 120                     |
| Triangles drawn                   | ≤ 1.5 M / ≤ 300 k                 |
| Shadow casters                    | count it; cut the ones off screen |
| Pixels drawn                      | ≤ ~2.5 M device px / ≤ ~1.5 M     |
| Shader compiles after first frame | 0                                 |
| Allocations per steady frame      | 0                                 |

## The usual wins, in order

1. **Cap pixels, not pixel ratio.** Choose `renderer.setPixelRatio` from a
   pixel budget (`Math.min(devicePixelRatio, sqrt(budget / (w*h)))`), so a
   4K or retina display doesn't quadruple GPU cost.
2. **Draws scale with materials, not objects.** Merge static geometry, instance
   repeats (`InstancedMesh`, `BatchedMesh`), put crowd animation on the GPU.
3. **Nothing compiles during play.** Fixed light count (see `look` →
   `references/lighting.md`), every material and pass warmed before the menu
   hands over (`renderer.compileAsync(scene, camera)` on WebGPU,
   `renderer.compile` on WebGL, then render one frame offscreen).
4. **Write state only when it changes.** Setting a uniform, a transform or a
   DOM value to the same value still triggers uploads and layout downstream.
5. **Nothing allocates per frame.** Reuse vectors, arrays and event objects.
   Check with the browser's allocation timeline: a sawtooth in the heap is GC
   cutting through your frames.
6. **One decode per image.** Fetch, decode and upload each texture once
   whatever uses it; pick compressed GPU formats (KTX2/Basis) by measuring.
7. **Large uploads in small pieces**, never in the task that handles a key
   press or on a run's first frame.
8. **Menus and previews draw only what changed.** A still 3D preview doesn't
   re-render every frame; a pause menu doesn't cost more than play.

## Adaptive quality

- Step down the **world** first (shadows, post, foliage density, render scale)
  and never the gameplay layer the player acts on (HUD, reticle, held item,
  board).
- Keep a step only if it bought time; climb back slowly with hysteresis so it
  never oscillates.
- The lowest tier still reads as the same game and never changes what cover
  hides from whom.
- A player's explicit setting is lowered only with a notice.

## Long sessions

Play for 30+ minutes with level switches and watch the whole tab's memory
(`performance.measureUserAgentSpecificMemory()` where available, otherwise the
browser task manager) and frame time per minute. Both stay flat. Dispose
geometries, materials, textures and render targets on level exit.

## Pace frames by what lands

Input latency is the age of the picture on screen plus the input it carries.
Don't queue frames: if two frames are unfinished, skip starting a third.
Mouse look reads the latest input right before render, not at the start of a
long simulation step.
