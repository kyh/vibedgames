# Battle Arena

3D online PvP action-RPG (Three.js): pick a champion, fight bots or other players in a hexagonal dungeon hall. Deployed at `battle-arena.vibedgames.com`.

## Develop

```bash
pnpm dev:battle-arena                       # http://localhost:5194
pnpm --filter @repo/battle-arena typecheck
pnpm --filter @repo/battle-arena build
pnpm --filter @repo/battle-arena test       # 60-check headless sim harness (tools/verify-timing.mts)
```

## Routes

| URL           | What                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `/`           | the game (3D champion-select lobby, then match)                                         |
| `/?trailer=1` | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits) |
| `/?editor=1`  | map editor (draft saved to localStorage, used by offline matches as the TEST loop)      |
| `/?viewer=1`  | character & animation viewer                                                            |

## Options

| Param              | Effect                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `?auto`            | skip the lobby — instant solo match vs bots                               |
| `?online`          | skip the lobby — instant online match                                     |
| `?room=CODE`       | lobby code for online matches (defaults to the public room)               |
| `?champ=ID`        | champion for quick-start boots (falls back to localStorage, then default) |
| `?name=NAME`       | player name (max 14 chars; falls back to localStorage, then "Player")     |
| `?party=PORT\|URL` | dev-only party-server override (ignored in production builds)             |

Multiplayer is host-authoritative via `@vibedgames/multiplayer`: guests send intent events, only the host mutates the world and broadcasts snapshots (`src/net/protocol.ts`).
