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
| `/?trailer=1` | scripted gameplay trailer — rolls on its own, click anywhere for audio (`&loop=1` replays, Esc exits)                  |
| `/?gallery=1` | asset gallery — every world tile index with its gameplay classification, deco animations, character/animal/crop sheets |

Multiplayer: shared farm via `@vibedgames/multiplayer` (auto-join, offline solo fallback if the party server doesn't answer).

## Controls

- WASD / arrows — move (SHIFT runs)
- E / SPACE or click — use tool / interact
- 1–9 or scroll — switch tools
- I — inventory and seasonal journal
- M — sound on / off
- Touch: drag stick to move, tap a square to act, tap hotbar to switch tools; the
  🔊 / ⏸ cluster (top right, touch only) covers what M and Escape do on a keyboard
- Controller: stick to move, A to act, LB/RB to switch tools, Y for inventory

## Seasonal journal

Open the bag, then Journal. Harvest crops and catch fish in their season to
record personal discoveries. Finds persist across years; Winter lists its five
eligible fish. Only items that fit in the bag count. Purchases, other farmers'
finds and repeat catches do not add discoveries.

Sleep previews crops that will wither. Mine returns show the visit's deepest
floor, gathered minerals, defeated enemies and net gold. These receipts do not
award extra items or change the existing farming, fishing or combat rules.

Failed saves keep pending progress and retry every three seconds. Mine trips
retain the live farm even when storage is unavailable. Reload still requires a
successful browser save. In co-op, pause fences local input and preserves a
pending catch while the connection stays alive.

Run `pnpm --filter @repo/farm test` for action timing, journal, save recovery,
input, audio and lifecycle regressions.
