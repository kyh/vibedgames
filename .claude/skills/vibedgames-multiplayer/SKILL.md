---
name: vibedgames-multiplayer
description: "Add multiplayer to browser games using @vibedgames/multiplayer. Use when the user wants to add multiplayer, real-time sync, shared state, player state, or co-op/PvP to a web game. Triggers on: 'make it multiplayer', 'add multiplayer', 'sync between players', 'real-time', 'co-op', 'PvP'."
---

# Vibedgames Multiplayer

Add real-time multiplayer to any React browser game with `@vibedgames/multiplayer`.

## Install

```sh
npm install @vibedgames/multiplayer
```

## Core concepts

There are three types of state:

1. **Shared state** — one copy, all players see the same thing (game world, score, phase)
2. **Player state** — per-player, visible to everyone (position, health, name)
3. **Events** — fire-and-forget messages (explosions, chat, kills)

The **host** (first player to join) typically runs authoritative game logic. Use `useIsHost()` to check.

## Setup

Connect to the vibedgames party server:

```tsx
import { useMultiplayerRoom } from "@vibedgames/multiplayer";

const room = useMultiplayerRoom({
  host: "https://vibedgames-party.kyh.workers.dev",
  party: "vg-server",
  room: "my-game-room",
});
```

## Shared state (world/game state)

Use for anything all players should agree on: asteroid positions, game phase, timer, collectibles.

```tsx
import { useMultiplayerState, useIsHost } from "@vibedgames/multiplayer";

const [gameState, setGameState] = useMultiplayerState(room, {
  phase: "playing",
  score: 0,
});

// Only the host should mutate shared state
const isHost = useIsHost(room);
if (isHost) {
  setGameState({ score: gameState.score + 10 });
}
```

## Player state (per-player)

Use for position, angle, health, inventory — anything unique to each player.

```tsx
import { usePlayerState } from "@vibedgames/multiplayer";

const [myState, setMyState] = usePlayerState(room, {
  x: 0, y: 0, alive: true,
});

// Update on input
const onPointerMove = (e: PointerEvent) => {
  setMyState({ x: e.clientX, y: e.clientY });
};

// Read other players
Object.entries(room.players).forEach(([id, player]) => {
  const state = player.state; // their x, y, alive, etc.
  const color = player.color; // auto-assigned by server
});
```

## Events (one-shot messages)

Use for things that happen once: explosions, kills, chat messages, sound effects.

```tsx
// Send
room.sendEvent("explosion", { x: 100, y: 200, radius: 50 });

// Receive — use onEvent in room config
const room = useMultiplayerRoom({
  host: "https://vibedgames-party.kyh.workers.dev",
  party: "vg-server",
  room: "my-game-room",
  onEvent: (event, payload, fromPlayerId) => {
    if (event === "explosion") {
      // show explosion at payload.x, payload.y
    }
  },
});
```

## Room metadata

```tsx
room.connectionStatus  // "connecting" | "connected" | "disconnected" | "error"
room.playerId          // your unique ID
room.hostId            // the host's ID
room.players           // Record<string, Player> — all players with their state and color
```

## Architecture patterns

### Host-authoritative (recommended for game objects)

The host runs simulation (physics, spawning, AI), broadcasts via `setGameState`. Other players render from shared state and send input via player state or events.

```
Host: spawn enemies → move them → broadcast positions
All:  read enemy positions → render → detect local collisions → sendEvent("hit")
Host: receive hit events → validate → update shared state
```

### Per-player ownership

Each player controls their own state. Everyone renders all players. Good for: positions, cursors, drawing apps.

### Throttling

Don't call `setMyState` every frame at 60fps. Throttle to ~20Hz:

```tsx
const frameCount = useRef(0);
// In game loop:
frameCount.current++;
if (frameCount.current % 3 === 0) {
  setMyState({ x, y, angle });
}
```

## Multiplayer game loop pattern

For 60fps games, use refs instead of React state to avoid re-renders:

```tsx
const shipRef = useRef(null);
const mouseRef = useRef({ x: 0, y: 0 });

useEffect(() => {
  const interval = setInterval(() => {
    // Update game state from refs (no React re-renders)
    // Throttle network sends to every 3rd frame
  }, 1000 / 60);
  return () => clearInterval(interval);
}, []);
```

## Host migration

When the host disconnects, the server automatically assigns a new host. The new host detects this via `useIsHost()` becoming `true` and picks up simulation from the last synced shared state.

## Deploy

After adding multiplayer, deploy with:

```sh
npx vibedgames deploy ./dist --slug my-game
```

Your game will be live at `https://my-game.vibedgames.com` with multiplayer working out of the box — the party server is shared infrastructure.
