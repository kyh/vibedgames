// Real FSMs + original atlas metadata + installed Phaser AnimationState.
// Only display/texture plumbing is mocked; no browser or copied combat logic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnemyBody } from "../src/entities/enemy-body.ts";
import { BossBody } from "../src/entities/boss-body.ts";
import { ENEMIES } from "../src/data/enemies.ts";
import { bossKind } from "../src/data/bosses.ts";
import { Grid, ROWS } from "../src/sys/grid.ts";
import * as config from "../src/config.ts";
import { buildAnimsFromAseprite } from "../src/data/animations.ts";
import { showActorPose } from "../src/data/actor-animation.ts";
import * as acting from "../src/data/actor-presentation.ts";

const { enemyPose, BossActing, isEnemyAction, isBossAction, isActorTint, remoteBlend } = acting;
const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(base, "package.json"));
const phaserRoot = resolve(dirname(req.resolve("phaser")), "..");
const AnimationState = req(resolve(phaserRoot, "src/animations/AnimationState.js"));
const AnimationManager = req(resolve(phaserRoot, "src/animations/AnimationManager.js"));
const EventEmitter = createRequire(resolve(phaserRoot, "package.json"))("eventemitter3");
const DT = 1 / 60;
const floor = (ROWS - 2) * config.TILE;
let checks = 0;
function check(name, run) {
  run();
  checks++;
  console.log(`PASS ${name}`);
}

const atlases = new Map(
  ["warrior", "spearman", "archer", "bomber", "salamander"].map((name) => [
    name,
    JSON.parse(readFileSync(resolve(base, `public/sprites/ase/${name}.json`), "utf8")),
  ]),
);
const game = {
  events: new EventEmitter(),
  textures: {
    getFrame: (key, filename) => {
      const source = atlases.get(key)?.frames.find((frame) => frame.filename === filename);
      assert.ok(source, `actual atlas frame exists: ${key}/${filename}`);
      return { texture: { key }, name: filename, customPivot: false, source };
    },
  },
};
const manager = new AnimationManager(game);
game.events.emit("boot");
const scene = {
  sys: { anims: manager },
  anims: manager,
  cache: { json: { get: (key) => atlases.get(key) } },
};
for (const name of atlases.keys()) buildAnimsFromAseprite(scene, name);
const originalDurations = new Map(
  [...atlases.keys()].flatMap((name) =>
    manager.anims
      .getArray()
      .filter((anim) => anim.key.startsWith(name + ":"))
      .map((anim) => [anim.key, anim.frames.map((f) => f.duration)]),
  ),
);

class Sprite extends EventEmitter {
  x = 0;
  y = 0;
  alpha = 1;
  flipX = false;
  tint = 0xffffff;
  originY = 0;
  constructor(x, y) {
    super();
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.anims = new AnimationState(this);
  }
  play(key, ignore) {
    this.anims.play(key, ignore);
    return this;
  }
  setOrigin(x, y) {
    this.originX = x;
    this.originY = y;
    return this;
  }
  setScale(scale) {
    this.scaleX = scale;
    this.scaleY = scale;
    return this;
  }
  setDepth(depth) {
    this.depth = depth;
    return this;
  }
  setTint(tint) {
    this.tint = tint;
    return this;
  }
  setTintMode(mode) {
    this.tintMode = mode;
    return this;
  }
  setFlipX(flip) {
    this.flipX = flip;
    return this;
  }
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setSizeToFrame() {}
  updateDisplayOrigin() {}
  destroy() {
    this.anims.destroy();
  }
}
scene.add = { sprite: (x, y) => new Sprite(x, y) };
function viewClass(name, file, env) {
  const source = readFileSync(resolve(base, file), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export class ", "class ");
  const js = stripTypeScriptTypes(source, { mode: "transform" });
  return new Function(...Object.keys(env), js + `\nreturn ${name};`)(...Object.values(env));
}
const environment = {
  ...config,
  ...acting,
  showActorPose,
  EnemyBody,
  BossBody,
  bossKind,
  Phaser: { TintModes: { FILL: 1, MULTIPLY: 0 } },
  afterImage: () => {},
};
const Enemy = viewClass("Enemy", "src/entities/enemy.ts", environment);
const Boss = viewClass("Boss", "src/entities/boss.ts", environment);
const frameIndex = (sprite) => (sprite.anims.currentFrame?.index ?? 0) - 1;
const descriptor = (body) => ({ state: body.state, elapsed: body.stateT });

check("optional wire metadata accepts real states and rejects malformed ages/tints", () => {
  assert.ok(isEnemyAction({ state: "windup", elapsed: 0.2 }));
  assert.ok(isBossAction({ state: "slam", elapsed: 0.7 }));
  for (const bad of [
    undefined,
    null,
    {},
    { state: "wave", elapsed: 1 },
    { state: "dead", elapsed: -1 },
    { state: "hurt", elapsed: NaN },
    { state: "chase", elapsed: Infinity },
  ])
    assert.equal(isEnemyAction(bad), false);
  assert.equal(isBossAction({ state: "chase", elapsed: 1 }), false);
  for (const bad of [-1, 0x1000000, 1.1, "red", NaN]) assert.equal(isActorTint(bad), false);
  assert.ok(isActorTint(0));
  assert.ok(isActorTint(0xffffff));
});

check("warrior real active hitbox and recovery map to measured original Strike frames", () => {
  const body = new EnemyBody(ENEMIES.warrior, Grid.test(), 240, floor);
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    body.step(DT, body.x + 12, floor);
    const pose = enemyPose(body.kind, descriptor(body));
    seen.add(body.state);
    if (body.state === "windup") assert.ok(pose.frame <= 2);
    if (body.attackBox()) assert.deepEqual(pose, { clip: "strike", frame: 3 });
    if (body.state === "recover") assert.ok(pose.frame >= 4 && pose.frame <= 9);
  }
  for (const state of ["windup", "attack", "recover"]) assert.ok(seen.has(state));
  body.takeHit(1, 0, 1);
  assert.equal(enemyPose(body.kind, descriptor(body)).clip, "hit");
  body.iframes = 0;
  body.takeHit(99, 0, 1);
  assert.equal(enemyPose(body.kind, descriptor(body)).clip, "dead");
});

check("spearman uses forward thrust during real horizontal charge, then original recovery", () => {
  const body = new EnemyBody(ENEMIES.spearman, Grid.test(), 240, floor);
  const seen = new Set();
  for (let i = 0; i < 140; i++) {
    body.step(DT, body.x + 60, floor);
    const pose = enemyPose(body.kind, descriptor(body));
    seen.add(body.state);
    if (body.state === "windup") assert.ok(pose.clip === "strike" && pose.frame < 3);
    if (body.state === "charge") assert.ok(pose.frame >= 3 && pose.frame <= 5);
    if (body.state === "recover") assert.ok(pose.frame >= 6 && pose.frame <= 8);
  }
  for (const state of ["windup", "charge", "recover"]) assert.ok(seen.has(state));
});

check("archer release and bomber discharge occur on real projectile/blast edges", () => {
  const archer = new EnemyBody(ENEMIES.archer, Grid.test(), 180, floor);
  let released = false;
  for (let i = 0; i < 100; i++) {
    archer.step(DT, archer.x + 100, floor);
    const pose = enemyPose(archer.kind, descriptor(archer));
    if (archer.state === "windup") assert.ok(pose.frame < 5);
    if (archer.pendingProjectile) {
      assert.equal(pose.frame, 5);
      released = true;
      break;
    }
  }
  assert.ok(released);
  const bomber = new EnemyBody(ENEMIES.bomber, Grid.test(), 240, floor);
  let windup = 0;
  for (let i = 0; i < 120 && !bomber.dead; i++) {
    bomber.step(DT, bomber.x + 8, floor);
    const pose = enemyPose(bomber.kind, descriptor(bomber));
    if (bomber.state === "windup") {
      windup++;
      assert.ok(pose.frame < 8);
      assert.equal(bomber.pendingBlast, null);
    }
  }
  assert.ok(windup >= 32); // 550 ms fuse, not the old 450 ms animation fallback.
  assert.ok(bomber.pendingBlast);
  assert.deepEqual(enemyPose(bomber.kind, descriptor(bomber)), { clip: "explode", frame: 6 });
});

check("boss punch/wave danger gates and actual airborne-to-ground transition own contacts", () => {
  for (const state of ["punch", "wave", "charge"]) {
    const body = new BossBody(Grid.test(), 200, floor, 4);
    body.forceState(state);
    const acting = new BossActing();
    let active = false;
    for (let i = 0; i < 80; i++) {
      body.step(DT, 280, floor);
      const pose = acting.pose(descriptor(body));
      if (body.state !== state) break;
      if (state === "punch" && body.attackBox()) {
        active = true;
        assert.equal(pose.frame, 6);
      }
      if (state === "wave" && body.pendingWaves.length > 0) {
        active = true;
        assert.equal(pose.frame, 7);
        break;
      }
      if (state === "charge" && body.attackBox()) {
        active = true;
        assert.equal(pose.clip, "dash");
      }
    }
    assert.ok(active, state);
  }
  const body = new BossBody(Grid.test(), 200, floor, 1);
  body.forceState("jump");
  const acting = new BossActing();
  let landed = false;
  for (let i = 0; i < 180; i++) {
    body.step(DT, 260, floor);
    const pose = acting.pose(descriptor(body));
    if (body.state === "jump" || body.state === "slam") assert.ok(pose.frame < 11);
    if (body.pendingBlast) {
      assert.equal(pose.frame, 11);
      landed = true;
      break;
    }
  }
  assert.ok(landed);
  assert.equal(new BossActing().pose({ state: "idle", elapsed: 0 }), null);
  assert.deepEqual(acting.pose({ state: "idle", elapsed: 0 }), { clip: "flame-slam", frame: 11 });
  assert.equal(acting.pose({ state: "dead", elapsed: 0 }).clip, "death");
  assert.equal(acting.pose({ state: "dead", elapsed: 50 }).frame, 22);
  acting.reset();
  assert.equal(acting.pose({ state: "idle", elapsed: 0 }), null);
});

check("all poses address existing atlas frames without editing shared animation durations", () => {
  const states = ["spawn", "chase", "windup", "attack", "charge", "recover", "hurt", "dead"];
  for (const kind of Object.values(ENEMIES))
    for (const state of states)
      for (const elapsed of [0, 0.016, 0.1, 0.29, 0.42, 0.55, 1, 8]) {
        const pose = enemyPose(kind, { state, elapsed });
        if (pose) assert.ok(manager.get(`${kind.name}:${pose.clip}`).frames[pose.frame]);
      }
  const actor = new BossActing();
  for (const state of [
    "intro",
    "idle",
    "punch",
    "wave",
    "jump",
    "slam",
    "charge",
    "phase",
    "hurt",
    "dead",
  ])
    for (const elapsed of [0, 0.016, 0.26, 0.34, 0.4, 0.5, 0.6, 0.82, 2, 8]) {
      const pose = actor.pose({ state, elapsed });
      if (pose) assert.ok(manager.get(`salamander:${pose.clip}`).frames[pose.frame]);
    }
  for (const [key, durations] of originalDurations)
    assert.deepEqual(
      manager.get(key).frames.map((f) => f.duration),
      durations,
    );
});

check(
  "actual Phaser state holds through hit-stop, late/duplicate actions seek once, loops resume",
  () => {
    const enemy = new Enemy(scene, Grid.test(), ENEMIES.warrior, 240, floor);
    enemy.applyNet(
      "warrior:strike",
      240,
      floor,
      false,
      false,
      { state: "recover", elapsed: 0.2 },
      0x77bb33,
    );
    assert.equal(frameIndex(enemy.sprite), 8);
    for (let i = 0; i < 100; i++) {
      enemy.sprite.anims.update(i * 16, 16);
      enemy.applyNet(
        "warrior:strike",
        240,
        floor,
        false,
        false,
        { state: "recover", elapsed: 0.2 },
        0x77bb33,
      );
      assert.equal(frameIndex(enemy.sprite), 8);
    }
    assert.equal(enemy.sprite.tint, 0x77bb33);
    enemy.applyNet(
      "warrior:hit",
      240,
      floor,
      false,
      true,
      { state: "hurt", elapsed: 0.1 },
      0x33bb77,
    );
    assert.equal(enemy.sprite.tint, 0xffffff);
    enemy.applyNet(
      "warrior:run",
      240,
      floor,
      false,
      false,
      { state: "chase", elapsed: 0 },
      0x33bb77,
    );
    assert.equal(enemy.sprite.tint, 0x33bb77);
    assert.ok(enemy.sprite.anims.isPlaying);
    const initial = frameIndex(enemy.sprite);
    enemy.sprite.anims.update(0, 300);
    assert.notEqual(frameIndex(enemy.sprite), initial);
    enemy.applyNet("warrior:strike", 240, floor, false, false, { state: "windup", elapsed: 0 });
    assert.equal(frameIndex(enemy.sprite), 0); // real new attack, same clip restarts correctly by age.
    assert.equal(enemy.sprite.originY, config.ENEMY_ORIGIN_Y);
    const boss = new Boss(scene, Grid.test(), 240, floor, 3);
    boss.applyNet("salamander:flame-wave", 240, floor, false, false, true, {
      state: "wave",
      elapsed: 0.51,
    });
    assert.equal(frameIndex(boss.sprite), 7);
    boss.sprite.anims.update(2000, 2000);
    assert.equal(frameIndex(boss.sprite), 7);
    boss.applyNet("salamander:idle", 240, floor, false, false, false, {
      state: "idle",
      elapsed: 0,
    });
    assert.ok(boss.sprite.anims.isPlaying);
    assert.equal(boss.sprite.originY, config.HERO_ORIGIN_Y);
    enemy.destroy();
    boss.destroy();
  },
);

check("remote view smoothing agrees at 30/60/120 Hz and retains teleport snaps", () => {
  const outputs = [30, 60, 120].map((hz) => {
    const enemy = new Enemy(scene, Grid.test(), ENEMIES.warrior, 0, floor);
    for (let i = 0; i < hz / 5; i++)
      enemy.applyNet("warrior:idle", 40, floor, false, false, undefined, undefined, 1 / hz);
    const x = enemy.sprite.x;
    enemy.destroy();
    return x;
  });
  assert.ok(Math.max(...outputs) - Math.min(...outputs) < 1e-10);
  assert.ok(Math.abs(remoteBlend(1 / 60) - 0.35) < 1e-12);
  assert.equal(remoteBlend(0), 0);
  assert.equal(remoteBlend(-1), 0);
  assert.equal(remoteBlend(NaN), 0);
  const boss = new Boss(scene, Grid.test(), 0, floor, 1);
  boss.applyNet("salamander:idle", 49, floor, false, false, false, undefined, 1 / 120);
  assert.equal(boss.sprite.x, 49);
  boss.destroy();
});
console.log(`${checks} actor presentation groups passed`);
