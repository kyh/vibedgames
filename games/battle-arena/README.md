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

- **Host** (`host-net.ts`) runs the 30 Hz sim on real elapsed time, sends one delta **frame** per tick to the guests (`frames.ts`: only what changed — a few hundred bytes), and the whole world ~1 Hz in `sharedState.snap` for late joiners. Frames carry every field the sim reads (RNG state and id counter included), so a guest's copy is the host's world. Every frame and snapshot is stamped with the room's server time (`client.serverNow()`), so the stream keeps one clock whoever hosts.
- **Guest** predicts its own hero with the sim's movement code the frame input changes (`own-hero.ts`), sends that tick's input to the host only when it changes, and reconciles against the host's copy using the host's input ack. Everyone else is drawn at least 100 ms behind the newest frame's arrival, further when the route's jitter needs it, interpolated between frames on server time less the fastest recent host → server → guest trip. The SDK's `RemoteClock` reads both off the frames' arrivals (`mirror.ts`).
- The host replays each guest's inputs on that guest's own tick spacing behind a small jitter buffer (`input.ts`), so jitter neither drops a tap nor stretches a hold.
- **Host handover** (`host-state.ts` `takeOver`): when the host leaves, the guest the server elects carries the match on from its own copy as of the newest frame — units, camps, coins, strikes, timers, scores, the RNG — with its own hero where prediction drew it. Only a copy that missed frames (no snapshot has arrived live since it joined) falls back to the room's snapshot, up to a second old. The other guests keep their interpolation samples and prediction, re-learn the trip (the new host's frames come by another route) and re-send their held input to the new host.
- **A dropped connection** reads "Reconnecting…" (and "Host reconnecting…" for the guests of a dropped host, who stand still). Until the room readmits it, a client neither predicts nor sends: the SDK still queues events while reconnecting, and every input and frame here is one. A dropped host's sim pauses with it and carries on from its own world if it is back inside the server's host-liveness window; a guest restarts its mirror and prediction from the room's snapshot.
- **No server**: a client no room admits within 8 s of play ("Connecting…" meanwhile) falls back to the SDK's offline room of one (`fallbackMs`), which it hosts like any room: the match goes on against bots under a SERVER UNREACHABLE toast, and a pause freezes it as it does a solo match. A drop after joining is a reconnect, never this.
- Room ids carry `NETCODE_VERSION` (`protocol.ts`): bump it with any wire-format change, so tabs on an old bundle never share a match with new ones.
