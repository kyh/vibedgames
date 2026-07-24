# Changelog

## 0.2.0 — 2026-07-24

All wire changes are additive and feature-detected — old clients and old servers
interoperate with this version in the same room.

- Targeted events: `sendEvent(event, payload, { to, except })` — server-enforced
  delivery to specific player ids; untargeted sends stay byte-identical to the old
  wire protocol.
- Opt-in event coalescing: `sendEvent(..., { coalesce: true })` collapses rapid
  same-type/same-target events to the latest payload on a microtask flush, always
  flushed ahead of outgoing state patches (never reorders vs state). Composes with
  targeting.
- Keyed delta state sync: `updateSharedState`/`updateMyState` send only changed
  top-level keys; client advertises `_delta=1` and the server fans out per-key
  `player_state` deltas to capable clients, full snapshots to older ones.
- Schema validation: `schemas` option (`sharedState`/`playerState`/`onViolation`)
  via the Standard Schema interface — zod v3.24+/v4, valibot, arktype plug in with
  zero added deps. Always validates the full merged state, never a raw delta.
  Structural guard (`findStructuralIssue`, `MAX_MESSAGE_BYTES`, `MAX_STATE_DEPTH`)
  exported and enforced server-side on every patch.
- Reconnection grace: secret `_reconnectToken` reclaims a dropped player's seat
  within 30s; `Player.connected` + `player_connection` message let games render
  "reconnecting…" instead of removing the player. `destroy()` still leaves
  immediately.
- `initialState` no longer re-seeds on host promotion mid-round — a guest promoted
  after the host leaves can't wipe the live board.

## 0.1.2 — 2026-07-13

- The package now imports under plain Node ESM. Relative imports carry explicit `.js`
  extensions, so the emitted `dist` re-exports `./client.js` rather than `./client` —
  extensionless specifiers are what `moduleResolution: "bundler"` emits, and Node ESM
  rejects them. Long-standing (0.0.3 had it too); it went unnoticed because bundlers
  resolve extensionless imports happily and every consumer so far went through one.
  No API or behaviour change.

## 0.1.1 — 2026-07-13

- Republish of 0.1.0, whose `exports` shipped pointing at `./src/*.ts` — files that
  aren't in the tarball (`files: ["dist"]`), so the package wouldn't resolve. 0.1.0 was
  published with `npm publish`, which ignores `publishConfig`; the field rewriting that
  redirects `exports` at `./dist` is a pnpm feature. Use `pnpm publish` for this package.
  0.1.0 is deprecated. No source changes from 0.1.0.

## 0.1.0 — 2026-07-13 (deprecated — broken `exports`, use 0.1.1)

**Requires a server running the matching PartyServer.** The eviction sweep below is
server-driven, so a client older than 0.1.0 connected to a 0.1.0 server never answers
its pings and is dropped after ~75s. Deploy the client before the server.

- Ghost players are now evicted. A peer that vanishes without a close handshake — slept laptop, dropped radio, force-quit tab — used to leave an `OPEN` socket that TCP would not reap for the better part of an hour, so it sat in the room forever. Against a capped room those ghosts also consumed real slots and pushed live players into overflow siblings.
- New `ping` (server) / `pong` (client) messages, answered from the client's message handler. This is deliberately **not** the existing `heartbeat`: `heartbeat` is rAF-driven and stops when a tab is hidden, which is what demotes a backgrounded host within `HOST_LIVENESS_TIMEOUT_MS`. Eviction needs a signal that survives a hidden tab, so it gets its own. A backgrounded player keeps its slot; an unreachable one loses it.
- New `PING_INTERVAL_MS` (30s) and `EVICTION_TIMEOUT_MS` (75s) exports.
- Player state is re-announced on every `sync`, so a reconnect no longer leaves a player with empty server-side state (previously it stayed empty until the game next called `updateMyState`).
