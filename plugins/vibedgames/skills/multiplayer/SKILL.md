---
name: multiplayer
description: "Add online multiplayer — shared state, per-player state, events, host authority — to a browser game with @vibedgames/multiplayer."
---

# Vibedgames Multiplayer

Add real-time multiplayer to any browser game with `@vibedgames/multiplayer`.

## Install

```sh
npm install @vibedgames/multiplayer
```

## Two entry points

- `@vibedgames/multiplayer` — framework-agnostic `MultiplayerClient` class (Phaser, Three.js, vanilla JS)
- `@vibedgames/multiplayer/react` — React hooks wrapping the client

## Party host

Every example assumes this constant. Define it **once** — in a real game it lives in `net/client.ts` (see [references/architecture.md](references/architecture.md)) — and import it; never repeat the literal per call site:

```ts
export const PARTY_HOST = "https://vibedgames-party.kyh.workers.dev";
```

## Core concepts

1. **Shared state** — one copy, all players see the same (game world, score, phase). **Host-only writes.**
2. **Player state** — per-player, owned by that player (position, health, intent flags).
3. **Events** — fire-and-forget messages, broadcast to everyone (explosions, kills, pings).

The **host** (first player) runs authoritative game logic. If the host leaves, the next-joined player is reassigned as host.

## Room caps (overflow to new rooms)

By default a room is unlimited. Pass `maxPlayers` to cap it; when full, the next player overflows into a sibling room (`{room}~2`, `{room}~3`, …) and the SDK reconnects them there transparently — extra players get a parallel match instead of being turned away.

```ts
const client = new MultiplayerClient({
  host: PARTY_HOST,
  party: "vg-server",
  room: "arena",
  maxPlayers: 8, // 9th player lands in "arena~2", 17th in "arena~3", …
});
client.room; // the room you actually landed in — "arena" or an overflow sibling
```

`useMultiplayerRoom` takes the same `maxPlayers` option; read the live id off `room.room` for "Room #2"-style UI. Enforced server-side and clamped to a hard ceiling. All clients must pass the **same** `maxPlayers` (ship it in shared config). Overflow rooms are independent worlds (separate host, separate `sharedState`) — no cross-room matchmaking. Omit `maxPlayers` for unlimited.

## Host-only writes (important)

`updateSharedState` is rejected on the server unless the sender is the host. A non-host call is silently swallowed and the server echoes the authoritative `sharedState` back so the optimistic local mirror gets corrected. **Always gate writes behind `client.isHost` / `useIsHost(room)`.**

```ts
// Wrong — non-host's mutation gets reverted, the UI flickers.
client.updateSharedState({ score: client.sharedState.score + 10 });

// Right — gate the mutation; non-hosts request the change instead.
if (client.isHost) {
  client.updateSharedState({ score: client.sharedState.score + 10 });
} else {
  client.sendEvent("score_request", { delta: 10 });
}
```

The pattern: **intents go up via `sendEvent`, state comes down via `sharedState` patches**. Host listens for intent events, validates, and writes the result.

`updateMyState` is _not_ host-gated — players always own their own slot. **The corollary bites: the host cannot use `updateMyState` to mark _other_ players dead/disabled either, because that call only ever writes the caller's own slot.** Cross-player flags (deaths, scores, banned-from-round) belong in `sharedState`.

- **The host sim owes wall-clock time.** Phaser clamps `update()`'s `delta` when the tab is unfocused; a host that integrates `delta` crawls for every guest. Step the host sim from real elapsed time (a fixed-step loop over `performance.now()` deltas), not the engine's delta.
- **`offline` (no server) ≠ solo.** A connected host alone in a room is `offline === false`; gate bots and start-screen holds on `Object.keys(client.players).length <= 1`, never on `offline`.

### `updateSharedState` merges — your "reset" patch must include every field

`updateSharedState(patch)` does `{ ...prev, ...patch }` on the client and the same on the server. Any field you don't mention is carried over from the previous state. This bites hardest on round-restart logic, where you intend to wipe everything but forget one field:

```ts
// Wrong — `deaths`, `winner`, anything else that exists on prev survives.
client.updateSharedState({ grid: newGrid(), bombs: {}, blasts: {} });

// Right — list every resettable field with its empty value.
client.updateSharedState({
  grid: newGrid(),
  bombs: {},
  blasts: {},
  deaths: {},
  scores: {},
  winner: null,
  startedAt: Date.now(),
});
```

Keep a single `emptyState()` factory whose return type matches your `SharedState` exactly (so TS errors when you add a field). The function form `updateSharedState(prev => emptyState())` still goes through the same merge on the wire, so it still needs every field populated.

### Don't read player order before the first sync arrives

`Object.keys(client.players).indexOf(client.playerId)` returns `-1` between `connecting` and the first `sync` message — your local connection has opened but the server hasn't told you who else is in the room (including yourself). If you use the index to assign a spawn point, color, or team slot, both clients race to slot 0 and overlap. Wait for `client.playerId` to appear in `client.players` before deriving anything from order:

```ts
// Wrong — fires on every state change, including before sync.
useEffect(() => {
  const idx = Object.keys(room.players).indexOf(room.playerId!);
  setSpawn(SPAWNS[idx]); // idx is -1 on first tick; you spawn at SPAWNS[-1] = undefined
}, [room]);

// Right — wait until the server has confirmed our membership.
if (!room.playerId) return;
const idx = Object.keys(room.players).indexOf(room.playerId);
if (idx < 0) return; // sync hasn't arrived yet
setSpawn(SPAWNS[idx]);
```

### `initialState` seeds once — runtime-computed worlds seed host-side

`initialState` is applied by the first host of a still-empty room and never re-applied on host migration (≥ 0.2.0), so a promoted guest can't wipe the live round. It must be a static literal, though: a random map or `startedAt: Date.now()` is seeded by the host behind an "already seeded?" guard — see [references/architecture.md](references/architecture.md) → Seeding host-side.

## Pointers

- [references/react.md](references/react.md) — React hooks: `useMultiplayerRoom`/`useMultiplayerState`/`usePlayerState`, targeted + coalesced events, room metadata. Open for a React game.
- [references/engines.md](references/engines.md) — `MultiplayerClient` in a game loop, read-vs-subscribe rule, Phaser and Three.js examples. Open for any non-React game.
- [references/architecture.md](references/architecture.md) — `net/` adapter layer, host-side seeding, offline ≠ solo, throttling, reconnection UX (offline fallback, stale host), pause in an online game, latency (predict yourself, interpolate remotes, `bodyDrive`), the automated two-client check, schema discipline + validation. Open before writing `net/`, and whenever a room freezes, rubber-bands, or resets.

## Local dev loop (two tabs, one room)

1. Run the game's dev server, open it in **two browser tabs** with the same room id (use an incognito window for tab 2 if the game reads per-browser storage). Tab 1 is host.
2. Smoke both directions: move in tab 2, confirm tab 1 renders it; trigger a host write in tab 1, confirm tab 2 receives the patch.
3. **Host migration:** close tab 1. Tab 2 must promote to host and the round must survive (if the world resets here, you're re-seeding on promotion — see Seeding host-side).
4. **Latency pass:** in one tab, DevTools → Network → custom throttling profile with ~200ms latency (DevTools throttling applies to WebSockets). Play for a minute. Movement jitter, rubber-banding, and event/state races only show up here — localhost's ~0ms RTT hides all of them.
5. **Automated two-client check:** a Playwright harness with two headless contexts in one room — run one suite at a time, unique room id per run, `client.destroy()` before closing a context, assert on both clients' state. The full trap list — GPU flags, grace/eviction timing, blips vs leaves, virtual time — is in [references/architecture.md](references/architecture.md) → Automated two-client check.

## Anti-patterns

- ❌ **Mutating the local mirror directly.** `client.sharedState.score = 100` is silently overwritten on the next patch.
- ❌ **Sending positions as events.** Position belongs in `updateMyState`. Events are for things that _happened_.
- ❌ **Welding multiplayer into Phaser scene `update()`.** Use the adapter pattern. Single-player should still work after `rm -rf net/`.
- ❌ **No connection-state UI.** A disconnected game looks identical to a frozen one. Render the status.
- ❌ **Freezing a sim whose timers are raw `Date.now()`.** Resume mass-expires every fuse. Pause via an offset sim clock; online, pause = spectator.
- ❌ **Treating broadcast and send-to-one as interchangeable.** `sendEvent("secret_role", …)` + filtering in `onEvent` means every client still _receives_ the payload — anyone can read it in DevTools. Deliver private data with `{ to: playerId }`; the server never sends it elsewhere.
- ❌ **Treating a working local room as proof production works.** localhost is ~0ms RTT on one machine — it hides jitter, races, and reconnection paths. Run the 200ms-throttled pass and play the deployed URL from two devices before calling it done.

## Deploy

`vg deploy ./dist --slug my-game` → live at `https://my-game.vibedgames.com`; the party server is shared infrastructure. See the `deploy` skill for the full flow (use `npx vibedgames deploy` if `vg` isn't on PATH).

## See also

- `gamepad` (`@vibedgames/gamepad`) — on-screen touch controls (virtual joystick + buttons) so the multiplayer game is playable on phones, not just desktop.
