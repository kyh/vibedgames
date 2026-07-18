# Crazy Waymo

3D SF arcade driving game (Three.js + Rapier): a white Waymo picks up fares across a real-OSM San Francisco with day-night tied to the actual SF clock. Deployed at `crazy-waymo.vibedgames.com`.

## Develop

```bash
pnpm dev:crazy-waymo                        # http://localhost:5193
pnpm --filter @repo/crazy-waymo typecheck
pnpm --filter @repo/crazy-waymo build
pnpm --filter @repo/crazy-waymo test        # world-gen invariant harness (11 checks, headless)
pnpm --filter @repo/crazy-waymo test:e2e    # playwright smoke suite (needs a browser)
```

World tooling (see [CLAUDE.md](./CLAUDE.md) for when each is required): `pnpm bake:world` regenerates + installs `public/world/*.bin`, `pnpm bake:map` re-bakes the OSM vector network + street mask, `pnpm lint:streets` prints a street-mask sanity report.

## Routes

| URL           | What                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `/`           | the game                                                                                |
| `/?trailer=1` | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits) |
| `/?editor=1`  | map editor — place props, paint floors, add/remove street cells, export JSON            |
| `/?tune=1`    | live vehicle tuning panel                                                               |
| `/?bake=1`    | world bake — downloads `world.bin`/`rest.bin` by hand (prefer `pnpm bake:world`)        |

## Options

| Param        | Effect                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| `?map=<url>` | build the world from a saved map file (editor export)                      |
| `?cache`     | dev only: opt in to the IndexedDB world cache (bypassed by default in dev) |

## Controls

| Input                         | Action         |
| ----------------------------- | -------------- |
| W / ↑ (pad RT, touch HOLD)    | go             |
| S / ↓ (pad LT, touch BRAKE)   | stop / reverse |
| ← → (pad L-stick, touch DRAG) | steer          |
| Shift (pad B/RB, touch 🔥)    | boost          |
| M                             | mute           |

Multiplayer: everyone auto-joins a shared room via `@vibedgames/multiplayer` — other drivers appear as remote cars with chat bubbles.

Architecture, world-bake rules (`WORLD_REV`), and headless verification hooks: [CLAUDE.md](./CLAUDE.md).
