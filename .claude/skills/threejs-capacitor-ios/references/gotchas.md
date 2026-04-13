# Gotchas and Fast Fixes

## 1) "It works in browser but not simulator"

Common causes:
- stale native web assets
- incorrect `webDir`
- bad static asset path

Fix:
1. `npm run build`
2. `npx cap sync ios`
3. confirm `capacitor.config.*` uses `webDir: 'dist'`
4. use `/assets/...` URLs for files under `public/assets`

## 2) "Animation button does nothing"

Common causes:
- `sourceClipName` mismatch
- clip exists in different GLB than expected

Fix:
- inspect available clips
- compare exact string names
- warn at startup for unresolved entries

## 3) "Pan behavior feels wrong on touch"

Common causes:
- default `OrbitControls` mappings not aligned with UX
- custom pan constraint applied before `controls.update()`

Fix:
- set both `mouseButtons` and `touches` explicitly
- apply custom pan constraint after update in render loop

## 4) "Capacitor asks for CocoaPods"

Common causes:
- project created on older Capacitor template
- mixed dependency manager assumptions

Fix:
- move to Capacitor 8+
- use `npx cap add ios --packagemanager SPM`
- keep one iOS dependency manager strategy per project

## 5) "Xcode project confusion"

Rule of thumb:
- CocoaPods projects typically use workspace files.
- SPM projects use package dependencies and SPM scaffolding.

Use `npx cap open ios` to open the right project shape for the current template.
