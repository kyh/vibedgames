# Flappy Dragons

Flappy-bird-style Phaser 4 game with webcam pose control (physically jump or flap your arms to flap, via MediaPipe PoseLandmarker) and online multiplayer via `@vibedgames/multiplayer` — other players appear as translucent ghost dragons. Deployed at `flappy-dragons.vibedgames.com`.

## Develop

```bash
pnpm dev:flappy-dragons   # http://localhost:5184
pnpm --filter @repo/flappy-dragons typecheck   # tsc --noEmit
pnpm --filter @repo/flappy-dragons test        # netcode rules, headless
pnpm --filter @repo/flappy-dragons test:online # two real clients (party server on :8787, Chrome)
pnpm --filter @repo/flappy-dragons build       # vite build
pnpm --filter @repo/flappy-dragons preview     # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

| Input                         | Action                 |
| ----------------------------- | ---------------------- |
| Space / ↑ (click, tap, pad A) | flap                   |
| 📷 webcam                     | jump or flap your arms |
| M                             | mute                   |

Multiplayer: auto-joins the shared `flappy-dragons-v2` room (up to 8 players; the suffix versions the wire format), solo fallback when the party server is unreachable. Webcam is optional — keyboard/tap always works.

Netcode: every player flies their own dragon locally and streams stamped height samples at 20 Hz; rivals are drawn ~100 ms behind, interpolated between samples (`src/net/rival-motion.ts`). The host owns the course seed and scroll and reports both at 4 Hz on real time; guests dead-reckon between reports and fold any error in at a capped rate, so the pipes never run backwards (`src/net/world-follower.ts`). A crash in a race respawns into the ready hover over the next gap, and the first flap relaunches — the same start as solo.
