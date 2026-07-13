# React Doctor triage

Baseline: React Doctor 0.7.6, 2026-07-12. Command: `npx -y react-doctor@latest . --verbose`.

Result: 75 findings across 4 projects. Every finding is mapped below.

Verdicts:

- `fix` — surgical. This PR stacks and verifies it.
- `defer` — real, but needs a dedicated design/security/architecture pass.
- `close` — false positive, intentional pattern, or no user impact in this runtime.

## `@repo/factory` — 25

| Rule | Count | Locations | Verdict | Reason |
| --- | ---: | --- | --- | --- |
| `no-unknown-property` | 21 | `src/tui/app.tsx:448-453,489,492-498,656,1107-1112` | close | OpenTUI custom renderer props. Not DOM. Typechecked by `@opentui/react`. |
| `no-derived-useState` | 3 | `src/tui/app.tsx:552-554` | close | Launch prefill seeds an editable form. Prop is static. Syncing would overwrite edits. |
| `rendering-hydration-mismatch-time` | 1 | `src/tui/app.tsx:989` | close | Terminal renderer. No SSR or hydration. Existing tick drives refresh. |

## `@repo/web` — 39

| Rule | Count | Locations | Verdict | Reason |
| --- | ---: | --- | --- | --- |
| `raw-sql-injection-risk` | 1 | `.output/server/_ssr/server-CcUUxkL4.mjs:1991` | close | Ignored generated bundle. No source finding. |
| `unsafe-json-in-html` | 1 | `.output/server/_ssr/server-CcUUxkL4.mjs:4872` | close | Ignored generated bundle. No source finding. |
| `insecure-crypto-risk` | 1 | `.output/server/_ssr/server-CcUUxkL4.mjs:9078` | close | Ignored generated bundle. No source finding. |
| `clickjacking-redirect-risk` | 1 | `.output/server/_ssr/server-CcUUxkL4.mjs:16145` | close | Ignored generated bundle. No source finding. |
| `control-has-associated-label` | 1 | `src/components/admin/user-admin.tsx:93` | close | `FieldLabel htmlFor="user-role"` matches `select id="user-role"`. |
| `no-locale-format-in-render` | 2 | `src/components/admin/user-admin.tsx:135`; `src/components/settings/api-key-settings.tsx:11` | close | Rows come from client queries. Absent from SSR markup. Product has no fixed locale policy. |
| `rerender-lazy-state-init` | 1 | `src/components/auth/auth-form.tsx:66` | fix | Lazy initializer preserves behavior and avoids repeated string work. |
| `no-pass-live-state-to-parent` | 1 | `src/components/auth/auth-form.tsx:93` | close | One-shot prefilled invite validation. Not live state mirroring. |
| `no-prevent-default` | 1 | `src/components/auth/auth-form.tsx:99` | close | Intentional SPA mutation form. No native action exists. |
| `use-lazy-motion` | 9 | `src/components/canvas/canvas.tsx:2`; `canvas/game-stack.tsx:2`; `game/game-chrome.tsx:2`; `game/nav.tsx:3`; `game/play-view.tsx:10`; `ui/fade-in-blur.tsx:1`; `ui/rolling-text.tsx:2`; `routes/_site/build.tsx:3`; `routes/_site/index.tsx:3` | defer | Cross-app migration. Drag and layout require `domMax`, not Doctor's `domAnimation` recipe. Needs bundle baseline and full transition QA. |
| `unused-export` | 1 | `src/components/canvas/game-stack.tsx:113` | fix | `GameCard` is file-private. |
| `iframe-missing-sandbox` | 1 | `src/components/canvas/iframe.tsx:7` | defer | Real boundary risk. Sandbox tokens affect camera, storage, pointer lock, downloads, popups, gamepad, and `postMessage` origin. Needs every-game QA. |
| `only-export-components` | 2 | `src/components/game/game-chrome.tsx:19`; `src/components/ui/rolling-text.tsx:51` | close | Intentional colocated public helpers used by sibling route modules. Split adds API churn only. |
| `anchor-has-content` | 1 | `src/components/game/play-view.tsx:55` | fix | Polymorphic anchor gets an explicit accessible name. |
| `rendering-hydration-mismatch-time` | 1 | `src/components/settings/api-key-settings.tsx:139` | close | Client-query rows are absent during SSR. Expiry boundary is evaluated after data arrives. |
| `no-ref-current-in-render` | 1 | `src/components/ui/rolling-text.tsx:125` | fix | Observer can close over `char` and reconnect when it changes. |
| `js-flatmap-filter` | 1 | `src/components/ui/rolling-text.tsx:279` | fix | One-pass typed glyph extraction also removes the assertion. |
| `no-multi-comp` | 5 | `src/routes/_site/build.tsx:124,182,256,325,348` | close | Cohesive route-private sections. Splitting adds navigation cost without reuse. |
| `rendering-hydration-no-flicker` | 1 | `src/routes/_site/build.tsx:187` | defer | Real mount jump. Deterministic initial offsets change art direction. Needs visual choice and QA. |
| `no-static-element-interactions` | 1 | `src/routes/_site/build.tsx:262` | close | Blank-area click is optional pointer reset. Cards remain keyboard-operable. |
| `button-has-type` | 1 | `src/routes/_site/discover.tsx:28` | fix | Explicit non-submit button. |
| `tanstack-start-route-property-order` | 4 | `src/routes/admin/route.tsx:25`; `auth/cli.tsx:40`; `auth/route.tsx:10`; `settings.tsx:20` | fix | Reorder route options to preserve TanStack inference. |

## `@vibedgames/multiplayer` — 3

| Rule | Count | Locations | Verdict | Reason |
| --- | ---: | --- | --- | --- |
| `no-ref-current-in-render` | 3 | `src/react.ts:35,44,45` | defer | Real lifecycle bug. Socket creation/destruction runs during render. Needs a typed hook redesign plus StrictMode, config-change, unmount, SSR, and reconnect tests. |

Adjacent risks found during triage: `getSnapshot()` freshness, missing SSR snapshot, conditional hook use, and unsafe generic casts. A ref-only patch would hide the warning, not fix the lifecycle.

## `@repo/ui` — 8

| Rule | Count | Locations | Verdict | Reason |
| --- | ---: | --- | --- | --- |
| `only-export-components` | 4 | `src/components/alert-dialog.tsx:196`; `button.tsx:101`; `input.tsx:35`; `sonner.tsx:42` | close | Intentional shadcn variants, toast service, and imperative alert API. |
| `prefer-module-scope-pure-function` | 1 | `src/components/alert-dialog.tsx:216` | defer | Valid micro-optimization. No measurable user impact. |
| `no-array-index-as-key` | 1 | `src/components/field.tsx:192` | fix | Unique message is the stable semantic key. |
| `exhaustive-deps` | 2 | `src/components/sidebar.tsx:84,119` | close | Dependencies include derived `open` and `state`. Doctor requests their inputs redundantly. |

## Verification gates

- Changed-scope React Doctor scan.
- Affected project typechecks.
- Web production build.
- Public route browser smoke: Discover, Play, Build, auth, logged-out admin/settings.
- Mobile Discover tap vs swipe. Discover-to-Play zoom. Build rolling text and copy controls.

Sandbox, Motion, and multiplayer lifecycle stay open until their larger gates are executable. Do not silence them.
