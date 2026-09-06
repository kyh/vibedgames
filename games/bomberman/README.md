# Bomberman

Top-down Phaser 4 bomberman arena with online multiplayer via `@vibedgames/multiplayer` (shared room, solo fallback when the party server is unreachable). Deployed at `bomberman.vibedgames.com`.

## Develop

```bash
pnpm dev:bomberman   # http://localhost:5180
pnpm --filter @repo/bomberman build      # vite build
pnpm --filter @repo/bomberman typecheck  # tsc --noEmit
pnpm --filter @repo/bomberman preview    # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

| Input                                       | Action      |
| ------------------------------------------- | ----------- |
| WASD / arrows (pad stick/d-pad, touch drag) | move        |
| Space (pad A, touch 💣)                     | drop a bomb |
| R (pad Start, touch tap)                    | restart     |
| M (touch 🔊)                                | mute        |

Sound starts muted; unmute to enable procedural placement, blast, pickup and
round feedback. Fuse sparks use the pause-aware clock. Flames remain the existing
generated animation; fading smoke and scorch marks are cosmetic. Pickup feedback
fires only on an actual collection, never when fire destroys an item.

Multiplayer: all players auto-join the shared `bomberman-default` room; offline it degrades to solo play.
