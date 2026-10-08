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

Multiplayer: all players auto-join the shared `bomberman-v3` room (the suffix is bumped with every incompatible wire change, so tabs on an older bundle never share a match); offline it degrades to solo play.

## Netcode

- **One clock for the room.** Sim time (fuses, blasts, the round id, bot cadence) is the party server's clock (`client.serverClock`) minus any time a solo arena spent paused (`src/util/clock.ts`). Every client reads a stamp as the same instant and a host change moves nothing; the host publishes the pause offset only when it changes.
- **Your body and your bombs never wait on the network.** Each client walks its own body one grid step at a time on its own clock and publishes `{ col, row, t, s }` per step (`t` = when the step began, on the room's server clock; `s` = its length; `s: 0` is a spawn). A bomb shows, sounds and blocks on the press: the host places its own at once; a guest shows a prediction under the id the host will give it (`b-{owner}-{press counter}`), which the host's copy takes over without a second cue, or which drops if the host has not confirmed it in time (600 ms, stretched on a slow route) (`src/net/bomb-prediction.ts`). The host starts a guest's fuse at the press (at most 250 ms back), so both copies burn down together.
- **Other players and bots are drawn from their own step timing**, a round trip plus 100 ms behind the room clock (`src/net/step-track.ts`): a relayed step takes the sender's hop up and ours down. Exact cadence, corners walked in order, never past the newest tile; a late step is walked from where the body waited and caught up. Every room message is taken in, so steps that land in one frame are both walked.
- **Power-ups go to whoever claims them first.** Stepping onto one claims `pickup:<col>,<row>:<round>` from the party server (`src/net/pickup-claims.ts`), which decides in one hop. The claimer takes it at once (sprite, cue, stats) and gives it back if the server names someone else. The host grants every claimed power-up to its claimant; its own body and its bots claim like anyone, so it has no edge. The host clears the claims each round.
- **The host simulates on a fixed 50 ms step of sim time** (`src/sim/fixed-step.ts`) and sends one merged patch per frame; bots stride exactly 200 ms at any refresh rate. Intents (`place_bomb`, `request_restart`) go to the host only; the host handles its own locally.
- **The grid rides the wire once per round.** After that, opened crates travel as a compact `opened` string, two characters each (`src/net/grid-wire.ts`), instead of re-sending the 4.8 KB grid.

`pnpm --filter @repo/bomberman test` covers these headlessly (`tools/netcode-smoke.mts`); `pnpm --filter @repo/bomberman test:online` drives two browsers through a real room.
