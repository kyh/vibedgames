# Web portals

## Prove the zip before it leaves

A portal unpacks the zip under a path of its choosing and frames it from its
own origin. `--preview` on any portal's command reproduces exactly that, after
packing:

```sh
vg distribute itch --preview --json &
# {"ok": true, "zip": "...", "preview": {"url": "http://localhost:8472/", "game_url": "http://127.0.0.1:8471/play/index.html", ...}}

vg playtest open http://localhost:8472/
vg playtest errors                 # must be empty
vg playtest network requests       # no 4xx
vg playtest screenshot portal.png  # look at it
```

`localhost` and `127.0.0.1` are different origins, so the game is truly
cross-origin framed. `--port` moves both ports if 8471–8472 are taken. Stop the
preview when done. Check on a phone-sized viewport too (`vg playtest set
viewport 393 852`): the pause and mute controls must still be on screen.

## The portals

Limits below are the ones each portal publishes; `vg distribute <portal>`
enforces them. "—" means the portal names none.

| `vg distribute …`  | Who can publish                                        | Files | Unpacked                         | Per file | SDK                            | Upload                                    |
| ------------------ | ------------------------------------------------------ | ----- | -------------------------------- | -------- | ------------------------------ | ----------------------------------------- |
| `itch`             | Anyone, live at once                                   | 1,000 | 500 MB                           | 200 MB   | No                             | https://itch.io/game/new                  |
| `newgrounds`       | Anyone, live at once; players vote on it staying       | —     | per account                      | —        | No                             | https://www.newgrounds.com/projects/games |
| `crazygames`       | Reviewed first                                         | 1,500 | 250 MB (50 MB without their SDK) | —        | Optional                       | https://developer.crazygames.com          |
| `poki`             | Curated, **exclusive on the web**                      | —     | —                                | —        | Required                       | https://developers.poki.com               |
| `gamedistribution` | Reviewed first                                         | —     | —                                | —        | Required                       | https://gamedistribution.com/developers   |
| `youtube`          | Invite only (early access); see `youtube-playables.md` | 8,000 | 250 MiB                          | 30 MiB   | Required, tag added by the CLI | https://www.youtube.com/playables_portal  |

Any other host that takes a zip (Game Jolt, Kongregate, your own server): `vg distribute web`.

### itch.io

1. New project → Kind of project: **HTML**.
2. Upload the zip → tick **This file will be played in the browser**.
3. Embed options: set the viewport (e.g. 960×540), tick **Fullscreen button**
   and **Mobile friendly** if the game has touch controls.
4. Paths are case-sensitive and at most 240 characters; requests to other
   hosts must be HTTPS.

From a shell, once the project exists: `butler push distribute/my-game-itch.zip
user/my-game:html5` (`BUTLER_API_KEY` for CI). The person still ticks "played
in the browser" once after the first push.

### Newgrounds

Project → upload the zip as the game file, set the frame's width and height.
Two submissions a day. It is live at once and then "under judgment": a low
score from players removes it, so a game that opens on a broken or empty
screen does not survive. The file size cap is per account and can be raised on
request.

### CrazyGames

Submitted, then reviewed. Without their SDK: under 50 MB in total, no ads, no
external sign-in. Whatever the size, the first playable moment must arrive
within 20 seconds, and it is tested in Chrome and Edge. Three covers are
required: 1920×1080, 800×1200 and 800×800.

### Poki

Not a self-serve upload. They choose games, require their SDK, block every
other host until they approve it one URL at a time (a multiplayer server
included), allow no links out, and require that the game is on no other web
portal. Raise all of that with the person before doing any work for it.

## Listing art

Every portal wants a cover and screenshots; sizes differ, so make them from
the game at the size asked for instead of scaling one image.

- Screenshots: `vg playtest set viewport <w> <h>` then `vg playtest
  screenshot`, mid-play, with nothing but the game on screen.
- Cover or thumbnail: the `generate` skill, from a screenshot as the
  reference, at the portal's exact pixel size.
- Text to prepare for the person: title, one-line pitch, a paragraph of
  description, controls, genre and tags.
