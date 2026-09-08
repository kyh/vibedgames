# Pong

3D Three.js pong with a 2-tone Bayer-dither ink-on-paper look, steered by webcam hand tracking (open hand moves the paddle, fist serves and arms a charged power shot, via MediaPipe GestureRecognizer) with mouse/touch/pad fallbacks; online 1v1 via `@vibedgames/multiplayer`. Deployed at `pong.vibedgames.com`.

## Develop

```bash
pnpm dev:pong   # http://localhost:5188
pnpm --filter @repo/pong typecheck   # tsc --noEmit
pnpm --filter @repo/pong build       # vite build
pnpm --filter @repo/pong test        # contact shots, charge, input and multiplayer invariants
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

Multiplayer: auto-joins the shared `pong-default` room (2 players max) for a live 1v1; solo fallback (vs AI paddle) when the party server is unreachable or nobody else is around, and a tap during the handshake starts that solo game immediately.
