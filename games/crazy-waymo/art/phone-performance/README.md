# Phone performance — 2026-09-05

This pass keeps the SF geometry and improves phone rendering, scheduling, streaming and memory ownership. Measurements use headed Chrome on M1 Max / ANGLE Metal, DPR 3 coarse-pointer 390×844, with CPU throttling. These are desktop stress proxies; no physical phone was connected.

## Changes

- Cap phones at 60 rendered frames/s. Deadline pacing handles rounded browser timestamps without dropping 60 Hz displays to 40 Hz or alternating 8/25 ms on 120 Hz screens. Paused/hidden scenes stop render, update and governor work; paused resize redraws once, and resume discards stale timing. Desktop active cadence stays unchanged.
- Keep 1024 shadow maps and baked sky at all phone tiers. Higher tiers still earn resolution, cloud density and model detail; upgrades no longer quadruple the shadow allocation.
- Drivers without `WEBGL_multi_draw` use compact instancing for repeated opaque props and imposters. Empty groups are hidden. Shadow casters, transparent sorting, unique geometry and native multi-draw retain their existing paths.
- Build parcel cells within a soft 3 ms budget, yielding between parcels. Nearest cells finish first; LOD replacements swap atomically. Teleports release departed cells immediately. Initial loading and editor show-all remain synchronous.
- Copy surviving mesh indices into compact owned buffers and release construction payload references. Decoded index backing falls from 43,254,634 to 16,325,604 bytes: **25.7 MiB released**, without changing index values or width. This is a specific allocation saving, not total GPU memory.

## Matched fallback drive

Baseline: main `fa7e21b5`. Same connected Sunset route, fixed tier 3, CPU 4×, multi-draw deliberately unavailable. Each 8 s native touch drive covers about 224 u, ends near 30 u/s, and submits essentially identical geometry. Traffic is relocated from the isolated route; fleet simulation remains active. Steady sampling waits for parcel convergence and records real default-framebuffer renders, not skipped animation callbacks.

| Metric                    |        Before |         After |
| ------------------------- | ------------: | ------------: |
| Draw calls, median / max  |      646 /964 |      394 /642 |
| Render CPU, median / p95  |  9.8 /13.6 ms |  8.3 /11.0 ms |
| Moving frame median / p95 | 15.7 /25.6 ms | 16.1 /24.6 ms |
| Moving frames above 50 ms |             0 |             0 |
| Cold teleport max frame   |      319.4 ms |       96.9 ms |
| Cold parcel update max    |      290.8 ms |        6.6 ms |

Draw calls fell 39%; render CPU p95 fell 19%. The 60 Hz cap intentionally limits peak frame rate to reduce work; it is not a claim of higher maximum FPS. [Before](fallback-before.json), [after](fallback-after.json).

Cold loading is separate from driving. In the final fallback run the full destination settled in 2.05 s. Other measured runs peaked near 36 ms; the final 96.9 ms spike shows remaining cold work. Nearby detail finishes first; distant cells can appear over subsequent frames. The budget is soft because one parcel, buffer flush or attachment is atomic. Headless actual-geometry comparison preserved identical final residency/vertices/bytes; generator and clock overhead was 1.7%. [Parcel benchmark](parcel-benchmark.json).

## Validation

[Touch controls](controls.json): 18/18 passed, including pause GPU inactivity, single paused-resize redraw, 59.9 Hz resumed rendering, restart driving and all five tier budgets. Portrait and landscape visuals retained: [portrait](portrait-night.png), [landscape](landscape-noon.png). [Buffer ownership](buffer-ownership.json) records allocation sizes; regression tests detach the source buffer and verify runtime geometry survives.

[Repeated-drive report](repeated-drive.json), with native multi-draw: six mixed-pressure epochs over about 2.5 min, CPU 1×→4×→8×→4×→4×→1×. Each drive sustained motion, quality degraded to tier 4 under extreme pressure and recovered to tier 1. The three 4× epochs had moving p95 of 23.9/23.4/24.0 ms and zero frames above 50 ms. Deliberate 8× pressure reached 66.2 ms and eight frames above 50 ms; this is an adverse stress case, not a 60 FPS claim. No page errors. After forced collection between windows, retained heap stayed 250.6–251.4 MB and backing storage 224.014 MB (136-byte change). This excludes GPU allocations and is a bounded-duration stability check, not proof of zero leaks or physical-phone thermals.

[Fallback repeated drive](fallback-repeated-drive.json): three 4× CPU epochs with multi-draw disabled. Moving p95 was 24.7/25.3/23.2 ms, with zero frames above 50 ms and no page errors. Across repeated district changes and quality upgrades, collected heap changed from 251.4 to 252.2 MB; backing storage changed by only 207 bytes. This exercises the new instancing path separately from the native multi-draw run.

`pnpm verify` passes typecheck, lint, formatting and all repository tests (237 game checks). Desktop gameplay passes 9/9 checks. Production build succeeds: `assets/index-4v07mMOj.js`, SHA-256 `e2c46a036b3fe06a4348427e498a0202db5815cc3cbefb10e777520775bae1bd`.

[Native Safari](safari.json): 16/16 checks on an iOS 26.5 simulator with native multi-draw. Trusted touch/multitouch, pause/rotate/resume and portrait/landscape restart driving pass. Paused intervals submit zero WebGL draws or uploads, including after the rotation redraw settles. No runtime errors. One initial Start tap did not enter play; a second tap and a fresh-navigation first tap succeeded. Its cause remains unproven and it did not reproduce. This validates simulator compatibility, not physical-phone speed. Selected captures: [portrait driving](phone-preview-portrait-recovery-moving-2.png), [landscape driving, raw sideways capture](phone-preview-recovery-moving-2.png), [paused landscape](phone-preview-landscape-paused.png).

## Reproduce

Run an HMR-disabled dev server; keep other rendering browsers and heavy builds idle during timing samples.

```sh
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/phone-fallback 4 8000 --tier=3 --no-multi-draw
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/phone-repeat 1,4,8,4,4,1 8000 --keep-quality --memory
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/phone-fallback-repeat 4,4,4 8000 --keep-quality --memory --no-multi-draw
node tools/verify-mobile.mjs 'http://localhost:5193/?time=night&offline=1' /tmp/phone-controls
pnpm exec vite-node tools/benchmark-parcel-stream.mts
pnpm exec vite-node tools/benchmark-parcel-stream.mts --cost
```

`--memory` forces collection between sampling windows to audit retained allocations; it does not measure natural GC behavior or phone thermal limits. Physical-phone GPU, power and long-session thermal testing remain the next validation gap.
