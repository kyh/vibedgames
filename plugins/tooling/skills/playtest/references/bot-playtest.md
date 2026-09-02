# Bot Playtest: Prove the Game Plays, Not Just Renders

A smoke check proves the game renders; a bot playtest proves it _plays_. The bot drives real scripted input and measures **progression** — objective movement, player responsiveness, stuck runs, error-free runtime. A game that renders beautifully but can't be progressed by a scripted sweep is not ready. Engine-agnostic: works for Phaser and Three.js alike.

## The Diagnostics Contract

The bot needs machine-readable game state. Expose two globals:

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

Rule: JSON-serializable primitives only, never raw engine objects — `vg playtest eval … --json` has to serialize whatever you return. If gameplay randomness bypasses the seeded RNG, bot metrics are noise.

**`seed(n)` must restart, not just reseed.** By the time the bot can call it, the game has already run frames (and possibly generated the level) with unseeded RNG. The contract: `seed(n)` reseeds the RNG **and** restarts/regenerates the run from that seed, so everything the bot measures is deterministic. If a restart is expensive, seed before boot instead — read a `?seed=` query param at init, which is the one boot-time path the bot knows how to drive (it reloads with the param set and records `seedApplied: "boot-param"`).

## Running It

Run from the project root:

```bash
# This skill's directory. Claude Code substitutes CLAUDE_SKILL_DIR (project, global
# or plugin install); other agents fall back to wherever `skills add` put it.
SKILL="${CLAUDE_SKILL_DIR}"
[ -d "$SKILL" ] || for d in .agents/skills .claude/skills ~/.agents/skills ~/.claude/skills; do
  [ -d "$d/playtest" ] && SKILL=$d/playtest && break
done
```

```sh
node $SKILL/scripts/bot-playtest.mjs --url http://localhost:5173
node $SKILL/scripts/bot-playtest.mjs --game my-game --seed 42      # a deployed game
node $SKILL/scripts/bot-playtest.mjs --url http://localhost:5173 --script ./sweep.json
```

| Flag                    | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `--url <url>`           | Where the game is served (mutually exclusive with `--game`)                      |
| `--game <slug>`         | Playtest the deployed game (follows `VG_API_URL`)                                |
| `--seed <n>`            | Seed passed to `__GAME_TEST_HOOKS__.seed()` (default `12345`)                    |
| `--script <path>`       | JSON array of `{ keys?, pointer?, ms }` steps — each needs `keys` or a `pointer` |
| `--expect-progress`     | Assert the objective advances (see below)                                        |
| `--reaction-delay <ms>` | Idle gap after each step — models a slower player                                |
| `--headed`              | Show the browser (needed for real-GPU and WebGPU capture)                        |
| `--keep-open`           | Leave the page open afterwards so you can inspect it                             |

Exit `0` = the game plays, `1` = it doesn't (the JSON report names which check failed), `2` = the harness itself failed (no browser, game never booted).

## Metrics and What They Mean

- `framesAdvanced > 100` — the loop survived the run. A stall is a crash or frozen loop.
- `maxStepDisplacement > 5` — input mapping is alive: the furthest the player got from where a single step started. Near-zero under held input means broken input (or a mouse-driven game given a keyboard script). `distanceTravelled` is reported alongside it as total path length, but is not the gate — path sums every sampled wobble, so an idle bob could drift past a threshold on a game whose input is entirely dead.
- `scoreAfter > scoreBefore` + `stepOfFirstScore` — the objective is reachable, and how fast a naive player finds it. This is an assertion **only under `--expect-progress`**; otherwise it lands in `warnings`. Pass that flag once your script actually performs the game's scoring verb. A generic sweep knows nothing about how a given game scores, and a harness that fails healthy games teaches its reader to ignore the verdict.
- `stuckSteps` / `longestStuckRun` — steps where frames advanced, the step **asked the player to move**, and nothing came of it. Only the longest _consecutive_ run fails (above 2), because one dead step is a key the game doesn't bind while several in a row is a player wedged in geometry. A step asks the player to move if it holds WASD/arrows or a `pointer`; override with `"expectMotion": true | false` when a game moves on some other key.

  Motion is measured as **peak displacement during the hold**, not net displacement at the end of it — otherwise every round trip reads as zero, and a jump that works perfectly is reported as a stuck player.

- `consoleErrors` / `pageErrors` — both are arrays, and both must be empty for the full run.

## Writing a Good Input Script

The default sweep holds each direction plus a jump. Replace it with the game's core verb:

```json
[
  { "keys": ["ArrowUp"], "ms": 2000 },
  { "keys": ["ArrowUp", "Space"], "ms": 800 },
  { "keys": ["ArrowRight"], "ms": 1500 }
]
```

Key names are [KeyboardEvent codes](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code), and simultaneous keys in one step are held together — that's how you express "run and jump". The script maps `Key<A-Z>`, `Digit<0-9>`, the arrows, and the common named keys (`Space`, `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `Shift*`, `Control*`, `Alt*`, and the punctuation codes). Anything else exits 2 naming the unsupported code — add it to `NAMED_KEYS` in the script rather than guessing a substitute.

**A keyboard sweep proves nothing about a game that steers with the mouse.** Aim-and-thrust shooters, twin-stick games and point-to-move games will report `distanceTravelled` near zero under WASD and look broken when they are fine. Use `pointer` steps, in viewport fractions so the script survives a resize:

```json
[
  { "pointer": { "x": 0.8, "y": 0.3, "down": true }, "ms": 1500 },
  { "pointer": { "x": 0.2, "y": 0.7, "down": true }, "ms": 1500 }
]
```

`down` holds the primary button for the step (firing, dragging); omit it to only move the cursor. A step may carry both `keys` and `pointer` — that's "strafe while aiming". Each step's cursor position is held for its whole duration, which is what makes an aim-and-thrust ship actually travel.

When raw keys can't express the verb — placing a tower, choosing a card, triggering a wave — add a game-specific hook (`forceWave()`, `placeTower(x, y)`) to `__GAME_TEST_HOOKS__` and call it via `vg playtest eval`. A bot that can't perform the core verb measures nothing.

## Difficulty and Fairness Runs

For games with fail states, run the bot twice and compare:

```sh
node $SKILL/scripts/bot-playtest.mjs --url http://localhost:5173 --reaction-delay 0
node $SKILL/scripts/bot-playtest.mjs --url http://localhost:5173 --reaction-delay 300
```

- Delayed bot does as well as the fast one → difficulty pressure is decorative.
- Even the fast script can't survive the first threat → the opening is unfair.

Report both runs whenever difficulty tuning is in scope.

Also assert the fail state itself: a "reckless" script that seeks hazards should trigger the fail state, and retry should restore play. A game that can't be failed has no pressure; a fail state that can't be retried is a release blocker.

## Manual Bot Steps

The script is just a loop over `vg playtest` calls. When you need something it doesn't cover, drive it by hand — the daemon keeps the page alive between commands:

```sh
vg playtest open "http://localhost:5173?test=1&seed=42"
# Wait for the CONTRACT first, not for frames — a game sitting on its menu
# never advances a frame until seed()/setState() has started a run.
vg playtest wait --fn "window.__GAME_TEST_HOOKS__ !== undefined"
vg playtest eval "window.__GAME_TEST_HOOKS__.seed(42)"
vg playtest wait --fn "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10"
vg playtest eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',keyCode:68,which:68,bubbles:true}))"
vg playtest wait 1500
vg playtest eval "window.dispatchEvent(new KeyboardEvent('keyup',{key:'d',code:'KeyD',keyCode:68,which:68,bubbles:true}))"
vg playtest eval "window.__GAME_DIAGNOSTICS__" --json
vg playtest errors
```

## Driving Keys: Use `eval`, Not `keydown`

**Verified against agent-browser 0.34 — do not use `vg playtest keydown`/`keyup` for game input.** They dispatch a trusted event, but with an empty `code` and `keyCode: 0`, so any engine that matches on keyCode (Phaser included) silently ignores it. `press` populates the event correctly (`code: "KeyD"`, `keyCode: 68`) but is a discrete tap, so it cannot express a hold.

The only way to hold a properly-formed key is to dispatch the event yourself — the sequence shown under [Manual Bot Steps](#manual-bot-steps) above.

`scripts/bot-playtest.mjs` does exactly this, including the `code` → `keyCode` mapping. The one tradeoff is `isTrusted: false`, which matters only for games that explicitly check it.

Always release what you hold — a dangling keydown stays stuck in the game and poisons the next run against the same daemon.

## Headless WebGL Footguns

- **Never report headless FPS as performance.** Headless Chrome renders WebGL on SwiftShader (software rasterizer) — ~2fps on scenes a real GPU runs at 120. Headless runs are for correctness only; capture FPS with `--headed` on a real GPU and label headless numbers functional-only.
- **WebGPU screenshots are black in headless Chrome on Linux and Windows** (rendering and in-page readbacks work; only the capture fails). Use `--headed`; on Linux with no `DISPLAY`, agent-browser starts Xvfb automatically. `vg playtest doctor --webgpu` verifies the whole pipeline.
- **Don't run two playtests concurrently against WebGL games.** They share the software rasterizer; the frame-time collapse drifts game time from wall time and flakes every timed phase.
