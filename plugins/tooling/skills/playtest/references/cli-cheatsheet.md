# `vg playtest` Cheatsheet

Every argument passes through to [agent-browser](https://github.com/vercel-labs/agent-browser). `vg playtest --help` is the authoritative surface; this is the game-shaped subset.

## Mental Model

- A **daemon** holds the browser open between invocations. Commands are separate processes; the page is not. It shuts down after an idle timeout, or on `vg playtest close`.
- **Refs (`@e1`, `@e2`) are per-snapshot.** Take a snapshot, act on its refs, and re-snapshot after anything that changes the page. A stale ref is the single most common mistake.
- **Headless by default.** `--headed` when you need a real GPU or WebGPU capture.
- **`--json` on read commands** when the output will be parsed rather than read.

## Open and Navigate

```sh
vg playtest open http://localhost:5173
vg playtest open "http://localhost:5173?test=1&seed=42"
vg playtest --game my-game                 # https://my-game.vibedgames.com
vg playtest --game                         # slug from ./vibedgames.json
vg playtest open http://localhost:5173 --headed
vg playtest reload
vg playtest close
```

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
vg playtest set viewport 390 844 3          # phone-sized, DPR 3
vg playtest set device "iPhone 14"          # touch-controls check
vg playtest set media dark
vg playtest set offline on
```

`set device` is the fastest way to check on-screen touch controls without a phone.

## Sessions

Sessions isolate browser state (tabs, cookies, storage):

```sh
vg playtest --session p1 open http://localhost:5173
vg playtest --session p2 open http://localhost:5173
vg playtest --session p1 eval "window.__GAME_DIAGNOSTICS__" --json
vg playtest session list
```

**Two-client multiplayer testing this way is unverified.** Sessions are documented to be isolated, but nobody here has confirmed two concurrent clients against the party server — and two concurrent WebGL contexts share the software rasterizer, so any timing measured that way is unreliable regardless. If you try it, confirm both clients really are connected before trusting a finding, and say in your report that the setup is unproven.

## Install and Diagnostics

```sh
vg playtest install                         # re-provision the browser
vg playtest install --with-deps             # Linux system libraries
vg playtest doctor                          # check the setup
vg playtest doctor --webgpu                 # verify the WebGPU capture pipeline
```

`vg playtest` installs the browser on first use, so `install` is only needed to repair or to add Linux system deps.
