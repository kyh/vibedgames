# `vg playtest` Cheatsheet

Every argument passes through to [agent-browser](https://github.com/vercel-labs/agent-browser). `vg playtest --help` is the authoritative surface; this is the game-shaped subset.

## Mental Model

- A **daemon** holds the browser open between invocations. Commands are separate processes; the page is not. It shuts down after an idle timeout, or on `vg playtest close`.
- **Refs (`@e1`, `@e2`) are per-snapshot.** Take a snapshot, act on its refs, and re-snapshot after anything that changes the page. A stale ref is the single most common mistake.
- **Headless by default**, on the real GPU (check the renderer string — SwiftShader means functional-only evidence). `--headed` for WebGPU capture on Linux/Windows.
- **`--json` on read commands** when the output will be parsed rather than read.

## Open and Navigate

```sh
vg playtest open http://localhost:5173
vg playtest open "http://localhost:5173?test=1&seed=42"
vg playtest --game my-game                 # the deployed game, opened
vg playtest --game                         # slug from ./vibedgames.json
vg playtest open http://localhost:5173 --headed
vg playtest reload
vg playtest close
```

`--game` expands to the game's URL wherever you put it, so it also works with an explicit verb and with multi-URL subcommands:

```sh
vg playtest --session p1 open --game my-game
vg playtest diff url --game my-game --game my-game-v2 --screenshot
```

The host follows `VG_API_URL`, so pointing the CLI at staging playtests staging rather than production.

## Wait for Readiness

```sh
vg playtest wait --fn "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10"
vg playtest wait --fn "window.__GAME_DIAGNOSTICS__?.complete === true"
vg playtest wait --load networkidle
vg playtest wait --text "Game Over"
vg playtest wait 500                        # last resort; prefer a condition
```

## See the Page

```sh
vg playtest snapshot                        # full accessibility tree with @eN refs
vg playtest snapshot -i                     # interactive elements only
vg playtest snapshot -i --urls              # include link targets
vg playtest snapshot -s "#hud" -c           # scoped + compact
vg playtest screenshot /tmp/frame.png
vg playtest screenshot --full               # includes off-screen content
vg playtest screenshot --annotate           # overlays [N] labels matching @eN
```

Canvas games have almost no accessibility tree — `snapshot` covers menus and HUD overlays, `eval` covers gameplay. Use both.

## Act

```sh
vg playtest click @e2
vg playtest fill @e3 "player-name"
vg playtest press Enter                     # menus/DOM only — see the warning below
vg playtest mouse move 640 360
vg playtest mouse down left
vg playtest scroll down 300
```

> **Game input does not go through `keydown`/`keyup`.** Verified on agent-browser 0.34: those send an event with an empty `code` and `keyCode: 0`, which Phaser and other keyCode-matching engines ignore. `press` builds the event correctly but is a discrete tap and cannot hold. To hold a key, dispatch the event yourself:
>
> ```sh
> vg playtest eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',keyCode:68,which:68,bubbles:true}))"
> ```
>
> `scripts/bot-playtest.mjs` handles this and the `code` → `keyCode` mapping for you. Full explanation in `references/bot-playtest.md`.

## Read Game State

```sh
vg playtest eval "window.__GAME_DIAGNOSTICS__" --json
vg playtest eval "window.__GAME_DIAGNOSTICS__.score" --json
vg playtest eval "window.__GAME_TEST_HOOKS__.setState('boss')"
vg playtest get text @e1
vg playtest is visible @e4
```

## Evidence When Something Fails

Gather in this order — it's roughly cheapest-to-most-specific:

```sh
vg playtest errors                          # uncaught exceptions
vg playtest console --json                  # console messages (filter to error yourself)
vg playtest network requests --filter api   # non-2xx, missing assets
vg playtest screenshot /tmp/failure.png
vg playtest eval "window.__GAME_DIAGNOSTICS__" --json
```

`console --clear` and `errors --clear` before a run so what you read afterwards belongs to that run.

## Compare

```sh
vg playtest diff screenshot --baseline /tmp/before.png -o /tmp/diff.png
vg playtest diff screenshot --baseline /tmp/before.png -t 0.2
vg playtest diff snapshot --baseline /tmp/before.txt
vg playtest diff url https://a.vibedgames.com https://b.vibedgames.com --screenshot
```

## Batch

One invocation, one result array — good for a fixed opening sequence:

```sh
vg playtest batch \
  "open http://localhost:5173?test=1" \
  "wait --fn '(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10'" \
  "eval 'window.__GAME_DIAGNOSTICS__' --json" \
  "screenshot /tmp/boot.png"

vg playtest batch --bail "open http://localhost:5173" "click @e1"
```

## Environment and Emulation

```sh
vg playtest set viewport 1280 720           # lock before any baseline
vg playtest set viewport 390 844 3          # phone-sized layout, DPR 3
vg playtest set device "iPhone 15"          # viewport + UA only — NOT a touch device
vg playtest set media dark
vg playtest set offline on
```

**`set device` does not make a phone.** It sets viewport and user-agent; the page still reports `pointer: fine`, `maxTouchPoints: 0`, no `ontouchstart`. Games gate their touch UI on `matchMedia('(pointer: coarse)')`, so a session set up this way runs the **desktop** build and every mobile finding from it is void. Assert before believing anything:

```sh
vg playtest eval "({ coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints })" --json
```

Real emulation is CDP on the session's page target, from a client that **stays attached for the whole run** — Chrome reverts every `Emulation.*` override the moment the client detaches:

1. `Emulation.setDeviceMetricsOverride { width, height, deviceScaleFactor, mobile: true }`
2. `Emulation.setTouchEmulationEnabled { enabled: true, maxTouchPoints: 5 }`
3. Navigate or `reload` **after** the override — `ontouchstart` and `maxTouchPoints` are fixed at renderer boot.

Traps that silently corrupt mobile readings:

- **Never enable `Emulation.setEmitTouchEventsForMouse`** — every Playwright `click`/`mouse` command hangs forever. Dispatch gestures with `Input.dispatchTouchEvent` (tap, hold, swipe, multi-finger); `click <selector>` is still fine for tapping a DOM control.
- **`screenshot` re-applies the portrait viewport** and returns a stale frame while `innerWidth` still reports the old width. Re-assert the viewport after shooting. A second CDP client attaching can reset the holder's emulation too.
- **`env(safe-area-inset-*)` reads 0 in the emulator.** A missing `env()` is checkable statically; a notch collision is not observable here — never claim you saw one.

## Sessions

Sessions isolate browser state (tabs, cookies, storage):

```sh
vg playtest --session p1 open http://localhost:5173
vg playtest --session p2 open http://localhost:5173
vg playtest --session p1 eval "window.__GAME_DIAGNOSTICS__" --json
vg playtest session list
```

Two concurrent sessions genuinely are isolated — verified on 0.34: `p1` and `p2` each held their own page state against the same URL at the same time. So a two-client multiplayer check is possible, with two caveats:

- Sync through the party server hasn't been exercised this way yet. Confirm both clients actually connected before trusting a finding.
- Concurrent WebGL sessions contend for the GPU (~8 run fine), so any _timing_ measured under contention is noise. Assert on state; take load/perf numbers serially in a fresh session — `canvas-determinism.md` § Headless Footguns.

## Install and Diagnostics

```sh
vg playtest install                         # re-provision the browser
vg playtest install --with-deps             # Linux system libraries
vg playtest doctor                          # check the setup
vg playtest doctor --webgpu                 # verify the WebGPU capture pipeline
```

`vg playtest` installs the browser on first use, so `install` is only needed to repair or to add Linux system deps.
