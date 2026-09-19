# Architecture patterns

`PARTY_HOST` is the constant defined in [SKILL.md](../SKILL.md) → Party host.

## Adapter layer (recommended for any game past a prototype)

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

// The one place the host literal lives — everything else imports PARTY_HOST.
export const PARTY_HOST = "https://vibedgames-party.kyh.workers.dev";

export const client = new MultiplayerClient({
  host: PARTY_HOST,
  party: "vg-server",
  room: "my-game-room",
});
```

`net/session.ts` — domain verbs, host-only enforcement lives here, not in scenes:

```ts
import { client } from "./client";

export const session = {
  get isHost() {
    return client.isHost;
  },
  get players() {
    return client.players;
  },
  get world() {
    return client.sharedState as { score: number; phase: string };
  },

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

## Seeding host-side

`initialState` is applied once, by the first host of a still-empty room, and
never re-applied on host migration (`@vibedgames/multiplayer` ≥ 0.2.0). Reach
for host-side seeding instead when the opening world can't be a static literal
— a random map, a `startedAt` timestamp, anything computed at runtime. Guard on
"already seeded?" so a promoted guest, who already holds the live state, never
re-seeds:

```ts
const client = new MultiplayerClient({ host, party, room /* no initialState */ });

const emptyWorld = () => ({ grid: newGrid(), scores: {}, winner: null, startedAt: Date.now() });
const seeded = (s) => Array.isArray(s.grid); // any reliable "is populated" check

client.subscribe(() => {
  // First host seeds. A guest promoted later already holds the live state,
  // so `seeded` is true and the round survives the migration.
  if (client.isHost && client.connectionStatus === "connected" && !seeded(client.sharedState)) {
    client.updateSharedState(emptyWorld());
  }
  render();
});
```

## Offline ≠ solo

"Offline" means no server reachable (the connect fallback below fired) — a
connected player alone in a room is **online, solo**. Bots, start-screen holds,
"waiting for players" copy and any solo-only rule must gate on the human count,
`Object.keys(client.players).length <= 1`, never on an `offline` flag. Gating
on `offline` gives a connected solo host no bots and an offline player a
"waiting for players" screen nobody can join.

## Throttling

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

## Reconnection UX

Surface `client.connectionStatus` somewhere visible. A frozen game with
no overlay reads as a bug:

```ts
client.subscribe(() => {
  const status = client.connectionStatus; // "connecting" | "connected" | "disconnected" | "error"
  showOverlay(status !== "connected");
});
```

**Other players dropping:** a peer whose transport dies keeps their seat for
~30s while the server waits for them to reconnect. During that window
`player.connected === false` — render a "reconnecting…" treatment (dim the
avatar, badge the name), don't remove them; `player_left` firing (the id
vanishing from `client.players`) is the real removal. Treat a missing
`connected` field as connected. Events fired during the window are **not**
buffered or replayed to the dropped player — only their seat and state
survive. A deliberate `client.destroy()` leaves immediately, no grace window.

### Offline fallback that doesn't strand players

A game that plays solo when no server answers needs two guards, or a transient
failure drops a live room into single-player for good:

- **A connect deadline, started on the first `update()` tick** (`bootedAt`),
  not at `create()` — load time counted against the deadline drops a
  slow-booting client to solo before its socket ever connects. The example
  games use 4–8 s (`OFFLINE_FALLBACK_MS`). Pre-connect errors and closes are
  **not** instant failures: the socket retries by itself, so the deadline is
  the only fallback trigger.
- **`everConnected`**: once `connectionStatus` has been `"connected"`, never
  fall back. A later drop is transient — let the socket reconnect (the seat is
  held for `RECONNECT_GRACE_MS`) and show the status overlay instead.

Going offline is `client.destroy()` plus a local stand-in for `client.players`
(a synthesized self entry, so every `id === myId` render path still works).
Refresh to go back online.

### Stale host

The server demotes a host only when its heartbeats stop: they're rAF-driven,
so a **hidden** tab stops pinging and loses host within
`HOST_LIVENESS_TIMEOUT_MS` (6 s). A tab that is throttled but still ticking —
an occluded window, a low-power laptop, a heavy page at 1–4 fps — keeps
heartbeating and stays WS-connected, so the server never migrates: its sim
crawls, guests freeze on the last snapshot, and new players join as guests of a
host that is effectively dead.

Detect it guest-side from the snapshot's own clock. Sample `snap.gameTime`
over ~2 s windows; if the host advanced less than 0.5× real time for 2
consecutive windows, take over: run the sim locally from the last snapshot so
play continues (shared-state writes stay rejected until `hostId` is you). Once
the server promotes you, fold into the normal host path — you're already
simulating; if it promotes someone else, drop back to guest and re-adopt their
snapshots. The cheap variant, when the game has no local sim to fall back to:
surface "HOST CONNECTION LOST — WAITING FOR A NEW HOST" once `snap.seq` stops
advancing for ~4 s, so the freeze reads as a network state, not a crash.

## Pause in an online game

Never freeze a sim whose timers are raw `Date.now()`: sleeping the update loop
stops nothing, every stored fuse/deadline keeps counting against real time, and
on resume they all expire at once. Pause through an offset sim clock instead:

```ts
// simNow() = Date.now() − pausedTotal; holds still while paused, resumes where it stopped.
export const simNow = () => (pausedAt !== 0 ? pausedAt : Date.now()) - pausedTotal;
```

Every sim timestamp (`placedAt`, `nextMoveAt`, round timers, AI cadence) reads
`simNow()`; net heartbeats, connect deadlines and logging stay on real
`Date.now()` — pausing those breaks reconnection. Only the offline sim ever
freezes. Online, pause is **spectator**: the overlay hides input and the local
player parks, but the shared arena keeps running — a host must never stall a
room for everyone because one player opened a menu.

## Latency

Localhost hides it; a 200 ms room shows it. The rule is **interpolate remotes,
predict yourself**. Remote players render from snapshots, blended toward the
newest one — never re-blended toward a stale one, which drags them backwards.
The guest's _own_ body runs the real fixed-step sim on local input the frame a
key goes down, and the host's authoritative copy — which lags local time by
~RTT — is reconciled against a short history of recent predicted positions, not
the current one: comparing against "now" reports a phantom error of velocity ×
latency and drags a running player backwards forever. If the authority sits on
the recent trajectory, nothing is corrected; a small deviation blends out a
fraction per snapshot; a large one (respawn, teleport, a hit's knockback) snaps
— the jerk _is_ the feedback, so hits and respawns are applied on their state
edges rather than smoothed. Make the driver explicit per body:
`bodyDrive = "sim" | "predict" | "puppet"` — `sim` on the host/solo,
`predict` for the guest's own body, `puppet` for everyone else the guest sees —
so exactly one thing advances each body per frame.

## Automated two-client check

Two headless browsers in one room, driven by Playwright. The traps, in the
order they bite:

- **Run suites one at a time.** Two headless Chromes starve each other's rAF —
  the host looks frozen and every timing assertion lies.
- **Heavy games need a real GPU and no throttling:**
  `--use-angle=metal --ignore-gpu-blocklist` (SwiftShader runs at ~4 fps) plus
  `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.
- **Closing a context is a transport drop, not a leave.** No close frame is
  sent, so the seat is parked for `RECONNECT_GRACE_MS` (30 s) and reaped at
  `EVICTION_TIMEOUT_MS` (75 s) — both exported from `@vibedgames/multiplayer`.
  Wait for those, or call `client.destroy()` before closing to leave cleanly.
- **A "blip" is `socket.close(4000)` then `socket.reconnect()`** on the
  underlying PartySocket (expose a dev hook from your `net/` layer — the
  client keeps its socket private). Close code `1000` is a deliberate leave and
  elects a new host immediately.
- **Playwright does not throttle background tabs.** To test host migration,
  silence the host explicitly (kill its heartbeat via the blip hook, or close
  the context and wait out the grace window).
- **Concurrent QA agents join each other's rooms.** Use a unique room id per
  run (`arena-${Date.now()}`).
- **`--virtual-time-budget` fast-forwards `performance.now()`**, so the
  connect-fallback deadline expires before the socket connects and the client
  drops to solo. Don't use it against a game with an offline fallback.

## Schema-shape discipline

`sharedState` is the wire format. Keep it minimal:

- ✅ `{ score: 42, phase: "playing", winnerId: null }`
- ❌ `{ explosionVfx: ParticleEmitter, sprite: PhaserSprite, animFrame: 7 }`

VFX, sprite refs, and per-frame animation indices are render concerns —
derive them locally from state changes, don't sync them.

One server-side rule: keys named `__proto__`, `constructor`, or `prototype`
anywhere in a patch get the **whole patch dropped** (prototype-pollution
guard) — don't key state by raw user strings without prefixing.

## Schema validation (optional)

Pass `schemas` to the `MultiplayerClient` constructor to validate state
against a [Standard Schema](https://standardschema.dev) (zod v3.24+/v4,
valibot, arktype…). Outgoing failures block the send (fail fast on your own bugs);
incoming failures drop the patch (other clients' malformed data).

```ts
import { z } from "zod";

const client = new MultiplayerClient({
  host: PARTY_HOST,
  party: "vg-server",
  room: "arena",
  schemas: {
    sharedState: z.object({ score: z.number(), phase: z.string() }),
    playerState: z.object({ x: z.number(), y: z.number() }),
    onViolation: (v) => console.warn(v.channel, v.direction, v.issues),
  },
});
```

Two rules: schemas describe the **full merged state**, never a partial patch
(validation always runs post-merge — a schema requiring `{x, y}` still passes
when a patch carries only `{x}`), and **empty states bypass** (rooms and
players start `{}` by protocol — model required fields accordingly or seed
via the host). Schemas must be synchronous; async ones warn once and pass.
