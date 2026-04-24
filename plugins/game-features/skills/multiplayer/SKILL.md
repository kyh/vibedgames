---
name: multiplayer
description: "Add multiplayer to browser games using @vibedgames/multiplayer. Use when the user wants to add multiplayer, real-time sync, shared state, player state, or co-op/PvP to a web game. Triggers on: 'make it multiplayer', 'add multiplayer', 'sync between players', 'real-time', 'co-op', 'PvP'."
---

# Vibedgames Multiplayer

Add real-time multiplayer to any browser game with `@vibedgames/multiplayer`.

## Install

```sh
npm install @vibedgames/multiplayer
```

## Two entry points

- `@vibedgames/multiplayer` — framework-agnostic `MultiplayerClient` class (Phaser, Three.js, vanilla JS)
- `@vibedgames/multiplayer/react` — React hooks wrapping the client

## Core concepts

Three types of state:

1. **Shared state** — one copy, all players see the same (game world, score, phase)
2. **Player state** — per-player, visible to everyone (position, health)
3. **Events** — fire-and-forget messages (explosions, kills)

The **host** (first player) typically runs authoritative game logic.

---

## React usage

```tsx
import { useMultiplayerRoom, useMultiplayerState, usePlayerState, useIsHost } from "@vibedgames/multiplayer/react";

const room = useMultiplayerRoom({
  host: "https://vibedgames-party.kyh.workers.dev",
  party: "vg-server",
  room: "my-game-room",
});

const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { x: 0, y: 0 });
const isHost = useIsHost(room);
```

### Shared state

```tsx
if (isHost) setWorld({ score: world.score + 10 });
```

### Player state

```tsx
const onPointerMove = (e: PointerEvent) => {
  setMe({ x: e.clientX, y: e.clientY });
};
```

### Events

```tsx
room.sendEvent("explosion", { x: 100, y: 200 });

// Receive via onEvent config:
const room = useMultiplayerRoom({
  host, party, room,
  onEvent: (event, payload, from) => { /* handle */ },
});
```

---

## Vanilla JS / Phaser / Three.js usage

```ts
import { MultiplayerClient } from "@vibedgames/multiplayer";

const client = new MultiplayerClient({
  host: "https://vibedgames-party.kyh.workers.dev",
  party: "vg-server",
  room: "my-game-room",
  initialState: { phase: "playing" },
  onEvent: (event, payload, from) => { /* handle */ },
});

// Subscribe to state changes
client.subscribe(() => {
  const { players, sharedState, playerId, hostId } = client.getSnapshot();
  // Re-render your game
});

// Update shared state (host only)
if (client.isHost) {
  client.updateSharedState({ score: 100 });
}

// Update your player state
client.updateMyState({ x: player.x, y: player.y });

// Send events
client.sendEvent("shoot", { angle: 45 });

// Read state directly (no subscription needed in game loops)
const { players, sharedState } = client;

// Clean up
client.destroy();
```

### Phaser example

```ts
class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;

  create() {
    this.client = new MultiplayerClient({
      host: "https://vibedgames-party.kyh.workers.dev",
      party: "vg-server",
      room: "phaser-room",
    });
  }

  update() {
    // Read other players
    for (const [id, player] of Object.entries(this.client.players)) {
      if (id === this.client.playerId) continue;
      // Render player at player.state.x, player.state.y
    }

    // Send my position
    this.client.updateMyState({ x: this.ship.x, y: this.ship.y });
  }

  destroy() {
    this.client.destroy();
  }
}
```

## Architecture patterns

### Host-authoritative (recommended)

Host runs simulation, broadcasts via `updateSharedState`. Others render and send input.

### Throttling

Don't send state every frame. ~20Hz is plenty:

```ts
let frame = 0;
function update() {
  frame++;
  if (frame % 3 === 0) {
    client.updateMyState({ x, y });
  }
}
```

## Deploy

```sh
vg deploy ./dist --slug my-game
```

If `vg` isn't on PATH, substitute `npx vibedgames deploy` — works identically.

Live at `https://my-game.vibedgames.com` — party server is shared infrastructure.
