# Multiplayer gaps

A roadmap for the host-authoritative PartyServer stack (`apps/party` +
`@vibedgames/multiplayer` + the `multiplayer` skill). Built by diffing
the upstream `colyseus-multiplayer` skill against the current code.

We deliberately don't adopt Colyseus (server-authoritative + binary
schemas don't fit our last-write-wins host-authoritative model). This
doc is the subset that _does_ apply.

## Critical fixes (security / correctness)

These are bugs in the current code, not feature work.

- **`apps/party/src/server.ts:61` — host-only enforcement on `state_patch`.**
  Any client can overwrite `sharedState` today. CLAUDE.md _claims_
  host-authoritative, the relay is not. One-line fix: reject unless
  `sender.id === this.room.hostId`. **S.**
- **`apps/party/src/server.ts:107` — reconnection grace + stable player id.**
  `onClose` deletes the player immediately, so a 1s drop reshuffles
  hosts and wipes per-player state. Accept a `reconnectToken` query
  param, keep the slot for ~30s with `connected: false`. After this,
  the "first key becomes host" reassignment becomes deterministic
  instead of accidental. **M.**
- **DO hibernation safety.** `this.room` is an instance field. If the
  Durable Object hibernates and reloads, state resets without
  notifying clients. Either persist to DO storage or document that
  hibernation = reset. **M.**
- **`packages/multiplayer/src/client.ts` — `initialState` re-applied on
  host promotion wipes the live round.** The `sync` _and_ `host`
  message handlers both push `options.initialState` whenever the client
  becomes host, guarded only by a once-flag a promoted guest hasn't
  tripped. So when the host leaves, the new host re-seeds the room with
  a fresh `initialState`, resetting the board/scores for everyone. Fix:
  don't re-apply `initialState` if shared state is already populated
  (e.g. skip when the incoming `sync` state is non-empty, or drop the
  `host`-case re-apply entirely). Game-side workaround already shipped
  in `games/bomberman` (no `initialState`; host seeds via an
  `isHost && !seeded` check) and documented in the `multiplayer` skill.
  **S.**

## Server-side roadmap (`apps/party`, `packages/multiplayer`)

- **`onAuth` hook.** Bigger than it looks. Three real obstacles:
  1. Web app and party are on different sites
     (`vibedgames.com` vs `vibedgames-party.kyh.workers.dev`), so
     better-auth session cookies don't traverse.
  2. Browser WebSocket clients can't send custom headers — auth has
     to ride on a URL token (leaks to logs) or `Sec-WebSocket-Protocol`
     (a hack), each requiring a token-mint API and a pre-connect
     acquisition step.
  3. Threat model is weak today — `connection.id` is partyserver-random,
     so there is no vibedgames identity to spoof, and games are
     served at `{slug}.vibedgames.com` for users who may not be
     logged in at all.
     Hold until private rooms or persistent identity are actual
     requirements, then design properly: subdomain (`party.vibedgames.com`)
     for cookie carry, OR a join-token mint endpoint + URL token. **M.**
- **Typed message channels.** Replace the single `emit`/`event` pair
  with `room.send(type, payload, { to?, except? })`. Mirrors
  Colyseus's `client.send` vs `broadcast` so events can target one
  player ("you died"). Currently broadcast-only. **M.**
- **Keyed deltas instead of full re-broadcast.** `MultiplayerClient`'s
  `state_patch` handler shallow-merges; the wire still carries the
  whole patch. Switch to `{ path, value }` pairs and apply
  path-by-path. Bandwidth on a 50-key state is currently O(N) per
  change. **M.**
- **`connected` flag on `Player`.** Add to
  `packages/multiplayer/src/types.ts` so reconnection grace is
  observable to game logic (render "reconnecting…" overlays). **S.**
- **Room caps + overflow rooms.** A room used to accept unlimited
  players. Now `MultiplayerOptions.maxPlayers` caps a room; the SDK
  advertises it via the `_maxPlayers` query param, the server rejects
  over-cap connects with a `room_full` message naming the next overflow
  sibling (`{room}~2`, `{room}~3`, …), and the client transparently
  reconnects there. Cap is clamped server-side to `HARD_ROOM_CAP`.
  Overflow rooms are independent worlds (no cross-room matchmaking — by
  design, see "Intentionally omitted"). **(done — 2026-06-06.) S.**
- **Server-side validation hook.** Let game authors register Zod
  schemas for `state_patch` / `player_state_patch` payloads. Today
  the server validates nothing. **M.**
- **`/health` + room-listing endpoint.** Needed for any deploy /
  ops story. Lift from Colyseus deployment guidance. **S.**
- **Testing harness.** Spin up `VgServer` against `unstable_dev` so
  games can write integration tests with two simulated clients. **M.**
- **Optional event coalescing.** `sendEvent({ coalesce: true })` —
  damage-number events shouldn't beat the HP update they describe. **S.**

### Intentionally omitted

These are Colyseus features that don't fit a host-authoritative model:

- Declarative `@type` schemas with binary protocol
- Server simulation tick loop / `setSimulationInterval`
- Per-client filtered sync (`@filter`)
- Server-driven matchmaker (we lean on client-chosen room ids)
- Lobby room
- Redis-backed presence / multi-process scaling (DO-per-room handles
  it for free)

## Skill-side roadmap (`plugins/game-features/skills/multiplayer/SKILL.md`)

Things the stack already supports but the skill doesn't teach. Each is
a docs PR, not code work.

- **"Intents up, events down"** framing for messages. Sharper than
  the current "shared / player / events" trio. Maps onto existing
  `sendEvent`.
- **Host-only mutation rule, stated explicitly.** The skill shows
  `if (isHost) setWorld(...)` once but never explains that
  non-hosts writing to `sharedState` is a footgun the relay won't
  catch (and after the server fix, will reject).
- **Read-vs-subscribe distinction.** `client.players` direct read in
  Phaser `update()` vs `useMultiplayerState` for React. Skill doesn't
  draw the line.
- **Throttle vs send-on-change patterns.** Skill teaches frame-mod-3
  throttle; doesn't teach send-on-change for keyboard intents.
- **Adapter-layer recipe** (`net/client`, `net/session`,
  `net/registry`). The Colyseus skill's renderer-agnostic shape is
  better than the current "drop client into a Phaser scene" examples.
- **Three.js / vanilla examples.** Framework section is Phaser+React
  only despite the client being framework-agnostic.
- **Reconnection / connection-state UX.** `connectionStatus` already
  exists on the snapshot but the skill never tells authors to render
  a "reconnecting…" overlay. Becomes essential after server-side
  grace lands.
- **Initial-state ownership pattern.** `initialState` only seeds when
  the _current_ client becomes host — surprising semantics. Document.
- **Schema-shape discipline.** Don't put VFX, sprite refs, or
  animation frame indices in `sharedState`. Mirrors Colyseus's
  "schema is a wire format" rule.
- **Two-tab dev loop + 200ms RTT throttling test.** Standard
  debugging checklist; trivially applies.

## Anti-patterns to port verbatim from Colyseus skill

Host-authoritative-compatible only:

- Sending positions as messages instead of state.
- Mutating the local mirror of state directly (overwritten on next
  patch).
- Treating broadcast and send-to-one as interchangeable (after we add
  typed channels).
- Hardcoding `ws://localhost:…` (the skill currently hardcodes
  `https://vibedgames-party.kyh.workers.dev` everywhere — same smell).
- No `onError` / connection-lost UI — game appears frozen.
- Retrofitting multiplayer into single-player scene logic — keep SP
  intact, build a dedicated MP adapter.
- Async work in connection lifecycle hooks.
- Treating local websocket success as proof production works.

Skip Colyseus anti-patterns that assume server schemas: monolithic
GameState, filtered sync, `@filter`, `allowReconnection` placement,
`consented` flag, `afterNextPatch`, Redis/sticky-session, monitor
exposure.

## Priority order

1. **`server.ts:61` host enforcement** — credibility / safety, one line.
   **(done — 2026-05-07.)**
2. **Adapter-layer skill recipe + host-only mutation rule** — cheapest
   way to stop agents from welding multiplayer into Phaser scene code,
   and the place to teach the new server-side rejection behavior.
3. **Reconnection grace + stable id** — without it, host migration is
   theatre. Defer until one game complains about flaky reconnects.
4. **`onAuth`** — defer. Cross-domain cookie problem + WS-header
   constraint make this an M, not an afternoon. Revisit when private
   rooms or persistent identity become product requirements.
5. Everything else.
