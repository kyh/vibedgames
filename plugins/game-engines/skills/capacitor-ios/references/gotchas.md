# Gotchas and Fast Fixes

## 1) "Works in browser but not simulator"

Stale native assets, wrong `webDir`, or bad asset path. Fix:

1. `npm run build`
2. `npx cap sync ios`
3. confirm `capacitor.config.*` uses `webDir: 'dist'`
4. use `/assets/...` URLs for files under `public/assets`

## 2) "Animation button does nothing"

`sourceClipName` mismatch, or clip lives in a different GLB. Inspect available clips, compare exact string names, warn at startup for unresolved entries.

## 3) "Pan feels wrong on touch"

Default `OrbitControls` mappings don't match UX, or custom pan constraint applied before `controls.update()`. Set both `mouseButtons` and `touches` explicitly; apply pan constraint *after* update in the render loop.

## 4) "Capacitor asks for CocoaPods"

Project created on an older template, or mixed dependency managers. Move to Capacitor 8+, use `npx cap add ios --packagemanager SPM`, keep one iOS dependency manager per project.

## 5) "Xcode project confusion"

CocoaPods projects use workspace files; SPM projects use package dependencies + SPM scaffolding. Use `npx cap open ios` to open the right shape for the current template.
