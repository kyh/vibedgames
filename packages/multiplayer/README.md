# @repo/multiplayer

PlayroomKit-inspired multiplayer primitives for React. The API is intentionally small:

- `useMultiplayerRoom` to open a connection and read shared room data
- `useMultiplayerState` for shared game/session state
- `usePlayerState` for per-player state
- `useIsHost` to determine who should own shared responsibilities

The hooks wrap the PartyKit-compatible server in `apps/party` and are meant to keep multiplayer logic predictable and easy to port between prototypes.

## Quickstart

```tsx
import { useMultiplayerRoom, usePlayerState, useMultiplayerState, useIsHost } from "@repo/multiplayer";

const room = useMultiplayerRoom({ host: "https://server.workers.dev", party: "vg-server", room: "demo" });
const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { position: { x: 0, y: 0 } });
const isHost = useIsHost(room);
```

### Shared state

`useMultiplayerState` synchronizes a single shared object across every participant. The host can seed initial values.

```tsx
const room = useMultiplayerRoom({ host, party, room, initialState: { started: false } });
const [game, setGame] = useMultiplayerState(room);

const start = () => {
  if (!isHost) return;
  setGame({ started: true, startedAt: Date.now() });
};
```

### Player state

`usePlayerState` keeps player-specific data (such as positions or selections) in sync.

```tsx
const [player, setPlayer] = usePlayerState(room, { position: { x: 0, y: 0 } });

useEffect(() => {
  const handlePointerMove = (event: PointerEvent) => {
    setPlayer({ position: { x: event.clientX, y: event.clientY } });
  };

  window.addEventListener("pointermove", handlePointerMove);
  return () => window.removeEventListener("pointermove", handlePointerMove);
}, [setPlayer]);
```

### Room metadata

`useMultiplayerRoom` exposes the current players, your `playerId`, and connection status:

```tsx
const room = useMultiplayerRoom({ host, party, room });
const isConnected = room.connectionStatus === "connected";
const players = Object.values(room.players);
```

## Server notes

The Party server now only handles three concepts:

- Shared state patches
- Player state patches
- Generic events

Hosting responsibilities (like seeding initial state) can be decided client-side with `useIsHost`.

## Examples

- `apps/astroid` demonstrates cursor/ship syncing using `usePlayerState` for positions and `useMultiplayerState` for any shared session data.
