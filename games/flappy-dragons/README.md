# Flappy Dragons

Flappy-bird-style Phaser 4 game with webcam pose control (physically jump or flap your arms to flap, via MediaPipe PoseLandmarker) and online multiplayer via `@vibedgames/multiplayer` — other players appear as translucent ghost dragons. Deployed at `flappy-dragons.vibedgames.com`.

## Develop

```bash
pnpm dev:flappy-dragons   # http://localhost:5184
pnpm --filter @repo/flappy-dragons typecheck   # tsc --noEmit
pnpm --filter @repo/flappy-dragons build       # vite build
pnpm --filter @repo/flappy-dragons preview     # vite preview
```

## Routes

| URL | What |
|---|---|
| `/` | the game |

## Controls

| Input | Action |
|---|---|
| Space / ↑ (click, tap, pad A) | flap |
| 📷 webcam | jump or flap your arms |
| M | mute |

Multiplayer: auto-joins the shared `flappy-dragons-default` room (up to 8 players), solo fallback when the party server is unreachable. Webcam is optional — keyboard/tap always works.
