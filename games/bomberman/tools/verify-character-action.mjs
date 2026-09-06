import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import {
  ACTION_SHEETS,
  CharacterAction,
  PLACE_ACTION_MS,
  VICTORY_ACTION_MS,
} from "../src/render/character-action.ts";

let groups = 0;
const group = (name, run) => {
  run();
  groups++;
  console.log(`✓ ${name}`);
};
const pose = { col: 1, row: 1, dir: "down", moving: false };
const bomb = { id: "accepted", placedAt: 1000, col: 1, row: 1 };

group("accepted stamp/age ownership, four directions, immediate interruption", () => {
  for (const dir of ["up", "down", "left", "right"]) {
    for (const age of [0, 100, 279, 280, 300]) {
      const action = new CharacterAction();
      const current = { ...pose, dir };
      assert.equal(action.place(bomb, 1000 + age, 500, current), age < 280);
      const frame = action.sample(500, current, true);
      if (age < 280) {
        assert.equal(frame.frame, Math.floor(age / 70));
        assert.equal(frame.flip, dir === "left");
        assert.equal(frame.key, `player-place-${dir === "left" || dir === "right" ? "side" : dir}`);
      } else assert.equal(frame, null);
      assert.equal(action.place(bomb, 1000 + age, 550, current), false);
      assert.equal(action.sample(500 + PLACE_ACTION_MS, current, true), null);
    }
  }
  for (const changed of [
    { ...pose, moving: true },
    { ...pose, dir: "left" },
    { ...pose, col: 2 },
    { ...pose, row: 2 },
  ]) {
    const action = new CharacterAction();
    action.place(bomb, 1000, 0, pose);
    assert.equal(action.sample(1, changed, true), null);
    assert.equal(action.sample(2, pose, true), null, "interrupted action never resumes");
  }
});

group("moving/distant/future placements stay consumed; reset accepts the next round", () => {
  for (const [current, now] of [
    [{ ...pose, moving: true }, 1000],
    [{ ...pose, col: 2 }, 1000],
    [pose, 999],
    [pose, 1300],
  ]) {
    const action = new CharacterAction();
    assert.equal(action.place(bomb, now, 0, current), false);
    assert.equal(action.place(bomb, 1000, 1, pose), false);
    assert.equal(action.sample(1, pose, true), null);
    action.reset();
    assert.equal(action.place(bomb, 1000, 2, pose), true);
    assert.equal(action.sample(2, pose, false), null);
  }
  const action = new CharacterAction();
  action.place(bomb, 1000, 0, pose);
  assert.equal(action.place({ ...bomb, id: "older", placedAt: 990 }, 1000, 2, pose), false);
  assert.equal(action.place({ ...bomb, id: "new", placedAt: 1050 }, 1050, 50, pose), true);
});

group("victory holds salute, honors scene-clock pause, death and fresh movement", () => {
  const action = new CharacterAction();
  const finalStep = { ...pose, moving: true };
  action.victory(100, finalStep);
  assert.equal(action.place(bomb, 1000, 100, pose), false, "placement cannot replace victory");
  assert.equal(action.sample(100, finalStep, true).frame, 0);
  const paused = action.sample(350, finalStep, true);
  for (let i = 0; i < 10; i++) assert.deepEqual(action.sample(350, finalStep, true), paused);
  assert.equal(action.sample(100 + VICTORY_ACTION_MS, pose, true).frame, 3);
  assert.equal(action.sample(100000, pose, true).frame, 3);
  assert.equal(action.sample(100001, finalStep, true), null, "a new movement edge interrupts");
  action.victory(100002, pose);
  assert.equal(action.sample(100003, pose, false), null);
  action.victory(100004, pose);
  action.reset();
  assert.equal(action.sample(100005, pose, true), null);
});

group("raw PNG cuts/pivots and original walk/video bytes stay intact", () => {
  const hashes = {
    "player-down.webp": "f3a151f4906b6b3bfc827556a24f571d2bf89aa8c4672ea88a165fd388f3b989",
    "player-up.webp": "f50d35a95894dbf53ab6b75529fa47bcec00c88735f21e584af59640ba3a21a2",
    "player-side.webp": "8b48f03d199d726db2f49ca5ed2f8bb64febf0cff3e1903d859512f81d8afd0f",
    "explosion.webp": "a9ebe5076898a88c4c6ec095f2f91fcd59ede2e99a661c5cf9947234ae2a6e2e",
    "player-place-down-v2.png": "6d4565330c95dd4b25af68ca261f8686fe9021fa028d5313c2c33599c7f1d352",
    "player-place-up-v2.png": "43673cc485992d4ddb83c22e8833a35dce3e773da3478f5b299cdb4c9d5d9f7f",
    "player-place-side-v2.png": "6a3cd5ea3c3f407b463db7059c131fca5b31e58f2466194754357ed407ed12e3",
    "player-victory-v2.png": "e9d9841888d360adbe0583ebfedea267090cd4a965a232ceb1710f01f0246263",
  };
  for (const [file, hash] of Object.entries(hashes))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(`../public/assets/${file}`, import.meta.url)))
        .digest("hex"),
      hash,
      file,
    );
  for (const sheet of ACTION_SHEETS) {
    const bytes = readFileSync(new URL(`../public/${sheet.url}`, import.meta.url));
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    let area = 0;
    for (const cut of sheet.frames) {
      assert.ok(
        cut.x >= 0 && cut.y >= 0 && cut.x + cut.width <= width && cut.y + cut.height <= height,
      );
      assert.ok(cut.feetX > 0 && cut.feetX < cut.width && cut.feetY > 0 && cut.feetY < cut.height);
      area += cut.width * cut.height;
    }
    assert.equal(area, width * height, "cuts retain the full unchanged raster");
  }
});

class SceneStub {
  key;
  constructor(key) {
    this.key = key;
  }
}

group("actual Boot keeps four-frame9fps walk and video16-frame32fps fire", () => {
  const source = readFileSync(new URL("../src/scenes/boot-scene.ts", import.meta.url), "utf8");
  const code = stripTypeScriptTypes(
    source.replace(/^import.*;\n/gm, "").replace("export class", "class"),
    { mode: "strip" },
  );
  const Boot = new Function("Phaser", "ACTION_SHEETS", `${code};return BootScene;`)(
    {
      Scene: SceneStub,
      Textures: { FilterMode: { NEAREST: 0, LINEAR: 1 } },
    },
    ACTION_SHEETS,
  );
  const loads = [];
  const clips = [];
  const textures = new Map();
  const boot = new Boot();
  boot.makeUtilTextures = () => {};
  boot.load = {
    image: (key, url) => loads.push({ key, url }),
    spritesheet: (key, url, config) => loads.push({ key, url, config }),
  };
  boot.textures = {
    get: (key) => {
      if (!textures.has(key))
        textures.set(key, {
          frames: [],
          filter: null,
          setFilter(filter) {
            this.filter = filter;
          },
          add(index, source, x, y, width, height) {
            const frame = { index, source, x, y, width, height };
            this.frames.push(frame);
            return frame;
          },
        });
      return textures.get(key);
    },
  };
  boot.anims = {
    create: (clip) => clips.push(clip),
    generateFrameNumbers: (key, { start, end }) =>
      Array.from({ length: end - start + 1 }, (_, i) => ({ key, frame: start + i })),
  };
  boot.scene = { start: (key) => assert.equal(key, "Game") };
  boot.preload();
  boot.create();
  for (const dir of ["down", "up", "side"]) {
    const clip = clips.find((entry) => entry.key === `walk-${dir}`);
    assert.equal(clip.frameRate, 9);
    assert.equal(clip.repeat, -1);
    assert.deepEqual(
      clip.frames.map((frame) => frame.frame),
      [0, 1, 2, 3],
    );
    assert.deepEqual(loads.find((entry) => entry.key === `player-${dir}`).config, {
      frameWidth: 256,
      frameHeight: 256,
    });
  }
  const fire = clips.find((entry) => entry.key === "explode");
  assert.equal(fire.frames.length, 16);
  assert.equal(fire.frameRate, 32);
  assert.equal(fire.repeat, 0);
  for (const sheet of ACTION_SHEETS) {
    assert.equal(loads.find((entry) => entry.key === sheet.key).url, sheet.url);
    const texture = textures.get(sheet.key);
    assert.equal(texture.filter, 0);
    for (const [index, frame] of texture.frames.entries()) {
      const cut = sheet.frames[index];
      assert.equal(frame.customPivot, true);
      assert.ok(Math.abs(frame.pivotX * cut.width - cut.feetX) < 1e-9);
      assert.ok(Math.abs(frame.pivotY * cut.height - cut.feetY) < 1e-9);
    }
  }
});

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const found = new RegExp(`^  private ${name}\\([^]*?^  }`, "m").exec(source)?.[0];
  assert.ok(found, name);
  return found;
};
// Actual rendering methods; the display/tween objects below are explicit local
// collaborators. This verifies ownership and restoration, not Phaser pixels.
const code = stripTypeScriptTypes(
  `class Render {
${[
  "applyAnim",
  "resetPlayerFeedback",
  "clearBodyFeedback",
  "playDeath",
  "reviveVisual",
  "pulsePlayer",
  "syncPlayers",
  "tweenPlayer",
  "tweenContainer",
  "updateCharacterActions",
]
  .map(method)
  .join("\n")}
${method("setBanner").split("    const state = this.roundPresentation();")[0]}}
}`,
  { mode: "strip" },
);
const Render = new Function(
  "TILE",
  "VICTORY_ACTION_MS",
  "BOT_MOVE_MS",
  "colX",
  "rowY",
  "sfx",
  `${code};return Render;`,
)(
  64,
  VICTORY_ACTION_MS,
  200,
  (col) => col * 64 + 32,
  (row) => row * 64 + 32,
  { death() {}, win() {} },
);
class Display {
  x = 0;
  y = 0;
  alpha = 1;
  scaleX = 1;
  scaleY = 1;
  angle = 0;
  originX = 0.5;
  originY = 0.5;
  visible = true;
  texture = "player-down";
  frame = 0;
  anims = {
    currentAnim: null,
    isPlaying: false,
    stop: () => {
      this.anims.isPlaying = false;
    },
    play: (key) => {
      this.anims.currentAnim = { key };
      this.anims.isPlaying = true;
    },
  };
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(x, y = x) {
    this.scaleX = x;
    this.scaleY = y;
    return this;
  }
  setDisplaySize(w, h) {
    this.scaleX = w / 256;
    this.scaleY = h / 256;
    return this;
  }
  setTexture(key, frame) {
    this.texture = key;
    this.frame = frame;
    return this;
  }
  setOrigin(x, y = x) {
    this.originX = x;
    this.originY = y;
    return this;
  }
  setFlipX(flip) {
    this.flipX = flip;
    return this;
  }
  setAngle(angle) {
    this.angle = angle;
    return this;
  }
  setAlpha(alpha) {
    this.alpha = alpha;
    return this;
  }
  setVisible(visible) {
    this.visible = visible;
    return this;
  }
  setTint(tint) {
    this.tint = tint;
    return this;
  }
  clearTint() {
    delete this.tint;
    return this;
  }
  destroy() {
    this.destroyed = true;
  }
}
const makeScene = () => {
  const player = {
    ...pose,
    container: new Display().setPosition(96, 96),
    body: new Display(),
    sprite: new Display(),
    ring: new Display(),
    marker: null,
    action: new CharacterAction(),
    actionFrame: null,
  };
  const fighter = { ...pose, id: "winner", isLocal: true, isBot: false };
  const pending = [];
  const scene = Object.assign(new Render(), {
    players: new Map([[fighter.id, player]]),
    deathSeen: new Set(),
    winnerAction: null,
    characterTime: 100,
    feedbackEnabled: true,
    reducedMotion: false,
    myId: "winner",
    bannerEl: {},
    observedWinner: null,
    shared: () => ({ winner: "winner" }),
    fighters: () => [fighter],
    alive: true,
    isAlive() {
      return this.alive;
    },
    burst() {},
    tweens: {
      add: (tween) => pending.push(tween),
      killTweensOf: (target) => {
        for (let i = pending.length - 1; i >= 0; i--)
          if (pending[i].targets === target) pending.splice(i, 1);
      },
    },
  });
  return { scene, player, fighter, pending };
};

group("actual sprite restoration, child-only feedback, original460ms death and snap", () => {
  const { scene, player, pending } = makeScene();
  player.action.place(bomb, 1000, 100, pose);
  scene.applyAnim(player, pose.dir, false);
  assert.equal(player.sprite.texture, "player-place-down");
  assert.equal(player.sprite.y, 64 * 0.34);
  assert.deepEqual([player.container.x, player.container.y], [96, 96]);
  scene.characterTime += 100;
  scene.applyAnim(player, "left", true);
  assert.equal(player.sprite.anims.currentAnim.key, "walk-side");
  assert.equal(player.sprite.flipX, true);
  assert.equal(player.sprite.scaleX, (64 * 0.95) / 256);
  assert.equal(player.sprite.y, -64 * 0.06);
  assert.equal(player.sprite.originX, 0.5);
  scene.tweenContainer(player, 2, 1, 175);
  scene.pulsePlayer("winner", "pickup");
  assert.equal(pending.at(-1).targets, player.body);
  scene.playDeath(player);
  assert.equal(pending.at(-1).duration, 460);
  assert.equal(pending.at(-1).targets, player.sprite);
  scene.reviveVisual(player, 1, 1);
  assert.equal(pending.length, 0, "snap cancels movement/body/death ownership");
  assert.deepEqual([player.container.x, player.container.y], [96, 96]);
  assert.equal(player.sprite.scaleX, (64 * 0.95) / 256);
});

group("actual winner edge, silent baselines/draw, repeat snapshots and later fire death", () => {
  for (const [winner, observed, enabled] of [
    ["winner", "winner", true],
    ["draw", null, true],
    ["winner", null, false],
  ]) {
    const { scene, player } = makeScene();
    scene.shared = () => ({ winner });
    scene.observedWinner = observed;
    scene.feedbackEnabled = enabled;
    scene.setBanner();
    scene.syncPlayers();
    assert.equal(player.actionFrame, null);
  }
  const { scene, player, fighter } = makeScene();
  fighter.moving = true; // winner's accepted final step may retain this flag
  scene.setBanner();
  scene.syncPlayers();
  assert.equal(player.sprite.texture, "player-victory");
  scene.characterTime += 400;
  scene.setBanner();
  scene.syncPlayers();
  assert.equal(player.sprite.frame, 2, "repeat snapshot doesn't restart victory");
  scene.characterTime += 1000;
  scene.syncPlayers();
  assert.equal(player.sprite.frame, 3);
  scene.alive = false;
  scene.syncPlayers();
  assert.equal(player.actionFrame, null);
  assert.equal(player.action.sample(scene.characterTime, pose, true), null);
});

group("actual owned clock advances without snapshots; wake doesn't consume a long pause", () => {
  const { scene, player } = makeScene();
  player.action.place(bomb, 1000, scene.characterTime, pose);
  scene.applyAnim(player, pose.dir, false);
  scene.updateCharacterActions(50);
  assert.equal(player.sprite.frame, 0);
  scene.updateCharacterActions(5000);
  assert.equal(scene.characterTime, 200);
  assert.equal(player.sprite.frame, 1);
  for (let i = 0; i < 4; i++) scene.updateCharacterActions(50);
  assert.equal(player.actionFrame, null);
  assert.equal(player.sprite.texture, "player-down");
});

console.log(`✓ ${groups} character action groups`);
