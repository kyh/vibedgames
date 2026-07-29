# @vibedgames/multiplayer

Multiplayer for browser games: a framework-agnostic client plus React hooks.
Connect to a [PartyServer](https://partykit.io)-compatible backend and sync
state across players in a few lines.

## Install

```sh
npm install @vibedgames/multiplayer
```

Two entry points — pick one:

| Import                          | For                                              |
| ------------------------------- | ------------------------------------------------ |
| `@vibedgames/multiplayer`       | `MultiplayerClient` — Phaser, Three.js, any loop |
| `@vibedgames/multiplayer/react` | `useMultiplayerRoom` and friends                 |

## React quickstart

```tsx
import {
  useMultiplayerRoom,
  useMultiplayerState,
  usePlayerState,
  useIsHost,
} from "@vibedgames/multiplayer/react";

const room = useMultiplayerRoom({
  host: "https://your-party-server.workers.dev",
  party: "vg-server",
  room: "demo",
});

const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { x: 0, y: 0 });
const isHost = useIsHost(room);
```

- `useMultiplayerRoom` — connect to a room, read players and shared state
- `useMultiplayerState` — sync shared game state (e.g. world, score)
- `usePlayerState` — sync per-player state (e.g. position, health)
- `useIsHost` — is this client the host

## Game-loop quickstart (no React)

The same client the hooks are built on. Read the snapshot each frame; nothing
re-renders.

```ts
import { MultiplayerClient } from "@vibedgames/multiplayer";

const client = new MultiplayerClient({
  host: "https://your-party-server.workers.dev",
  party: "vg-server",
  room: "demo",
  onEvent: (event, payload, from) => queue.push({ event, payload, from }),
});

// each frame:
if (client.isHost) client.updateSharedState({ tick });
client.updateMyState({ x: player.x, y: player.y });
for (const p of Object.values(client.players)) draw(p);

client.destroy(); // on teardown
```

`subscribe(listener)` + `getSnapshot()` are there if you'd rather push than
poll. Only `/react` imports React, so a vanilla game pulls in no framework.

## Model: host-authoritative, last-write-wins

The first player is the host and is the only writer of shared state. Intents go
up (`sendEvent`), state comes down (`state_patch`). There is no conflict
resolution and no server-side simulation — so keep authority in one place:
guests send input, the host mutates the world.

If the host leaves (or its tab is backgrounded long enough to stop
heartbeating), the server elects a new one. Design for that: state must live in
`sharedState`, not in the current host's local variables.

## Shared state

One object synced to everyone. Patches shallow-merge by key.

```tsx
const room = useMultiplayerRoom({ host, party, room, initialState: { started: false } });
const [game, setGame] = useMultiplayerState(room);

if (isHost) setGame({ started: true });
```

`initialState` is applied once, by the first host of a still-empty room, and is
never re-applied on host migration — so a host leaving mid-game cannot reset the
round.

## Player state

Per-player data visible to everyone.

```tsx
const [player, setPlayer] = usePlayerState(room, { x: 0, y: 0 });

useEffect(() => {
  const onMove = (e: PointerEvent) => setPlayer({ x: e.clientX, y: e.clientY });
  window.addEventListener("pointermove", onMove);
  return () => window.removeEventListener("pointermove", onMove);
}, [setPlayer]);
```

## Events

Fire-and-forget messages. Handled by the `onEvent` callback in the room config.

```ts
room.sendEvent("explosion", { x: 100, y: 200 });

room.sendEvent("hit", dmg, { to: victimId }); // one player
room.sendEvent("spawn", data, { except: room.playerId }); // everyone else
room.sendEvent("cursor", pos, { coalesce: true }); // latest-wins, flushed per microtask
```

`to`/`except` are enforced by the server; `coalesce` is client-side and collapses
rapid same-type events into one wire message without reordering them against
state patches. Events are not buffered — a player who is away misses them, so
anything that must survive a reconnect belongs in state.

## Room metadata

```tsx
const isConnected = room.connectionStatus === "connected";
const players = Object.values(room.players);
const myId = room.playerId;
const actualRoom = room.room; // may be an overflow sibling — see below
```

Each `Player` carries `id`, an auto-assigned `color`/`hue`, its state, and
`connected` — `false` while a dropped player's seat is being held. Render that
as "reconnecting…", not as a leave.

## Capacity and overflow

```ts
useMultiplayerRoom({ host, party, room, maxPlayers: 8 });
```

At capacity the client is transparently reconnected into a sibling room
(`{room}~2`, `{room}~3`, …) — an independent world with its own host and shared
state. Read `room.room` to show players which instance they landed in. Omit
`maxPlayers` for no cap (the server still clamps to a hard ceiling).

## Reconnection

A dropped connection holds the player's seat, identity and state for 30s
(`RECONNECT_GRACE_MS`) against a client-secret token, so a network blip is a
pause rather than a leave + rejoin. A deliberate `destroy()` skips the grace
window and leaves immediately.

## Validation (core client)

`MultiplayerClient` accepts optional [Standard
Schema](https://standardschema.dev) validators — Zod, Valibot, ArkType — applied
to the full merged state, so invalid patches are dropped before they reach the
wire:

```ts
new MultiplayerClient({
  host,
  party,
  room,
  schemas: {
    sharedState: z.object({ tick: z.number() }),
    onViolation: (v) => console.warn(v.issues),
  },
});
```

The server enforces game-agnostic structural limits regardless
(`MAX_MESSAGE_BYTES`, `MAX_STATE_DEPTH`, no cycles or functions).

## Server

Works with any PartyServer-compatible backend. The vibedgames party server
([`apps/party`](https://github.com/kyh/vibedgames/tree/main/apps/party)) handles
shared state, player state, events, capacity, reconnection and host election
generically — it never knows a game's shape.

## License

MIT
