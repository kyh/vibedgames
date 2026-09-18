# Model Playtest: Let a Model Play It

The scripted bot proves a game _can_ be played: held keys move the player, the objective is reachable, nothing throws. It cannot tell you whether a player who is _trying_ gets anywhere — whether the first hazard is readable, whether the objective is findable from what the game shows, whether a run ends in a wall or a win. That needs something that decides. `vg playtest run` is a playtester that decides its own inputs from the game state, several times a second, with no human involved.

```sh
vg playtest run --url http://localhost:5173
vg playtest run --game my-game --goal "Reach the flag on the right; pits kill, jump them" --json
```

## How It Works

The playtester is the two-layer loop the community Jev game bots use (TerraBlind's boss combat, JevPilot's autopilot):

1. **Perception is code.** Each tick `vg playtest run` reads `window.__GAME_DIAGNOSTICS__` — the same contract the bot uses — and adds what the last inputs achieved: displacement, score delta, a short position trail, how many ticks in a row the player has been stuck.
2. **Decision is the model.** That state goes to Jev, TypeSafe's decision-only model, through the vibedgames API (`playtest.decide`; the server holds the key, you need nothing but `vg login`). It doesn't generate text: it answers typed questions with calibrated probabilities. One call answers everything at once — a `choice` for which movement to hold, a yes/no per action ("should the player jump right now?").
3. **Execution is code.** The answers become properly-formed held keys and pointer events, dispatched the way the bot does it (never agent-browser's `keydown`, which Phaser ignores).

**The decision is the hold.** There is no fixed tick. The previous inputs stay down while the model answers, so the game runs continuously and the playtester decides as fast as answers arrive — typically 3–5 times a second, about a player's reaction time. `--tick-ms` is a floor, not a period: the default (150 ms) only stops a very fast answer from playing at a jittery superhuman rate; raise it for a slower player. The report's `decisionsPerSecond` and `model.meanDecisionMs` say what a run actually did.

There is no vision. The model sees exactly what the diagnostics expose, which makes the playtester an honest audit of the contract: **a playtester that can't decide is telling you the diagnostics don't describe what a player sees.** `decisions.meanConfidence` is the signal — below 0.3 the report says so.

## Make Your Game Playable by the Model

Three things, all in the game's own code, all cheap. The first two are the diagnostics contract every playtest needs; the third is what lets the playtester play without a controls file.

### 1. Publish state the way a player sees it

```js
// Updated every frame from the game loop. Primitives only — never engine objects.
window.__GAME_DIAGNOSTICS__ = {
  frame: 0, // the loop's heartbeat
  score: 0, // the objective metric: points, distance, waves, gems
  complete: false, // win or fail state reached
  player: { x: 0, y: 0, speed: 0 }, // x/z for 3D games
  entities: 0,
  // What the playtester decides FROM. Relative vectors beat absolute lists:
  nearestHazard: { dx: 120, dy: 0, kind: "spike" }, // null when none in view
  nearestPickup: { dx: -40, dy: -30, kind: "coin" },
  goalDirection: { dx: 900, dy: 0 }, // where progress is
  hp: 3,
  canJump: true, // grounded / cooldown ready
};
```

Rules of thumb: a few kilobytes at most (the whole object is sent each tick; a 500-entity array is cost without signal); the nearest few threats and pickups with `dx`/`dy` from the player, not everything; the game's own verbs as booleans (`canJump`, `reloading`, `onLadder`); and `score` monotonic so `after > before` is a sound assertion. Field names are free-form — the model reads the JSON — but describe them in the goal if they aren't obvious.

### 2. Expose the hooks a playtest needs

```js
window.__GAME_TEST_HOOKS__ = {
  seed(n) {}, // reseed the RNG AND restart the run — see bot-playtest.md
  setState(name) {}, // 'active-play' skips the menu; returns { state: name } once applied
  setPausedForScreenshot(paused) {},
};
```

Gate both behind dev mode or `?test=1` if you don't want them shipping to players; `vg playtest run --game <slug>` opens the deployed URL as-is, so a game that gates on `?test=1` needs `--url https://<slug>.vibedgames.com/?test=1`.

### 3. Describe the controls, in words the model chooses between

```js
window.__GAME_PLAYTEST__ = {
  goal: "Cross the level to the flag on the right. Pits and spikes kill; jump over them (nearestHazard.dx tells you how far). Coins raise the score.",
  move: {
    none: { description: "Stand still", keys: [] },
    left: { description: "Run left", keys: ["ArrowLeft"] },
    right: { description: "Run right (towards the flag)", keys: ["ArrowRight"] },
    right_jump: {
      description: "Run right while jumping — clears pits and spikes",
      keys: ["ArrowRight", "Space"],
    },
  },
  actions: {
    fire: { description: "fire the blaster at an enemy in front of the player", keys: ["KeyX"] },
  },
};
```

`vg playtest run` reads this at launch and needs no `--controls`. The descriptions are literally the criteria the model picks from, so write them as a coach would ("towards the flag", "clears pits"), and put the rules in `goal`: what wins, what kills, which way progress is, what the diagnostic fields mean. The model has no memory between ticks beyond the `recent` block the harness supplies — the goal is where continuity lives.

- **`move`** — one `choice` question per tick; the chosen option's `keys` and/or `pointer` are held until the next decision. `pointer` is `{ x, y, down? }` in viewport fractions, for games that steer from the cursor (aim-and-thrust, twin-stick, point-to-move — `games/pong` parks the cursor in five lanes). A `none` option is added if you leave it out.
- **`actions`** — one yes/no question each, held for the tick when the answer is ≥ 0.5. Keys only; a mouse-fire game puts `down: true` on its pointer moves instead.
- Combos the game needs held together are `move` options (`right_jump`); independent verbs are `actions`. Key names are [KeyboardEvent codes](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) — `Key<A-Z>`, `Digit<0-9>`, arrows, `Space`, `Enter`, `Shift*`, and the rest the bot accepts.

Where raw input can't express the verb — placing a tower, choosing a card — add a hook to `__GAME_TEST_HOOKS__` and a diagnostic that shows the choices; the playtester can only pull levers that exist as input.

The same JSON works as a `--controls` file for a game you don't own or can't edit, and `--goal` overrides the goal either way.

## Flags

`run` is the one `vg playtest` verb that belongs to `vg` rather than to agent-browser; `vg playtest run --help` is its reference, and every other `vg playtest …` still passes straight through to the binary.

| Flag                              | Meaning                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url <url>`                     | Where the game is served (mutually exclusive with `--game`)                                                                                  |
| `--game <slug>`                   | Playtest the deployed game (follows `VG_API_URL`)                                                                                            |
| `--goal <text>`                   | What the playtester is trying to do — the single most useful flag. Overrides the manifest's or scheme's goal                                 |
| `--controls <wasd\|arrows\|path>` | Control scheme: a preset, or a JSON file in the `__GAME_PLAYTEST__` shape. Default: the game's manifest, else `wasd`                         |
| `--ticks <n>`                     | Decisions to make (default `60`); the run also stops when `complete` turns true                                                              |
| `--tick-ms <ms>`                  | Minimum time each decision's inputs stay held (default `150`, about a quick player's cadence; `0` = as fast as decisions arrive; max `5000`) |
| `--seed <n>`                      | Seed passed to `__GAME_TEST_HOOKS__.seed()` / `?seed=` (default `12345`)                                                                     |
| `--expect-progress`               | Assert the objective advances                                                                                                                |
| `--model <id>`                    | Decision model id (default `jev-latest`)                                                                                                     |
| `--headed`                        | Show the browser                                                                                                                             |
| `--keep-open`                     | Leave the page open afterwards                                                                                                               |
| `--json` / `--field <path>`       | The full report as JSON, or one value from it                                                                                                |

Exit `0` = the game plays under the playtester, `1` = it doesn't (the report names which check failed), `2` = the harness itself failed (bad flags, no browser, the game never booted, the model unreachable). Not logged in exits `1` like every other command.

## What the Model Sees

Each decision sends `{ goal, game, recent, tick }`:

- `game` — the JSON snapshot of `__GAME_DIAGNOSTICS__` taken when the previous inputs were applied, whole.
- `recent` — `held` (last move and actions), `movedLastTick` (peak displacement), `scoreDeltaLastTick`, `stuckTicksInARow`, a six-point position `trail`, and `blockedMoves`.
- `tick` — `{ index, of }`, so "no time left" is knowable.

**The reflex.** A move that produced no motion for two ticks running is withdrawn from the next question's options. Omission, not persuasion: the model cannot answer outside its schema, so removing the option is the one nudge that always lands. Only that move, only for one tick — the model still chooses among the rest.

Per-call state is capped at 64 KB and 32 questions server-side; a run of 60 decisions costs a fraction of a cent and is not metered against credits.

## Metrics and What They Mean

The play metrics are the bot's, measured per decision instead of per scripted step; the thresholds live in `THRESHOLDS` in the CLI's `lib/playtest/run.ts`:

- `framesAdvanced`, `maxTickDisplacement`, `longestStuckRun`, `consoleErrors`, `pageErrors` — the same gates as [bot-playtest.md](bot-playtest.md), and they fail for the same reasons. A wedged playtester is one that kept choosing moves that went nowhere _despite_ the reflex — geometry it can't read its way out of.
- `scoreAfter > scoreBefore`, `tickOfFirstScore` — an assertion only under `--expect-progress`. A playtester that never scores under a well-written goal is a real finding about discoverability; under the default goal it's a warning.
- `complete`, `completedAtTick` — the run stops when the game reports `complete`. Whether that was a win or a death is in the timeline's last entries and in your knowledge of the game.
- `decisions` — histograms of `moves` and `actions`, and `meanConfidence` for the move choice.
- `decisionsPerSecond`, `model` — cadence and cost (`calls`, `inputTokens`, `meanDecisionMs`, `maxDecisionMs`), so a slow run can be attributed.
- `timeline` — one entry per decision: the move and actions chosen, the move's confidence, each action's probability, `peak`/`path`, `scoreDelta`, `frames`, `stuck`. This is the playtest log; read it before deciding anything about the game.

## Reading a Run Like a Playtest

The model playtester is not a benchmark; it is a cheap, tireless first player. Things it surfaces that the scripted sweep cannot:

- **Onboarding:** does the objective get scored at all in 60 decisions under a goal that says what to do? If a model that has been told the rules can't find the score, a player who hasn't been told won't either.
- **Readability:** run with the honest diagnostics, then add `nearestHazard` and run again. If `meanConfidence` jumps and deaths drop, that information is what a player needs to _see_ — check the art is showing it.
- **Difficulty:** run at the default cadence and at `--tick-ms 600`. A slower decision rate models a slower player; if both survive equally, the pressure is decorative. The scripted bot's `--reaction-delay` runs measure the same thing without any judgement in the loop — report both.
- **Determinism:** same `--seed`, same controls, and the decisions still differ run to run — the model isn't deterministic, so compare distributions across a few runs, not single runs.

Pair a model run with the scripted sweep, not instead of it: the sweep is deterministic and free; the playtester is for the questions that need someone trying.
