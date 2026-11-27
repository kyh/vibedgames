# Sources

The rendering technique (splats baked from solids, a palette-index G-buffer at twice the art
resolution, a 2x2 vote, self-coloured ink, a camera snapped to the art grid) follows:

- alois-rive/rive_pixelart_gaussian_splat on GitHub: its `pixel-splat-scene` skill, in particular
  `references/renderer.md`, `references/style.md` and `references/games.md`.

That repository has no licence file, so nothing from it is copied here: no code, shaders, palettes,
models or images. The implementation in `src/splat/` is written for three.js from the description
of the technique.

The game itself took direction from gameplay footage and two screenshots of top-down car brawlers
(bumper punches, knock-offs, a lamp-lit board at night). They set the genre and the mood only: the
board, hazards, cars, items, names, HUD and sounds here are this repo's own.
