---
name: threejs-capacitor-ios
description: "Build and ship Three.js apps on Capacitor iOS with Vite and Swift Package Manager: GLTF loading, assets_index animation UI, OrbitControls mouse/touch mappings, and iOS sync/run troubleshooting."
---

# Three.js Capacitor iOS

Build interactive Three.js apps that run in browser and ship in an iOS native shell via Capacitor.
This skill focuses on the integration boundary where most breakage happens: web build output, animation contracts, controls, and native sync/run workflow.

## Philosophy: Two Runtimes, One Contract

Treat the project as two systems that must agree:
- A web renderer runtime (Three.js + Vite)
- A native runtime wrapper (Capacitor iOS)

Most failures happen when their contract is implicit.
Make file paths, animation names, build output, and iOS package manager choices explicit and testable.

**Before implementing, ask:**
- What is the exact web output directory (`dist` or `www`) and does Capacitor `webDir` match it?
- Are animation names loaded from data (`assets_index.json`) instead of hardcoded strings?
- Is iOS using SPM or CocoaPods, and are plugin dependencies compatible with that choice?
- Are desktop and touch controls intentionally mapped, or left to defaults that may not match product UX?

**Core principles:**
1. Contract-first data flow: UI and animation playback should derive from JSON metadata, not ad-hoc clip names in code.
2. SPM-first iOS setup: on modern Capacitor, default to Swift Package Manager unless a specific plugin forces CocoaPods.
3. Symmetric controls: define mouse and touch mappings together so desktop and mobile behavior stay aligned.
4. Build-sync discipline: every native run depends on fresh web assets and sync.
5. Fast diagnosis: prefer small runtime checks for paths, clip names, and action resolution before deep debugging.

## Quick Start Workflow

1. Build the Three.js app with Vite (`npm run build`).
2. Keep static assets under `public/` and load via absolute URLs (`/assets/...`).
3. Configure Capacitor with `webDir: "dist"`.
4. Add iOS platform with SPM (`npx cap add ios --packagemanager SPM`).
5. Repeat day-to-day loop:
   - `npm run build`
   - `npx cap sync ios`
   - `npx cap run ios` or `npx cap open ios`

For command-level details, see `references/capacitor-ios-spm-workflow.md`.

## Implementation Guidelines

### 1) Project Shape

Prefer this shape for minimal ambiguity:
- `index.html` and `src/*` for app code
- `public/assets/...` for GLBs and JSON contracts
- `capacitor.config.ts` with `webDir: "dist"`

If using Vite, keep all runtime fetches compatible with both browser and WKWebView:
- Good: `fetch('/assets/assets_index.json')`
- Avoid: filesystem paths or environment-specific base URLs unless intentionally configured.

### 2) Animation Contract via `assets_index.json`

Use one source of truth:
- Character skeleton URL
- Animation source URL
- `animations[]` entries with:
  - stable app id (`idle`, `walk`, `run`)
  - `sourceClipName` (exact `AnimationClip.name`)
  - loop mode and defaults

Runtime pattern:
1. Load index JSON
2. Load skeleton GLB and animation GLB
3. Resolve each UI button to a clip by `sourceClipName`
4. Build `AnimationAction` map keyed by app id
5. Play default action from index

See `references/threejs-animation-index-pattern.md`.

### 3) Controls: Desktop and Touch

Use `OrbitControls` and set mappings explicitly:
- Mouse:
  - left = rotate
  - wheel = dolly/zoom
  - right = pan
- Touch:
  - one-finger = rotate
  - two-finger = dolly + pan

If product requires vertical-only pan, constrain target/camera translation after `controls.update()` each frame.
Do not silently change rotate/zoom semantics when adding this constraint.

### 4) Performance and Stability Guardrails

- Cap pixel ratio: `Math.min(devicePixelRatio, 2)`.
- Reuse mixer/actions; do not recreate per click.
- On resize, always update camera aspect, projection, and renderer size.
- Keep animation switching with fade transitions from metadata defaults.

### 5) Capacitor iOS Integration

Use SPM by default with Capacitor 8+.
For existing CocoaPods projects, migrate intentionally (assistant or recreate iOS platform).

After native-side changes or plugin changes, run `npx cap sync ios` again.

## Anti-Patterns to Avoid

❌ **Hardcoding clip names in UI handlers**
Why bad: a renamed clip in GLB silently breaks buttons.
Better: map buttons from `assets_index.json` and resolve clip names once at startup.

❌ **Mixing SPM and CocoaPods assumptions**
Why bad: dependency drift and broken Xcode project expectations.
Better: choose one package manager per project; for modern setups prefer SPM.

❌ **Running iOS without rebuilding web assets**
Why bad: simulator shows stale JS/CSS and debugging becomes misleading.
Better: use scripts that always build before `cap sync`/`cap run`.

❌ **Leaving control mappings implicit**
Why bad: desktop and mobile interaction diverge from UX requirements.
Better: set `mouseButtons` and `touches` explicitly in code.

❌ **Debugging native first for web contract errors**
Why bad: wastes time in Xcode when issue is usually missing JSON keys, bad paths, or unresolved clips.
Better: add startup assertions/logs for index shape and clip resolution.

## Variation Guidance

**IMPORTANT**: Do not produce identical viewers by default.
Adjust implementation to the product intent:
- Character showcase: richer lighting, slower camera damping, emphasis on idle loop.
- Gameplay prototype: fast transitions, state-driven animation switching, minimal UI chrome.
- Asset QA tool: diagnostics overlay, clip length/track info, missing-clip warnings surfaced clearly.

Vary at least these dimensions intentionally:
- Visual style (lighting/background/floor treatment)
- Input tuning (damping/zoom/pan speeds)
- Animation UX (buttons, keyboard shortcuts, auto-play strategy)

Avoid converging on a single generic "orbit + three buttons" output when context calls for more.

## Resource Map

- `references/capacitor-ios-spm-workflow.md`
  - canonical iOS setup, migration, and run commands
- `references/threejs-animation-index-pattern.md`
  - index contract and runtime loading pattern
- `references/gotchas.md`
  - high-frequency integration failures and fixes

## Remember

Three.js + Capacitor iOS succeeds when contracts are explicit and workflows are disciplined.
Build a clear metadata contract, map controls intentionally, prefer SPM on modern Capacitor, and keep build/sync/run deterministic.
