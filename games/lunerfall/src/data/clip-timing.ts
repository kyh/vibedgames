import type Phaser from "phaser";

import type { HeroName } from "./animations";
import { HEROES } from "./heroes";

// Single timing source for hero attack playback — the fix for "the damage and
// the animation don't line up". The hitbox spec (Swing a0/a1/dur) and the art
// used to be timed independently: a0/a1 stayed authored-early (~50-140ms,
// responsive) while the clip was stretched UNIFORMLY to dur (SWING_TEMPO), so
// the visual contact frame drifted 300-700ms past the actual hit.
//
// The idiomatic contract instead: per clip, the frame that shows the blade
// connecting (measured from the sheets, below) must be ON SCREEN during the
// live hitbox. So each attack clip gets a retimed "@kit" variant with UNEVEN
// per-frame durations derived from its swing spec:
//   frames before the strike  → compressed into [0, a0]   (fast into the hit
//                               reads as MORE powerful, and startup stays snappy)
//   the strike frame          → displayed for [a0, a1]    (the smear IS the hitbox)
//   frames after the strike   → spread over [a1, dur], follow-through held longest
// Total playback still equals the swing's dur, so combo cadence is unchanged —
// this is a render-only fix; the sim never reads any of it.
//
// Variants (not in-place retiming) because base anims are shared: the boss
// plays the salamander atlas clips with their slow authored telegraphs.
export const KIT_SUFFIX = "@kit";

// Contact frame per attack clip, measured frame-by-frame from the Aseprite
// exports (index is within the clip, not the atlas). If art is re-exported,
// re-verify these against a contact sheet.
export const STRIKE_FRAME: Record<HeroName, Record<string, number>> = {
  axion: { "attack-3a": 3, "attack-3b": 2, "attack-3c": 0, "super-smash": 7 },
  reaper: { slash: 5, "double-slash": 3, attack: 14, skill: 14 },
  riven: { slash: 5, "double-slash": 4, "slash-heavy": 5 },
  mooni: { thrust: 6, spin: 6, smash: 11 },
  salamander: { "fire-punch": 6, "flame-slam": 11, "flame-wave": 7 },
};

// One retimed clip: windup → strike-at-hitbox → weighted recovery (see above).
type ActionWindow = { a0: number; a1: number; dur: number };

function retime(scene: Phaser.Scene, hero: HeroName, clip: string, w: ActionWindow) {
  const base = scene.anims.get(`${hero}:${clip}`);
  const strike = STRIKE_FRAME[hero][clip];
  if (!base || strike === undefined) return;
  const kitKey = `${hero}:${clip}${KIT_SUFFIX}`;
  if (scene.anims.exists(kitKey)) return;

  const n = base.frames.length;
  const k = Math.min(strike, n - 1);
  const windupMs = w.a0 * 1000;
  const strikeMs = (w.a1 - w.a0) * 1000;
  const recoverMs = (w.dur - w.a1) * 1000;
  const nRecover = n - 1 - k;
  // Recovery frames share recoverMs with the final follow-through pose held
  // twice as long as the rest (weights 1,1,...,2).
  const recoverUnit = nRecover > 0 ? recoverMs / (nRecover + 1) : 0;

  const frames: Phaser.Types.Animations.AnimationFrame[] = [];
  let total = 0;
  base.frames.forEach((f, i) => {
    let ms: number;
    if (i < k) ms = windupMs / k;
    else if (i === k) ms = k === 0 ? windupMs + strikeMs : strikeMs;
    else ms = i === n - 1 ? recoverUnit * 2 : recoverUnit;
    frames.push({ key: f.textureKey, frame: f.textureFrame, duration: ms });
    total += ms;
  });
  scene.anims.create({ key: kitKey, frames, duration: total, repeat: 0 });
}

// Build every hero's retimed attack variants. Call once at boot, after
// buildAnimsFromAseprite has created the base clips.
export function buildKitClips(scene: Phaser.Scene) {
  for (const hero of Object.values(HEROES)) {
    for (const sw of hero.kit.swings) retime(scene, hero.name, sw.clip, sw);
    const sp = hero.kit.special;
    if (sp.kind === "aoe") retime(scene, hero.name, sp.clip, sp);
    // Projectile: the release frame shows while the wave spawns at fireAt.
    else if (sp.kind === "projectile")
      retime(scene, hero.name, sp.clip, { a0: sp.fireAt, a1: sp.fireAt + 0.12, dur: sp.dur });
  }
}

// The anim key playback should use for a hero clip — the retimed kit variant
// when one exists, else the base authored clip. Shared by Player + the editor.
export function kitClipKey(scene: Phaser.Scene, hero: HeroName, clip: string): string {
  const kitKey = `${hero}:${clip}${KIT_SUFFIX}`;
  return scene.anims.exists(kitKey) ? kitKey : `${hero}:${clip}`;
}
