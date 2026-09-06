import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as config from "../src/config.ts";
import * as animations from "../src/data/animations.ts";
import * as affixes from "../src/data/affixes.ts";
import * as biomes from "../src/data/biomes.ts";
import * as bosses from "../src/data/bosses.ts";
import * as enemies from "../src/data/enemies.ts";
import * as heroes from "../src/data/heroes.ts";
import * as relics from "../src/data/relics.ts";
import * as rooms from "../src/data/rooms.ts";
import * as acting from "../src/data/actor-presentation.ts";
import * as timing from "../src/data/clip-timing.ts";
import * as json from "../src/net/json.ts";
import * as snapshot from "../src/net/snapshot.ts";
import * as checkpoint from "../src/net/checkpoint.ts";
import * as rng from "../src/sys/rng.ts";
import * as versus from "../src/sys/versus.ts";
import { PlayerBody, rectsOverlap, DASH_DUR } from "../src/entities/player-body.ts";
import { EnemyBody } from "../src/entities/enemy-body.ts";
import { BossBody } from "../src/entities/boss-body.ts";
import { Grid } from "../src/sys/grid.ts";
import { RunManager } from "../src/sys/run.ts";
import { Reconciler } from "../src/net/predict.ts";
export const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
export const wire = (value) => JSON.parse(JSON.stringify(value));
export const neutral = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  attackPressed: false,
  specialPressed: false,
};
export function loadClass(path, name, context) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8").replace(
    /^import\b[^;]+;\s*/gm,
    "",
  );
  const code = stripTypeScriptTypes(src, { mode: "transform" }).replace(/^export /gm, "");
  return new Function(...Object.keys(context), `${code};return ${name};`)(
    ...Object.values(context),
  );
}
export function display(x = 0, y = 0) {
  const target = {
    x,
    y,
    active: true,
    visible: true,
    alpha: 1,
    flipX: false,
    scaleX: 1,
    scaleY: 1,
    anims: { currentAnim: { key: "axion:idle" }, isPlaying: true, timeScale: 1 },
    destroy() {
      this.active = false;
    },
    setTint(v) {
      this.tint = v;
      return this;
    },
    setVisible(v) {
      this.visible = v;
      return this;
    },
    setAlpha(v) {
      this.alpha = v;
      return this;
    },
    setPosition(x, y) {
      this.x = x;
      this.y = y;
      return this;
    },
    setFlipX(v) {
      this.flipX = v;
      return this;
    },
    play(key) {
      this.anims.currentAnim = { key };
      return this;
    },
  };
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (key in obj) return obj[key];
      return () => receiver;
    },
  });
}
const noOp = () => {};
function sceneOwner(key) {
  this.sceneKey = key;
}
export function fixture(id = "left", withPartner = true) {
  const cues = [],
    writes = [],
    exits = [],
    bank = [];
  const Phaser = {
    Scene: sceneOwner,
    Math: { Clamp: (n, a, b) => Math.max(a, Math.min(b, n)), Linear: (a, b, t) => a + (b - a) * t },
    Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } },
  };
  const fx = Object.fromEntries(
    [
      "afterImage",
      "landPuff",
      "smoke",
      "clearFx",
      "dust",
      "explosion",
      "hitSpark",
      "impactRing",
      "popText",
      "wallSmoke",
    ].map((name) => [name, () => cues.push(name)]),
  );
  const context = {
    ...config,
    ...animations,
    ...affixes,
    ...biomes,
    ...bosses,
    ...enemies,
    ...heroes,
    ...relics,
    ...rooms,
    ...acting,
    ...timing,
    ...json,
    ...snapshot,
    ...checkpoint,
    ...rng,
    ...versus,
    ...fx,
    Phaser,
    PlayerBody,
    EnemyBody,
    BossBody,
    rectsOverlap,
    DASH_DUR,
    Grid,
    RunManager,
    Reconciler,
    window: { matchMedia: () => ({ matches: false }) },
    location: { search: "" },
    sfx: new Proxy({}, { get: (_, name) => () => cues.push(`sound:${name}`) }),
    showActorPose: noOp,
    buildParallax: () => [],
    drawRoom: () => display(),
    ambientEmbers: () => display(),
    bankRun: (...args) => {
      bank.push(["bank", ...args]);
      return { banked: 0 };
    },
    recordBestScore: (...args) => bank.push(["best", ...args]),
    loadMeta: () => ({}),
    runBonuses: () => ({ dmg: 0, armor: 0, hearts: 0 }),
    syncTouchHud: noOp,
    diag: { frame: 0, player: {} },
    isCoarse: () => false,
    touchHudBand: () => 0,
    gameInset: () => 0,
    Door: class {
      constructor(scene, x, y, type, index) {
        Object.assign(this, { x, y, type, index });
      }
      setActive(v) {
        this.active = v;
      }
      destroy() {}
      near() {
        return false;
      }
    },
  };
  context.Player = loadClass("../src/entities/player.ts", "Player", context);
  context.Enemy = loadClass("../src/entities/enemy.ts", "Enemy", context);
  context.Boss = loadClass("../src/entities/boss.ts", "Boss", context);
  const Scene = loadClass("../src/scenes/game-scene.ts", "GameScene", context);
  const scene = new Scene();
  Object.assign(scene, {
    anims: { exists: () => false },
    add: new Proxy({}, { get: () => display }),
    cameras: { main: display() },
    tweens: { add: () => display(), killTweensOf: noOp },
    time: { now: 0 },
    controls: { reset: noOp, update: noOp, sample: () => neutral },
    gamepad: { update: noOp },
    heartsText: display(),
    infoText: display(),
    banner: display(),
    comboText: display(),
    fadeRect: display(),
    scene: { start: (...args) => exits.push(args) },
    scale: { width: config.BASE_W, height: config.BASE_H },
    registry: { get: noOp, set: noOp },
  });
  const peer = id === "left" ? "right" : "left";
  const players = {
    [id]: {
      id,
      connected: true,
      state: { hero: "axion", input: { ...neutral, j: 0, d: 0, a: 0, s: 0 } },
    },
  };
  if (withPartner)
    players[peer] = {
      id: peer,
      connected: true,
      state: { hero: "salamander", input: { ...neutral, j: 0, d: 0, a: 0, s: 0 } },
    };
  const session = {
    playerId: id,
    hostId: id,
    live: true,
    isHost: true,
    offline: false,
    authorityRevision: 1,
    disconnectRevision: 0,
    players,
    sharedState: null,
    tick: noOp,
    otherPlayer() {
      return Object.values(this.players).find((p) => p.id !== this.playerId) ?? null;
    },
    updateMyState(patch) {
      Object.assign(this.players[this.playerId].state, patch);
    },
    patchShared(patch) {
      writes.push(patch);
      this.sharedState = { ...this.sharedState, ...patch };
    },
  };
  scene.session = session;
  scene.role = "host";
  scene.authority = { kind: "ready", runId: "expedition", term: 0, revision: 1 };
  scene.seats = { host: "left", guest: withPartner ? "right" : null };
  scene.grid = Grid.test();
  scene.roomSpawn = { x: 40, y: (scene.grid.rows - 2) * config.TILE };
  scene.player = scene.spawnPlayer(heroes.HEROES.axion, scene.grid, 40, scene.roomSpawn.y);
  if (withPartner) {
    scene.remote = scene.spawnPlayer(heroes.HEROES.salamander, scene.grid, 320, scene.roomSpawn.y);
    scene.remoteId = peer;
  }
  scene.run.type = "combat";
  scene.run.biome = 2;
  scene.run.depth = 3;
  scene.roomSeq = 4;
  scene.mustClear = true;
  // Presentation-only outputs remain explicit mocks. Actual bodies, room builders,
  // combat, RNG, lifecycle admission and every tested scene method are unchanged.
  scene.updateHud = noOp;
  return { scene, session, cues, writes, exits, bank, context, Scene };
}
export function accepted(scene) {
  const snap = scene.encodeSnapshot();
  const checkpoint = scene.encodeCheckpoint();
  assert.ok(checkpoint);
  const room = scene.encodeRoom();
  const state = wire({ snap, checkpoint, room });
  const read = checkpointRead(state);
  assert.equal(read.kind, "ready");
  return { state, read };
}
const checkpointRead = checkpoint.readCheckpoint;
export { checkpoint, rng, config, heroes, enemies, versus };
