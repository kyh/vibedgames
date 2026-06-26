---
name: capacitor-ios
description: "Build and ship Three.js apps on Capacitor iOS with Vite and Swift Package Manager: GLTF loading, assets_index animation UI, OrbitControls mouse/touch mappings, and iOS sync/run troubleshooting."
---

# Three.js Capacitor iOS

Ship a Three.js + Vite app in an iOS native shell via Capacitor. Two runtimes — web renderer (Three.js + Vite) and native wrapper (Capacitor iOS) — must agree on an explicit, testable contract: web output dir, animation names, build output, iOS package manager. Most breakage is an implicit contract.

**Before implementing, confirm:**

- Web output dir (`dist` or `www`) matches Capacitor `webDir`.
- Animation names come from data (`assets_index.json`), not hardcoded strings.
- iOS uses SPM (default on Capacitor 8+) unless a plugin forces CocoaPods.
- Mouse and touch controls are mapped intentionally, not left to defaults.

## Quick Start Workflow

1. Build with Vite (`npm run build`).
2. Keep static assets under `public/` and load via absolute URLs (`/assets/...`).
3. Configure Capacitor with `webDir: "dist"`.
4. Add iOS with SPM: `npx cap add ios --packagemanager SPM`.
5. Day-to-day loop: `npm run build` → `npx cap sync ios` → `npx cap run ios` (or `npx cap open ios`).

Command details: `references/capacitor-ios-spm-workflow.md`.

## Implementation Guidelines

### 1) Project Shape

- `index.html` + `src/*` for app code
- `public/assets/...` for GLBs and JSON contracts
- `capacitor.config.ts` with `webDir: "dist"`

Runtime fetches must work in both browser and WKWebView: use `fetch('/assets/assets_index.json')`, not filesystem or environment-specific base URLs.

### 2) Animation Contract via `assets_index.json`

One source of truth: skeleton URL, animation source URL, and `animations[]` entries with a stable app id (`idle`, `walk`, `run`), `sourceClipName` (exact `AnimationClip.name`), and loop mode/defaults.

Runtime: load index JSON → load skeleton GLB + animation GLB → resolve each UI button to a clip by `sourceClipName` → build `AnimationAction` map keyed by app id → play default action. See `references/threejs-animation-index-pattern.md`.

### 3) Controls: Desktop and Touch

Use `OrbitControls` with explicit `mouseButtons` and `touches`:

- Mouse: left = rotate, wheel = dolly/zoom, right = pan
- Touch: one-finger = rotate, two-finger = dolly + pan

For vertical-only pan, constrain target/camera translation *after* `controls.update()` each frame — don't change rotate/zoom semantics.

### 4) Performance and Stability Guardrails

- Cap pixel ratio: `Math.min(devicePixelRatio, 2)`.
- Reuse mixer/actions; don't recreate per click.
- On resize, update camera aspect, projection, and renderer size.
- Use fade transitions from metadata defaults when switching animations.

### 5) Capacitor iOS Integration

SPM by default on Capacitor 8+; migrate existing CocoaPods projects intentionally. Re-run `npx cap sync ios` after native-side or plugin changes.

## Anti-Patterns

- **Hardcoding clip names in UI handlers** — a renamed clip silently breaks buttons. Resolve from `assets_index.json` once at startup.
- **Mixing SPM and CocoaPods** — dependency drift, broken Xcode expectations. One package manager per project; prefer SPM.
- **Running iOS without rebuilding web assets** — simulator shows stale JS/CSS. Always build before `cap sync`/`cap run`.
- **Implicit control mappings** — desktop/mobile diverge from UX. Set `mouseButtons` and `touches` explicitly.
- **Debugging native first for web contract errors** — usually missing JSON keys, bad paths, or unresolved clips. Add startup assertions/logs for index shape and clip resolution.

## Variation Guidance

Don't converge on a generic "orbit + three buttons" viewer. Vary by product intent: character showcase (richer lighting, slow damping, idle emphasis), gameplay prototype (fast transitions, state-driven switching, minimal UI), asset QA tool (diagnostics overlay, clip length/track info, missing-clip warnings). Tune at least visual style, input feel (damping/zoom/pan speeds), and animation UX (buttons, shortcuts, auto-play).

## Resource Map

- `references/capacitor-ios-spm-workflow.md` — iOS setup, migration, run commands
- `references/threejs-animation-index-pattern.md` — index contract + runtime loading
- `references/gotchas.md` — high-frequency failures and fixes
