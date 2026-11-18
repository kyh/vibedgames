# Sources

The rendering technique (splats baked from solids, a palette-index G-buffer at twice the art
resolution, a 2x2 vote, self-coloured ink, a camera snapped to the art grid) follows:

- alois-rive/rive_pixelart_gaussian_splat on GitHub: its `pixel-splat-scene` skill, in particular
  `references/renderer.md`, `references/style.md` and `references/games.md`.

That repository has no licence file, so nothing from it is copied here: no code, shaders, palettes,
models or images. The implementation in `src/splat/` is written for three.js from the description
of the technique.
