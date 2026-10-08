# Pong

3D Three.js pong with a 2-tone Bayer-dither ink-on-paper look, steered by webcam hand tracking (open hand moves the paddle, fist serves and arms a charged power shot, via MediaPipe GestureRecognizer) with mouse/touch/pad fallbacks; online 1v1 via `@vibedgames/multiplayer`. Deployed at `pong.vibedgames.com`.

## Develop

```bash
pnpm dev:pong   # http://localhost:5188
pnpm --filter @repo/pong typecheck   # tsc --noEmit
pnpm --filter @repo/pong build       # vite build
pnpm --filter @repo/pong test        # contact-shot, spin and netcode timing (node --test)
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

Multiplayer: auto-joins the shared `pong-v2` room (2 players max) for a live 1v1; solo fallback (vs AI paddle) when the party server is unreachable or nobody else is around, and a tap during the handshake starts that solo game immediately.

Netcode: the host owns the ball and the score, and each player's own paddle is local and instant. A guest runs the ball as a local sim on the same flight rules (`src/shared/ball.ts`) and calls contacts on its own paddle the frame they happen; the host parks the ball at the guest's hit band until that verdict lands (at most 600 ms), checks it against its own flight and replays it, caught up to now (`src/shared/referee.ts`). Serves, the host's returns and points reach the guest as events it applies as state; the host's 30 Hz snapshots, stamped with its clock, correct the guest's copy and are eased out of the picture. Each side draws the other's paddle through `Interpolator`, and sends run on a `FixedRate` clock that hit-stop never pauses.
