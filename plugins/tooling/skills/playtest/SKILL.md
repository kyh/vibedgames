---
name: playtest
description: 'Drive a real browser to play a game and prove it works — smoke checks, scripted bot playtests, softlock detection, canvas/WebGL determinism, screenshots and visual diffs — via `vg playtest` (agent-browser). Use for canvas/WebGL games (Phaser, Three.js) and for verifying a deployed game. Trigger: "playtest", "test my game", "does it work", "is it broken", "softlock", "check the deployed game", "screenshot the game", "visual regression", "browser automation".'
---

# Playtest

A build that compiles proves nothing. A game that renders proves almost nothing. **Playtesting proves it plays** — that the loop runs, input moves the player, the objective is reachable, and nothing throws along the way.

## The Tool: `vg playtest`

Everything here runs through one command. `vg playtest` is a passthrough to [agent-browser](https://github.com/vercel-labs/agent-browser), a native browser-automation CLI built for agents — `vg` installs it and its browser on first use, so **there is nothing to add to the game's `package.json`**. No test runner, no devDependencies, no MCP server to configure.

```sh
vg playtest open http://localhost:5173   # launch + navigate (headless by default)
vg playtest snapshot -i                  # interactive elements, with @eN refs
vg playtest click @e2                    # act on a ref from that snapshot
vg playtest eval "window.__GAME_DIAGNOSTICS__" --json
vg playtest screenshot /tmp/frame.png
vg playtest close
```

A daemon persists between invocations, so one-call-per-step is cheap and the page stays open across commands. `vg playtest --help` is the full surface; `references/cli-cheatsheet.md` is the game-shaped subset.

**Playtest a deployed game with no local setup at all:**

```sh
vg playtest --game my-game        # opens https://my-game.vibedgames.com
vg playtest --game               # reads the slug from ./vibedgames.json
```

That is the fastest possible loop after `vg deploy`: ship it, then play it.

## Start Here: The 60-Second Smoke Check

Before anything clever, prove the game boots and doesn't throw:

```sh
vg playtest batch \
  "open http://localhost:5173" \
  "wait --fn 'window.__GAME_DIAGNOSTICS__?.frame > 10'" \
  "eval 'window.__GAME_DIAGNOSTICS__' --json" \
  "screenshot /tmp/boot.png"
vg playtest errors     # uncaught exceptions — must be empty
vg playtest console    # console.error — treat as product failure
```

`batch` runs the whole sequence in one invocation and returns one result array. If `wait --fn` times out, the game never reached a live frame — that's the bug, and you have it in ten seconds without writing a test file.

**Treat any console error or failed asset request as a failure** unless you can name why it's benign.

## The Diagnostics Contract

The browser can see pixels; it can't see whether the player is stuck. Games expose two globals so a playtest can measure real state instead of guessing from screenshots:

```javascript
// Read-only, updated every frame from the game loop
window.__GAME_DIAGNOSTICS__ = {
  frame: 0, // increments every update — the loop's heartbeat
  score: 0, // or the objective metric: waves, distance, gems
  complete: false, // win/fail state reached
  player: { x: 0, y: 0, speed: 0 }, // x/z for 3D games
  entities: 0, // live entity count
  renderer: null, // Three.js only: { calls, triangles } from renderer.info.render
};

// Mutations — keep them real as the game evolves; silent no-op hooks
// make every downstream assertion lie
window.__GAME_TEST_HOOKS__ = {
  seed(n) {}, // reseed RNG AND restart/regenerate the run — see below
  setState(name) {}, // jump to a named state: 'active-play', 'fail', 'boss'
  setPausedForScreenshot(paused) {},
  setReducedMotion(enabled) {}, // freeze shake/particles/time-based FX
  hideDebugUi() {},
};
```

JSON-serializable primitives only, never raw engine objects — `eval --json` has to serialize whatever you return.

**`seed(n)` must restart, not just reseed.** By the time a playtest can call it, the game has already run frames (and possibly generated the level) with unseeded RNG. The contract: `seed(n)` reseeds **and** restarts the run, so everything measured afterwards is deterministic. If a restart is expensive, seed before boot instead — read a `?seed=` query param at init.

Adding this contract to a game is a prerequisite, not an optional extra. Without it a playtest can only assert "pixels changed".

## Bot Playtest: Prove It Plays

A smoke check proves the game loads; a bot playtest proves it _plays_. It drives real held input and measures **progression**:

```sh
node scripts/bot-playtest.mjs --url http://localhost:5173 --seed 12345
```

The bundled script (zero dependencies — just Node and `vg`) drives a scripted input sweep of held keys, samples diagnostics between steps, and prints a JSON report:

- `framesAdvanced > 100` — the loop survived. A stall is a crash or a frozen loop.
- `distanceTravelled` above threshold — input mapping is alive. Near-zero under held keys means broken input.
- `scoreAfter > scoreBefore` + `stepOfFirstScore` — the objective is reachable, and how fast a naive player finds it. If a scripted sweep never scores, the objective is unreachable, unreadable, or broken.
- `softlockWindows` — windows where frames advanced but held input produced **neither motion nor progress**. Repeated windows mean stuck-on-geometry, dead input states, or unrecovered fail states. Fail above 2.
- Zero page errors, zero console errors, for the whole run.

Adapt `--script` to the game's core verb: a runner holds forward and switches lanes, an arena game sweeps the space, a tower defense places towers through test hooks. Game-specific hooks (`forceWave()`) are encouraged where raw keys can't express the verb.

Full contract, tuning, and difficulty/fairness runs: `references/bot-playtest.md`.

## Canvas & WebGL: Two Footguns

- **Never report headless FPS as performance.** Headless Chrome renders WebGL on SwiftShader (software raster) — ~2fps on scenes a real GPU runs at 120. Headless runs are for _correctness_. Capture FPS with `--headed` on a real GPU and label headless numbers functional-only.
- **Headless can't capture WebGPU canvases on Linux/Windows** — rendering works, the screenshot comes out black. Add `--headed` (on Linux with no `DISPLAY`, agent-browser starts Xvfb automatically). Verify the pipeline with `vg playtest doctor --webgpu`.

Determinism setup, readiness signals, and flake classification: `references/canvas-determinism.md`.

## Screenshots and Visual Diffs

Visual comparison is built in — there is no separate image-diff tool to install:

```sh
vg playtest screenshot /tmp/baseline.png
# … make a change, reload …
vg playtest diff screenshot --baseline /tmp/baseline.png -o /tmp/diff.png
vg playtest diff snapshot --baseline /tmp/before.txt   # accessibility-tree diff, for DOM/HUD
```

**Freeze before every baseline**: seed RNG, `setReducedMotion(true)`, `setPausedForScreenshot(true)`, `hideDebugUi()`, wait for fonts and textures/GLTFs, lock the viewport (`vg playtest set viewport 1280 720`). Skip baselines for un-seedable prototypes or particle-dominated scenes — and say why — rather than masking the image into meaninglessness.

## Anti-Patterns

❌ **Sleep-driven steps** — `wait 2000` then click
✅ `wait --fn "window.__GAME_DIAGNOSTICS__?.frame > 10"`

❌ **Screenshot-only verdicts** — "it looks right"
✅ Read `__GAME_DIAGNOSTICS__`; a screenshot is evidence, not an assertion

❌ **Asserting exact pixel positions** without fixed dt and seeded RNG
✅ Assert user-meaningful invariants: score rose, player moved, fail state triggered

❌ **Stale refs** — `@e2` from a snapshot two navigations ago
✅ Re-`snapshot` after anything that changes the page; refs are per-snapshot

❌ **`keydown`/`keyup` for game input** — agent-browser 0.34 sends them with an empty `code` and `keyCode: 0`, so Phaser and friends ignore them entirely
✅ Dispatch the event via `eval` (what the bot script does), and always release what you hold — see `references/bot-playtest.md`

❌ **Calling a game verified because it rendered**
✅ Run the bot; renders ≠ plays

## When You're Done

- [ ] Smoke check passes: boots, reaches a live frame, zero console/page errors
- [ ] Diagnostics contract exposed and honest (no silent no-op hooks)
- [ ] Bot playtest scores, moves, and reports ≤ 2 softlock windows
- [ ] Fail state triggers and retry restores play (for games that can be lost)
- [ ] Deployed build playtested with `vg playtest --game <slug>`, not just localhost

## Bundled Resources

- `scripts/bot-playtest.mjs` — the progression-measuring bot; run it, read the JSON report
- `references/bot-playtest.md` — diagnostics contract, metrics, difficulty/fairness runs
- `references/canvas-determinism.md` — deterministic mode, readiness, flake triage, Phaser/Three.js specifics
- `references/cli-cheatsheet.md` — the game-shaped subset of the `vg playtest` command surface

## Remember

Any game becomes testable by adding one small, stable seam for readiness and state. The goal is not coverage — it's the ability to answer "does this actually play?" in under a minute, every time, without the human opening a browser.
