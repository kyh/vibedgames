import type Phaser from "phaser";

import type { HeroName } from "./animations";
import { HEROES } from "./heroes";

export const KIT_SUFFIX = "@kit";

export const STRIKE_FRAME = new Map<HeroName, Record<string, number>>([
  ["axion", { "attack-3a": 3, "attack-3b": 2, "attack-3c": 0, "super-smash": 7 }],
  ["reaper", { attack: 14, "double-slash": 3, skill: 14, slash: 5 }],
  ["riven", { "double-slash": 4, slash: 5, "slash-heavy": 5 }],
  ["mooni", { smash: 11, spin: 6, thrust: 6 }],
  ["salamander", { "fire-punch": 6, "flame-slam": 11, "flame-wave": 7 }],
]);

interface ActionWindow {
  a0: number;
  a1: number;
  dur: number;
}

const retime = (scene: Phaser.Scene, hero: HeroName, clip: string, w: ActionWindow) => {
  const base = scene.anims.get(`${hero}:${clip}`);
  const strike = STRIKE_FRAME.get(hero)?.[clip];

  if (!base || strike === undefined) {
    return;
  }

  const kitKey = `${hero}:${clip}${KIT_SUFFIX}`;

  if (scene.anims.exists(kitKey)) {
    return;
  }

  const n = base.frames.length;
  const k = Math.min(strike, n - 1);
  const windupMs = w.a0 * 1000;
  const strikeMs = (w.a1 - w.a0) * 1000;
  const recoverMs = (w.dur - w.a1) * 1000;
  const nRecover = n - 1 - k;
  const recoverUnit = nRecover > 0 ? recoverMs / (nRecover + 1) : 0;

  const frames: Phaser.Types.Animations.AnimationFrame[] = [];
  let total = 0;

  for (const [i, f] of base.frames.entries()) {
    let ms: number;

    if (i < k) {
      ms = windupMs / k;
    } else if (i === k) {
      ms = k === 0 ? windupMs + strikeMs : strikeMs;
    } else {
      ms = i === n - 1 ? recoverUnit * 2 : recoverUnit;
    }

    frames.push({ duration: ms, frame: f.textureFrame, key: f.textureKey });
    total += ms;
  }

  scene.anims.create({ duration: total, frames, key: kitKey, repeat: 0 });
};

export const buildKitClips = (scene: Phaser.Scene) => {
  for (const hero of Object.values(HEROES)) {
    for (const sw of hero.kit.swings) {
      retime(scene, hero.name, sw.clip, sw);
    }

    const sp = hero.kit.special;

    if (sp.kind === "aoe") {
      retime(scene, hero.name, sp.clip, sp);
    } else if (sp.kind === "projectile") {
      retime(scene, hero.name, sp.clip, { a0: sp.fireAt, a1: sp.fireAt + 0.12, dur: sp.dur });
    }
  }
};

export const kitClipKey = (scene: Phaser.Scene, hero: HeroName, clip: string) => {
  const kitKey = `${hero}:${clip}${KIT_SUFFIX}`;

  return scene.anims.exists(kitKey) ? kitKey : `${hero}:${clip}`;
};
