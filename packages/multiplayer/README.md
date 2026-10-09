# @vibedgames/multiplayer

Multiplayer for browser games: a framework-agnostic client plus React hooks.
Connect to a [PartyServer](https://partykit.io)-compatible backend and sync
state across players in a few lines.

## Install

```sh
npm install @vibedgames/multiplayer
```

Two entry points — pick one:

| Import                          | For                                              |
| ------------------------------- | ------------------------------------------------ |
| `@vibedgames/multiplayer`       | `MultiplayerClient` — Phaser, Three.js, any loop |
| `@vibedgames/multiplayer/react` | `useMultiplayerRoom` and friends                 |

## React quickstart

```tsx
import {
  useMultiplayerRoom,
  useMultiplayerState,
  usePlayerState,
  useIsHost,
} from "@vibedgames/multiplayer/react";

const room = useMultiplayerRoom({
  host: "https://your-party-server.workers.dev",
  party: "vg-server",
  room: "demo",
});

const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { x: 0, y: 0 });
const isHost = useIsHost(room);
```

- `useMultiplayerRoom` — connect to a room, read players and shared state
- `useMultiplayerState` — sync shared game state (e.g. world, score)
- `usePlayerState` — sync per-player state (e.g. position, health)
- `useIsHost` — is this client the host

## Game-loop quickstart (no React)

The same client the hooks are built on. Read the snapshot each frame; nothing
re-renders.

```ts
import { MultiplayerClient } from "@vibedgames/multiplayer";

const client = new MultiplayerClient({
  host: "https://your-party-server.workers.dev",
  party: "vg-server",
  room: "demo",
  onEvent: (event, payload, from) => queue.push({ event, payload, from }),
});

// each frame:
if (client.isHost) client.updateSharedState({ tick });
client.updateMyState({ x: player.x, y: player.y });
for (const p of Object.values(client.players)) draw(p);

client.destroy(); // on teardown
```

`subscribe(listener)` + `getSnapshot()` are there if you'd rather push than
poll. Only `/react` imports React, so a vanilla game pulls in no framework.

## Netcode helpers

Three small, framework-agnostic pieces for the parts every real-time game gets
wrong. All exported from `@vibedgames/multiplayer`.

**`FixedRate`** — a steady send clock driven by a variable frame loop. It keeps
the remainder instead of resetting to 0, so a 20 Hz clock fires 20 times a
second at any refresh rate instead of drifting to ~15 Hz with uneven gaps.

```ts
const net = new FixedRate(20);
// each frame:
if (net.due(deltaMs)) client.updateMyState({ t: Math.round(performance.now()), x, y });
```

**`Interpolator`** — snapshot interpolation for remote entities. Senders stamp
every update with the room's server clock (`client.serverNow()`, see [Server
time](#server-time)); receivers render each entity ~100 ms behind the moment its
updates arrive, blending the two updates around it. Motion is as smooth as the
sender's, however unevenly the packets arrive. Keep sending while idle — an
unchanged position costs only the `t` key, since unchanged primitives never ride
the wire.

```ts
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";

const remote = new Interpolator<{ x: number; y: number; a: number }>({
  lerp: (p, q, k) => ({ x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), a: lerpAngle(p.a, q.a, k) }),
});
// sender, at its send rate:
client.updateMyState({ t: Math.round(client.serverNow()), x, y, a });
// receiver, each frame (duplicate stamps are ignored):
const s = player.state;
remote.push(s.t, { x: s.x, y: s.y, a: s.a });
const pose = remote.sample();
// on a teleport or respawn: remote.clear()
```

An `Interpolator` reads stamps through a `RemoteClock`, which learns from
arrivals how long one sender's updates take to reach you — sender to server to
you — so the delay only has to cover jitter. Entities from one sender (a host's
world snapshot) share one: `new Interpolator({ clock: hostClock, lerp })`, and
`hostClock.relearn()` when the host changes: the new host's route differs, while
its stamps carry straight on, so the clock eases onto the new route instead of
jumping.
Stamps in server time stay continuous across reloads and host changes and mean
the same instant to every client.

Don't render on `client.serverClock` directly: a stamp reaches you a whole relay
(sender → server → you, often 100–200 ms) after it was taken, so ~100 ms behind
server time is usually past the newest update, and remotes stall.

**`Reconciler`** — for a guest's own body in a host-simulated game. The guest
moves its body the frame input happens, and corrects it against the host's copy.
That copy is about one round trip old, so it is compared with where the body
_was_ at the matching time, never with where it is now.

```ts
const reconciler = new Reconciler({ deadZone: 2, snapDistance: 96 });
// guest: tag inputs, remember when they left
sentAt.set(++seq, performance.now());
client.sendEvent("input", { seq, mx, my }, { to: client.hostId ?? [] });
// host: each guest body's row carries the newest seq applied and for how long
// guest, on a snapshot:
reconciler.reconcile(row.x, row.y, (sentAt.get(row.ack) ?? 0) + row.ackAge);
// guest, every frame after moving the body:
const fix = reconciler.step(me.x, me.y, deltaMs);
me.x += fix.x;
me.y += fix.y;
```

Errors inside `deadZone` are ignored, mid-size ones ease out over ~100 ms, and
ones past `snapDistance` (knockback, a missed collision) apply at once.
Teleports are not errors: place the body, then call `clear()`.

**Net stats** — how often remotes ran out of data. Every frame an
`Interpolator` renders is counted; one drawn past the newest update (the next
came too late, so it extrapolated or held) is _starved_, and one held still past
`maxExtrapolateMs` is _stalled_ — a visible freeze. `netStats()` returns the
page's totals. Tooling reads the same numbers, and each live client's room, host
flag and round trip, from `window.__VG_NET__`: the multiplayer skill's
`net-check` script plays two clients under injected latency and judges a game by
them, with nothing for the game to wire up.

## Model: host-authoritative, last-write-wins

The first player is the host and is the only writer of shared state. Intents go
up (`sendEvent`), state comes down (`state_patch`). The server runs no game
simulation — so keep authority in one place: guests send input, the host
mutates the world. The server does provide what a game cannot do fairly from any
one client: one clock ([server time](#server-time)), first-come arbitration
([claims](#claims)), an ordered input stream ([tick rooms](#tick-rooms)),
[interest management](#interest-management) and [bounds on player
state](#player-state-limits).

If the host leaves (or its tab is backgrounded long enough to stop
heartbeating), the server elects a new one. Design for that: state must live in
`sharedState`, not in the current host's local variables. The room's world and
claims also survive the server restarting mid-session (a deploy): the server
restores them, and a host that kept the role re-sends anything newer.

## Shared state

One object synced to everyone. Patches shallow-merge by key.

```tsx
const room = useMultiplayerRoom({ host, party, room, initialState: { started: false } });
const [game, setGame] = useMultiplayerState(room);

if (isHost) setGame({ started: true });
```

`initialState` is applied once, by the first host of a still-empty room, and is
never re-applied on host migration — so a host leaving mid-game cannot reset the
round.

## Player state

Per-player data visible to everyone.

```tsx
const [player, setPlayer] = usePlayerState(room, { x: 0, y: 0 });

useEffect(() => {
  const onMove = (e: PointerEvent) => setPlayer({ x: e.clientX, y: e.clientY });
  window.addEventListener("pointermove", onMove);
  return () => window.removeEventListener("pointermove", onMove);
}, [setPlayer]);
```

## Events

Fire-and-forget messages. Handled by the `onEvent` callback in the room config.

```ts
room.sendEvent("explosion", { x: 100, y: 200 });

room.sendEvent("hit", dmg, { to: victimId }); // one player
room.sendEvent("spawn", data, { except: room.playerId }); // everyone else
room.sendEvent("cursor", pos, { coalesce: true }); // latest-wins, flushed per microtask
```

`to`/`except` are enforced by the server; `coalesce` is client-side and collapses
rapid same-type events into one wire message without reordering them against
state patches. Events are not buffered — a player who is away misses them, so
anything that must survive a reconnect belongs in state.

## Room metadata

```tsx
const isConnected = room.connectionStatus === "connected";
const players = Object.values(room.players);
const myId = room.playerId;
const actualRoom = room.room; // may be an overflow sibling — see below
```

Each `Player` carries `id`, an auto-assigned `color`/`hue`, its state, and
`connected` — `false` while a dropped player's seat is being held. Render that
as "reconnecting…", not as a leave.

## Capacity and overflow

```ts
useMultiplayerRoom({ host, party, room, maxPlayers: 8 });
```

At capacity the client is transparently reconnected into a sibling room
(`{room}~2`, `{room}~3`, …) — an independent world with its own host and shared
state. Read `room.room` to show players which instance they landed in. Omit
`maxPlayers` for no cap (the server still clamps to a hard ceiling).

## Reconnection

A dropped connection holds the player's seat, identity and state for 30s
(`RECONNECT_GRACE_MS`) against a client-secret token, so a network blip is a
pause rather than a leave + rejoin. A deliberate `destroy()` skips the grace
window and leaves immediately, and so does closing or reloading the page: the
token lives in the page's memory, so the server frees the seat at once.

While the connection is down, state updates and inputs apply locally but are
not queued: on reconnect the client sends its latest player state and held
input, and a host re-sends whatever of its world the server holds differently.
Peers never get a burst of stale frames. Events and claims do queue, and go out
on reconnect.

## Server time

```ts
client.serverNow(); // ms since the epoch, by the server's clock
client.rtt; // fastest recent round trip (ms)
client.serverClock; // the clock itself
```

The SDK probes the server when it joins and every 5 s (`TIME_PROBE_INTERVAL_MS`):
the fastest recent probe defines the offset, and later revisions are slewed in
rather than jumped. Stamp anything time-based with it — snapshots, spawns, a
round's deadline — and every client agrees on what the stamp means. Render
remotes on a per-sender `RemoteClock`, not on this clock (see `Interpolator`).

## Claims

First come, first served, decided by the server in one hop — no host round trip
and no host advantage. For anything two players can race for: a pellet, a
pickup, a harvest, a seat.

```ts
const client = new MultiplayerClient({
  host,
  party,
  room,
  onClaim: (key, owner) => {
    if (owner !== client.playerId && eatenLocally.has(key)) undoEat(key); // lost the race
  },
});

client.claim(`pellet:${i}`); // act on it at once; undo if onClaim names someone else
client.ownerOf(`pellet:${i}`); // who holds it, or null
client.claim("door", { ttlMs: 2000 }); // released automatically
client.release("door"); // its owner, or the host, may release a key
client.clearClaims("pellet:"); // host only: a new round
```

Everyone hears a grant; a refused claimer alone hears who already holds the key.
Claims outlive their owner leaving (an eaten pellet stays eaten) and arrive in
the join `sync` (`client.claims`), reported through `onClaim` like any other
change — as is whatever moved while a client was disconnected. A room holds up to `MAX_CLAIMS` keys;
`RESERVED_CLAIM_KEYS` (`__proto__`, `constructor`, `prototype`) can't be claimed.

## Tick rooms

For deterministic lockstep or rollback games: the server stamps every input into
a numbered tick and broadcasts each tick's changes to everyone, in order. The
simulation runs on the clients; the server only keeps time and orders inputs.

```ts
const client = new MultiplayerClient({
  host,
  party,
  room,
  tickRate: 30,
  onTick: ({ n, inputs, changed }) => sim.step(n, inputs), // every tick, in order, no gaps
});

client.sendInput({ up: true }); // held from the next tick until the next sendInput
client.sendInput(input, client.serverTick() + 2); // or from a chosen tick (input delay)
client.tickClock; // { epoch, ms, n }: tick n starts at server time epoch + n * ms
client.tickInputs(); // every player's held input as of tickClock.n
client.tickInputs(n); // ...or as of any tick in the recent history
```

Send inputs on change, not per frame: they are held. An input for a tick that
has passed lands on the next one (a rollback game re-simulates). A player who
leaves or drops gets `null` on the next tick. Back from a network blip, the
ticks missed meanwhile replay through `onTick`, and the player's held input is
re-sent. A joiner starts from `tickClock` and `tickInputs()`; to join a match
in progress, have the host publish the world with the tick it belongs to in
shared state, and replay forward with `tickInputs(t)` (the room keeps
`MAX_TICK_HISTORY` ticks). Inputs are small (`MAX_INPUT_BYTES`).

## Interest management

```ts
new MultiplayerClient({ host, party, room, interest: { radius: 800 } });
```

Players farther apart than `radius` (measured on the player-state keys `x`/`y`,
or the ones the rule names) stop receiving each other's player state; such a
player reads `visible: false` — hide it. Coming back into range delivers the
whole state, then `visible: true`. The host always receives everyone, since it
may simulate players far from its own avatar.

## Player-state limits

```ts
new MultiplayerClient({ host, party, room, limits: { hp: { min: 0, max: 100 } } });
```

The server drops any player-state patch that sets a listed key outside its range
(or to a non-number) before anyone sees it.

Room rules — `tickRate`, `interest`, `limits` — are adopted from the first
client admitted to an empty room and kept until it empties, like `maxPlayers`:
ship them in shared config so every client passes the same ones.

## Validation (core client)

`MultiplayerClient` accepts optional [Standard
Schema](https://standardschema.dev) validators — Zod, Valibot, ArkType — applied
to the full merged state, so invalid patches are dropped before they reach the
wire:

```ts
new MultiplayerClient({
  host,
  party,
  room,
  schemas: {
    sharedState: z.object({ tick: z.number() }),
    onViolation: (v) => console.warn(v.issues),
  },
});
```

The server enforces game-agnostic structural limits regardless
(`MAX_MESSAGE_BYTES`, `MAX_STATE_DEPTH`, no cycles or functions).

## Server

Speaks the vibedgames party server's protocol
([`apps/party`](https://github.com/kyh/vibedgames/tree/main/apps/party)), which
handles shared state, player state, events, capacity, reconnection, host
election, server time, claims, ticks, interest and limits generically — it never
knows a game's shape.

## License

MIT
