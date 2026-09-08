# Lunerfall

TowerFall-feel roguelite dungeon crawl — Phaser, pixel art, five heroes with distinct kits, proc-gen rooms across five biomes. Online co-op and first-to-3 versus via `@vibedgames/multiplayer` (share a party code, host-authoritative). Deployed at `lunerfall.vibedgames.com`.

Combat effects reuse scene-owned pools (192 particles, 32 afterimages, 16 labels), cleared between rooms. Hero specials and boss blasts carry their own colors; elite clears and boss defeats get finite payoff cues. Routine camera shake follows the local player. Authored swings, hitboxes, combat freeze and rewards are unchanged.

The start screen showcases your warrior above a compact roster. Choose Solo, Co-op or Versus, then Play. Forge and controls live in their own dialogs; the last descent expands for details.

For online play, use **Copy link** to invite a friend. The link selects the room and mode; each player picks a warrior and presses Play. Or choose the same mode, enter the four-character code, and select Join before Play. Codes ignore letter case. Co-op and Versus rooms stay separate, and a third player sees “Room full.” If clipboard access is unavailable, the full link appears for manual copying.

## Develop

```bash
pnpm dev:lunerfall                        # http://localhost:5192
pnpm --filter @repo/lunerfall typecheck
pnpm --filter @repo/lunerfall build
pnpm --filter @repo/lunerfall test        # headless sim harness (tools/sim.mts)
```

## Routes

| URL           | What                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `/`           | the game (hero-select hub → run)                                                                     |
| `/?trailer=1` | scripted gameplay trailer, rolls on its own (click anywhere for audio, `&loop=1` replays, Esc exits) |
| `/?viewer=1`  | character/animation viewer with live hitbox overlay (`&char=<name>` deep-links a character)          |

## Options

| Param           | Effect                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `?demo=1`       | scripted demo input drives the run (skips the hub)                                             |
| `?hero=<name>`  | boot straight into a run as `axion` / `reaper` / `riven` / `mooni` / `salamander`              |
| `?room=<type>`  | debug-enter one room: `start` / `combat` / `elite` / `merchant` / `rest` / `treasure` / `boss` |
| `?biome=N`      | with `?room`, preview biome `N` (≥1) palette + roster                                          |
| `?party=<code>` | join/host an online party under that code                                                      |
| `?mode=vs`      | with `?party`, versus duel instead of co-op                                                    |
