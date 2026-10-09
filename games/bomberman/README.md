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

Multiplayer: all players auto-join the shared `bomberman-v4` room (the suffix is bumped with every incompatible wire change, so tabs on an older bundle never share a match); offline it degrades to solo play. A room seats four, one per corner (`MAX_PLAYERS`): the fifth player lands in `bomberman-v4~2`, a match of its own, and so on. A newcomer joins the round in progress, in the corner a bot held.

## Netcode

- **One clock for the room.** Sim time (fuses, blasts, the round id, bot cadence) is the party server's clock (`client.serverClock`) minus any time a solo arena spent paused (`src/util/clock.ts`). Every client reads a stamp as the same instant and a host change moves nothing; the host publishes the pause offset only when it changes.
- **Your body and your bombs never wait on the network.** Each client walks its own body one grid step at a time on its own clock and publishes `{ col, row, t, s }` per step (`t` = when the step began, on the room's server clock; `s` = its length; `s: 0` is a spawn), and `h`, the server clock, 20 times a second while the body is on the board and another player is in the room to draw it (`FixedRate`). The party server drops any of those off the board, the palette or the base stride (`PLAYER_LIMITS`). A bomb shows, sounds and blocks on the press: the host places its own at once; a guest shows a prediction under the id the host will give it (`b-{owner}-{press counter}`), which the host's copy takes over without a second cue, or which drops if the host has not confirmed it in time (600 ms, stretched on a slow route) (`src/net/bomb-prediction.ts`). The host starts a guest's fuse at the press (at most 250 ms back), so both copies burn down together.
- **Other players and bots are drawn through the SDK's `Interpolator`**, never past the newest tile and with corners walked in order. A player (`src/net/step-track.ts`): each step is two samples, the tile it leaves at its start and the tile it reaches at its end, so it is drawn from its start, only as far behind as arrivals scatter. The player's `RemoteClock` learns from step starts and heartbeats how long that player's messages take and how late they run (`hold()`), and draws that far behind, at least 100 ms; the heartbeat keeps a body at rest fed. A bot (`src/net/bot-track.ts`): every host turn, moved or not, is one sample on the tile it took, stamped with the turn (the SDK's grid-mover recipe), drawn a stride plus jitter behind on that bot's own clock, which is relearnt when the host changes. When this client's own connection comes back, every clock relearns its route, players' and bots' alike. The host draws its own bots from its sim (`src/render/bot-stride.ts`). A message that arrives past the delay holds the body on its tile; when it lands, the body moves to where the sender is by then. Every room message is taken in, so steps that land in one frame are both walked. The multiplayer skill's `net-check` judges all of this.
- **Power-ups go to whoever claims them first.** Stepping onto one claims `pickup:<col>,<row>:<round>` from the party server (`src/net/pickup-claims.ts`), which decides in one hop. The claimer takes it at once (sprite, cue, stats) and gives it back if the server names someone else. The host grants every claimed power-up to its claimant; its own body and its bots claim like anyone, so it has no edge. The host clears the claims each round.
- **The host simulates on a fixed 50 ms step of sim time** (`src/sim/fixed-step.ts`); bots stride exactly 200 ms at any refresh rate. The SDK sends a frame's writes as one message, so a frame slow enough to hold two bot turns stops after the first and leaves the rest due for the next: one message never carries a bot two tiles. Intents (`place_bomb`, `request_restart`) go to the host only; the host handles its own locally.
- **Only what changed rides the wire.** The host writes the board as it stands and the sim clock with every change to the world; the SDK sends the leaves that changed, so an opened crate is one cell and an unchanged clock is nothing. `tools/wire-audit.mts` sizes a dozen bot rounds this way: about 1.7 KB/s per guest, no more than the old two-characters-a-crate `opened` string cost.

`pnpm --filter @repo/bomberman test` covers these headlessly (`tools/netcode-smoke.mts`, `tools/tracks-smoke.mts`); `pnpm --filter @repo/bomberman test:online` drives two browsers through a real room.
