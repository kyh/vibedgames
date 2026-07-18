# Ancients of Eldermoor

Keyboard-first action MOBA (Phaser): two-lane two-island map, 6 heroes, creep waves, towers, jungle camps. Deployed at `moba.vibedgames.com`.

## Develop

```bash
pnpm dev:moba                        # http://localhost:5182
pnpm --filter @repo/moba typecheck
pnpm --filter @repo/moba build
pnpm --filter @repo/moba test        # headless sim smoke (17 checks)
```

## Routes

| URL               | What                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `/`               | the game                                                                                |
| `/?trailer=1`     | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits) |
| `/?viewer=1`      | character showcase — pick any hero/creep/neutral, demo anims + abilities at a dummy     |
| `/?gallery=units` | asset gallery pages: `units`, `terrain`, `fx`, `map` (bare `?gallery` = units)          |

## Options

| Param        | Effect                                         |
| ------------ | ---------------------------------------------- |
| `?hero=<id>` | pre-select a hero on the menu                  |
| `?auto=1`    | skip the menu, start a match immediately       |
| `?online=1`  | with `?auto=1`, start the match in online mode |

Multiplayer: online matches auto-match into a shared room via `@vibedgames/multiplayer` (host-authoritative).
