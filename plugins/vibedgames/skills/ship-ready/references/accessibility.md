# Accessibility

More people can play, and most of these also make the game better for
everyone. Assist modes and difficulty for players who need more time live in
`onboarding`; HUD layout in `game-ui`; touch and pads in `gamepad`.

## Input

- **A controller reaches everything.** With a pad connected, every screen,
  menu, setting and dialog works with the pad alone, focus is always visible,
  prompts show the device in hand, and plugging or unplugging never breaks
  the game.
- **Every action can be rebound, and a rebind swaps.** Taking a key already
  used by another action swaps the two, so no action is left unbound and no
  key does two things. Bindings persist and are the ones the game reads.
- **Sensitivity, axis inversion and FOV are settings**, applied live,
  persisted, and frame-rate independent (the same mouse travel turns the same
  angle at any fps).
- **Menus work from the keyboard**, with visible focus that lands somewhere
  sensible, real labels on controls, and a second pause key (P or Tab) because
  the browser or a host page may take Escape (fullscreen exit, the vibedgames
  wrapper, a portal frame).

## Seeing and hearing

- **Important sounds are also seen**: subtitles for speech (with speaker
  name), a directional indicator for threats behind, an icon for objective
  cues.
- **Colour is never the only signal.** Team, rarity, selection, damage type
  and danger also differ by shape, icon, text or position, and a colour keeps
  one meaning across the game. Check frames through a deuteranopia and
  protanopia simulation (Chrome DevTools → Rendering → Emulate vision
  deficiencies).
- **No-HUD means none**: a setting that draws nothing over the picture, not
  even toasts, easy to find and toggle during play.
- **Text is readable**: ≥ 16 CSS px for body text at the default size, a size
  setting, and contrast ≥ 4.5:1 against what is behind it.

## Motion and flashes

- **Limit flashes at the source.** No effect changes full-screen brightness by
  a large step more than three times a second (the WCAG general-flash limit).
  Cap muzzle flash, explosion and hit-flash intensity and rate in code.
- **Reduced motion is honoured**: read `prefers-reduced-motion` and offer a
  calm setting. Remove decorative motion (shake, bob, chromatic aberration,
  motion blur, menu parallax) rather than freezing it, and keep the
  information it carried (a hit still shows a direction marker).

## Before the game starts

A visitor who cannot play is told why at once, in the game's own look: no
WebGL2/WebGPU, or a touch-only device for a game without touch controls. The
message names the reason and what to do.

## Prove each option

Each option changes what it claims in a real run, both on and off, and
survives a reload. Toggle it in `vg playtest`, capture before and after, and
read the saved value back.
