# Stability: zero crashes, proven

The release bar is zero crashes across full sessions on every target device
and browser. A freeze, a self-reload, an automatic recovery and a load that
timed out all count as crashes.

## Find them

- **Soak, don't smoke.** Run many complete sessions with real input, long
  enough to reach late-game states (boss, wave 20, the tenth level switch),
  and count crashes per hundred sessions. A bot that plays
  (`vg playtest run`, or a scripted input loop from `playtest`) is the cheap
  way to get there.
- **Crash reports survive the reload.** On `error` and `unhandledrejection`,
  write a record to `localStorage` before the page dies: message, stack, build
  id (the deployment id), device, screen, the last ~50 game events. Send it
  on the next load and clear it only once sent. Without a report endpoint,
  surface it in a "last session crashed" note the person can copy.

## Remove them by structure

Each crash class gets a guard in the structure, not a patch on the one case:

- **Every fixed-size pool is named and counted**: particles, decals, lights,
  audio voices, touch slots, instance buffers. Each has a declared size, a live
  count, a recorded peak, and a warning before it fills. On overflow, drop the
  lowest-priority item and log which pool.
- **No late timer moves the game.** Once play starts, boot timers, loaders
  and deferred callbacks cannot change mode. Cancel them on state change.
- **Nothing falls back silently.** A missing file is an error the player can
  read, never a guessed substitute. A fallback renderer or reduced mode is
  shown, and keeps every feature.
- **One composite per frame.** Nothing draws to the canvas after the final
  full-screen pass, so no frame shows half a picture.
- **The game survives losing the GPU.** Handle `webglcontextlost` /
  `webglcontextrestored` (or WebGPU `device.lost`): restore, or show a
  one-tap resume card. Never a frozen frame.
- **The watchdog tells slow from hung.** It measures progress (bytes, load
  steps, compiles, frames ticked), keeps a slow but moving load going, trips
  only on a real hang, names what it was waiting on, and never reloads the
  page by itself.
- **Recovery never loops.** At most one automatic recovery per session, back
  to a known screen.

## Builds

- **Dev commands are absent from public builds.** No URL parameter, console
  global or key that grants items, skips progress or disables a check. Guard
  with `import.meta.env.DEV` so the bundler removes them. Test hooks that
  must ship (`__GAME_DIAGNOSTICS__`) are read-only.
- **Boot the fallback path on every change to defaults**: if the game prefers
  WebGPU, a gate also boots and plays it on WebGL2, and records which backend
  it got.
- **Check the served build after every deploy.** `vg deploy --json` returns
  the URL; open it in `vg playtest`, confirm `/__vg/version` matches the
  deployment id you just published, and play the first minute.
