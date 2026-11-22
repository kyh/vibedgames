# Apple App Store

Needs a Mac with Xcode 26 or later (Apple refuses uploads built with anything
older). `vg distribute targets` says whether this machine is ready.

## What the shell already sets

`vg distribute ios` writes these from `vibedgames.json` on every run:

- Bundle id, version (`MARKETING_VERSION`) and build (`CURRENT_PROJECT_VERSION`).
- Full screen, status bar hidden, the orientations asked for, on iPhone and iPad.
- `NSCameraUsageDescription` / `NSMicrophoneUsageDescription` from
  `permissions`. iOS kills an app that opens the camera without one.
- `ITSAppUsesNonExemptEncryption = false`, so uploads do not stop to ask about
  export compliance. True for a game that only uses HTTPS and WSS; if the game
  ships its own cryptography, set it by hand and answer Apple's questions.
- The app icon and splash screen from `icon`.

## 1. Run it

```sh
npx cap run ios --target <simulator-udid>      # xcrun simctl list devices available
xcrun simctl io booted screenshot shot.png
```

Debug the web view from Safari → Develop → Simulator.

## 2. What the person does first, in a browser

1. Join the Apple Developer Program and accept the current agreements.
2. Register the bundle id (`appId`) and create the app record in App Store
   Connect: name, primary language, bundle id, SKU. There is no API for this.
3. Create an App Store Connect API key (Users and Access → Integrations →
   Team Keys, role App Manager) and hand over the `.p8` file, its Key ID and
   the Issuer ID. Keep the `.p8` outside the repo.

## 3. Archive and upload

Raise `distribute.build`, build the game, run `vg distribute ios`, then:

```sh
cat > ExportOptions.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>TEAMID</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST

AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath /abs/path/AuthKey_KEYID.p8
  -authenticationKeyID KEYID
  -authenticationKeyIssuerID ISSUER-UUID)

xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/App.xcarchive \
  DEVELOPMENT_TEAM=TEAMID "${AUTH[@]}"

xcodebuild -exportArchive -archivePath build/App.xcarchive -exportPath build/export \
  -exportOptionsPlist ExportOptions.plist "${AUTH[@]}"
```

`destination: upload` sends the build straight to App Store Connect; it shows
under TestFlight after a few minutes of processing. `method` is spelled
`app-store-connect` (`app-store` is the retired name). This upload is the
outward-facing step: confirm with the person before running it.

## 4. The listing (the person, with what you prepare)

| Needed                | Notes                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Screenshots, iPhone   | 1–10, PNG or JPEG, no transparency. 1320×2868, 1290×2796 or 1260×2736 (or landscape)             |
| Screenshots, iPad     | Required because the shell runs on iPad: 2064×2752 or 2048×2732                                  |
| Name / subtitle       | 2–30 characters / up to 30                                                                       |
| Description, keywords | Up to 4,000 characters / 100 bytes, comma-separated                                              |
| Support URL           | Any page where a player can reach the developer                                                  |
| Privacy policy URL    | Required. It must cover the camera or microphone if the game asks for one                        |
| Age rating, category  | A questionnaire in App Store Connect                                                             |
| App Privacy answers   | What data the app collects. A multiplayer game that sends a name or id to a server collects that |

Take the screenshots from the simulator at the exact size, mid-play:

```sh
xcrun simctl boot "iPhone 16 Pro Max" && npx cap run ios --target <its-udid>
xcrun simctl io booted screenshot iphone-1.png      # 1320×2868
xcrun simctl boot "iPad Pro 13-inch (M4)" && npx cap run ios --target <its-udid>
xcrun simctl io booted screenshot ipad-1.png        # 2064×2752
```

## What gets a game rejected

- **4.2, minimum functionality.** A "repackaged website". The build is bundled
  in the app, so make that true in spirit: it plays offline, has no browser
  chrome, no links to a website, and nothing that reads as a web page.
- **2.5.2, downloaded code.** The app may not fetch code that changes what it
  does. Bundle scripts; fetch data only.
- **5.1.1, permissions.** A purpose string that does not say what the camera
  is for, or a permission the game never uses.
- **3.1.1, payments.** Anything sold inside the app must use Apple's in-app
  purchase. A web checkout link is a rejection.
- **4.2.6.** An app submitted by someone other than its owner. The person
  uploads from their own account.
- **Crashes and blank screens on iPad.** Reviewers test there. Run the iPad
  simulator before every submission.

Apps that use a required-reason API need a `PrivacyInfo.xcprivacy`. The bare
shell does not; a Capacitor plugin you add later might
(https://capacitorjs.com/docs/ios/privacy-manifest).
