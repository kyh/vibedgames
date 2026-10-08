# Battle Arena

3D online PvP action-RPG (Three.js): pick a champion, fight bots or other players in a hexagonal dungeon hall. Deployed at `battle-arena.vibedgames.com`.

## Develop

```bash
pnpm dev:battle-arena                       # http://localhost:5194
pnpm --filter @repo/battle-arena typecheck
pnpm --filter @repo/battle-arena build
pnpm --filter @repo/battle-arena test       # sim harness (tools/verify-timing.mts) + pure-logic tests (tools/verify-logic.mts) + headless host/guest netcode under latency and jitter (tools/verify-netcode.mts)
```

## Routes

| URL           | What                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `/`           | the game (3D champion-select lobby, then match)                                         |
| `/?trailer=1` | scripted gameplay trailer, rolls itself (`&loop=1` replays, click for audio, Esc exits) |
| `/?editor=1`  | map editor (draft saved to localStorage, used by offline matches as the TEST loop)      |
| `/?viewer=1`  | character & animation viewer                                                            |

## Options

| Param              | Effect                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `?auto`            | skip the lobby — instant solo match vs bots                               |
| `?online`          | skip the lobby — instant online match                                     |
| `?room=CODE`       | lobby code for online matches (defaults to the public room)               |
| `?champ=ID`        | champion for quick-start boots (falls back to localStorage, then default) |
| `?name=NAME`       | player name (max 14 chars; falls back to localStorage, then "Player")     |
| `?party=PORT\|URL` | dev-only party-server override (ignored in production builds)             |

Multiplayer is host-authoritative via `@vibedgames/multiplayer` (`src/net/`):

- **Host** (`host-net.ts`) runs the 30 Hz sim on real elapsed time, sends one delta **frame** per tick to the guests (`frames.ts`: only what changed — a few hundred bytes), and the whole world ~1 Hz in `sharedState.snap` for late joiners and host handover. Every frame and snapshot is stamped with the room's server time (`client.serverNow()`), so the stream keeps one clock whoever hosts.
- **Guest** predicts its own hero with the sim's movement code the frame input changes (`own-hero.ts`), sends that tick's input to the host only when it changes, and reconciles against the host's copy using the host's input ack. Everyone else is drawn ~100 ms behind the newest frame's arrival, interpolated between frames on the server clock less the measured host → server → guest trip (`mirror.ts`).
- The host replays each guest's inputs on that guest's own tick spacing behind a small jitter buffer (`input.ts`), so jitter neither drops a tap nor stretches a hold.
- Room ids carry `NETCODE_VERSION` (`protocol.ts`): bump it with any wire-format change, so tabs on an old bundle never share a match with new ones.
