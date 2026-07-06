#!/usr/bin/env node
// Import hand-picked FX textures from the locally-downloaded Unity asset packs
// (extracted .unitypackage layout: <GUID>/asset + <GUID>/pathname) into
// public/fx/. We commit ONLY the specific files we use — never the raw packs.
//
// Usage: node tools/import-fx-assets.mjs [packs-root]
//   packs-root defaults to ~/Desktop/vg/outlast
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.argv[2] ?? join(homedir(), "Desktop/vg/outlast");
const PACKS = ["FX_Slash_Collection(URP)", "RPG Game VFX Collection(Built-in)"];
const OUT = new URL("../public/fx/", import.meta.url).pathname;

// pathname suffix → committed name (kebab, stable API for the renderer)
const WANT = new Map([
  // erosion / noise (the Gabriel Aguiar dissolve maps)
  ["Texture/NoiseSmooth02.png", "noise-smooth.png"],
  ["Texture/NoiseCaustic02.png", "noise-caustic.png"],
  ["Texture/noise_07.png", "noise-streak.png"],
  // impact / glow sprites
  ["Texture/imp_01.png", "impact-burst.png"],
  ["Texture/Particle_Impact_Circle_01.png", "impact-circle.png"],
  ["Texture/shock_wave_005.png", "shockwave.png"],
  ["Texture/glow_19.png", "glow-soft.png"],
  ["Texture/flare07.png", "flare-star.png"],
  // authored slash crescents (tinted at runtime — pick the neutral/bright ones)
  ["Texture/slash_C001.png", "slash-arc.png"],
  ["Texture/white_slash_01.png", "slash-white.png"],
  ["Texture/rotation_slash.png", "slash-spin.png"],
  ["Texture/Wind_Blade_F02.png", "slash-wind.png"],
  // spell accents (RPG pack)
  ["FX_Thunder/Textures/FineLightning_03.png", "lightning-fine.png"],
  ["FX_Deflector_Shield/Textures/Hexagon_01.png", "hex-shield.png"],
  // spell-kit textures for the FX gallery (?fx=1) → future champion spells
  ["FX_Thunder/Textures/Ground_Crack_02.png", "ground-crack.png"],
  ["FX_Thunder/Textures/razorFlash.png", "razor-flash.png"],
  ["FX_Thunder/Textures/lightning02_02.png", "lightning-arc.png"],
  ["FX_Fireball/Textures/glow_fire_01.png", "glow-fire.png"],
  ["FX_Fireball/Textures/fire.png", "fire-sprite.png"],
  ["FX_Groundexplosion/Textures/decal_fire.png", "scorch-decal.png"],
  ["FX_Groundexplosion/Textures/firerock.png", "fire-rock.png"],
  ["FX_Groundexplosion/Textures/shock_02.png", "shock-burst.png"],
  ["FX_MagicCircle/Textures/Rune_01.png", "rune-circle-a.png"],
  ["FX_MagicCircle/Textures/Rune_02.png", "rune-circle-b.png"],
  ["FX_DarkDoor/Textures/Galaxy_01.png", "galaxy.png"],
  ["FX_DarkDoor/Textures/sd_21a.png", "dark-swirl.png"],
  ["FX_DarkDoor/Textures/smoke_01.png", "smoke-puff.png"],
  ["FX_DarkShock/Textures/DkEffect_gn005_505.png", "dark-shock.png"],
  ["FX_DarkShock/Textures/line_lightning01_puple.png", "lightning-purple.png"],
  ["FX_HolyWings/Textures/sl-g01g 2.png", "holy-wings.png"],
  ["FX_HolyWings/Textures/trail41_r.png", "trail-holy.png"],
  ["FX_Lightningball/Textures/Electro03.png", "electro-ball.png"],
  ["FX_Lightningball/Textures/Electric_Splat_Hit_02.png", "electric-splat.png"],
  ["FX_Magicbullet/Textures/trail_pink.png", "trail-pink.png"],
  ["FX_Magicbullet/Textures/smoke_pink2.png", "smoke-pink.png"],
  ["FX_Magicbullet/Textures/wenli.png", "swirl-lines.png"],
  ["FX_Starfall/Textures/tex_vfx-ult_particle_sprite_kh_twinkle-blurred 1.png", "twinkle.png"],
  ["FX_Starfall/Textures/tex_vfx-ult_particle_sprite_lensflare.png", "lensflare.png"],
  ["FX_Starfall/Textures/line03_white.png", "streak-line.png"],
  ["FX_Starfall/Textures/Sparkle_Ink_008.png", "sparkle-ink.png"],
]);

mkdirSync(OUT, { recursive: true });
const found = new Map();
for (const pack of PACKS) {
  const dir = join(ROOT, pack);
  if (!existsSync(dir)) {
    console.warn(`skip missing pack: ${dir}`);
    continue;
  }
  for (const guid of readdirSync(dir)) {
    const pn = join(dir, guid, "pathname");
    const asset = join(dir, guid, "asset");
    if (!existsSync(pn) || !existsSync(asset)) continue;
    const path = readFileSync(pn, "utf8").split("\n")[0].trim();
    for (const [suffix, outName] of WANT) {
      if (path.endsWith(suffix) && !found.has(outName)) found.set(outName, asset);
    }
  }
}

let missing = 0;
for (const [outName] of WANT.entries()) {
  void outName;
}
for (const [suffix, outName] of WANT) {
  const src = found.get(outName);
  if (!src) {
    console.error(`MISSING: ${suffix}`);
    missing++;
    continue;
  }
  copyFileSync(src, join(OUT, outName));
  const kb = Math.round(statSync(join(OUT, outName)).size / 1024);
  console.log(`${outName}  (${kb} KB)  <- …/${suffix}`);
}
process.exit(missing > 0 ? 1 : 0);
