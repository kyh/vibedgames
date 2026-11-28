# Sources

The look (crisp low-resolution solids, dark ink outlines, eight-tone ramps, ordered dither, checker
shadows, a warm daylight palette) took direction from:

- danielwh2/sprite-stacking on GitHub, and a short clip of a sprite-stacked scene in the same style.

They set the style only. Nothing from them is copied here: no code, sprites, palettes, models or
images, and this game does not stack sprites. The renderer in `src/pixel/` draws real solids at art
resolution into a palette-index G-buffer and inks, shades and dithers them in a resolve pass; it is
this repo's own, written for three.js.

The game itself took direction from gameplay footage and two screenshots of top-down car brawlers
(bumper punches, knock-offs). They set the genre only: the board, hazards, cars, items, names, HUD
and sounds here are this repo's own.
