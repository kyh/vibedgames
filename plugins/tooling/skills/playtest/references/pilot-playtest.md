# Pilot Playtest: Let a Model Play It

The scripted bot proves a game _can_ be played: held keys move the player, the objective is reachable, nothing throws. It cannot tell you whether a player who is _trying_ gets anywhere — whether the first hazard is readable, whether the objective is findable from the state, whether a run ends in a wall or a win. That needs something that decides, and `scripts/pilot-playtest.mjs` is a playtester that decides its own inputs from the game state, several times a second, with no human involved.

## How It Works

The pilot is a two-layer loop, the same shape as the community Jev game bots (TerraBlind's boss combat, JevPilot's autopilot):

1. **Perception is code.** Each tick the harness reads `window.__GAME_DIAGNOSTICS__` — the same contract the bot uses — and adds what the last inputs achieved: displacement, score delta, a short position trail, how many ticks in a row the player has been stuck.
2. **Decision is the model.** That state goes to [Jev](https://docs.typesafe.ai), TypeSafe's decision-only model: it doesn't generate text, it answers typed questions with calibrated probabilities in roughly 100–300 ms. One call per tick answers everything at once — a `choice` for which movement to hold, a yes/no (`noul`) per action ("should the player jump right now?").
3. **Execution is code.** The answers become properly-formed held keys and pointer events through the harness in `scripts/lib/harness.mjs`, dispatched the way the bot does it (never `vg playtest keydown`). Keys stay down across the decision gap, like a player holding a direction while thinking.

There is no vision. The model sees exactly what the diagnostics expose, which makes the pilot an honest audit of the contract: **a pilot that can't decide is telling you the diagnostics don't describe what a player sees.** Add positions of hazards, pickups and the goal, and it gets better. The report's `decisions.meanConfidence` is the signal — a low value warns about exactly this.

## Running It

Needs `TYPESAFE_API_KEY` (create one at [console.typesafe.ai](https://console.typesafe.ai/settings/keys)). The key is read by the script and sent only to the TypeSafe API; nothing in vibedgames proxies or meters it. A run of 60 ticks costs well under a cent at published pricing — the report carries `model.inputTokens` so you can check.

```bash
# This skill's directory. Claude Code substitutes CLAUDE_SKILL_DIR (project, global
# or plugin install); other agents fall back to wherever `skills add` put it.
SKILL="${CLAUDE_SKILL_DIR}"
[ -d "$SKILL" ] || for d in .agents/skills .claude/skills ~/.agents/skills ~/.claude/skills; do
  [ -d "$d/playtest" ] && SKILL=$d/playtest && break
done
```

```sh
export TYPESAFE_API_KEY=…
node $SKILL/scripts/pilot-playtest.mjs --url http://localhost:5173
node $SKILL/scripts/pilot-playtest.mjs --game my-game --seed 42 --ticks 120     # a deployed game
node $SKILL/scripts/pilot-playtest.mjs --url http://localhost:5173 --goal "Reach the exit on the right without touching lava"
node $SKILL/scripts/pilot-playtest.mjs --url http://localhost:5173 --controls ./controls.json --expect-progress
```

| Flag                              | Meaning                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `--url <url>`                     | Where the game is served (mutually exclusive with `--game`)                                  |
| `--game <slug>`                   | Playtest the deployed game (follows `VG_API_URL`)                                            |
| `--seed <n>`                      | Seed passed to `__GAME_TEST_HOOKS__.seed()` / `?seed=` (default `12345`)                     |
| `--ticks <n>`                     | Decisions to make (default `60`); the run also stops when `complete` turns true              |
| `--tick-ms <ms>`                  | How long each decision's inputs are held before the next read (default `300`, range 80–5000) |
| `--controls <wasd\|arrows\|path>` | Control scheme: a preset, or a JSON file (below). Default `wasd`                             |
| `--goal <text>`                   | What the pilot is trying to do — the single most useful flag. Overrides the scheme's `goal`  |
| `--model <id>`                    | Jev model id (default `jev-latest`)                                                          |
| `--expect-progress`               | Assert the objective advances                                                                |
| `--headed`                        | Show the browser                                                                             |
| `--keep-open`                     | Leave the page open afterwards                                                               |

Exit `0` = the game plays under the pilot, `1` = it doesn't (the JSON report names which check failed), `2` = the harness itself failed (no key, no browser, the game never booted, the model unreachable). `TYPESAFE_BASE_URL` overrides the API host, as the TypeSafe SDK does.

**Tick cadence.** A tick is the hold (`--tick-ms`) plus one `vg playtest eval` round trip plus one model call, so the effective rate is 1–2 decisions per second — JevPilot's clear-road rate, slower than TerraBlind's 5 Hz. The window each tick measures runs from the previous decision to the end of this hold, so it includes the decision latency, during which the previous inputs were still held. `wallMs` and `model.meanDecisionMs` in the report tell you the real cadence of a run.

## The Controls File

Presets cover WASD and arrows with a Space action. Real games need their own verbs — write them down, because the descriptions are literally what the model chooses between:

```json
{
  "goal": "Cross the level to the flag on the right. Pits and spikes kill; jump over them. Coins raise the score.",
  "move": {
    "none": { "description": "Stand still", "keys": [] },
    "left": { "description": "Run left", "keys": ["ArrowLeft"] },
    "right": { "description": "Run right (towards the flag)", "keys": ["ArrowRight"] },
    "right_jump": {
      "description": "Run right while jumping — clears pits and spikes",
      "keys": ["ArrowRight", "Space"]
    }
  },
  "actions": {
    "fire": {
      "description": "fire the blaster at an enemy in front of the player",
      "keys": ["KeyX"]
    }
  }
}
```

- **`move`** — one `choice` question. Each option holds `keys` and/or a `pointer` (`{ x, y, down? }` in viewport fractions, for aim-and-thrust and twin-stick games) for the whole tick. A `none` option is added if you leave it out. Key names are [KeyboardEvent codes](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code), the same set the bot accepts.
- **`actions`** — one yes/no question each, held for the tick when the answer is ≥ 0.5. Keys only; a mouse-fire game puts `down: true` on its pointer moves instead.
- **`goal`** — plain prose. Say what wins, what kills, and which direction progress is. The model has no memory between ticks beyond the `recent` block the harness supplies, so the goal is where continuity lives.

Combos belong in `move` options (`right_jump` above) when the game needs them held together; independent verbs belong in `actions`. Where raw input can't express the verb — placing a tower, picking a card — add a hook to `__GAME_TEST_HOOKS__` and a diagnostic that shows its effect; the pilot can only pull levers that exist as input.

## What Jev Sees

Each call sends `{ goal, game, recent, tick }`:

- `game` — a JSON snapshot of `__GAME_DIAGNOSTICS__`, whole. Keep it primitives-only (the contract already says so) and under a few kilobytes: the model's context is ~32k tokens per call, and a 500-entity array every tick is cost with no signal. Prefer `nearestEnemy: { dx, dy, dist }` over `entities: [...]`.
- `recent` — `held` (last move and actions), `movedLastTick` (peak displacement), `scoreDeltaLastTick`, `stuckTicksInARow`, a six-point position `trail`, and `blockedMoves`.
- `tick` — `{ index, of, tickMs }`, so "no time left" is knowable.

**The reflex.** A move that produced no motion for two ticks running is withdrawn from the next question's options. Omission, not persuasion: Jev cannot answer outside its schema, so removing the option is the one nudge that always lands. Only that move, only for one tick — the model still chooses among the rest.

## Metrics and What They Mean

The play metrics are the bot's, measured per tick instead of per step, and the thresholds live in `THRESHOLDS` at the top of the script:

- `framesAdvanced`, `maxTickDisplacement`, `longestStuckRun`, `consoleErrors`, `pageErrors` — the same gates as [bot-playtest.md](bot-playtest.md), and they fail for the same reasons. A wedged pilot is one that kept choosing moves that went nowhere _despite_ the reflex — geometry it can't read its way out of.
- `scoreAfter > scoreBefore`, `tickOfFirstScore` — an assertion only under `--expect-progress`. A pilot that never scores under a well-written goal is a real finding about discoverability; under the default goal it's a warning.
- `complete`, `completedAtTick` — the run stops when the game reports `complete`. Whether that was a win or a death is in the timeline's last entries (`scoreDelta`, `game` state before it), and in your knowledge of the game.
- `decisions` — histograms of `moves` and `actions`, and `meanConfidence` for the move choice. Below 0.3 the report warns: the state isn't giving the model enough to prefer one direction over another.
- `model` — `calls`, `inputTokens`, `outputTokens`, `meanDecisionMs`, `maxDecisionMs`. Cost and cadence, so a slow run can be attributed.
- `timeline` — one entry per tick: the move and actions chosen, the move's confidence, each action's probability, `peak`/`path`, `scoreDelta`, `frames`, `stuck`. This is the playtest log; read it before deciding anything about the game.

## Reading a Run Like a Playtest

The pilot is not a benchmark; it is a cheap, tireless first player. Things it surfaces that the scripted sweep cannot:

- **Onboarding:** does the objective get scored at all in the first 60 ticks under a goal that says what to do? If a model that has been told the rules can't find the score, a player who hasn't been told won't either.
- **Readability:** run with the honest diagnostics, then add `nearestHazard` and run again. If `meanConfidence` jumps and deaths drop, that information is what a player needs to _see_ — check the art is showing it.
- **Difficulty:** run the pilot at `--tick-ms 200` and `--tick-ms 600`. A slower decision rate models a slower player; if both survive equally, the pressure is decorative. The scripted bot's `--reaction-delay` runs measure the same thing without any judgement in the loop — report both.
- **Determinism:** same `--seed`, same controls, and the decisions still differ tick to tick — the model isn't deterministic, so compare distributions across a few runs, not single runs.

Pair a pilot run with the scripted sweep, not instead of it: the sweep is deterministic and cheap enough to run on every change; the pilot is for the questions that need someone trying.

## Adding a Game-Specific Question

The default questions are movement and actions. When a game's core verb is something else — which tower to place, which card to play — the cleanest path is a hook on `__GAME_TEST_HOOKS__` plus a diagnostic that exposes the choices, then a copy of `pilot-playtest.mjs` whose `buildQuestions` adds a `choice` over those options and whose `inputsFor` calls the hook via `evaluate`. The harness module does the rest.
