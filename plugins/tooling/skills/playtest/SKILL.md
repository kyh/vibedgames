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

A daemon persists between invocations, so one-call-per-step is cheap and the page stays open across commands.

### Load the upstream skill for the general command surface

agent-browser ships its own skills and serves them from the installed binary, so the content always matches the version you actually have:

```sh
vg playtest skills get core       # the general browser-automation guide — read before driving anything
vg playtest skills get core --full  # + full command reference and templates
vg playtest skills get dogfood    # systematic exploratory testing / bug hunts
vg playtest skills list           # everything available on this version
```

**`skills get core` is the source of truth for the generic surface** — the snapshot-and-ref loop, sessions, waiting, forms, auth, troubleshooting. Don't re-derive it here, and don't trust a stale memory of it.

This skill covers only what upstream can't know: the game diagnostics contract, the bot playtest, canvas/WebGL determinism, `--game`, and the traps we hit driving real games (see below). `references/cli-cheatsheet.md` is the game-shaped subset of commands.

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
  "wait --fn 'window.__GAME_TEST_HOOKS__ !== undefined'" \
  "eval 'window.__GAME_TEST_HOOKS__.setState(\"active-play\")'" \
  "wait --fn '(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10'" \
  "eval 'window.__GAME_DIAGNOSTICS__' --json" \
  "screenshot /tmp/boot.png"
vg playtest errors     # uncaught exceptions — must be empty
vg playtest console    # console.error — treat as product failure
```

`batch` runs the whole sequence in one invocation and returns one result array.

**Wait for the contract before waiting for frames.** A game sitting on its menu has a frame counter that never moves until `setState('active-play')` starts a run — wait on frames first and you deadlock on exactly the games that implement the contract correctly. If the _first_ wait times out, the game never published its diagnostics: it crashed on boot, or it doesn't implement the contract. If the _second_ times out, the hooks are no-ops.

**Treat any console error or failed asset request as a failure** unless you can name why it's benign.

## The Diagnostics Contract

The browser can see pixels; it can't see whether the player is stuck. Games expose two globals so a playtest can measure real state instead of guessing from screenshots:

- `window.__GAME_DIAGNOSTICS__` — read-only per-frame telemetry (`frame`, `score`, `complete`, `player`, `entities`).
- `window.__GAME_TEST_HOOKS__` — the mutations a playtest may perform (`seed`, `setState`, `setReducedMotion`, …).

**The full field list and rules live in `references/bot-playtest.md`** — that is the address `games/lunerfall/src/sys/diag.ts` and `games/starfall/src/shared/diag.ts` both cite, so it stays the one copy to edit.

Two rules worth knowing before you read it: JSON-serializable primitives only, never raw engine objects; and `seed(n)` must **restart** the run, not just reseed it, or everything measured afterwards is still unseeded.

Adding this contract to a game is a prerequisite, not an optional extra. Without it a playtest can only assert "pixels changed".

## Bot Playtest: Prove It Plays

A smoke check proves the game loads; a bot playtest proves it _plays_. It drives real held input and measures **progression**:

```sh
node scripts/bot-playtest.mjs --url http://localhost:5173 --seed 12345
```

The bundled script (zero dependencies — just Node and `vg`) drives a scripted input sweep of held keys, samples diagnostics between steps, and prints a JSON report. It measures four things: the loop survived (`framesAdvanced`), input reaches the player (`distanceTravelled`), the objective is reachable (`scoreAfter` / `stepOfFirstScore`), and held input never stopped producing anything (`softlockWindows`) — plus zero console and page errors. Exit `0` means it plays, `1` means it doesn't and the report names which check failed, `2` means the harness itself broke.

The pass thresholds live in `THRESHOLDS` at the top of the script; read them there rather than from prose that can drift.

Adapt `--script` to the game's core verb: a runner holds forward and switches lanes, an arena game sweeps the space, a tower defense places towers through test hooks. Game-specific hooks (`forceWave()`) are encouraged where raw keys can't express the verb.

Metric meanings, flags, difficulty/fairness runs, and the key-dispatch trap: `references/bot-playtest.md`.

## Canvas & WebGL

Two things will mislead you if you don't know them: **headless FPS is not performance** (software rasterization, ~2fps on scenes a GPU runs at 120), and **headless can't capture WebGPU canvases on Linux/Windows** (the screenshot comes out black even though rendering worked). Both are `--headed` problems with real consequences for what you report.

Determinism setup, readiness signals, flake classification, and the full footgun list: `references/canvas-determinism.md`.

## Screenshots and Visual Diffs

Visual comparison is built in — there is no separate image-diff tool to install:

```sh
vg playtest screenshot /tmp/baseline.png
# … make a change, reload …
vg playtest diff screenshot --baseline /tmp/baseline.png -o /tmp/diff.png
vg playtest diff snapshot --baseline /tmp/before.txt   # accessibility-tree diff, for DOM/HUD
```

A baseline taken without freezing the scene first is a flake generator — the freeze checklist and the "when not to take a baseline at all" judgment are in `references/canvas-determinism.md`.

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

For anything generic — the snapshot/ref loop, sessions, auth, waiting, troubleshooting — read `vg playtest skills get core` rather than these files.

## Remember

Any game becomes testable by adding one small, stable seam for readiness and state. The goal is not coverage — it's the ability to answer "does this actually play?" in under a minute, every time, without the human opening a browser.
