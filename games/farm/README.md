# Farm

Stardew-like farming RPG in Phaser — farming, fishing, mine combat, animals, NPCs, seasons, skills. Deployed at `farm.vibedgames.com`.

## Develop

```bash
pnpm dev:farm        # http://localhost:5191
pnpm --filter @repo/farm typecheck
pnpm --filter @repo/farm build
```

## Routes

| URL           | What                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/`           | the game                                                                                                               |
| `/?trailer=1` | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits)                                |
| `/?gallery=1` | asset gallery — every world tile index with its gameplay classification, deco animations, character/animal/crop sheets |

Multiplayer: shared farm via `@vibedgames/multiplayer` (auto-join, offline solo fallback if the party server doesn't answer).

## Controls

- WASD / arrows — move (SHIFT runs)
- E / SPACE or click — use tool / interact
- 1–9 or scroll — switch tools
- I — inventory
- M — sound on / off
- Touch: drag stick to move, tap a square to act, tap hotbar to switch tools
- Controller: stick to move, A to act, LB/RB to switch tools, Y for inventory
