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

Multiplayer: auto-joins the shared `flappy-dragons-v3` room (up to 8 players; the suffix versions the wire format), solo fallback when the party server is unreachable. Webcam is optional — keyboard/tap always works.

Netcode: every player flies their own dragon locally and streams height samples at 20 Hz, stamped with the room's server time; each rival is drawn 100 ms or more behind the moment its samples land, interpolated between them, through its own clock that learns how long its samples take to arrive and how unevenly, so on a jittery route the delay grows instead of the stream running dry (`src/net/rival-motion.ts`). The course scrolls on the room's server time too: as a race begins, the host publishes the seed and the server time the race started from, and every screen scrolls `PIPE_SPEED` from it — nothing streams, screens never drift apart, and a new host inherits the course untouched (`src/net/course.ts`). Alone, the host's course runs on its own frame clock and pauses through a stall like the rest of the solo game. A flying dragon never sees the pipes reverse: a course that comes back behind (a blip into a race the host held) halts until the room's catches up. A crash in a race respawns into the ready hover over the next gap, and the first flap relaunches — the same start as solo. A rival whose connection drops stays in the race while the room holds its seat for the reconnect: its dragon waits faded where its stream stopped and its row on the board reads reconnecting…; back from a drop, its or yours, its clock measures the route afresh.
