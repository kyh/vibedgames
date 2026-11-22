# Google Play

Needs JDK 21 and the Android SDK (Android Studio brings both). `vg distribute
targets` prints the exact `export JAVA_HOME=…` / `export ANDROID_HOME=…` lines
when they are installed but not exported.

## What the shell already sets

`vg distribute android` writes these from `vibedgames.json` on every run:

- `versionName` and `versionCode` (from `version` and `build`).
- Immersive full screen (`MainActivity.java`): system bars hidden, a swipe
  from the edge shows them for a moment.
- `android:screenOrientation` when `orientation` is not `any`.
- `CAMERA` / `RECORD_AUDIO` from `permissions`, each with its hardware marked
  optional so Play does not hide the game from devices without it.
- Launcher icons (adaptive: the outer third of `icon` is cropped) and splash
  screens.

The project targets API 36, which Play requires of every new app and update.

## 1. Run it

```sh
npx cap run android                         # a running emulator or a plugged-in phone
adb exec-out screencap -p > shot.png
```

No device: `$ANDROID_HOME/emulator/emulator -list-avds`, then `emulator -avd
<name> -no-window &` and `adb wait-for-device`. Debug the web view at
`chrome://inspect`.

## 2. The upload key (once per app)

```sh
keytool -genkey -v -keystore ~/keys/my-game-upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias upload
```

Outside the repo, backed up, passwords in the person's password manager. Play
re-signs the app with its own key (Play App Signing), so this is only the
upload key, but every update must be signed with it.

## 3. Build the signed bundle

Raise `distribute.build`, build the game, run `vg distribute android`, then:

```sh
npx cap build android --androidreleasetype AAB \
  --keystorepath ~/keys/my-game-upload.jks --keystorepass "$KEYSTORE_PASS" \
  --keystorealias upload --keystorealiaspass "$KEY_PASS"
# → android/app/build/outputs/bundle/release/app-release-signed.aab
```

Play takes only `.aab` bundles for new apps.

## 4. What the person does, in a browser

1. Create a Play Console account and the app: name, language, **Game**, free
   or paid.
2. Fill in App content: privacy policy URL, ads, target audience, content
   rating questionnaire, data safety.
3. Upload the first `.aab` by hand (Testing → Internal testing → Create
   release). The publishing API cannot create an app or take its first build.
4. **Personal accounts created after 13 November 2023:** run a closed test
   with at least 12 testers opted in for 14 days in a row, then apply for
   production. Tell the person this on day one; it is the long pole.

Later uploads can be scripted against the Play Developer API with a service
account (`fastlane supply --aab … --track internal --json_key …`).

## 5. The listing

| Needed            | Notes                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Icon              | 512×512 PNG, up to 1 MB. Scale `icon.png` down                                                     |
| Feature graphic   | 1024×500 JPEG or PNG, no transparency                                                              |
| Phone screenshots | 2–8, each side 320–3840 px, long side at most twice the short. Games: 3+ at 1080×1920 or 1920×1080 |
| Short description | Up to 80 characters                                                                                |
| Full description  | Up to 4,000 characters                                                                             |

Screenshots: `adb exec-out screencap -p > play-1.png` mid-play on an emulator
whose screen is 1080 wide. Feature graphic: the `generate` skill at 1024×500
from a screenshot as the reference.

## What gets a game rejected

- A camera or microphone permission with no privacy policy that names it.
- A data safety form that says "no data collected" when the game talks to a
  multiplayer server.
- A target API below Play's floor: update Capacitor (`@capacitor/*` in
  `package.json`), delete `android/`, run `vg distribute android` again.
- A `versionCode` Play has already seen: raise `distribute.build`.
