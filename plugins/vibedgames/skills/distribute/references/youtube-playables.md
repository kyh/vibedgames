# YouTube Playables

Games played inside YouTube, on the web and in the YouTube app. It is the one
portal here that needs changes in the game itself: YouTube decides when it
runs, when it makes sound and where it saves, and it blocks every other host.

## Access: ask first

Early access, by invitation. A YouTube channel must be onboarded to Playables
before anything can be uploaded; the person applies through YouTube's interest
form, linked from https://developers.google.com/youtube/gaming/playables. Say
this before doing the work. Everything below can be built and verified
without an invite.

## What YouTube requires of the game

| Requirement                                                                         | How                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Load the SDK, `https://www.youtube.com/game_api/v1`, before any game code           | Nothing: `vg distribute youtube` adds the tag to the packaged `index.html` |
| `ytgame.game.firstFrameReady()` once the first frame shows                          | After the first render                                                     |
| `ytgame.game.gameReady()` once the player can act (no loading screen)               | After `firstFrameReady`, when the title or first screen accepts input      |
| Stop **everything** on `ytgame.system.onPause`, until `onResume`                    | Skip update and render in the frame loop; it can arrive before play starts |
| Sound only while `ytgame.system.isAudioEnabled()`, following `onAudioEnabledChange` | Drive the game's mute from it                                              |
| No in-game mute control                                                             | Hide the mute button and key inside Playables                              |
| Save progress only with `ytgame.game.saveData(string)`, after `await loadData()`    | Under 3 MiB. No `localStorage` for progress                                |
| No request to any other host (CSP `connect-src 'self'`, no iframes)                 | Bundle every asset. Multiplayer, analytics and CDN models switch off       |
| Touch **and** mouse for everything; never `preventDefault()` on Escape              |                                                                            |
| Any aspect ratio, no orientation lock                                               | Letterbox or pillarbox                                                     |
| No external links, no exit button, no sharing prompts, English supported            |                                                                            |
| No language from `navigator.languages`                                              | `await ytgame.system.getLanguage()`                                        |

Packaging limits, which `vg distribute youtube` enforces: under
250 MiB in all, every file under 30 MiB, at most 8,000 files, file names of
letters, digits, `_`, `-` and `.` only, relative paths. YouTube also wants the
game playable within 5 seconds and under 30 MiB loaded before `gameReady`;
the command cannot measure those, so check the preview's network panel.

The CLI fails the package (`sdk-not-called`) if the build never calls
`firstFrameReady`, `gameReady`, `onPause`, `onResume` and `isAudioEnabled`.

## Wiring it in

Outside YouTube there is no `ytgame`, and the game must behave exactly as
before. Guard on `IN_PLAYABLES_ENV`:

```ts
interface YtGame {
  IN_PLAYABLES_ENV: boolean;
  game: {
    firstFrameReady(): void;
    gameReady(): void;
    loadData(): Promise<string>;
    saveData(data: string): Promise<void>;
  };
  system: {
    isAudioEnabled(): boolean;
    onAudioEnabledChange(cb: (enabled: boolean) => void): () => void;
    onPause(cb: () => void): () => void;
    onResume(cb: () => void): () => void;
  };
}
declare global {
  interface Window {
    ytgame?: YtGame;
  }
}

const yt = window.ytgame?.IN_PLAYABLES_ENV ? window.ytgame : null;

let systemPaused = false;
if (yt) {
  yt.system.onPause(() => {
    systemPaused = true;
    // also pause the game's own way, so the player returns to a pause screen
  });
  yt.system.onResume(() => {
    systemPaused = false;
  });
  setMuted(!yt.system.isAudioEnabled());
  yt.system.onAudioEnabledChange((enabled) => setMuted(!enabled));
}

let ready = false;
function frame() {
  requestAnimationFrame(frame);
  if (systemPaused) return;
  update();
  render();
  if (yt && !ready) {
    ready = true;
    yt.game.firstFrameReady();
    yt.game.gameReady(); // or later, once a loading screen is gone
  }
}
```

Saves:

```ts
const saved = yt ? await yt.game.loadData() : localStorageGet("save");
// ...
if (yt) await yt.game.saveData(JSON.stringify(progress));
```

In Phaser, check `systemPaused` at the top of the scene's `update`, and call
`this.game.loop.sleep()` / `wake()` from onPause and onResume to stop
rendering as well.

Multiplayer games: start offline when `yt` is set rather than letting the
connection fail. A failed WebSocket logs a CSP error YouTube's review sees. A
`@vibedgames/multiplayer` client takes `offline: true`.

## Prove it before an invite

```sh
npm run build
vg distribute youtube --preview --json &
vg playtest open http://localhost:8472/
```

The preview serves the game under YouTube's own CSP, with a stand-in for the
SDK. The page shows buttons for YouTube pause, YouTube resume and audio
on/off, plus the stand-in's call log, which is also on the page as
`window.vgPreview`:

```sh
vg playtest eval "JSON.stringify(window.vgPreview.log)"
# {"calls":["system.isAudioEnabled",...,"game.firstFrameReady","game.gameReady"],"errors":[],"save":null}
vg playtest eval "window.vgPreview.pause()"      # the game must freeze: screenshot twice, compare
vg playtest eval "window.vgPreview.resume()"
vg playtest eval "window.vgPreview.setAudio(false)"
vg playtest network requests                     # nothing but localhost / 127.0.0.1
```

`log.errors` must stay empty. The stand-in records a call out of order
(`gameReady` before `firstFrameReady`), `saveData` before `loadData`, a save
over 3 MiB, any page error, and every request the CSP blocks.

The stand-in is not YouTube. Once the channel is onboarded, the Playables
portal's Test step links each uploaded release to YouTube's own test suite.
Run that too.

## Submitting (the person)

1. Playables portal, https://www.youtube.com/playables_portal, from a channel
   they manage that has been onboarded.
2. Add a new game, upload the zip, entry point `index.html`.
3. Title, description, genre, languages, one thumbnail per aspect ratio (no
   logos or text in thumbnails), IARC age rating.
4. Run the linked test suite, then submit for review.

Content must suit ages 13 and up and not target children. Ads come from
YouTube's own SDK only; no other monetisation.
