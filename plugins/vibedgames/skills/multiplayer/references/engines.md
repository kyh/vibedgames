# Vanilla JS / Phaser / Three.js usage

`PARTY_HOST` is the constant defined in [SKILL.md](../SKILL.md) → Party host.

```ts
import { MultiplayerClient } from "@vibedgames/multiplayer";

const client = new MultiplayerClient({
  host: PARTY_HOST,
  party: "vg-server",
  room: "my-game-room",
  initialState: { phase: "playing" },
  onEvent: (event, payload, from) => {
    /* handle */
  },
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

## Read vs subscribe — pick by loop ownership

- **Game-loop renderers** (Phaser `update()`, Three.js rAF): **read** `client.players` / `client.sharedState` directly each tick. The loop already runs every frame; a subscription adds nothing but re-render churn.
- **React / event-driven UI**: **subscribe** — `useMultiplayerState` / `usePlayerState` / `useIsHost` — and let state changes drive re-renders. Don't poll the client from effects or timers.
- `client.subscribe()` inside a game-loop game is for **edges only**: connection-status overlays, join/leave sounds — things that should fire once per change, not once per frame.

## Phaser example

```ts
class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;

  create() {
    this.client = new MultiplayerClient({
      host: PARTY_HOST,
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

## Three.js example

```ts
const client = new MultiplayerClient({ host: PARTY_HOST, party: "vg-server", room: "three-room" });

const remoteMeshes = new Map<string, THREE.Mesh>();
let tick = 0;

renderer.setAnimationLoop(() => {
  // Read directly each frame — never subscribe inside the render loop.
  for (const [id, player] of Object.entries(client.players)) {
    if (id === client.playerId) continue;
    let mesh = remoteMeshes.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(avatarGeometry, avatarMaterial);
      scene.add(mesh);
      remoteMeshes.set(id, mesh);
    }
    const s = player.state as { x?: number; z?: number };
    mesh.position.set(s.x ?? 0, 0, s.z ?? 0);
  }

  // Reap meshes for players who left.
  for (const [id, mesh] of remoteMeshes) {
    if (!(id in client.players)) {
      scene.remove(mesh);
      remoteMeshes.delete(id);
    }
  }

  // Throttled position send (~20Hz at 60fps).
  if (++tick % 3 === 0) {
    client.updateMyState({ x: avatar.position.x, z: avatar.position.z });
  }

  renderer.render(scene, camera);
});
```
