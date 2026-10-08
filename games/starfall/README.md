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

Multiplayer is host-authoritative via `@vibedgames/multiplayer`: everyone joins one 32-player room (`starfall-arena-v7`; bump the suffix whenever the wire format changes), and the first host seeds the world explicitly — no `initialState`, so host migration never wipes it.

- **Your ship is local.** It moves the frame you steer. Each client sends its pose as flat primitives at 20 Hz (`FixedRate`), stamped with `performance.now()`; unchanged keys never ride the wire.
- **Remote ships are interpolated** ~100 ms behind their sender's clock (`net/peer-roster.ts`, `Interpolator`). Hit tests, homing and the minimap read the same drawn pose.
- **Shots are events.** Each trigger pull is one `fire` event (weapon, origin, aim, jitter seed, locks — `net/fire-wire.ts`). Every client rebuilds the volley with the shooter's own code (`sys/volley.ts`) and flies it on the timeline that shooter's hull is drawn on (`sys/remote-fire.ts`); a victim adjudicates PvP against those copies.
- **The world is sent as deltas** at 20 Hz (`net/world-wire.ts`): stamped row buckets re-sent only when an entity spawns, turns or is taken, plus every enemy's motion each share. Guests age each row by the host clock, fold it into their dead-reckoned copy and bleed the residual error in over ~0.1 s; host deadlines are converted to the guest's clock (`net/host-clock.ts`).
- **Intents go to the host only**, one batched event per frame (`net/intents.ts`); the host applies its own directly. A promoted host keeps its own extrapolated world rather than the departed host's last snapshot.

`node_modules/.bin/tsx scripts/wire-audit.ts` measures both wires at the 32-player caps.
