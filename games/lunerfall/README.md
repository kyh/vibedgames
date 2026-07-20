# Lunerfall

TowerFall-feel roguelite dungeon crawl — Phaser, pixel art, five heroes with distinct kits, proc-gen rooms across five biomes. Online co-op and first-to-3 versus via `@vibedgames/multiplayer` (share a party code, host-authoritative). Deployed at `lunerfall.vibedgames.com`.

## Develop

```bash
pnpm dev:lunerfall                        # http://localhost:5192
pnpm --filter @repo/lunerfall typecheck
pnpm --filter @repo/lunerfall build
pnpm --filter @repo/lunerfall test        # 78-check headless sim harness (tools/sim.mts)
```

## Routes

| URL           | What                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `/`           | the game (hero-select hub → run)                                                            |
| `/?trailer=1` | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits)     |
| `/?viewer=1`  | character/animation viewer with live hitbox overlay (`&char=<name>` deep-links a character) |

## Options

| Param           | Effect                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `?demo=1`       | scripted demo input drives the run (skips the hub)                                             |
| `?hero=<name>`  | boot straight into a run as `axion` / `reaper` / `riven` / `mooni` / `salamander`              |
| `?room=<type>`  | debug-enter one room: `start` / `combat` / `elite` / `merchant` / `rest` / `treasure` / `boss` |
| `?biome=N`      | with `?room`, preview biome `N` (≥1) palette + roster                                          |
| `?party=<code>` | join/host an online party under that code                                                      |
| `?mode=vs`      | with `?party`, versus duel instead of co-op                                                    |
