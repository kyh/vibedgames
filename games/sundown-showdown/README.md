# Sundown Showdown

3D top-down battle royale brawler (Three.js): pick one of four brawlers, drop into a
procedurally laid-out arena with seven bots, and be the last one standing while the
sun sets and the poison gas closes in. Single-player. Deployed at
`sundown-showdown.vibedgames.com`.

## Develop

```bash
pnpm dev:sundown-showdown   # http://localhost:5195
pnpm --filter @repo/sundown-showdown typecheck   # tsc --noEmit
pnpm --filter @repo/sundown-showdown build       # vite build
pnpm --filter @repo/sundown-showdown preview     # vite preview
pnpm --filter @repo/sundown-showdown test        # headless config/utils smoke checks (tools/boot-smoke.mts, no three.js)
```

## Routes

| URL | What     |
| --- | -------- |
| `/` | the game |

## Options

| Param             | Effect                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| `?q=<quality>`    | `low` / `medium` / `high` / `ultra`; disables the automatic GPU benchmark       |
| `?bots=<level>`   | bot difficulty: `easy` / `normal` / `hard`                                      |
| `?time=<hour>`    | pin the time of day (0–24, e.g. `19.4` for dusk) instead of following the match |
| `?seed=<int>`     | deterministic arena layout for the first match                                  |
| `?auto=<brawler>` | skip the menu and start as `dusty` / `ace` / `fuse` / `titan`                   |
| `?zoom=<factor>`  | camera distance multiplier (default `1`)                                        |
| `?speed=<n>`      | simulation steps per rendered frame, 1–16 (fast-forward for tests)              |
| `?ss=<factor>`    | supersample factor 0–3, overriding the quality tier's pixel ratio               |

## Controls

| Input                              | Action                                  |
| ---------------------------------- | --------------------------------------- |
| WASD (left thumb)                  | move                                    |
| Mouse (right thumb drag)           | aim                                     |
| Click (release the right thumb)    | shoot                                   |
| Tap                                | auto-aim shot (touch)                   |
| Space / Right-click (SUPER button) | hold to aim the super, release to fire  |
| T                                  | cycle time of day (noon → dusk → night) |
| P                                  | pause                                   |
| M                                  | mute                                    |
| ⚙                                  | settings: quality, bots, time, effects  |

## Rendering

A custom pipeline on top of three.js: a PCSS soft-shadow patch for the sun and the
street lamps (falling back to PCF on the low tier), GTAO ambient occlusion, bloom, a
grade pass, and a time-of-day lighting rig that drives the sun, sky, fog, lamp
pool and fireflies from afternoon to night as the match progresses. Quality is
picked automatically from a startup benchmark and stepped down in play when the
frame rate drops, unless the player chooses a tier under ⚙.

No multiplayer yet.
