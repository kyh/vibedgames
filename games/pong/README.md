# Pong

3D Three.js pong with a 2-tone Bayer-dither ink-on-paper look, steered by webcam hand tracking (open hand moves the paddle, fist serves and arms a charged power shot, via MediaPipe GestureRecognizer) with mouse/touch/pad fallbacks; online 1v1 via `@vibedgames/multiplayer`. Deployed at `pong.vibedgames.com`.

## Develop

```bash
pnpm dev:pong   # http://localhost:5188
pnpm --filter @repo/pong typecheck   # tsc --noEmit
pnpm --filter @repo/pong build       # vite build
pnpm --filter @repo/pong test        # contact shots, the lockstep sim and rollback netcode (node --test)
pnpm --filter @repo/pong test:online # two browsers against a party server on :8787
pnpm --filter @repo/pong preview     # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

Every accepted return adds one charge. Four returns fill the meter; make a fresh
fist (or press Space, click, tap, or press pad A) to arm a power shot on your next contact.
Power returns travel at 1.4× ordinary rally speed, capped at 17. Charge carries
between points; queued shots clear on a point, pause, or lost hand tracking.
Rematches reset charge.

Where the ball meets your paddle determines the return, relative to your screen:
left third slices left, center stays flat, right third adds 10% speed and a lower
topspin hop. Power replaces the topspin speed bonus. The next return resumes the
ordinary rally speed ramp. First to 7.

The court has a compact charge meter and an edge-mounted serve/rematch button.
Detailed controls live in the pause menu.

Reduced motion follows the system preference: static camera, no inversion flash,
shorter trails, and still score/callout feedback.

| Input                              | Action                       |
| ---------------------------------- | ---------------------------- |
| ✋ hand (mouse, finger, pad stick) | steer the paddle             |
| ✊ fist (Space, click, tap, pad A) | serve · power shot · rematch |
| M · 🔊 button                      | mute                         |
| Escape · ⏸ button                  | pause                        |

Hand tracking costs ~17 MB of third-party wasm + model and a camera prompt, so it never loads during boot: a desktop starts it after first paint, a touch device opts in by tapping the "ENABLE HAND CONTROL" pill. The pause menu only advertises ✋/✊ while tracking is live.

Multiplayer: auto-joins the shared `pong-v3` room (2 players max) for a live 1v1; a solo match vs the AI paddle while nobody else is around or when the party server is unreachable, and a tap during the handshake starts that solo game immediately. A rival joining starts a fresh match; a rival leaving hands their paddle to the AI and the match carries on.

Netcode: lockstep with rollback on a 60 Hz tick room. The whole match is a deterministic fixed-step simulation (`src/shared/sim.ts`): seeded randomness, and only arithmetic every engine rounds alike (`src/shared/exact-math.ts`), so every client stepping the same inputs on the same ticks holds the same state. Each player sends its input — a paddle target and two press counters, three small integers (`src/shared/input.ts`) — only when it changes, scheduled a little ahead of the server's clock so it reaches the room before its tick; the server stamps it into that tick and streams every tick to both players. Each client runs ahead on its own input and the rival's last one, and when a tick reveals a rival input it guessed wrong, rewinds to it and re-simulates (`src/net/rollback.ts`); the drawn ball and rival paddle ease out the correction. Your paddle answers the frame you move, there is one ball, and nobody has a host advantage. The host only publishes the match record (seats, first tick, seed) when a pairing forms (`src/net/match-record.ts`); the match itself never depends on who hosts, so host migration changes nothing. A point a rival human defended waits for its tick to be confirmed before it plays, so a misprediction never flashes a goal. A dropped player's paddle is the AI's until they are back, and the ticks they missed replay on return. How far ahead each client sends adapts to the link: late inputs lengthen the lead at once, on-time ones shorten it slowly (`src/net/tick-driver.ts`).
