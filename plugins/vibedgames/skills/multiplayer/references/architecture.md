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
export const PARTY_HOST = "https://party.vibedgames.com";

export const client = new MultiplayerClient({
  // No room within 6 s of play: a local room of one (see Offline fallback).
  fallbackMs: 6000,
  host: PARTY_HOST,
  // Offline by intent: never dial.
  offline: new URLSearchParams(location.search).has("offline"),
  onEvent: (event, payload, from) => applyIntent(event, payload, from),
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

  // Host-owned writes go through the host: it applies its own intents at
  // once, and a guest's reach it alone. `applyIntent` (the client's onEvent)
  // validates each one and writes the result.
  setScore(score: number) {
    client.sendToHost("set_score", { score });
  },

  // Player-owned writes pass straight through.
  setPosition(x: number, y: number) {
    client.updateMyState({ x, y });
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

Offline (`connectionStatus === "offline"`) means a local room of one, with no
server: the connect fallback below fired, or the game asked for it. A connected
player alone in a room is **online, solo**. Bots, start-screen holds,
"waiting for players" copy and any solo-only rule must gate on the human count,
`Object.keys(client.players).length <= 1`, never on an `offline` flag. Gating
on `offline` gives a connected solo host no bots and an offline player a
"waiting for players" screen nobody can join.

## Throttling

Don't send state every frame. 20–30 Hz is plenty, on a clock that ignores the
frame rate. `frame % 3` sends 48 times a second on a 144 Hz monitor. The other
usual throttle, `acc += dt; if (acc >= 1 / 20) { acc = 0; send(); }`, throws away
the remainder: at 60 fps it fires every 4th frame (~15 Hz) with uneven gaps, and
receivers see the unevenness as stutter. `FixedRate` keeps the remainder:

```ts
import { FixedRate } from "@vibedgames/multiplayer";

const net = new FixedRate(20);
function update(deltaMs: number) {
  if (net.due(deltaMs)) {
    // stamp every send with server time — receivers interpolate on it (see Latency)
    client.updateMyState({ t: Math.round(client.serverNow()), x, y });
  }
}
```

Keep ticking while the player stands still. Unchanged primitives never ride
the wire, so an idle tick costs only the `t` key, and the receiver gets a final
resting sample. Never put a big array or object in a per-tick patch: the SDK
diffs only primitive keys and re-sends every object or array value whole.

For input intents (`sendEvent`), prefer **send-on-change**: only emit when the
held-button state flips, never every frame. Address them to the host:
`{ to: client.hostId }`. The host handles its own intents locally, without the
server round trip.

## Reconnection UX

Surface `client.connectionStatus` somewhere visible. A frozen game with
no overlay reads as a bug:

```ts
client.subscribe(() => {
  // "connecting" (first dial) | "connected" | "reconnecting" (seat held) | "offline"
  const status = client.connectionStatus;
  showOverlay(status === "connecting" || status === "reconnecting", status);
});
```

**Other players dropping:** a peer whose transport dies keeps their seat for
~30s while the server waits for them to reconnect. During that window
`player.connected === false` — render a "reconnecting…" treatment (dim the
avatar, badge the name), don't remove them; `player_left` firing (the id
vanishing from `client.players`) is the real removal. Treat a missing
`connected` field as connected. Events fired during the window are **not**
buffered or replayed to the dropped player — only their seat and state
survive. A deliberate `client.destroy()` leaves immediately, no grace window,
and so does a tab that closes or reloads (the browser closes its socket with
1001): the token died with the page, so the seat is freed at once.

**Your own drop:** keep the game loop running. While the socket is down the
SDK sends no state patches or inputs; on reconnect it sends this player's
latest state and held input, and a host re-sends whatever of its world the
server holds differently. Events and claims made while away do queue and go
out on reconnect, so never stream per-frame state as events.

### Offline fallback

Pass `fallbackMs` and the SDK plays solo when no server answers. If no room
admits the client within that long, it goes offline: a local room of one with
the same API. It is the host, writes apply locally, events and `sendToHost`
loop back to `onEvent`, claims are granted at once, and `serverNow()` reads
the local clock. Don't write stand-ins for an offline game: the client is one.
The example games use 4–8 s.

- **The deadline counts rendered frames**, from the first one after the client
  is created. Loading time and a hidden tab don't count, so a slow boot isn't
  dropped to solo before its socket ever connects. Still, create the client
  when the game can play, not before a long load.
- **Once admitted, a drop is `"reconnecting"`, never a fallback.** The seat is
  held for `RECONNECT_GRACE_MS` while the socket redials; show the overlay.
- **Offline by intent** (`?offline=1`, a trailer): `offline: true` never dials.
- **"Play solo"**: `client.goOffline()` leaves the room (the seat frees at once)
  and plays on from the room's world. Subscribers see `"offline"`.

A new client is the way back online (a page refresh). Tick rooms don't tick
offline: run the sim locally.

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

Localhost hides latency; a 200 ms room shows it. The rule is **interpolate
remotes, predict yourself**. Make the driver explicit per body, so exactly one
thing advances each body per frame:
`bodyDrive = "sim" | "predict" | "puppet"`.

- `sim` is the host's or solo player's body.
- `predict` is a guest's own body.
- `puppet` is everyone else the guest sees.

**Remotes (puppets): `Interpolator`.** Never chase the newest value. An
exponential lerp toward it surges on every packet and stalls on every gap, and
snapping or tweening per packet is worse. Every sender stamps its updates with
the room's server clock, `t: Math.round(client.serverNow())`. Receivers push
each update and render about 100 ms behind the moment updates arrive, blending
the two updates that bracket it:

```ts
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";

const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  angle: lerpAngle(a.angle, b.angle, k),
});
const remotes = new Map<string, Interpolator<Pose>>();
// each frame, per remote player (duplicate stamps are dropped):
let interp = remotes.get(id);
if (!interp) {
  interp = new Interpolator({ lerp: lerpPose });
  remotes.set(id, interp);
}
interp.push(s.t, { x: s.x, y: s.y, angle: s.angle });
const pose = interp.sample(); // undefined until the first update
```

- **Delay.** 100 ms suits 20–30 Hz senders; use ~150 ms for 10–15 Hz.
- **Discontinuities.** Call `clear()` on a respawn or teleport, so the entity
  snaps instead of gliding through walls.
- **Which clock.** Each `Interpolator` reads stamps through a `RemoteClock`
  (a private one by default), which learns from arrivals how long a sender's
  updates take to reach you, so the delay only covers jitter. Never render on
  `client.serverClock` with a fixed delay: a server-time stamp arrives a whole
  relay (sender → server → you, often 100–200 ms) after it was taken.
- **Host snapshots.** The host stamps each snapshot with `client.serverNow()`
  too; the units in it share one `RemoteClock`
  (`new Interpolator({ clock: hostClock, lerp })`). `relearn()` it when `hostId`
  changes: the new host's route differs, while its stamps carry straight on, so
  the clock eases onto the new route instead of jumping.
- **Grid or step movers.** Stamp each step when it starts, like any other
  update. Never stamp a future arrival time: the clock reads every stamp as send
  time, so a shifted stamp skews every entity from that sender. Set `delayMs` to
  at least one stride plus jitter and `maxExtrapolateMs: 0`. The mover then walks
  each step evenly and never overshoots a tile.

**Own body (predict): `Reconciler`.** The guest runs the real movement code on
local input the frame a key goes down. The host's authoritative copy lags local
time by about one round trip. Comparing it with the body's position _now_
reports a phantom error of speed × latency, which drags a running player
backwards forever. Compare it with where the body was at the matching time
instead:

1. The guest tags each input with a `seq` and remembers when it was sent.
2. The host reports, per guest body, the newest seq it applied and how long it
   has applied it (`ack`, `ackAge`).
3. The guest calls `reconciler.reconcile(x, y, sentAt[ack] + ackAge)`.

Without timing, the host's copy is matched to the nearest point of the recent
path instead. That needs no extra wire data, but it can't see along-track
error until the body stops. Every frame, apply `reconciler.step(...)`'s
correction to the body.

What happens to the remaining error depends on its size:

- **Inside the dead zone:** nothing.
- **Small:** eased out over about 100 ms.
- **Large** (a hit's knockback, a missed collision): applied at once. The jerk
  _is_ the feedback.

Respawns and teleports are not errors: place the body and call `clear()`.

**The two sims must agree.** Anything the host does to the guest's copy that
the guest doesn't predict becomes a correction the player feels as
rubber-banding. Examples are hit-stop freezing every body, a separation push,
a speed debuff, or a stomp bounce. Either run it on the guest too, or deliver
it as a state edge (a `hitSeq` in the row) that the guest applies locally.

## Races: claims

Two players reach the same pellet, pickup or harvest in the same frame. Asking
the host to decide costs the guest a round trip and hands the host every tie.
Claim it instead: the server decides first come, first served, in one hop.

```ts
client.claim(`pellet:${i}`); // eat it now, optimistically
// onClaim option: (key, owner) => { if (owner !== client.playerId) undoEat(key) }
client.clearClaims("pellet:"); // host, on a new level
```

A refused claimer alone hears who holds the key; everyone hears a grant. Claims
outlive their owner (an eaten pellet stays eaten) and arrive in the join sync;
`ttlMs` releases a short hold automatically. The host still applies the effect
(score, respawn timer) when it hears the grant: the claim settles who, not what.

## Lockstep and rollback: tick rooms

A deterministic game (fighting, pong, RTS) can skip the host entirely: pass
`tickRate`, send inputs on change with `sendInput`, and step the sim from
`onTick({ n, inputs })` — every client gets the same inputs on the same ticks.
The server only keeps time and orders inputs. For rollback, simulate ahead on
predicted inputs (each player's held one) and re-simulate from tick `n` when
`onTick` reports a change you didn't predict. `sendInput(input,
client.serverTick() + delay)` schedules a few ticks ahead to hide latency. A
blip replays the missed ticks through `onTick`; a joiner starts from
`tickClock` and `tickInputs()`, or from a world the host published with its
tick, replayed forward with `tickInputs(t)`. The sim must be deterministic:
fixed steps, no `Math.random()` without a shared seed, no frame-time
integration.

## Big worlds: interest

`interest: { radius }` stops the server sending a player the state of anyone
farther away; such players read `visible: false` (hide them, and drop their
`Interpolator`), and come back with their whole state. The host always sees
everyone. Pick the radius past the edge of the screen, so nobody pops in view.

## Bounds: limits

`limits: { hp: { min: 0, max: 100 } }` makes the server drop player-state
patches outside the range. It is a cheap guard against a hacked client writing
nonsense into its own slot, not a substitute for the host validating intents.

Room rules (`tickRate`, `interest`, `limits`, like `maxPlayers`) come from the
first client into an empty room, so every client must pass the same ones.

## Automated two-client check

For lag, start with `scripts/net-check.mjs` (SKILL.md → Local dev loop): it
already runs two clients in a fresh room with lag on the party socket
(Playwright WebSocket routing, frames delayed but never reordered), drives both
from your playtest moves, and judges each by `window.__VG_NET__` — the SDK's
count of `Interpolator` frames drawn past the newest update (starved) or frozen
(stalled). It reports each page's frame rate and calls a page under 20 fps "too
slow" rather than blaming the netcode; run it with a real GPU when you can.
`--set-state <name>` calls a `__GAME_TEST_HOOKS__` state first, for a game whose
menu stands between load and the room (`active-play` usually starts a solo run,
so it isn't the default).

For everything else, write a harness: two headless browsers in one room, driven
by Playwright. The traps, in the order they bite:

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
  client keeps its socket private). Close codes `1000` (`destroy()`) and `1001`
  (a page unloading) are leaves and elect a new host immediately.
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
