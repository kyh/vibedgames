# @vibedgames/multiplayer

Drop-in React hooks for multiplayer browser games. Connect to a [PartyServer](https://partykit.io)-compatible backend and sync state across players with a few lines of code.

## Install

```sh
npm install @vibedgames/multiplayer
```

## Hooks

- `useMultiplayerRoom` — connect to a room, read players and shared state
- `useMultiplayerState` — sync shared game state (e.g. world, score)
- `usePlayerState` — sync per-player state (e.g. position, health)
- `useIsHost` — check if you're the host (first player)

## Quickstart

```tsx
import {
  useMultiplayerRoom,
  usePlayerState,
  useMultiplayerState,
  useIsHost,
} from "@vibedgames/multiplayer";

const room = useMultiplayerRoom({
  host: "https://your-party-server.workers.dev",
  party: "vg-server",
  room: "demo",
});

const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { x: 0, y: 0 });
const isHost = useIsHost(room);
```

## Shared state

Syncs a single object across all players. Host seeds initial values.

```tsx
const room = useMultiplayerRoom({
  host, party, room,
  initialState: { started: false },
});
const [game, setGame] = useMultiplayerState(room);

// Only the host starts the game
if (isHost) setGame({ started: true });
```

## Player state

Per-player data visible to everyone.

```tsx
const [player, setPlayer] = usePlayerState(room, { x: 0, y: 0 });

useEffect(() => {
  const onMove = (e: PointerEvent) => {
    setPlayer({ x: e.clientX, y: e.clientY });
  };
  window.addEventListener("pointermove", onMove);
  return () => window.removeEventListener("pointermove", onMove);
}, [setPlayer]);
```

## Events

Fire-and-forget messages to all players.

```tsx
room.sendEvent("explosion", { x: 100, y: 200 });
```

Handle with `onEvent` in config:

```tsx
const room = useMultiplayerRoom({
  host, party, room,
  onEvent: (event, payload, from) => {
    console.log(`${from} sent ${event}`, payload);
  },
});
```

## Room metadata

```tsx
const isConnected = room.connectionStatus === "connected";
const players = Object.values(room.players);
const myId = room.playerId;
```

## Server

Works with any [PartyServer](https://partykit.io)-compatible backend. The vibedgames party server handles shared state, player state, events, and host assignment generically.

## License

MIT
