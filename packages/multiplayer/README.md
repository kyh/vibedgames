# @repo/multiplayer

PlayroomKit-inspired utilities for building lightweight multiplayer experiences.

This package exposes a small set of hooks for synchronising shared game state,
per-player state, and host-sensitive flows while keeping the client API as
familiar as the PlayroomKit runtime.

## Quick Start

```tsx
import {
  MultiplayerProvider,
  useIsHost,
  useMultiplayerState,
  usePlayerState,
  usePlayers,
} from "@repo/multiplayer";

const HOST =
  process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://vg-partyserver.kyh.workers.dev";

export function DemoGame() {
  return (
    <MultiplayerProvider host={HOST} party="vg-server" room="demo">
      <Lobby />
      <Canvas />
    </MultiplayerProvider>
  );
}

function Lobby() {
  const players = usePlayers();
  const isHost = useIsHost();
  const [sharedState, setSharedState] = useMultiplayerState<{ round: number; started: boolean }>();

  return (
    <div>
      <p>Players: {players.length}</p>
      <p>Round: {sharedState.round}</p>
      {isHost ? (
        <button onClick={() => setSharedState((prev) => ({ ...prev, started: true }))}>
          Start Game
        </button>
      ) : (
        <p>Waiting for host…</p>
      )}
    </div>
  );
}

function Canvas() {
  const [playerState, setPlayerState] = usePlayerState<{ x: number; y: number }>();

  return (
    <div>
      <button onClick={() => setPlayerState((prev) => ({ ...prev, x: prev.x + 10 }))}>
        Move Right
      </button>
      <pre>{JSON.stringify(playerState, null, 2)}</pre>
    </div>
  );
}
```

## Available Hooks

### `MultiplayerProvider`
Wrap your multiplayer UI with the provider to establish a PartyKit connection.
Accepts the PartyKit `host`, `party`, and `room` identifiers plus optional
`initialSharedState` and `initialPlayerState` values.

### `useMultiplayerState`
Returns a tuple with the synchronised shared state and a setter mirroring the
standard React `useState` API. Updates are broadcast to every player.

### `usePlayerState`
Manages per-player state. Without arguments the hook controls the current
player. Passing an ID returns the corresponding player state as read-only data.
The hook also returns the full `Player` object so you can access metadata and
colours broadcast by the server.

### `useIsHost`
Indicates whether the current client is the authoritative host. The host is the
first connected client, and ownership automatically transfers when the host
leaves the room.

### `usePlayers`
Provides an array of all connected players including metadata and per-player
state.

### `useSelf`
Returns the full `Player` object for the current connection.

### `useConnectionStatus`
Access the underlying socket status (`connecting`, `connected`, `disconnected`,
`error`).

## Server Behaviour

The matching PartyKit server (`apps/party/src/server.ts`) keeps track of:

- Connected players and their metadata
- Per-player state dictionaries
- A single shared state object broadcast to all participants
- Host ownership

Clients communicate via the following messages:

| Type              | Direction | Description                                       |
| ----------------- | --------- | ------------------------------------------------- |
| `set_state`       | Client    | Replace the shared state object                   |
| `set_player_state` | Client   | Replace the sender's player state                 |
| `set_metadata`    | Client    | Merge custom metadata into the sender's profile   |
| `emit`            | Client    | Broadcast custom events to all players            |
| `init`            | Server    | Initial payload with players, shared state & host |
| `player_joined`   | Server    | A new player joined the room                      |
| `player_left`     | Server    | A player disconnected                             |
| `player_updated`  | Server    | Player state or metadata changed                  |
| `shared_state`    | Server    | Shared state updated                              |
| `host_changed`    | Server    | Host ownership transferred                        |
| `custom_event`    | Server    | Custom event emitted by a client                  |

The server intentionally mirrors PlayroomKit's minimal feature set, providing a
solid base for LLM-authored games without introducing additional abstractions.
