# Phones

Phones fail differently: Safari kills a tab that uses too much memory and
reloads it with no error, audio unlocks differently, and touches get
cancelled. None of it shows in desktop emulation.

## Memory

- **Measure tab memory on the weakest target phone, in its own browser,**
  through a full session (Safari Web Inspector → Timelines → Memory).
  Write a budget (start at ~400 MB on older iPhones) and hold it.
- **Free CPU copies after upload**: once a texture or geometry is on the GPU,
  drop the JS-side image and arrays unless something reads them again
  (`texture.source.data = null` after upload only if you can re-fetch from
  its URL after a context loss).
- **Cap texture size per device class** (e.g. 2048 desktop, 1024 phone) and
  download only the mips that class draws. Any visible cut in phone fidelity
  is agreed with the person.

## Before the first frame

- Choose tier, pixel ratio and worker count from a device check **before** the
  renderer draws, so a phone starts at phone settings.
- If the device cannot run the game (no WebGL2/WebGPU, or touch-only and the
  game has no touch controls), show a card in the game's own look within a
  second that names the reason and what to do. Never a blank page.

## Input

- **Every touch that starts has an end.** Handle `pointerup`,
  `pointercancel`, `lostpointercapture`, `blur` and `visibilitychange`, and
  release every held control on any of them, so no ghost finger owns the
  camera. Use `setPointerCapture` on the control the touch started on.
- Thumb-sized targets (≥ 48 CSS px, ideally larger), clear of the safe areas
  (`env(safe-area-inset-*)`). Touch controls: `gamepad`.
- Landscape for action games, with a clear rotate prompt in portrait.
- `touch-action: none` on the canvas; prevent double-tap zoom and the
  long-press callout.

## Sound

Unlock on the first touch (resume the context inside the `touchend` handler),
resume after calls, locks and tab switches, and prove it by measured output
(see `audio` → `references/qa-without-ears.md`), not by `ctx.state`.

## Frame rate and look

- A written phone floor and target, measured on the phone in menus, loading
  and play. Hold a steady 30 rather than bouncing between 40 and 60.
- **No live `backdrop-filter` blur over the canvas on iPhone**: it costs a full
  extra composite every frame. Use a pre-blurred image or a dark scrim.
- Offer the installed web-app mode (a manifest, `display: fullscreen`), never
  force it.
