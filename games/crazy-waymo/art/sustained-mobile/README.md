# Sustained mobile performance

Runtime improvements after `fa77a97d`. World revision remains 96: geometry,
materials, collision data and quality presets are unchanged.

- Sealed city roots skip Three.js's redundant descendant transform walk.
  Streamed parcel cells still compose after attachment; editors stay live.
- Baked restoration stops recapturing unused cache records. Before: 64,049
  separate matrix arrays, 4,099,136 bytes plus JS overhead; after: zero. The
  capture arrays also referenced 1,780,776 raw-geometry bytes, some shared with
  rendering. Removing those references does **not** prove all those bytes freed.
  Cold generation still captures records for baking and IndexedDB.
- Quality decisions include recurring missed refreshes. With every fifth frame
  at 50 ms, the old sampler reported 16.67 ms despite a 42.9 FPS cadence; the new
  score is 23.02 ms, crossing the downgrade threshold. An isolated paired hitch
  remains excluded. Existing 60/90/120 Hz pacing checks still pass.

## Evidence and limits

`before.json` and `after.json` retain per-window timings, resource samples and
checks from five timed driving minutes each. Each runs the same staged Sunset
road repeatedly, in portrait/landscape and day/night, with actual CDP touch.
The governor stays adaptive. CPU throttling is 4x, DPR is 3, and multi-draw is
disabled. Fleet relocation isolates the route. Resets, settling, screenshots,
pauses and heap reads are outside timed windows; no forced GC is used.

Resource checks compare repeated start poses at the same view and tier.
`insufficient-samples` means adaptation left too few comparable windows;
it is not a passed memory check. Counts are uploaded resources, not GPU bytes.
Natural heap sawteeth and different resource counts across separate launches
cannot establish a leak or exact memory savings.

`static-traversal-ab.json` isolates the transform walk in one browser:
original → skipped walk → original restored, all at fixed tier 4. CPU render
medians were 10.5 → 8.3 → 9.0 ms. The warmed restored comparison is an 8% reduction
in submission CPU time. Frame pacing remained near the display limit. The
standalone profile is intentionally separate from adaptive-soak comparisons.

These are headed M1 Max/Chrome stress proxies. No physical phone was connected.
They do not measure phone GPU capacity, battery life, heat or thermal throttling.
Native Safari evidence uses an owned iPhone simulator with the same limits.

Both Chrome soaks passed. Before/after mean submission intervals:

| View             |   Before |    After |
| ---------------- | -------: | -------: |
| Portrait, day    | 18.28 ms | 17.89 ms |
| Landscape, day   | 18.86 ms | 18.50 ms |
| Portrait, night  | 17.58 ms | 16.86 ms |
| Landscape, night | 18.33 ms | 17.26 ms |

The after run completed 17,052 measured gameplay submissions in 300.16 timed
seconds, with one interval over 50 ms (53.9 ms), no errors/context loss, and all
four pause/resume checks passing. All four after views had enough same-tier
samples for the bounded resource gate; baseline had two inconclusive views.
Adaptive tiers differ, so these are session observations, not an isolated FPS
speedup. No claim is made about eliminating every hitch or smaller leaks.

`native-safari.json`: 14/14 checks pass on iPhone 17 Pro simulator, iOS 26.5.
The four-stage 240-second scenario covers dense streets and open water by day
and night, with trusted native touch, working foam/steering, and zero observed
runtime/shader/context-loss errors. All 11,069 measured submissions are from
active driving windows; staging overhead is outside those windows. The owned
simulator was deleted and every pre-existing simulator state was preserved.

`pnpm verify`: 382 game checks pass, including five static-world lifecycle checks
and six new paired-frame regressions. No world rebake is required.

## Reproduce

Run from `games/crazy-waymo`, with a dev server at port 5193. Keep other GPU and
build/test work idle; run browsers serially.

```sh
node tools/verify-mobile-soak.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-soak --minutes=5 --cpu=4
node tools/verify-native-soak.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-native-soak 240
```

The native runner needs Appium/XCUITest and an available iOS simulator runtime;
`--help` documents setup. It creates and deletes one simulator and preserves
existing devices. Both tools close only their owned sessions.
