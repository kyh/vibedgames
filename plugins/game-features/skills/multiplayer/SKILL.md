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

1. **Shared state** — one copy, all players see the same (game world, score, phase). **Host-only writes.**
2. **Player state** — per-player, owned by that player (position, health, intent flags).
3. **Events** — fire-and-forget messages, broadcast to everyone (explosions, kills, pings).

The **host** (first player) runs authoritative game logic. If the host leaves, the next-joined player is reassigned as host.

## Host-only writes (important)

`updateSharedState` is rejected on the server unless the sender is the
host. A non-host call is silently swallowed and the server echoes the
authoritative `sharedState` back so the optimistic local mirror gets
corrected. **Always gate writes behind `client.isHost` / `useIsHost(room)`.**

```ts
// Wrong — non-host's mutation gets reverted, the UI flickers.
client.updateSharedState({ score: client.sharedState.score + 10 });

// Right — gate the mutation; non-hosts request the change instead.
if (client.isHost) {
  client.updateSharedState({ score: client.sharedState.score + 10 });
} else {
  client.sendEvent("score_request", { delta: 10 });
}
```

The pattern: **intents go up via `sendEvent`, state comes down via `sharedState` patches**. Host listens for intent events, validates, and writes the result.

`updateMyState` is *not* host-gated — players always own their own slot.

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

### Adapter layer (recommended for any game past a prototype)

Don't put `MultiplayerClient` directly inside a Phaser scene or Three.js
component. Wrap it in a thin renderer-agnostic adapter so single-player
logic stays untouched and the network surface is one file.

```
src/
  game/         # rendering, input, single-player simulation
  net/
    client.ts   # constructs MultiplayerClient; one place to swap host/room
    session.ts  # game-shaped API: setScore, requestSpawn, onPlayerHit
    registry.ts # local entity ↔ remote player id mapping
```

`net/client.ts` — connection only:

```ts
import { MultiplayerClient } from "@vibedgames/multiplayer";

export const client = new MultiplayerClient({
  host: "https://vibedgames-party.kyh.workers.dev",
  party: "vg-server",
  room: "my-game-room",
});
```

`net/session.ts` — domain verbs, host-only enforcement lives here, not in scenes:

```ts
import { client } from "./client";

export const session = {
  get isHost() { return client.isHost; },
  get players() { return client.players; },
  get world() { return client.sharedState as { score: number; phase: string }; },

  // Host-only writes wrapped — non-host calls become intent events.
  setScore(score: number) {
    if (client.isHost) client.updateSharedState({ score });
    else client.sendEvent("set_score", { score });
  },

  // Player-owned writes pass straight through.
  setPosition(x: number, y: number) {
    client.updateMyState({ x, y });
  },

  onIntent(handler: (event: string, payload: unknown, from: string) => void) {
    return client.subscribe(() => {}); // wire onEvent in the client config
  },
};
```

`net/registry.ts` — bidirectional mapping if your renderer uses local
sprite ids that aren't `player.id`. Lets game code work in renderer-native
ids while the network sees `player.id`.

Why this matters:
- **Single-player keeps working.** Stripping multiplayer = deleting `net/`.
- **One place to fix bugs.** Throttling, reconnection UI, intent validation — all in `session.ts`.
- **Renderer doesn't change.** The Phaser scene calls `session.setScore(10)`, not `client.updateSharedState({...})`.

### Host-authoritative

Host runs simulation, broadcasts via `updateSharedState` (gated by
`client.isHost`). Non-hosts render the broadcast state and send intents
via `sendEvent`. The host is the only one allowed to mutate
`sharedState`; the server enforces this.

### Throttling

Don't send state every frame. ~20Hz is plenty:

```ts
let frame = 0;
function update() {
  frame++;
  if (frame % 3 === 0) {
    session.setPosition(x, y);
  }
}
```

For input intents (`sendEvent`), prefer **send-on-change**: only emit when
the held-button state flips, not every frame.

### Reconnection UX

Surface `client.connectionStatus` somewhere visible. A frozen game with
no overlay reads as a bug:

```ts
client.subscribe(() => {
  const status = client.connectionStatus; // "connecting" | "connected" | "disconnected" | "error"
  showOverlay(status !== "connected");
});
```

### Schema-shape discipline

`sharedState` is the wire format. Keep it minimal:

- ✅ `{ score: 42, phase: "playing", winnerId: null }`
- ❌ `{ explosionVfx: ParticleEmitter, sprite: PhaserSprite, animFrame: 7 }`

VFX, sprite refs, and per-frame animation indices are render concerns —
derive them locally from state changes, don't sync them.

## Anti-patterns

❌ **Mutating the local mirror directly.**
`client.sharedState.score = 100` is silently overwritten on the next patch.

❌ **Sending positions as events.**
Position belongs in `updateMyState`. Events are for things that *happened*.

❌ **Hardcoding the party host URL throughout the codebase.**
Put it in `net/client.ts` once.

❌ **Welding multiplayer into Phaser scene `update()`.**
Use the adapter pattern. Single-player should still work after `rm -rf net/`.

❌ **Calling `updateSharedState` outside an `if (isHost)` gate.**
Server rejects, your local optimistic mutation flickers.

❌ **No connection-state UI.**
A disconnected game looks identical to a frozen one. Render the status.

## Deploy

```sh
vg deploy ./dist --slug my-game
```

If `vg` isn't on PATH, substitute `npx vibedgames deploy` — works identically.

Live at `https://my-game.vibedgames.com` — party server is shared infrastructure.
