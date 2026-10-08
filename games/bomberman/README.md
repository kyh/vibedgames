# Bomberman

Top-down Phaser 4 bomberman arena with online multiplayer via `@vibedgames/multiplayer` (shared room, solo fallback when the party server is unreachable). Deployed at `bomberman.vibedgames.com`.

## Develop

```bash
pnpm dev:bomberman   # http://localhost:5180
pnpm --filter @repo/bomberman build      # vite build
pnpm --filter @repo/bomberman typecheck  # tsc --noEmit
pnpm --filter @repo/bomberman preview    # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

| Input                                       | Action      |
| ------------------------------------------- | ----------- |
| WASD / arrows (pad stick/d-pad, touch drag) | move        |
| Space (pad A, touch 💣)                     | drop a bomb |
| R (pad Start, touch tap)                    | restart     |
| M (touch 🔊)                                | mute        |

Sound starts muted (procedural WebAudio, no asset files); the preference persists in localStorage.

Multiplayer: all players auto-join the shared `bomberman-v2` room (the suffix is bumped with every incompatible wire change, so tabs on an older bundle never share a match); offline it degrades to solo play.

## Netcode

- **Your body and your bombs never wait on the network.** Each client walks its own body one grid step at a time on its own clock and publishes `{ col, row, t, s }` per step (`t` = when the step began on its `performance.now()`, `s` = its length; `s: 0` is a spawn). A bomb shows, sounds and blocks on the press: the host places its own at once; a guest shows a prediction under the id the host will give it (`b-{owner}-{press counter}`), which the host's copy takes over without a second cue, or which drops if the host has not confirmed it in time (600 ms, stretched on a slow route) (`src/net/bomb-prediction.ts`).
- **Other players and bots are drawn from their own step timing**, 100 ms behind the sender's clock (`src/net/step-track.ts`, on the package's `RemoteClock`): exact cadence, corners walked in order, never past the newest tile; a late step is walked from where the body waited and caught up. Every room message is taken in, so steps that land in one frame are both walked.
- **The host simulates on a fixed 50 ms step of sim time** (`src/sim/fixed-step.ts`) and sends one merged patch per frame; bots stride exactly 200 ms at any refresh rate. Intents (`place_bomb`, `request_restart`) go to the host only; the host handles its own locally.
- **The grid rides the wire once per round.** After that, opened crates travel as a compact `opened` string, two characters each (`src/net/grid-wire.ts`), instead of re-sending the 4.8 KB grid.

`pnpm --filter @repo/bomberman test` covers these headlessly (`tools/netcode-smoke.mts`); `pnpm --filter @repo/bomberman test:online` drives two browsers through a real room.
