# The quality bar: judging a game without fooling yourself

A stranger decides in about ninety seconds. What makes a browser game feel
premium is less the amount of content than the absence of cheap tells on the
route a new player walks: loading, title, menu, first minute. `visual-bar.md`
locks the references; `critic-loop.md` runs the review. This file is what the
review looks for and how to keep its scores honest.

## The cheap tells

Walk this list against captures from the real route (built game, real menu,
real input). Fix in this order: the core loop first, then every generated
asset, then the front end, then a playtest. A deliberately flat or minimal
style changes what counts (flat light is the style if the person chose it).

| #   | Tell                           | How to look for it                                                                         |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Primitive stand-ins            | A box, sphere or capsule where a designed hero, enemy, item or landmark belongs            |
| 2   | Default materials              | One flat colour and roughness everywhere, metal that reflects nothing                      |
| 3   | Flat light                     | Shade nearly as bright as light, no contact shadows, no warm/cool split (`look`)           |
| 4   | No grade                       | Milky horizon, bloom on lit walls, a frame flatter than the reference                      |
| 5   | An empty world                 | Props on a grid on a ground plane, nothing overhead, no wear, things floating              |
| 6   | Placeholder UI                 | Browser fonts, debug text, emoji as icons, a title that is a button on black (`game-ui`)   |
| 7   | Silent, thin or harsh sound    | No music or ambience, one sample per action, clipping on overlap (`audio`)                 |
| 8   | No hit feedback                | A hit with no flash, sound or reaction; a kill with no beat of its own (`game-feel`)       |
| 9   | A dead camera                  | Rigid follow, no response to sprint or impact, shake that never decays                     |
| 10  | Stiff animation                | Sliding feet, popping clips, no hit reaction or death, a T-pose (`animation`, `action-3d`) |
| 11  | Hitches                        | A stall on the first shot or effect, GC spikes (`ship-ready`)                              |
| 12  | Generated work left out        | An asset made for the game that it never loads, while a stand-in sits in its place         |
| 13  | Stand-ins while loading        | A wrong or half-built model in a menu, pickup or preview                                   |
| 14  | Black or blown held items      | First-person hands or tool read as a black shape or a white one                            |
| 15  | Stuck enemies                  | Pressed against walls, pacing, frozen, or a round that never ends                          |
| 16  | Crash or reload during load    | The tab reloads or drops to the menu near the end of the bar                               |
| 17  | Flicker in motion              | Shimmer or crawl while the camera moves, though every still is clean                       |
| 18  | Picture and collision disagree | Invisible walls, walk-through solids, impassable doors, spawning inside rocks              |
| 19  | A body no person has           | Floating arms, impossible wrists, see-through limbs                                        |

## Turn the reference into a bar

- **The bar is a frame from a named game** (or the person's concept film) per
  screen: combat, HUD, menu, boss, results. The concept is the floor; the
  named frame is the bar. Every comparison sheet has three panels: concept,
  reference frame, build.
- **Write the reference as pass/fail statements** a stranger can mark on a
  capture, measured where possible (`look` §1).

## Score bluntly

- **0–10 by eye**, on fixed hero frames, side by side with the reference.
  Pixel or colour metrics can support a score; they never close an item. Feed
  the scorer a death screen and a loading screen: both must score near zero,
  or the scorer is broken.
- **The builder never grades its own work.** The verdict comes from someone
  who didn't build it and sees the artifact, not the builder's description.
- **Judge the frame people play**: the player's camera, at play distance, on
  default settings and window size, while moving. Never an editor view or a
  hero still.

## Model judges are noisy instruments

- Identical frames can drift 1–3 points between readings. A score change
  counts only when the same judges saw old and new **side by side, blind, in
  one sitting**, against fixed anchor frames (your own game's low, middle and
  high examples), with an unchanged control frame that must hold still.
- Three independent read-only judges beat one. Report the spread and the
  control's drift beside every score.
- **Judges score only what their evidence carries.** Stills can't show
  motion, sound, input lag or flicker; those go to video review and to a
  person.
- **The person's decisions travel in every judge brief and outrank it.** No
  judge note reverses something the person asked for; a conflict becomes a
  question to them.

## Make progress, not polish

- **Add what the reference has, remove what it lacks.** Each round adds a
  model, light, prop layer or effect the reference has and the build lacks,
  or removes something neither has. Retuning sky, fog or grade while models,
  surfaces and density still miss is not progress.
- **Change the method when progress stalls.** Several passes that each move
  the score a little, or the same axis rejected twice, means change how the
  thing is made, not polish it again.
- **Once free concepts stall, paint over the build's own frames**, so the
  target shares the build's camera, layout and HUD and every difference is
  actionable.
- **One report becomes a sweep.** "This rock floats" becomes "no prop may
  float on any map", fixed everywhere, then reported. A class the person
  reports twice gets an automated check.
- **Approved quality is frozen.** What the person approved is never traded
  away for a budget, device or judge's advice without their yes. Keep the
  approved capture and commit; a regression is fixed by restoring first.

## Report what was observed

Mark every claim **observed pass**, **observed failure**, **unverified** or
**not applicable**. Reading the source is never an observation. Every picture
sent to the person is reviewed, so name its flaws in the caption. And the
final test: someone who has never seen the game, from the real menu with no
explanation, understands what to do, does it, and wants a second minute.
