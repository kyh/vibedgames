# Mobile performance review — 2026-09-05

Measurements use headed Chrome on Apple M1 Max / ANGLE Metal, coarse-pointer emulation, 390×844 CSS pixels and device DPR 3. CPU throttle is a desktop stress proxy, not physical-phone performance. Connected-device inventory found no physical phone. Render resolution remains adaptive, separately from screen DPR.

## Changes supported by measurements

- Prewarm the mobile shadowless shader variant under the loading screen. The first tier 3→4 transition previously spent 6,051 ms in renderer submission; the CPU profile attributed 5,828 ms to `getProgramInfoLog`.
- Evaluate frame quality over roughly two seconds, instead of 120 frames. Retain bounded visible frames slower than 100 ms so sustained low frame rates can recover. Ignore hidden and invalid samples. Eight focused timing checks cover 8/30/60/120 FPS, an isolated hitch and reset behavior.
- Freeze static world matrices as well as local matrices. Streamed cells inherit the city's setting; editor parents retain live transforms.
- Let opaque, non-shadow-casting prop batches reuse their draw lists between chunk visibility changes. Shadow casters retain per-pass frustum culling; transparent batches retain sorting.
- Preserve the phone's parcel residency radius when it earns higher pixel/shadow quality. Worst-case Richmond parcel geometry fell from **81.18 MiB to 57.06 MiB**, including static skyline and the sign atlas, below the existing 70 MiB limit. This is the parcel geometry budget, not total game GPU memory.

## Controlled render comparison

Same browser session, CPU 4×, fixed mobile floor tier, same Sunset centerline. Eight-second native touch drives covered about 224 world units and finished at 30 units/s. At least 97% of frames were moving. Traffic was relocated away from this isolated route and recycling held; the fleet simulation remained active.

| Configuration                  | Moving frame median / p95 | Render CPU median / p95 | Median submitted triangles |
| ------------------------------ | ------------------------- | ----------------------- | -------------------------- |
| Original runtime               | 16.4 / 26.1 ms            | 9.0 / 13.2 ms           | 462,964                    |
| Static world matrices          | 16.0 / 25.7 ms            | 8.7 / 11.2 ms           | 459,076                    |
| Matrices + cached prop batches | 14.9 / 23.2 ms            | 7.7 / 9.3 ms            | 467,332                    |

The combined case reduced render p95 by 30%, with roughly 0.9% more submitted triangles. No art, collision or baked-world changes were required. Full trace: [render-ab.json](render-ab.json).

The earlier [shader-stall-before.json](shader-stall-before.json) uses a route that hit a bend and stopped. Its moving-only timing is separated in the report. It establishes the first shadowless shader stall; its whole-window timing is not a continuous-driving claim.

## Renderer validation before recovery fixes

A fresh page's first tier 3→4 switch occurred 2.66 seconds into the measured touch drive. Its **maximum frame was 34.0 ms**, with no frames over 50 ms or long tasks. This verifies the shader warmup during the actual transition, not after a settling delay. [Transition report](first-shadowless-transition.json).

| Adaptive CPU proxy | Moving frame median / p95 / max | Moving samples | Frames over 50 ms |
| ------------------ | ------------------------------- | -------------- | ----------------- |
| 2×                 | 8.3 / 10.2 / 16.8 ms            | 940            | 0                 |
| 4×                 | 15.4 / 18.8 / 40.7 ms           | 564            | 0                 |

These eight-second drives crossed about 225 world units on a connected Sunset centerline. The 4× run earned tier 2 from tier 3. [Adaptive report](adaptive-drive.json).

A distant FiDi teleport was measured separately: one 192 ms frame at 2× and one 316.6 ms frame at 4×. Synchronous parcel reconciliation accounted for 137.8 / 269.7 ms respectively. These are explicit neighborhood loading events, not continuous-drive frame rates. Sustained driving and quality changes produced no frames over 50 ms in the final runs.

The separate [DPR 3 touch suite](../mobile/report.json) passed all 14 checks: acceleration, steering, nitro, drift, reverse, pause/resume/restart, portrait HUD clearance, both landscape lighting states and no page errors. Its [night landscape capture](../mobile/landscape-night.png) also shows the retained facade and street-light geometry after the culling changes.

Before the later touch, spawn and camera fixes, production bundle `index-BEEtAtzT.js` passed native touch smoke at DPR 3, CPU 2×, both 390×844 and 844×390. The visible dashboard reached **65 MPH** in both orientations, with no overflow, no page errors and no development hooks. This is historical renderer evidence, not verification of the current bundle. [Production report](production-touch.json), [portrait capture](production-portrait.png), [landscape capture](production-landscape.png).

Production smoke records one 226.5 / 250.1 ms frame respectively. These startup-inclusive samples also contain an intentional screenshot readback at two seconds, which can stall rendering while encoding the PNG. They verify controls and layout; they are **not frame-pacing acceptance data** and do not establish a game-side stall. The sustained drive and first-quality-transition runs above take their screenshots after sampling finishes.

## Current release

After the safe-start and underpass camera fixes, a fresh 4× CPU run covered 224u with 539 moving samples. Moving frame median / p95 / max: **16.1 / 24.4 / 33.8 ms**; no frames over 50 ms or long tasks. The camera framing change preserves the full boom under low structures and can change visible geometry. These final measurements supersede the earlier 4× result for the current release. The separate distant-neighborhood teleport produced one 415.1 ms frame, including 297.9 ms of parcel reconciliation; it remains a loading event, not sustained-driving data. [Final recovery drive](recovery-drive.json).

## Reproduce

Run from `games/crazy-waymo`, with an HMR-disabled dev server and no competing rendering browser or heavy build:

```sh
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/mobile-transition 4 8000 --transition
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/mobile-adaptive 2,4 8000
node tools/verify-mobile.mjs 'http://localhost:5193/?time=night&offline=1' /tmp/mobile-controls
node tools/verify-mobile-performance.mjs 'http://localhost:5199/?time=noon&offline=1' /tmp/mobile-production 2 8000 --production
```

Each run owns and closes its headed browser. CDP stays attached for the entire emulation. The production check reads visible dashboard drawing and native touch input; it requires development hooks to be absent.
