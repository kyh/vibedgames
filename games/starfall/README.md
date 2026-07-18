# Starfall

Top-down 32-player arena shooter (Phaser): drop into a shared arena, level up, and fight for the top of the board. Deployed at `starfall.vibedgames.com`.

## Develop

```bash
pnpm dev:starfall                       # http://localhost:5185
pnpm --filter @repo/starfall typecheck
pnpm --filter @repo/starfall build
```

## Routes

| URL | What |
|---|---|
| `/` | the game (auto-connects to the shared arena) |
| `/?trailer=1` | scripted gameplay trailer (`&autostart=1` skips the gate, `&loop=1` replays, Esc exits; fully offline with fake peers) |

## Options

| Param | Effect |
|---|---|
| `?seed=N` | reseed the deterministic RNG before boot |
| `?offline=1` | never dial the party server — deliberate solo/bot session |
| `?room=NAME` | dev-only room override (defaults to the shared arena room) |

Multiplayer is host-authoritative via `@vibedgames/multiplayer` (everyone joins one 32-player room; the first host seeds the world explicitly — no `initialState`, so host migration never wipes it).
