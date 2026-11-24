# Loading: from link to playable

A stranger decides within seconds whether to wait. The first visit is cold:
empty browser cache, empty shader cache, an ordinary connection.

## On vibedgames, the host already does part of this

A game deployed with `vg deploy` is served from `{slug}.vibedgames.com` with:

- `index.html` cached 60 s; every other file under the deployment cached for
  a year as immutable (each deploy has its own path, so a new deploy never
  mixes with an old one);
- text compressed by the edge, and GLB/glTF/wasm gzipped by the games Worker
  on request, so **do not precompress** files yourself;
- a small injected script that reloads the page when a newer deployment is
  live and the tab returns after five or more minutes hidden. **Save the
  player's progress** (settings, run state) to `localStorage` so that reload
  costs nothing.

Hashed filenames (Vite's default) still matter for anything you host
elsewhere, and for `vg distribute` portal builds.

## Rules

- **The first frame is the game's own picture** and needs no fetch: inline a
  small key-art background, the title in CSS, and a progress element in
  `index.html`, so the very first paint looks like the game.
- **One loading screen, before the menu.** When the menu appears, pressing
  Play starts play with no second wait. In a match game, the lobby and
  countdown are the second loading screen: stream and compile the map there,
  and start the countdown only once the map is shown.
- **What the player sees first loads first**: their own character, their
  weapon or tool, the first level, the first sounds. Nothing appears as a
  stand-in or an empty hand.
- **Budget the bytes before the menu** at a stated connection (e.g. ≤ 8 MB
  to title on fast 4G), measure it on every build with a cold cache and a
  throttled network, and only let it go down without a named decision.
- **Few request waves.** Discover dependencies early (`<link rel=preload>`
  or `modulepreload` for the entry chunks and first textures) so requests go
  out in parallel, not in a chain of import → fetch → parse → fetch.
- **Ship only what the game requests.** Build a manifest from a real run
  (every URL fetched, its size, which tier needs it) and delete anything not
  in it from `dist/`.

## The progress bar tells the truth

- It follows bytes received plus weighted non-network work (decode, compile),
  climbs in small even steps, never goes backward, never stands still long
  enough to look frozen, and reads 100 only when play can start.
- Shader warm-up is part of loading. Show it on the bar.

## Failure and stalls

- Every fetch has a timeout and a retry with backoff.
- A **byte deadline**, not a time deadline: a slow load that is still
  receiving bytes continues; one that stopped receiving for ~10 s is a stall,
  reported by name ("waiting on level2.glb"), and ends on a Retry button,
  never an automatic page reload.
- Loading keeps going in a background tab (don't gate it on
  `requestAnimationFrame`).

## Decode off the main thread

Use `createImageBitmap` (or the loader's worker path: `KTX2Loader` with
transcoder workers, `DRACOLoader`/`MeshoptDecoder`) so no decode blocks a
frame. Change quality tier and pixel ratio at runtime, never by reloading.

## Measure

```bash
# cold load through the playtest browser with network throttled
vg playtest open "https://<slug>.vibedgames.com/?nocache=$(date +%s)"
vg playtest network requests --json   # count waves, total bytes before title
```

Record: time to first paint, time to interactive title, time to first
controllable frame, bytes before title, request count, longest chain.
