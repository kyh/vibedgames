# Capacitor iOS SPM Workflow (Three.js Apps)

## Why SPM

Capacitor 8 supports and promotes Swift Package Manager for iOS dependency management.
Use SPM unless you have a plugin that explicitly requires CocoaPods.

## One-time Setup

From repo root:

```bash
npm install @capacitor/core@latest
npm install -D @capacitor/cli@latest @capacitor/ios@latest
```

If adding iOS for the first time:

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

Or open Xcode:

```bash
npx cap open ios
```

## Simulator Tips

List targets:

```bash
npx cap run ios --list
```

Run specific simulator:

```bash
npx cap run ios --target <TARGET_ID>
```

## Migrating from CocoaPods to SPM

Two practical options:
1. Recreate iOS platform with SPM template (`npx cap add ios --packagemanager SPM`) after backing up/removing old `ios/`.
2. Use migration helper:

```bash
npx cap spm-migration-assistant
```

Then reopen iOS project and verify package dependencies were added.

## Validation

Use doctor for dependency sanity:

```bash
npx cap doctor
```

Look for:
- matching `@capacitor/*` versions
- iOS status healthy
- sync writing `Package.swift` for plugins

## iOS Configuration Notes

For app permissions and capabilities:
- edit `ios/App/App/Info.plist`
- configure Signing & Capabilities in Xcode

Use official iOS configuration docs as source of truth.
