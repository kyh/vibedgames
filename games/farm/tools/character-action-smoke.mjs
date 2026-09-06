// Actual action/contact methods with deterministic scene clocks and an event
// emitter standing in for rendering. Native sheet/feet inspection is separate.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CharacterAction,
  FARMER_HURT_MS,
  SKELETON_CONTACT_MS,
} from "../src/render/character-action.ts";
import { store } from "../src/systems/store.ts";
import * as config from "../src/config.ts";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(resolve(base, "src/scenes", `${name}-scene.ts`), "utf8");
const gameSource = read("game");
const mineSource = read("mine");
const bootSource = read("boot");
function method(source, name, required = true) {
  const found = new RegExp(`^  (?:(?:private|override) )?${name}\\([^]*?^  }`, "m").exec(
    source,
  )?.[0];
  if (required) assert.ok(found, `actual ${name} method`);
  return found ?? "";
}
function record(source, name) {
  const declaration = new RegExp(`(?:export )?const ${name} = \\{[^]*?^};?[^\\n]*`, "m").exec(
    source,
  )?.[0];
  assert.ok(declaration, name);
  return new Function(
    `${stripTypeScriptTypes(declaration.replace(/^export /, ""))}; return ${name};`,
  )();
}
const timings = record(gameSource, "ACTION_TIMING");
const Phaser = {
  Animations: { Events: { ANIMATION_COMPLETE: "animationcomplete" } },
  Cameras: { Scene2D: { Events: { FADE_OUT_COMPLETE: "fadeout" } } },
  TintModes: { FILL: 1 },
};
const dependencies = {
  ...config,
  CharacterAction,
  FARMER_HURT_MS,
  SKELETON_CONTACT_MS,
  ACTION_TIMING: timings,
  Phaser,
  store,
  Sound: { chop() {}, mine() {}, thud() {}, footstep() {} },
  burst() {},
  floatText() {},
  shake() {},
  stickMove: () => null,
};
function sceneClass(source, names) {
  const code = stripTypeScriptTypes(
    `class ActualScene { ${names.map((name) => method(source, name)).join("\n")}\n${method(source, "setMovementAnimation", false)}\n${method(source, "resetCharacterAction", false)} }`,
  );
  return new Function(...Object.keys(dependencies), `${code}; return ActualScene;`)(
    ...Object.values(dependencies),
  );
}
const Game = sceneClass(gameSource, ["beginAction"]);
const mineMethods = [
  "swing",
  "mineNode",
  "damagePlayer",
  "faint",
  "handleMovement",
  "updateEnemies",
  "hitEnemy",
  "killEnemy",
];
const Mine = sceneClass(mineSource, mineMethods);
class Sprite extends EventEmitter {
  scene = {};
  x = 100;
  y = 100;
  anims = { currentAnim: { key: "p-idle" } };
  plays = [];
  play(key) {
    this.anims.currentAnim = { key };
    this.plays.push(key);
    return this;
  }
  setFlipX(flip) {
    this.flip = flip;
    return this;
  }
  setTint() {
    return this;
  }
  setTintMode() {
    return this;
  }
  clearTint() {
    return this;
  }
  setAlpha() {
    return this;
  }
  setDepth() {
    return this;
  }
  destroy() {
    this.scene = undefined;
    this.removeAllListeners();
  }
  complete(key = this.anims.currentAnim.key) {
    this.emit("animationcomplete", { key });
    this.emit(`animationcomplete-${key}`, { key });
  }
}
class Clock {
  now = 0;
  timers = [];
  delayedCall(ms, callback) {
    this.timers.push({ at: this.now + ms, callback });
  }
  runTo(now) {
    while (true) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > now) break;
      this.timers.shift();
      this.now = next.at;
      next.callback();
    }
    this.now = now;
  }
}
function fixture(Type = Mine) {
  store.initNew();
  const g = new Type();
  Object.assign(g, {
    player: new Sprite(),
    characterAction: new CharacterAction(),
    hurtUntil: 0,
    time: new Clock(),
    acting: false,
    transitioning: false,
    clickPath: [],
    invulnUntil: 0,
    knock: { x: 0, y: 0 },
    facing: { x: 1, y: 0 },
    enemies: [],
    depth: 1,
    visit: { deepest: 1, defeated: 0, gathered: 0, startingGold: store.gold },
    recap: () => ({}),
    stepTimer: 0,
    persistCalls: 0,
    persist() {
      this.persistCalls++;
    },
    toast() {},
    moveBy(x, y) {
      this.player.x += x;
      this.player.y += y;
    },
    moveEnemy(e, x, y) {
      e.spr.x += x;
      e.spr.y += y;
    },
    baseZoom: () => 3,
    awardCombatLoot() {},
    dropNode() {},
    pad: { getStick: () => null },
    tweens: { add() {} },
    keys: Object.fromEntries(
      ["A", "D", "W", "S", "LEFT", "RIGHT", "UP", "DOWN", "SHIFT"].map((key) => [
        key,
        { isDown: false },
      ]),
    ),
    scene: { stop() {}, start() {} },
  });
  const cam = new EventEmitter();
  cam.fadeOut = (duration) => {
    g.fadeDuration = duration;
  };
  cam.zoomTo = () => {};
  cam.setZoom = () => {};
  g.cameras = { main: cam };
  return g;
}
function enemy(x = 116, y = 94) {
  const spr = new Sprite();
  spr.x = x;
  spr.y = y;
  return {
    spr,
    hp: 100,
    maxHp: 100,
    dead: false,
    hurt: 0,
    contactUntil: 0,
    invuln: 0,
    kx: 0,
    ky: 0,
  };
}
let groups = 0;
function pass(label) {
  groups++;
  console.log(`PASS ${label}`);
}

// Unrelated completions used to release acting and cancel its guarded impact.
for (const [action, expectedMs, energyCost] of [
  ["dig", 500, 2],
  ["water", 1000 / 3, 2],
  ["axe", 437.5, 2],
  ["mine", 437.5, 2],
  ["doing", 4000 / 14, 0],
]) {
  const g = fixture(Game);
  const energy = store.energy;
  let impacts = 0;
  g.beginAction(action, () => impacts++);
  g.player.complete("p-caught");
  assert.equal(g.acting, true);
  assert.equal(g.player.anims.currentAnim.key, `p-${action}`);
  assert.equal(store.energy, energy - energyCost);
  assert.ok(Math.abs(g.time.timers[0].at - expectedMs) < 1e-9);
  g.time.runTo(expectedMs - 0.001);
  assert.equal(impacts, 0);
  g.time.runTo(expectedMs + 0.001);
  assert.equal(impacts, 1);
  g.player.complete();
  assert.equal(g.acting, false);
  assert.equal(g.player.anims.currentAnim.key, "p-idle");
  g.player.complete(`p-${action}`);
  assert.equal(impacts, 1);
}
const exhausted = fixture(Game);
store.energy = 0;
exhausted.beginAction("dig", () => assert.fail("rejected impact"));
assert.equal(exhausted.acting, false);
assert.equal(exhausted.time.timers.length, 0);
exhausted.beginAction("doing", () => {});
assert.equal(exhausted.acting, true);
pass("five exact farm impacts/energy; unrelated completion; rejection unchanged");

const owner = new CharacterAction();
const sprite = new Sprite();
let completions = 0;
for (let i = 0; i < 100; i++) owner.watch(sprite, "p-mine", () => completions++);
assert.equal(sprite.listenerCount("animationcomplete-p-mine"), 1);
sprite.play("p-death");
sprite.complete("p-mine");
assert.equal(completions, 0);
owner.watch(sprite, "p-mine", () => completions++);
owner.reset();
owner.reset();
assert.equal(sprite.listenerCount("animationcomplete-p-mine"), 0);
owner.watch(sprite, "p-mine", () => completions++);
sprite.destroy();
sprite.off = () => assert.fail("destroyed sprite touched");
owner.reset();
owner.reset();
pass("one completion owner; replacement/death key; repeated and post-destroy reset");

const swing = fixture();
const target = enemy();
swing.enemies = [target];
const energy = store.energy;
swing.swing();
assert.equal(store.energy, energy - 2);
assert.equal(swing.invulnUntil, 350);
swing.time.runTo(179.999);
assert.equal(target.hp, 100);
swing.time.runTo(180);
assert.equal(target.hp, 100 - store.skills.swordDamage(config.SWORD_BASE_DAMAGE));
assert.equal(target.spr.anims.currentAnim.key, "e-skel-hurt");
swing.player.complete("p-caught");
assert.equal(swing.acting, true);
swing.player.complete("p-attack");
assert.equal(swing.acting, false);
const mining = fixture();
const node = { hp: 3, spr: new Sprite() };
mining.mineNode(node);
mining.time.runTo(439.999);
assert.equal(node.hp, 3);
mining.time.runTo(440);
assert.equal(node.hp, 2);
mining.player.complete();
assert.equal(mining.acting, false);
pass("actual sword180/node440 contacts, damage, energy and original protection");

const hurt = fixture();
hurt.damagePlayer(9, 1, 0);
assert.equal(hurt.player.anims.currentAnim.key, "p-hurt");
assert.equal(hurt.acting, false);
assert.equal(hurt.invulnUntil, 800);
assert.deepEqual(hurt.knock, { x: -180, y: -0 });
hurt.knock = { x: 0, y: 0 };
hurt.keys.RIGHT.isDown = true;
hurt.handleMovement(0.05);
assert.equal(hurt.player.x, 100 + config.WALK_SPEED * 0.05);
assert.equal(hurt.player.anims.currentAnim.key, "p-hurt");
hurt.time.runTo(FARMER_HURT_MS);
hurt.handleMovement(0);
assert.equal(hurt.player.anims.currentAnim.key, "p-walk");
const interrupt = fixture();
interrupt.damagePlayer(9, 1, 0);
interrupt.swing();
assert.equal(interrupt.player.anims.currentAnim.key, "p-attack");
assert.equal(interrupt.hurtUntil, 0);
interrupt.damagePlayer(9, 1, 0);
assert.equal(interrupt.player.anims.currentAnim.key, "p-attack");
assert.equal(interrupt.player.listenerCount("animationcomplete-p-attack"), 1);
pass("hurt does not block movement/input or replace committed action");

const dying = fixture();
store.gold = 100;
store.hp = 1;
const dyingNode = { hp: 3, spr: new Sprite() };
dying.mineNode(dyingNode);
dying.damagePlayer(9, 1, 0);
assert.equal(dying.player.anims.currentAnim.key, "p-death");
assert.equal(dying.fadeDuration, 900);
assert.equal(store.gold, 92);
assert.equal(dying.transitioning, true);
assert.equal(dying.player.listenerCount("animationcomplete-p-mine"), 0);
dying.player.complete("p-mine");
assert.equal(dying.player.anims.currentAnim.key, "p-death");
dying.time.runTo(440);
assert.equal(dyingNode.hp, 2, "existing committed impact is preserved during faint");
dying.resetCharacterAction();
dying.resetCharacterAction();
assert.equal(dying.acting, false);
pass("faint wins presentation; original loss/fade/pending-impact semantics retained");

const contact = fixture();
const attacker = enemy(110, 100);
contact.enemies = [attacker];
contact.time.now = 1;
contact.updateEnemies(0);
assert.equal(attacker.spr.anims.currentAnim.key, "e-skel-contact");
assert.equal(store.hp, config.MAX_HP - 9);
assert.equal(attacker.contactUntil, 1 + SKELETON_CONTACT_MS);
const plays = attacker.spr.plays.length;
contact.time.now = 100;
contact.updateEnemies(0);
assert.equal(attacker.spr.plays.length, plays);
assert.equal(store.hp, config.MAX_HP - 9);
contact.time.now = 251;
contact.updateEnemies(0);
assert.equal(attacker.spr.anims.currentAnim.key, "e-skel-idle");
contact.invulnUntil = 1000;
attacker.hurt = 0.18;
attacker.kx = 140;
contact.updateEnemies(0.05);
assert.equal(attacker.spr.anims.currentAnim.key, "e-skel-hurt");
contact.hitEnemy(attacker, 1000);
assert.equal(attacker.spr.anims.currentAnim.key, "e-skel-death");
contact.updateEnemies(1);
assert.equal(attacker.spr.anims.currentAnim.key, "e-skel-death");
pass("contact follow-through only after accepted damage; repeat suppression and death priority");

// Exercise actual Boot animation definitions: existing rates unchanged; no
// windup frames enter the post-contact clip. No image pixels are rewritten.
const charFrames = record(bootSource, "CHAR_FRAMES");
const skelFrames = record(bootSource, "SKEL");
const definitions = new Map();
const loaded = new Map();
const bootCode = stripTypeScriptTypes(
  `class Boot { ${method(bootSource, "preload")} ${method(bootSource, "makeAnimsAndStart")} }`,
);
const Boot = new Function(
  "CHAR",
  "CHAR_FRAMES",
  "SKEL",
  "CROP_ORDER",
  "getWorldMap",
  "window",
  "FARMER_HURT_MS",
  "SKELETON_CONTACT_MS",
  `${bootCode}; return Boot;`,
)(
  { frameWidth: 96, frameHeight: 64 },
  charFrames,
  skelFrames,
  [],
  () => ({ deco: {} }),
  { location: { search: "" } },
  FARMER_HURT_MS,
  SKELETON_CONTACT_MS,
);
const boot = new Boot();
boot.load = {
  spritesheet: (key, path, frameSize) => loaded.set(key, { path, frameSize }),
  image() {},
  atlas() {},
  json() {},
};
boot.anims = {
  create: (def) => definitions.set(def.key, def),
  generateFrameNumbers: (key, range) => ({ key, range }),
};
boot.makeIcon = () => {};
boot.scene = { start() {} };
boot.preload();
boot.makeAnimsAndStart();
for (const [key, rate] of [
  ["p-walk", 12],
  ["p-run", 14],
  ["p-dig", 18],
  ["p-water", 9],
  ["p-axe", 16],
  ["p-mine", 16],
  ["p-doing", 14],
  ["p-attack", 20],
  ["p-death", 10],
])
  assert.equal(definitions.get(key)?.frameRate, rate);
assert.equal(loaded.get("p-hurt")?.path, "assets/char/hurt.webp");
assert.deepEqual(loaded.get("e-skel-attack")?.frameSize, { frameWidth: 96, frameHeight: 64 });
assert.deepEqual(definitions.get("e-skel-contact")?.frames, {
  key: "e-skel-attack",
  range: { start: 4, end: 6 },
});
assert.equal(definitions.get("e-skel-contact")?.frameRate, 12);
assert.equal(loaded.has("p-roll"), false);
assert.equal(loaded.has("p-carry"), false);
pass("actual Boot assets/frames/rates and original movement strips preserved");

// Optional local baseline comparison executes the immutable original methods;
// only simulation state is compared, deliberately excluding new poses.
if (process.env.FARM_ACTION_BASELINE) {
  const oldMine = readFileSync(
    resolve(process.env.FARM_ACTION_BASELINE, "src/scenes/mine-scene.ts"),
    "utf8",
  );
  const Before = sceneClass(oldMine, mineMethods);
  function trace(Type, scenario) {
    const g = fixture(Type);
    const e = enemy(scenario.x, scenario.y);
    g.enemies = [e];
    const out = [];
    for (let i = 0; i < 120; i++) {
      const dt = scenario.steps[i % scenario.steps.length];
      g.time.runTo(g.time.now + dt * 1000);
      g.keys.RIGHT.isDown = i < 30;
      g.keys.SHIFT.isDown = i < 15;
      if (i === 10 || i === 50) g.swing();
      g.handleMovement(dt);
      g.updateEnemies(dt);
      if (i === 25 || i === 65) g.player.complete("p-attack");
      out.push({
        x: g.player.x,
        y: g.player.y,
        facing: { ...g.facing },
        knock: { ...g.knock },
        acting: g.acting,
        hp: store.hp,
        energy: store.energy,
        invuln: g.invulnUntil,
        enemy: { x: e.spr.x, y: e.spr.y, hp: e.hp, kx: e.kx, ky: e.ky, hurt: e.hurt },
      });
    }
    return out;
  }
  for (const scenario of [
    { x: 110, y: 100, steps: [1 / 60] },
    { x: 160, y: 100, steps: [1 / 30] },
    { x: 116, y: 94, steps: [0.016, 0.05, 0.008] },
  ])
    assert.deepEqual(trace(Mine, scenario), trace(Before, scenario));
  pass("360 actual baseline/current movement/contact/damage/protection/energy trace steps");
}
console.log(`${groups} Farm character/action groups passed.`);
