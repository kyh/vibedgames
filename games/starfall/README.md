# Starfall

Top-down 32-player arena shooter (Phaser): drop into a shared arena, level up, and fight for the top of the board. Deployed at `starfall.vibedgames.com`.

## Develop

```bash
pnpm dev:starfall                       # http://localhost:5185
pnpm --filter @repo/starfall typecheck
pnpm --filter @repo/starfall build
```

## Routes

| URL           | What                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | the game (auto-connects to the shared arena)                                                                                              |
| `/?trailer=1` | scripted gameplay trailer, rolls on its own (`&loop=1` replays, Esc exits, click anywhere to enable audio; fully offline with fake peers) |

## Options

| Param        | Effect                                                     |
| ------------ | ---------------------------------------------------------- |
| `?seed=N`    | reseed the deterministic RNG before boot                   |
| `?offline=1` | never dial the party server — deliberate solo/bot session  |
| `?room=NAME` | dev-only room override (defaults to the shared arena room) |

## Netcode

Multiplayer is host-authoritative via `@vibedgames/multiplayer`: everyone joins one 32-player room (`starfall-arena-v8`; bump the suffix whenever the wire format changes), and the first host seeds the world explicitly — no `initialState`, so host migration never wipes it.

- **One clock for stamps.** Every stamp on the wire — player state, `fire` events, world shares — is the room's server time (`client.serverNow()`), so a stamp means the same instant to every client and nothing changes when the host does. A client sends nothing until its first clock probe answers (`Link.connected`).
- **Your ship is local.** It moves the frame you steer. Each client sends its pose as flat primitives at 20 Hz (`FixedRate`); unchanged keys never ride the wire.
- **Remote ships are interpolated** ~100 ms behind the moment their updates arrive (`net/peer-roster.ts`). Each sender's stream has its own `RemoteClock` (the `Interpolator` default), which learns the relay — sender → server → here — from arrivals, so the delay only covers jitter; rendering a fixed delay behind server time would run past the newest update. Hit tests, homing and the minimap read the same drawn pose.
- **Shots are events.** Each trigger pull is one `fire` event (weapon, origin, aim, jitter seed, locks — `net/fire-wire.ts`). Every client rebuilds the volley with the shooter's own code (`sys/volley.ts`) and flies it on the clock that shooter's hull is drawn on (`sys/remote-fire.ts`); a victim adjudicates PvP against those copies.
- **The world is sent as deltas** at 20 Hz (`net/world-wire.ts`): stamped row buckets re-sent only when an entity spawns, turns or is taken, plus every enemy's motion each share. Guests age each row by the server clock, fold it into their dead-reckoned copy and bleed the residual error in over ~0.1 s; deadlines ride relative to the stamp and land on each client's own sim clock.
- **Intents go to the host only**, one batched event per frame (`net/intents.ts`: damage dealt, enemy shots a shield ate, SINGULARITY pulls); the host applies its own directly. A promoted host keeps its own extrapolated world rather than the departed host's last snapshot.
- **Pickups are claimed.** Two ships can reach one drop within a round trip, so items and XP shards go first come, first served through server claims (`sys/pickups.ts`, keys `i:<id>` / `s:<id>`, each lapsing shortly after its pickup would expire): the drop vanishes with its sparkle on contact, its effect lands when the claim comes back yours, and every client drops a granted pickup at once. The host takes no shortcut — its own claims go through the server too.
- **Interest management.** Players farther apart than `INTEREST_RADIUS` (2400 px, past the corner of the widest view) stop receiving each other's state; such a ship reads `visible: false` and is gone for that client — hull, pose buffer, shots, minimap dot. The host sees everyone, so enemy targeting, beacon control and magnets never depend on what a guest can see, and it relays every player's sector score (`sb`) so the standings stay arena-wide.

`node_modules/.bin/tsx scripts/wire-audit.ts` measures both wires at the 32-player caps.
