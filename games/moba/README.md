# Ancients of Eldermoor

Keyboard-first action MOBA (Phaser): two-lane two-island map, 6 heroes, creep waves, towers, jungle camps. Deployed at `moba.vibedgames.com`.

## Develop

```bash
pnpm dev:moba                        # http://localhost:5182
pnpm --filter @repo/moba typecheck
pnpm --filter @repo/moba build
pnpm --filter @repo/moba test        # headless sim smoke + pure net/presentation tests (tools/)
```

## Routes

| URL               | What                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `/`               | the game                                                                                     |
| `/?trailer=1`     | scripted gameplay trailer — rolls on its own (`&loop=1` replays, Esc exits, click for sound) |
| `/?viewer=1`      | character showcase — pick any hero/creep/neutral, demo anims + abilities at a dummy          |
| `/?gallery=units` | asset gallery pages: `units`, `terrain`, `fx`, `map` (bare `?gallery` = units)               |

## Options

| Param        | Effect                                         |
| ------------ | ---------------------------------------------- |
| `?hero=<id>` | pre-select a hero on the menu                  |
| `?auto=1`    | skip the menu, start a match immediately       |
| `?online=1`  | with `?auto=1`, start the match in online mode |

Multiplayer: online matches auto-match into a shared room via `@vibedgames/multiplayer` (host-authoritative). The notice ribbon reads CONNECTING… until a room admits the client and RECONNECTING… while a dropped connection redials (the room holds the seat); if no room admits it within 8 s, the match is played against bots instead, as PLAY vs BOTS plays it. Guests send numbered inputs to the host alone and move their own hero the frame they press, running the sim's own movement code and easing in the host's corrections (`src/net/predict.ts`); the host streams what each 30 Hz sim step changed (`src/net/stream.ts`, ~1 KB a tick), stamped with the room's server clock, and every other body is drawn 100 ms behind the newest step the stream can deliver, interpolated (`src/net/mirror.ts`). A full keyframe in shared state serves late joiners; a promoted guest resumes from its own replica of the stream, and since every host stamps with the same clock the other guests play straight on into the new host's ticks. Rooms are namespaced by wire version (`moba-v3-…` in `src/net/protocol.ts`), so tabs on an older bundle never share a match with newer ones.
