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
import { FixedRate, Interpolator, MultiplayerClient, lerp } from "@vibedgames/multiplayer";

interface Pose {
  x: number;
  y: number;
}
const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});

class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;
  private net = new FixedRate(20);
  private remotes = new Map<string, Interpolator<Pose>>();

  create() {
    this.client = new MultiplayerClient({
      host: PARTY_HOST,
      party: "vg-server",
      room: "phaser-room",
    });
  }

  update(_time: number, delta: number) {
    // Read other players; render each ~100 ms behind its sender's clock.
    for (const [id, player] of Object.entries(this.client.players)) {
      if (id === this.client.playerId) continue;
      const s = player.state as { t?: number; x?: number; y?: number } | undefined;
      if (s?.t === undefined) continue;
      let interp = this.remotes.get(id);
      if (!interp) this.remotes.set(id, (interp = new Interpolator({ lerp: lerpPose })));
      interp.push(s.t, { x: s.x ?? 0, y: s.y ?? 0 });
      const pose = interp.sample();
      // Render player at pose.x, pose.y
    }

    // Send my position on a steady 20 Hz clock, stamped.
    if (this.net.due(delta)) {
      this.client.updateMyState({
        t: Math.round(performance.now()),
        x: this.ship.x,
        y: this.ship.y,
      });
    }
  }

  destroy() {
    this.client.destroy();
  }
}
```

## Three.js example

```ts
import { FixedRate, Interpolator, MultiplayerClient, lerp } from "@vibedgames/multiplayer";

const client = new MultiplayerClient({ host: PARTY_HOST, party: "vg-server", room: "three-room" });

interface Pose {
  x: number;
  z: number;
}
const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  x: lerp(a.x, b.x, k),
  z: lerp(a.z, b.z, k),
});
const remotes = new Map<string, { mesh: THREE.Mesh; interp: Interpolator<Pose> }>();
const net = new FixedRate(20);
const timer = new THREE.Timer();

renderer.setAnimationLoop((time) => {
  timer.update(time);
  // Read directly each frame — never subscribe inside the render loop.
  for (const [id, player] of Object.entries(client.players)) {
    if (id === client.playerId) continue;
    const s = player.state as { t?: number; x?: number; z?: number } | undefined;
    if (s?.t === undefined) continue;
    let remote = remotes.get(id);
    if (!remote) {
      remote = {
        interp: new Interpolator({ lerp: lerpPose }),
        mesh: new THREE.Mesh(avatarGeometry, avatarMaterial),
      };
      scene.add(remote.mesh);
      remotes.set(id, remote);
    }
    remote.interp.push(s.t, { x: s.x ?? 0, z: s.z ?? 0 });
    const pose = remote.interp.sample();
    if (pose) remote.mesh.position.set(pose.x, 0, pose.z);
  }

  // Reap meshes for players who left.
  for (const [id, remote] of remotes) {
    if (!(id in client.players)) {
      scene.remove(remote.mesh);
      remotes.delete(id);
    }
  }

  // Steady 20 Hz position send, stamped for the receivers' interpolation.
  if (net.due(timer.getDelta() * 1000)) {
    client.updateMyState({
      t: Math.round(performance.now()),
      x: avatar.position.x,
      z: avatar.position.z,
    });
  }

  renderer.render(scene, camera);
});
```
