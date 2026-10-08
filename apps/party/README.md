# @repo/party

Real-time multiplayer server. Manages rooms, player state, and event broadcasting.

## Stack

- [PartyServer](https://partykit.io) on Cloudflare Durable Objects
- Generic protocol — not game-specific

## Protocol

Clients connect via WebSocket. The server handles:

- **Player join/leave** — auto-assigns colors, host migration
- **Shared state** — `state_patch` messages merged server-side, broadcast to all
- **Player state** — `player_state_patch` per-player, broadcast to others
- **Events** — `emit` pass-through for custom game events, optionally addressed
  to (`to`) or excluding (`except`) specific player ids
- **Reconnection grace** — a dropped (non-1000-close) player's seat is held for
  30s keyed by a client-secret reconnect token; peers see `connected: false`
  until reclaim or expiry. Events fired during the window are NOT buffered or
  replayed — only the seat and its state survive; shared state re-syncs on
  reclaim. Deliberate leaves (`destroy()`, close code 1000) skip the grace
  window entirely.
- **Host liveness** — clients heartbeat on a rAF interval (so a backgrounded tab
  stops); a host silent past `HOST_LIVENESS_TIMEOUT_MS` loses the role and the
  server elects a new one, rather than waiting out the TCP timeout. A separate
  `ping`/`pong` distinguishes "hidden" from "gone" for eviction.
- **Capacity + overflow** — a client advertises its cap via `_maxPlayers`
  (clamped to a hard ceiling of 64). A join over the cap is redirected to a
  sibling room (`{room}~2`, `~3`, …) and reconnects there; a reconnect reclaim
  is never bounced.
- **Structural limits** — messages over `MAX_MESSAGE_BYTES` are rejected, and
  patches are checked for shape (plain objects, bounded depth, no cycles or
  functions). Game-specific schemas are the client's job — the server never
  knows a game's shape.
- **Server time** — `time` probes are answered with the server's clock at once;
  the SDK turns them into `serverNow()`, one timebase for every client.
- **Claims** — `claim`/`release`/`clear_claims`: first come, first served per
  key, optional TTL (expiry wakes the alarm), owner-or-host release, host-only
  prefix clear, at most `MAX_CLAIMS` per room. Sent in `sync`.
- **Ticks** — a room with a `tickRate` rule runs a server clock that stamps
  each `input` into a numbered tick (`max(n, next)`, at most
  `MAX_INPUT_LEAD_TICKS` ahead) and broadcasts every tick's changes in order.
  The last `MAX_TICK_HISTORY` ticks of changes ride in `sync`, so a client back
  from a blip replays what it missed. A dropped or departed player's input
  clears to `null`. The running interval keeps the room awake while it ticks.
- **Interest** — with an `interest` rule, player-state deltas go only to
  players within the radius (the host gets everything); leaving range sends
  `player_visibility: false`, re-entering sends the whole state then `true`.
  Which pairs see each other is in memory: after hibernation every pair is
  re-decided with the whole state.
- **Limits** — a `limits` rule drops player-state patches whose listed numeric
  keys fall outside their bounds.
- **Persistence** — shared state and claims are written (debounced to 1 s,
  unconfirmed, ≤ 120 KB) so a room survives a restart mid-session.

Room rules (`tickRate`, `interest`, `limits`) arrive as JSON in the `_room`
query param and, like `_maxPlayers`, stick from the first admitted client until
the room empties. A connection without `_reconnectToken` is closed (4002). The
SDK and this server move together — there are no fallbacks for older clients;
a game that changes its own wire format versions its room ids.

The message types themselves live in
[`@vibedgames/multiplayer`](../../packages/multiplayer) and are imported by the
server, so client and server can never drift on a constant.

## Hosts

Games connect to `https://party.vibedgames.com`, a route on the `vibedgames.com` zone (`party`
is a reserved game slug).

## HTTP endpoints

- `GET /health` — liveness probe, answered at the Worker layer (never wakes a
  Durable Object). Returns `{ ok: true, service: "vibedgames-party" }`.
- `GET /parties/vg-server/:room` — per-room inspection. Returns aggregate stats
  only (`{ room, playerCount, capacity, hasHost, rules }`) — never player ids or
  game state, since room slugs are guessable and games are untrusted code. Wakes the
  room's Durable Object; with no open connections it sleeps again right after.

There is no global room-listing endpoint: Durable Objects have no "list all
instances" primitive, and maintaining a registry (KV or a directory DO) isn't
warranted yet. Inspect rooms by id.

## Design rationale

Multiplayer is **host-authoritative, last-write-wins**. The elected host (a browser)
runs game logic and is the only writer of `sharedState`; the server is a relay that
enforces that rule, not a simulation. Intents go up (`emit`), state comes down
(`state_patch`). What the server adds is only what no client can do fairly: one
clock, first-come claims, an ordered input stream, interest filtering and bounds.

### Why not Colyseus

Colyseus is server-authoritative with declarative `@type` schemas over a binary
protocol. Both halves fight this model: authority lives in a client (the host), and
the server never knows a game's shape — games are untrusted user code shipped against
one shared, generic relay. Adopting it would mean per-game server code.

So we deliberately skip the Colyseus features that only make sense inside that model:

- Declarative `@type` schemas with a binary protocol
- Server simulation (`setSimulationInterval`) — the tick loop here orders inputs; it simulates nothing
- Per-field filtered sync (`@filter`) — interest here is one radius rule over player state
- Server-driven matchmaker — rooms are client-chosen ids
- Lobby room
- Redis-backed presence / multi-process scaling — a Durable Object per room gives this for free

Overflow rooms (`{room}~2`, `{room}~3`, …) follow from having no matchmaker: they are
independent worlds with their own host and `sharedState`, and no cross-room matchmaking.

### Anti-patterns

Game-author-facing ones — positions as events, mutating the local state mirror,
welding the client into a Phaser scene, calling `updateSharedState` off-host, no
connection-state UI, hardcoded party host URL — live in the `multiplayer` skill
(`plugins/vibedgames/skills/multiplayer/SKILL.md`).

Server-side, in this app: no async work in connection lifecycle hooks, and never treat
a working local websocket as proof production works.

## Planning

Gaps and roadmap for this stack are tracked in GitHub Issues (label `plan`), not in
in-repo docs.

## Development

```sh
pnpm dev:party
```

Runs on `http://localhost:8787`.
