# Capacitor iOS SPM Workflow (Three.js Apps)

Capacitor 8 promotes Swift Package Manager for iOS. Use SPM unless a plugin explicitly requires CocoaPods.

## One-time Setup

From repo root:

```bash
npm install @capacitor/core@latest
npm install -D @capacitor/cli@latest @capacitor/ios@latest
```

Adding iOS for the first time:

```bash
npm run build
npx cap add ios --packagemanager SPM
npx cap sync ios
```

## Day-to-day Loop

```bash
npm run build
npx cap sync ios
npx cap run ios
```

Open Xcode instead: `npx cap open ios`.

## Simulator Tips

```bash
npx cap run ios --list                  # list targets
npx cap run ios --target <TARGET_ID>    # run a specific simulator
```

## Migrating from CocoaPods to SPM

Two options:

1. Recreate the iOS platform with the SPM template after backing up/removing old `ios/`: `npx cap add ios --packagemanager SPM`.
2. Migration helper: `npx cap spm-migration-assistant`.

Then reopen the iOS project and verify package dependencies were added.

## Validation

```bash
npx cap doctor
```

Check: matching `@capacitor/*` versions, iOS status healthy, sync writing `Package.swift` for plugins.

## iOS Configuration Notes

For permissions/capabilities: edit `ios/App/App/Info.plist`, configure Signing & Capabilities in Xcode. Use official iOS configuration docs as source of truth.
