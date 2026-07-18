# Tetris

3D Three.js tetris in an 8×8×12 well where the camera is gameplay — lean in front of the webcam to orbit the view, twist to rotate pieces, T-pose for a power sweep (MediaPipe PoseLandmarker), with full keyboard/touch/pad fallbacks; cleared layers collapse as physics debris (cannon-es). Single-player. Deployed at `tetris.vibedgames.com`.

## Develop

```bash
pnpm dev:tetris   # http://localhost:5187
pnpm --filter @repo/tetris typecheck   # tsc --noEmit
pnpm --filter @repo/tetris build       # vite build
pnpm --filter @repo/tetris preview     # vite preview
npx tsx games/tetris/scripts/smoke.ts  # headless game-core smoke checks (no three.js)
```

## Routes

| URL | What |
|---|---|
| `/` | the game |

## Controls

| Input | Action |
|---|---|
| ←→↑↓ / 📷 lean (touch drag, pad stick/d-pad) | move |
| R / 📷 twist (pad A) | rotate |
| Q / E (pad LB/RB) | turn view |
| Space (pad B) | hard drop |
| Shift (pad LT/RT) | soft drop |
| C (pad X) | hold piece |
| F / 📷 T-pose (pad Y) | power sweep |
| V | recenter |
| M / P | mute / pause |
