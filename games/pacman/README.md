# Pacman

Three.js maze chase restyled as a Baymax-like plush clinic, driven by webcam face control (open mouth to chomp, turn head to steer, via MediaPipe FaceLandmarker) with keyboard/touch/pad fallbacks; online multiplayer via `@vibedgames/multiplayer` shows other pacs in the same maze. Deployed at `pacman.vibedgames.com`.

## Develop

```bash
pnpm dev:pacman   # http://localhost:5186
pnpm --filter @repo/pacman typecheck   # tsc --noEmit
pnpm --filter @repo/pacman build       # vite build
pnpm --filter @repo/pacman preview     # vite preview
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Controls

| Input                                               | Action               |
| --------------------------------------------------- | -------------------- |
| 📷 open mouth (Space, swipe ↑, pad A)               | chomp                |
| 📷 turn head (← →, swipe, pad d-pad/stick)          | turn                 |
| ↓ / swipe ↓                                         | reverse              |
| Shift (pad LB, touch 🤳)                            | selfie cam           |
| M (touch 🔊)                                        | mute                 |
| Escape (touch ⏸)                                    | pause                |
| R / click / tap / any swipe on a banner (pad Start) | restart              |
| tap the porthole                                    | face camera on / off |

On touch the porthole boots as a pill and the face camera starts on the tap that opens it — phones only grant `getUserMedia` inside a gesture, and nothing of the ~6 MB face stack is fetched until then.

Multiplayer: auto-joins the shared `pacman-default` room (up to 4 players), solo fallback when the party server is unreachable.
