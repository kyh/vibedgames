---
name: distribute
description: "Package a built browser game for somewhere other than vibedgames with `vg distribute`: a zip for web portals (itch.io, Newgrounds, CrazyGames, YouTube Playables), a native iOS app for the App Store, a native Android app for Google Play."
---

# Vibedgames Distribute

`vg deploy` puts a game at `{slug}.vibedgames.com`. `vg distribute` packages
the same build for everywhere else. It never uploads: every store and portal
ends at an account only the person owns, so each flow stops at a file, the
exact page to upload it to, and what to tell the person.

> **`vg` not on PATH?** Run each `vg <cmd>` as `npx -y vibedgames@latest <cmd>`.
> Nothing here needs a vibedgames login.

One subcommand per platform, named for it:

| Platform           | Command                          | Produces                                      | Then                              |
| ------------------ | -------------------------------- | --------------------------------------------- | --------------------------------- |
| itch.io            | `vg distribute itch`             | `distribute/<slug>-itch.zip`                  | `references/web-portals.md`       |
| Newgrounds         | `vg distribute newgrounds`       | `distribute/<slug>-newgrounds.zip`            | `references/web-portals.md`       |
| CrazyGames         | `vg distribute crazygames`       | `distribute/<slug>-crazygames.zip`            | `references/web-portals.md`       |
| Poki               | `vg distribute poki`             | `distribute/<slug>-poki.zip`                  | `references/web-portals.md`       |
| GameDistribution   | `vg distribute gamedistribution` | `distribute/<slug>-gamedistribution.zip`      | `references/web-portals.md`       |
| YouTube Playables  | `vg distribute youtube`          | the zip, with YouTube's SDK tag added         | `references/youtube-playables.md` |
| Any other web host | `vg distribute web`              | `distribute/<slug>-web.zip`                   | `references/web-portals.md`       |
| Apple App Store    | `vg distribute ios`              | `ios/App/App.xcodeproj` (needs a Mac + Xcode) | `references/app-store.md`         |
| Google Play        | `vg distribute android`          | `android/` Gradle project                     | `references/google-play.md`       |

`vg distribute targets --json` lists every platform with its limits and says
what this machine still lacks to build each store's app, with the fix.

## 1. Make the build portable first

Off vibedgames a game runs from a folder, inside someone else's page or app,
with nobody to sign in. Fix these in the game before packaging; `vg distribute
web` checks the ones a file can show.

- **Relative paths.** Vite: `base: "./"`. Reference files as `./name` or
  through an import, never `/name`: a portal serves the game from
  `/some/folder/`, where `/name` is a 404. This is the `root-relative-url`
  error.
- **Play without the network.** The `hosts` list in the result is every other
  host the build reaches. A portal or an app reviewer may block any of them, so
  a failed request must degrade (multiplayer falls back to solo, a CDN model
  becomes an optional feature), never a blank screen.
- **Touch works.** Stores review on phones, and most portal traffic is mobile.
  The `gamepad` skill adds touch controls.
- **Storage and devices are best-effort.** Wrap `localStorage` in `try`/`catch`.
  A portal's iframe usually grants no camera or microphone, so those features
  need a fallback.
- **The game keeps its own pause and mute.** Outside the vibedgames play page
  nothing draws them for it.
- **No source maps** in the build you hand out (`source-maps` warning).

Then build: `npm run build`.

## 2. Web portals

```sh
vg distribute itch --json
```

Run it from the project root (it packs `dist/`, `build/` or `out/`) or pass the
build folder. Each portal's command checks that portal's published limits;
`web` checks only what every folder-hosted, framed game must pass. The zip
has `index.html` at its root, which every portal requires, and the same build
always packs to the same bytes.

```json
{
  "ok": true,
  "zip": "/abs/project/distribute/my-game-itch.zip",
  "bytes": 587578,
  "files": 4,
  "hosts": ["party.vibedgames.com"],
  "findings": [],
  "platform": "itch",
  "submit_url": "https://itch.io/game/new"
}
```

Exit 1 with `"ok": false` and `"zip": null` when a finding has `"level":
"error"`: fix it and run again. A `warning` is packed anyway; read it out to
the person. Finding ids: `no-index`, `root-relative-url`, `too-many-files`,
`build-too-large`, `file-too-large`, `path-too-long`, `case-collision`,
`zip-too-large`, `bad-file-name`, `sdk-not-called`, `source-maps`,
`remote-hosts`, `sdk-required`.

Before handing over the zip, prove it plays the way the portal serves it.
`--preview` packs, then keeps serving, so run it in the background:

```sh
vg distribute itch --preview --json &   # {..., "preview": {"url": "http://localhost:8472/", ...}}
vg playtest open http://localhost:8472/
vg playtest errors                 # must be empty
vg playtest screenshot portal.png  # look at it
```

The preview unpacks the zip under a folder, frames it from another origin,
and for a portal with a known SDK (YouTube) serves the portal's CSP and a
stand-in SDK. The per-portal rules and the listing art each one wants:
`references/web-portals.md`.

Start with **itch.io or Newgrounds**: anyone can upload and the game is live at
once. CrazyGames reviews first. Poki and GameDistribution need their SDK built
in, and Poki is exclusive on the web; do not send a game there without asking.
YouTube Playables is invite-only and needs code changes in the game, not just
a zip: `references/youtube-playables.md`.

## 3. Native apps

A native app is the same build inside a Capacitor shell. Everything about the
shell comes from the `distribute` block of `vibedgames.json`:

```json
{
  "slug": "my-game",
  "name": "My Game",
  "distribute": {
    "appId": "com.yourstudio.mygame",
    "version": "1.0.0",
    "build": 1,
    "orientation": "any",
    "backgroundColor": "#101010",
    "icon": "icon.png",
    "permissions": { "camera": "Steer by moving your hand in front of the camera." }
  }
}
```

| Field             | Meaning                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`           | Reverse-DNS id. **Permanent** once the app is in a store, and it should sit under a domain the person owns. Ask; do not invent one.            |
| `version`         | What players see. Raise it for each release.                                                                                                   |
| `build`           | Whole number. Raise it for **every upload**: both stores refuse a number they have seen.                                                       |
| `orientation`     | `any`, `portrait` or `landscape`. Lock it only if the game truly cannot rotate.                                                                |
| `backgroundColor` | `#rrggbb` shown while the game loads and behind the splash logo. Match the game's own background.                                              |
| `icon`            | Square PNG, 1024px or more, no transparency. Default `icon.png` in the project root. Keep the subject in the middle two thirds: Android crops. |
| `permissions`     | `camera` / `microphone`, each the sentence the OS shows when it asks. Declare only what the game uses; an unused one gets an app rejected.     |

```sh
vg distribute ios --app-id com.yourstudio.mygame --json   # first run saves the id
vg distribute android --json
```

Each run installs Capacitor if the project lacks it, creates `ios/` or
`android/` if missing, copies the current build in, and rewrites identity,
version, orientation, permissions, icons and splash screens from
`vibedgames.json`. **Run it again after every build and every config change.**
Do not hand-edit what it manages (`Info.plist` keys, the manifest's
`vg:distribute` block, `MainActivity.java`, `capacitor.config.json`): the next
run overwrites it. Commit `ios/` and `android/`.

```json
{
  "platform": "ios",
  "app_id": "com.yourstudio.mygame",
  "version": "1.0.0",
  "build": 1,
  "icon": true,
  "project": "/abs/project/ios/App/App.xcodeproj",
  "toolchain_missing": [],
  "next": ["npx cap run ios", "npx cap open ios"]
}
```

- `"icon": false` means the placeholder icon is still in place. No store
  accepts it. Make one (the `generate` skill; ask for a square app icon, full
  bleed, no text, no transparency), save it as `icon.png`, run again.
- `toolchain_missing` lists what to install or export before the project can
  be built here; each entry is the fix.

Run it before you call it done. A shell that builds can still show a blank
web view:

```sh
npx cap run ios --target "$(xcrun simctl list devices available | grep -m1 -oE '[0-9A-F-]{36}')"
xcrun simctl io booted screenshot shot.png     # look at it: the game, edge to edge

npx cap run android                            # an emulator or a plugged-in phone
adb exec-out screencap -p > shot.png
```

Release builds, signing, upload and the store listing:
`references/app-store.md` and `references/google-play.md`.

## What only the person can do

Say this up front, not after the build:

- **Apple:** a paid Apple Developer membership, the app record in App Store
  Connect, the listing (privacy policy URL, age rating, screenshots), and
  pressing Submit. Review usually takes a day or two.
- **Google:** a Play Console account, the app record, the content forms, and
  the first upload by hand. A personal account created after November 2023
  must also run a closed test with 12 testers for 14 days before production.
- **Portals:** an account on each, and the upload itself.

Each game goes out under its owner's own account. Apple rejects apps
submitted by a service on someone else's behalf (guideline 4.2.6).

## Rules

- **Never upload or submit on your own.** Stop at the artifact and the URL.
- **Never pick the `appId` for the person**, and never change it after a store
  has seen it: that is a different app.
- **Raise `build` before every store upload.**
- **A native app must be a game, not a web page in a box.** Apple rejects
  "repackaged websites" (4.2): the build is bundled in the app, so it must play
  with no network, fill the screen, and have no links out to a site.
- **Keystores and `.p8` keys never go in the repo.** Losing an Android upload
  key means asking Google to reset it; leaking one lets anyone ship as you.

## Troubleshooting

- **`No app id yet`** → pass `--app-id` once; it is saved to `vibedgames.json`.
- **`no build output`** → run the project's build; the source `index.html` cannot ship.
- **`The game must sit in its own folder`** → a plain-HTML game: move it into `dist/` so the shell has one folder to copy.
- **`capacitor.config.ts is in the way`** → move its settings into `capacitor.config.json` and delete it.
- **`android/ was created as …`** → the `appId` changed; delete `android/` and run again.
- **Blank screen in the app, fine in the browser** → an absolute path or a request the shell blocks. Open Safari → Develop → Simulator (or `chrome://inspect` for Android) and read the console.
- **Old game in the app** → you built but did not re-run `vg distribute <platform>`.
- **Portal shows a 403 or a file listing** → the zip was made by hand with a folder at its root. Use the zip this command wrote.
