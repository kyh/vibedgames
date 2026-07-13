# Changelog

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
