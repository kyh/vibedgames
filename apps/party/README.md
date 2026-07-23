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
- **Events** — `emit` pass-through for custom game events

## HTTP endpoints

- `GET /health` — liveness probe, answered at the Worker layer (never wakes a
  Durable Object). Returns `{ ok: true, service: "vibedgames-party" }`.
- `GET /parties/vg-server/:room` — per-room inspection. Returns aggregate stats
  only (`{ room, playerCount, capacity, hasHost }`) — never player ids or game
  state, since room slugs are guessable and games are untrusted code. Wakes the
  room's Durable Object; with no open connections it sleeps again right after.

There is no global room-listing endpoint: Durable Objects have no "list all
instances" primitive, and maintaining a registry (KV or a directory DO) isn't
warranted yet. Inspect rooms by id.

## Design rationale

Multiplayer is **host-authoritative, last-write-wins**. The elected host (a browser)
runs game logic and is the only writer of `sharedState`; the server is a relay that
enforces that rule, not a simulation. Intents go up (`emit`), state comes down
(`state_patch`). There is no conflict resolution.

### Why not Colyseus

Colyseus is server-authoritative with declarative `@type` schemas over a binary
protocol. Both halves fight this model: authority lives in a client (the host), and
the server never knows a game's shape — games are untrusted user code shipped against
one shared, generic relay. Adopting it would mean per-game server code.

So we deliberately skip the Colyseus features that only make sense inside that model:

- Declarative `@type` schemas with a binary protocol
- Server simulation tick loop (`setSimulationInterval`)
- Per-client filtered sync (`@filter`)
- Server-driven matchmaker — rooms are client-chosen ids
- Lobby room
- Redis-backed presence / multi-process scaling — a Durable Object per room gives this for free

Overflow rooms (`{room}~2`, `{room}~3`, …) follow from having no matchmaker: they are
independent worlds with their own host and `sharedState`, and no cross-room matchmaking.

### Anti-patterns

Game-author-facing ones — positions as events, mutating the local state mirror,
welding the client into a Phaser scene, calling `updateSharedState` off-host, no
connection-state UI, hardcoded party host URL — live in the `multiplayer` skill
(`plugins/game-features/skills/multiplayer/SKILL.md`).

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
