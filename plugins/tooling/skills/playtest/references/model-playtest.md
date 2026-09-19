# Model Playtest: Let a Model Play It

The scripted bot proves a game _can_ be played: held keys move the player, the objective is reachable, nothing throws. It cannot tell you whether a player who is _trying_ gets anywhere — whether the first hazard is readable, whether the objective is findable from what the game shows, whether a run ends in a wall or a win. That needs something that decides. `vg playtest run` is a playtester that decides its own inputs from the game state, several times a second, with no human involved.

```sh
vg playtest run --url http://localhost:5173
vg playtest run --game my-game --goal "Reach the flag on the right; pits kill, jump them" --json
```

## How It Works

The playtester is the two-layer loop the community Jev game bots use (TerraBlind's boss combat, JevPilot's autopilot), and it runs **inside the game's page**: `vg playtest run` boots the game, injects a small agent, and waits. Nothing crosses to the CLI per decision.

1. **Perception is code.** Several times a second the agent reads `window.__GAME_DIAGNOSTICS__` — the same contract the bot uses — and adds what the last inputs achieved: displacement, score delta, a short position trail, how many ticks in a row the player has been stuck.
2. **Decision is the model.** That state goes straight from the page to `POST /api/playtest/decide` on the vibedgames API, carrying a short-lived token the CLI minted for this run (`playtest.session`). The server holds the provider key and forwards one System One request to Jev, TypeSafe's decision-only model: typed questions in, calibrated probabilities out, no text. One call answers everything — a `choice` for which movement to hold, a yes/no (`noul`) per action, and a `score` for how close the player is to the goal (the model's own read, 0–1, reported as `progress`).
3. **Execution is code, at two speeds.** The answer becomes properly-formed held keys and pointer events, dispatched in the page (never agent-browser's `keydown`, which Phaser ignores). If the chosen move carries a `reflex` in `__GAME_PLAYTEST__`, that function runs **every frame** while the move is the model's intent, and its inputs are what is held — the model sets intent a few times a second, the reflex turns it into input at 60 fps. That is what makes a fast game playable: nothing waits on a round trip.

**The decision is the hold.** There is no fixed tick. The previous inputs stay down while the model answers, so the game runs continuously and the agent decides as fast as answers arrive — the model's own latency plus one hop to the API, typically 3–6 times a second. `--tick-ms` is a floor, not a period: the default (150 ms) only stops a very fast answer from playing at a jittery superhuman rate; raise it for a slower player. The report's `decisionsPerSecond` and `model.meanDecisionMs` say what a run actually did.

**The page is untrusted, and gets exactly one credential.** The token the agent carries is HMAC-signed, bound to your user, expires in 15 minutes, and is honoured by that one endpoint only — never by the rest of the API. A game that captured it could spend decision-model tokens in your name until it expired, and nothing else. Your session and API key never enter the page.

There is no vision. The model sees exactly what the diagnostics expose, which makes the playtester an honest audit of the contract: **a model that can't decide is telling you the diagnostics don't describe what a player sees.** `decisions.meanConfidence` is the signal — below 0.3 the report says so.

## Make Your Game Playable by the Model

Three things, all in the game's own code, all cheap. The first two are the diagnostics contract every playtest needs; the third is what lets the playtester play without a controls file. They are three window globals; `@vibedgames/playtest` types and publishes them, and checks the manifest the way the CLI will:

```sh
npm install @vibedgames/playtest
```

```ts
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
```

The package is the typed way to do what follows, not a requirement — the globals are the contract, and the CLI reads them however they got there. The snippets below show both.

### 1. Publish state the way a player sees it

```ts
// A live getter: read on every access, so the playtest always sees the current
// frame. Primitives only — never engine objects.
publishDiagnostics(() => ({
  frame: game.frame, // the loop's heartbeat
  score: game.score, // the objective metric: points, distance, waves, gems
  complete: game.over, // win or fail state reached
  player: { x: game.player.x, y: game.player.y, speed: game.player.speed }, // x/z for 3D games
  entities: game.entities.length,
  // What the playtester decides FROM. Relative vectors beat absolute lists:
  nearestHazard: game.nearestHazard(), // { dx: 120, dy: 0, kind: "spike" } | null when none in view
  nearestPickup: game.nearestPickup(), // { dx: -40, dy: -30, kind: "coin" }
  goalDirection: { dx: game.flag.x - game.player.x, dy: 0 }, // where progress is
  hp: game.player.hp,
  canJump: game.player.grounded, // grounded / cooldown ready
}));
// By hand: assign the same object to window.__GAME_DIAGNOSTICS__ every frame.
```

Rules of thumb: a few kilobytes at most (the whole object is sent each tick; a 500-entity array is cost without signal); the nearest few threats and pickups with `dx`/`dy` from the player, not everything; the game's own verbs as booleans (`canJump`, `reloading`, `onLadder`); and `score` monotonic so `after > before` is a sound assertion. Field names are free-form — the model reads the JSON — but describe them in the goal if they aren't obvious.

### 2. Expose the hooks a playtest needs

```ts
if (import.meta.env.DEV || isPlaytestRequested()) {
  // isPlaytestRequested() is `?test=1` in the URL
  publishTestHooks({
    seed: (n) => game.restart(n), // reseed the RNG AND restart the run — see bot-playtest.md
    setState: (name) => {
      game.jumpTo(name); // 'active-play' skips the menu
      return { state: name }; // once applied
    },
    setPausedForScreenshot: (paused) => game.setFrozen(paused),
  });
  publishPlaytest({/* step 3 */});
}
// By hand: window.__GAME_TEST_HOOKS__ = { seed, setState, setPausedForScreenshot }.
```

**Keep camera, microphone and other permission-gated features off under `?test=1`.** A playtest browser denies them, the rejection lands as a console error, and any console error fails the run — for a reason that has nothing to do with whether the game plays. `games/pong` skips its hand-tracking auto-start when `isPlaytestRequested()`.

Gate both behind dev mode or `?test=1` if you don't want them shipping to players; `vg playtest run --game <slug>` opens the deployed URL as-is, so a game that gates on `?test=1` needs `--url https://<slug>.vibedgames.com/?test=1`.

### 3. Describe the controls, in words the model chooses between

```ts
publishPlaytest({
  goal: "Cross the level to the flag on the right. Pits and spikes kill; jump over them (nearestHazard.dx tells you how far). Coins raise the score.",
  move: {
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
});
// By hand: window.__GAME_PLAYTEST__ = { goal, move, actions }.
```

`publishPlaytest` throws in the game's console on what `vg playtest run` would reject at launch — a missing description, a pointer in pixels, an action with no keys — and `publishPlaytest<MyDiagnostics>(…)` types every `reflex`'s argument as your own diagnostics shape. `vg playtest run` reads the manifest at launch and needs no `--controls`. When the model's decisions can't keep up with your game, don't ask for a faster model — give the move that needs speed a `reflex` (below). The descriptions are literally the criteria the model picks from, so write them as a coach would ("towards the flag", "clears pits"), and put the rules in `goal`: what wins, what kills, which way progress is, what the diagnostic fields mean. The model has no memory between ticks beyond the `recent` block the harness supplies — the goal is where continuity lives.

- **`move`** — one `choice` question per tick; the chosen option's `keys` and/or `pointer` are held until the next decision. `pointer` is `{ x, y, down? }` in viewport fractions, for games that steer from the cursor (aim-and-thrust, twin-stick, point-to-move — `games/pong` parks the cursor in five lanes). **Leave `none` out unless standing still is a real play.** Given a state that points nowhere, the model takes "hold nothing" at ~0.9 confidence, every tick — the run freezes, and the high confidence hides the actual finding, which is that the diagnostics said too little. Without it the model has to commit to a direction, and `meanConfidence` drops to where the warning can see it. If you do declare one, three idle decisions in a row rest it for eight so the run keeps exploring. (A one-move scheme still gets a `none` partner, because a choice needs two options.)
- **`reflex(game)`** on a move — optional, and the fast-game path. While the option is the model's current intent, the agent calls it every frame with the live diagnostics and holds what it returns: `{ keys?: string[], pointer?: { x, y, down? } | null }`. Put the per-frame skill here — tracking a ball, strafing around a target, leading a shot — and leave the model the judgment call of _when_ to do it. Actions the model chose stay held alongside. `games/pong`'s `track_ball` is `pointerTracker()` from `@vibedgames/playtest` — a cursor that walks towards a signed error each frame, clamped and rate-limited — fed `ball.x - player.x`; the model's part is choosing it over parking. Because the manifest is read live in the page, `reflex` can be a real function with closure state; it is simply absent from the JSON a `--controls` file can carry.
- **`actions`** — one yes/no question each, held for the tick when the answer is ≥ 0.5, and **pressed again on every decision that says yes** — so a verb the game reads on the keydown edge (jump, fire, drop a bomb) fires each time. Keys only; a mouse-fire game puts `down: true` on its pointer moves instead.
- **`minDisplacement`** — optional. The per-decision movement that proves input reaches the player, in the units of `player.x/y/z`. The default, `5`, is a pixel-scale number; a game that measures in world units (most Three.js games — `games/pong`'s court is a few units wide and it sets `0.05`) never moves 5 of anything in one decision and fails as "player did not respond to input" while playing perfectly. Set it to a fraction of what one decision's hold really moves the player. `--min-displacement` overrides it; the report echoes the gate as `minDisplacement`.
- Combos the game needs held together are `move` options (`right_jump`); independent verbs are `actions`. A move chosen twice running is one continuous hold, not two presses — right for a direction, wrong for an edge-triggered key inside a combo. If the jump in `right_jump` only fires on keydown, the model has to alternate it with `right` to jump again; make the jump an action instead when it needs to repeat. Key names are [KeyboardEvent codes](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) — `Key<A-Z>`, `Digit<0-9>`, arrows, `Space`, `Enter`, `Shift*`, and the rest the bot accepts.

Where raw input can't express the verb — placing a tower, choosing a card — add a hook to `__GAME_TEST_HOOKS__` and a diagnostic that shows the choices; the playtester can only pull levers that exist as input.

**Write the goal for a player whose eyes are one decision behind.** The state the model decides from is ~150–250 ms old by the time its answer becomes input — at 4 px a frame that is 40–60 px of travel. A rule like "jump when `nearestHazard.dx` is between 30 and 90" reads fine and still loses: one snapshot says 95 (no), the next says 55 (yes), and the jump lands at 15. Give thresholds lead — at least two decisions' travel wide, starting early — and for anything tighter than that, stop asking the model to time it: make it a move with a `reflex` and let the model choose _whether_, not _when_. Measured on a seven-spike runner: jump-as-action died at the first or second spike, jump-in-a-move won one run in two, and a `run_right` reflex that adds `Space` while `nearestHazard.dx` is in range won three of three.

The same JSON works as a `--controls` file for a game you don't own or can't edit, and `--goal` overrides the goal either way.

## What Worked Across Twelve Games

Every example game in the repo is wired for `vg playtest run` — `games/*/src/playtest*.ts` are the worked examples. The same lessons came up in almost all of them:

**The model picks intent; a reflex does the hands.** Ten of twelve games ended up with _every_ move a reflex: `fight` / `kite` / `heal` (battle-arena), `eat_pellets` / `flee` (pacman), `till` / `plant` / `water` (farm), `thread_gap` / `grab_coin` (flappy-dragons). Anything that needs facing, timing, pathing or an edge-triggered key does not survive a 200 ms-stale decision. Raw `left` / `right` moves are for games slow enough that a wrong one costs nothing.

**Pre-digest judgment into named fields.** The model cannot rank a table or path through a maze, and it leans towards the first option listed. Tetris handed it a 16-zone height table and it chose the first zone every tick; adding `bestZones` (ranked in code) fixed it. Publish `bestTarget`, `nearestPellet.step`, `chores.till` — the answer to "where", already computed — and order the `move` options so the safe default is first. Route-aware beats straight-line wherever there are walls: `dx`/`dy` to a pellet lies in a maze; the first step of the shortest path does not.

**Words beat numbers, lists beat prose.** "Heal when `hpPct` < 0.3" had battle-arena healing at full health 80 ticks out of 80; publishing `condition: "healthy" | "hurt" | "critical"` and keying the descriptions on the word fixed it on the next run (0.99 confidence). Farm's goal as paragraphs of rules scored 7–11 at 0.5 confidence; the same rules as a priority list ("1. harvest if ripe, 2. water if dry, …") scored 16–19 at 0.89.

**Edge-triggered verbs inside a reflex need a release.** A key a reflex returns every frame is one long press. `keyTapper()` from `@vibedgames/playtest` alternates press and release so each cycle is a fresh keydown; by hand, return the key for a couple of frames, then `{ keys: [] }`. A reflex that returns `null` holds nothing. Reflex input lands on the next frame, so the "give thresholds lead" rule is for goals the _model_ times — inside a reflex, lead overshoots. And do not give an `action` the same key a reflex taps: the action holds it down and the reflex never gets another edge.

**Pointer games.** `pointerTracker()` walks a cursor along one axis by an error (pong). `pointerAim(dx, dy, { down })` parks it in a target's direction for camera-follow games where the cursor is a heading (starfall). A button that stays down while the cursor moves is dispatched as a drag — one press, moves, one release — and every move carries `movementX`/`movementY`, so relative-look games steer too. The agent aims at `document.elementFromPoint`, so a HUD element with `pointer-events: auto` under the cursor swallows the click: keep reflex pointers off the HUD, or make the HUD transparent to pointers.

**`score` has to be something a first minute of play raises, and only play.** Bomberman's old score (any bot death) rose with no input, because the bots blow themselves up; farm's gold is spent as well as earned. Count the player's own work: crates opened by my bombs, tiles tilled, enemies slain by me. If the real win condition is minutes away, score the steps towards it.

**`setState('active-play')` lands in SOLO, offline play.** A multiplayer game under `?test=1` must never dial the shared room — a seeded restart there resets everyone's match. It may return a Promise (the CLI awaits it) when assets have to load first; don't publish the hooks before the game can honour them. `seed` is optional: leave it out if the scene can only start once and the playtest reloads with `?seed=<n>` instead. `complete` must turn true on death as well as on a win, or the run idles on a game-over screen — or restarts it with the next `Space`.

**A reflex has to say when it is stuck.** The playtest cannot tell a reflex that is holding position on purpose from one wedged under a ledge, so reflex moves are never counted as stuck on their own — and an all-reflex game would push into the same wall for the whole run (lunerfall did, one prod run in two). Return `stuck: true` alongside the inputs while the reflex is trying to travel and going nowhere (no real displacement for ~50 frames): the move is then withdrawn after two still decisions like any other, the model has to pick another, and a run that stays wedged fails as wedged instead of passing silently. Try to shake loose inside the reflex as well — reverse and hop, back out and re-approach.

**Tune a reflex without the model.** `vg playtest run --pin-move <name>` holds one move for the whole run and never calls the model: deterministic, free, and the same report. Get the reflex surviving on its own, then let the model choose between them.

**How long is a run?** 80 decisions is about 14 seconds — a first kill, four gates, one bed of crops. A whole match or level is 250–400, and a slow loop (a taxi fare across a city) is 600–900 (`--ticks`); the token lasts 15 minutes.

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
| `--pin-move <name>`               | Hold one move for the whole run and never call the model — for tuning a reflex                                                               |
| `--expect-progress`               | Assert the objective advances                                                                                                                |
| `--min-displacement <n>`          | The input-alive gate, in the game's `player` units (default `5`, pixel-scale). Overrides the manifest's `minDisplacement`                    |
| `--model <id>`                    | Decision model id (default `jev-latest`)                                                                                                     |
| `--headed`                        | Show the browser                                                                                                                             |
| `--keep-open`                     | Leave the page open afterwards                                                                                                               |
| `--json` / `--field <path>`       | The full report as JSON, or one value from it                                                                                                |

Exit `0` = the game plays under the playtester, `1` = it doesn't (the report names which check failed), `2` = the harness itself failed (bad flags, no browser, the game never booted, the model unreachable). Not logged in exits `1` like every other command.

The page calls the API itself, so the two have to be able to reach each other: a local game against the deployed API works, a deployed game against the deployed API works, and a **deployed game against a `localhost` `VG_API_URL` does not** — Chrome refuses a public page a request to a loopback address. `run` says so up front (exit `2`) rather than failing every decision with "Failed to fetch".

## What the Model Sees

Each decision sends `{ goal, game, recent, tick }`:

- `game` — the JSON snapshot of `__GAME_DIAGNOSTICS__` taken when the previous inputs were applied, whole.
- `recent` — `held` (last move and actions), `movedLastTick` (peak displacement), `scoreDeltaLastTick`, `stuckTicksInARow`, a six-point position `trail`, and `blockedMoves`.
- `tick` — `{ index, of }`, so "no time left" is knowable.

And asks three kinds of question of it: `move` (a `choice` among the manifest's options), one `noul` per action, and `progress` (a `score` on five levels from "no progress, or losing" to "achieved", normalised to 0–1). The score is the model's judgment of the run against the _goal_ — the one signal that tracks a goal the game's `score` field can't see, like "survive the wave". It is advisory: it shapes the report, never a gate.

**The stuck reflex.** A move that produced no motion for two ticks running is withdrawn from the question's options. Omission, not persuasion: the model cannot answer outside its schema, so removing the option is the one nudge that always lands. Withdrawals accumulate while the player stays stuck — walk into a corner and first one wall goes, then the other — and all come back the moment the player moves; at least two options always remain. Only a _held direction_ can be stuck: keys, or a pointer with `down: true`. A parked pointer that has arrived and a `reflex` that has converged are still because they worked, and are never counted.

Per-call state is capped at 64 KB and 32 questions server-side; a run of 60 decisions costs a fraction of a cent and is not metered against credits. The run's token expires after 15 minutes, so a very long `--ticks` at a slow `--tick-ms` ends with an authorization error — start a new run.

## Metrics and What They Mean

The play metrics are the bot's, measured per decision instead of per scripted step; the thresholds live in `THRESHOLDS` in the CLI's `lib/playtest/run.ts`:

- `framesAdvanced`, `maxTickDisplacement`, `longestStuckRun`, `consoleErrors`, `pageErrors` — the same gates as [bot-playtest.md](bot-playtest.md), and they fail for the same reasons. `maxTickDisplacement` is held to the scheme's `minDisplacement`. `longestStuckRun` fails at 5, not the bot's 3: the decision after a withdrawal is already in flight when it lands, so walking into one wall costs three stuck ticks by construction. A wedged playtester is one that kept going nowhere _after_ the withdrawals — geometry it can't read its way out of, which usually means the diagnostics don't describe the walls.
- `scoreAfter > scoreBefore`, `tickOfFirstScore` — an assertion only under `--expect-progress`. A playtester that never scores under a well-written goal is a real finding about discoverability; under the default goal it's a warning.
- `complete`, `completedAtTick` — the run stops when the game reports `complete`. Whether that was a win or a death is in the timeline's last entries and in your knowledge of the game.
- `decisions` — histograms of `moves` and `actions`, `meanConfidence` for the move choice, `reflexFrames`: how many frames a reflex produced the held input (zero means no chosen move had one), and `progress` — `{ first, last, mean, max }` of the model's own 0–1 read of how close the player got to the goal. A run whose `score` never rose but whose `progress.last` beats `progress.first` did something the score field can't see; the warning says which case you have.
- `decisionsPerSecond`, `model` — cadence and cost (`calls`, `inputTokens`, `meanDecisionMs`, `maxDecisionMs`), so a slow run can be attributed.
- `timeline` — one entry per decision: the move and actions chosen, the move's confidence, each action's probability, the model's `progress` read, `peak`/`path`, `scoreDelta`, `frames`, `stuck`. This is the playtest log; read it before deciding anything about the game.

## Reading a Run Like a Playtest

The model playtester is not a benchmark; it is a cheap, tireless first player. Things it surfaces that the scripted sweep cannot:

- **Onboarding:** does the objective get scored at all in 60 decisions under a goal that says what to do? If a model that has been told the rules can't find the score, a player who hasn't been told won't either.
- **Readability:** run with the honest diagnostics, then add `nearestHazard` and run again. If `meanConfidence` jumps and deaths drop, that information is what a player needs to _see_ — check the art is showing it.
- **Goals the score can't see:** "survive", "reach the door", "don't get caught" never move `score`. Watch `decisions.progress` across the timeline instead — a read that climbs then collapses at a fixed tick is the moment the game turns on the player.
- **Difficulty:** run at the default cadence and at `--tick-ms 600`. A slower decision rate models a slower player; if both survive equally, the pressure is decorative. The scripted bot's `--reaction-delay` runs measure the same thing without any judgement in the loop — report both.
- **Determinism:** same `--seed`, same controls, and the decisions still differ run to run — the model isn't deterministic, so compare distributions across a few runs, not single runs.

Pair a model run with the scripted sweep, not instead of it: the sweep is deterministic and free; the playtester is for the questions that need someone trying.
