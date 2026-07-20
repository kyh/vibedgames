# Pong

3D Three.js pong with a 2-tone Bayer-dither ink-on-paper look, steered by webcam hand tracking (open hand moves the paddle, fist serves, via MediaPipe GestureRecognizer) with mouse/touch/pad fallbacks; online 1v1 via `@vibedgames/multiplayer`. Deployed at `pong.vibedgames.com`.

## Develop

```bash
pnpm dev:pong   # http://localhost:5188
pnpm --filter @repo/pong typecheck   # tsc --noEmit
pnpm --filter @repo/pong build       # vite build
pnpm --filter @repo/pong preview     # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

| Input                              | Action           |
| ---------------------------------- | ---------------- |
| ✋ hand (mouse, finger, pad stick) | steer the paddle |
| ✊ fist (click, tap, pad A)        | serve · rematch  |
| M                                  | mute             |

Multiplayer: auto-joins the shared `pong-default` room (2 players max) for a live 1v1; solo fallback (vs AI paddle) when the party server is unreachable or nobody else is around.
