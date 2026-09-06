# Pong

3D Three.js pong with a 2-tone Bayer-dither ink-on-paper look, steered by webcam hand tracking (open hand moves the paddle, fist serves, via MediaPipe GestureRecognizer) with mouse/touch/pad fallbacks; online 1v1 via `@vibedgames/multiplayer`. Deployed at `pong.vibedgames.com`.

## Develop

```bash
pnpm dev:pong   # http://localhost:5188
pnpm --filter @repo/pong typecheck   # tsc --noEmit
pnpm --filter @repo/pong build       # vite build
pnpm --filter @repo/pong test        # curve + input continuity invariants
pnpm --filter @repo/pong preview     # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

Flick sideways just as the ball meets your paddle to curve a return. Hand, mouse,
touch, and stick use the same move. A still paddle keeps the original return;
curves keep rally speed and end after half a second or a wall bank. First to 7.

Reduced motion follows the system preference: static camera, no inversion flash,
shorter trails, and still score/callout feedback.

| Input                              | Action           |
| ---------------------------------- | ---------------- |
| ✋ hand (mouse, finger, pad stick) | steer the paddle |
| ✊ fist (click, tap, pad A)        | serve · rematch  |
| M · 🔊 button                      | mute             |
| Escape · ⏸ button                  | pause            |

Hand tracking costs ~17 MB of third-party wasm + model and a camera prompt, so it never loads during boot: a desktop starts it after first paint, a touch device opts in by tapping the "TAP FOR HAND CONTROL" pill. Instruction copy only advertises ✋/✊ while tracking is actually live.

Multiplayer: auto-joins the shared `pong-default` room (2 players max) for a live 1v1; solo fallback (vs AI paddle) when the party server is unreachable or nobody else is around, and a tap during the handshake starts that solo game immediately.
