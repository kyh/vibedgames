import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as constants from "../src/shared/constants.ts";
import { enemyToWire } from "../src/shared/wire.ts";
import { chargeTrail, fleetPose, hostileShotLook } from "../src/render/fleet-acting.ts";
import { TraumaCamera } from "../src/render/trauma-camera.ts";
import { method, sceneSource, networkFixture } from "./network-harness.mjs";

function actual(methods, scope) {
  const code = stripTypeScriptTypes(
    `class Scene { ${methods.map((name) => method(name)).join("\n")} }`,
    { mode: "strip" },
  );
  return new (new Function(...Object.keys(scope), `${code}; return Scene;`)(
    ...Object.values(scope),
  ))();
}
function helper(name) {
  const found = new RegExp(`^function ${name}\\([^]*?^}`, "m").exec(sceneSource)?.[0];
  assert.ok(found, name);
  return stripTypeScriptTypes(found, { mode: "strip" });
}
function shooter() {
  let ids = 0;
  const Phaser = { Math: { Clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) } };
  const helpers = new Function(
    "Phaser",
    `${["nearestOf", "dist2", "wrapAngle", "rotateToward"].map(helper).join("\n")};return {nearestOf,dist2,wrapAngle,rotateToward};`,
  )(Phaser);
  const scene = actual(["hostSpawnShot", "hostSimEnemies"], {
    ...constants,
    ...helpers,
    DEG: Math.PI / 180,
    entityId: () => `shot-${ids++}`,
    Phaser: { Math: { Clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) } },
  });
  const sim = { fireAt: 100, nextAttackAt: 0, kbVx: 0, kbVy: 0 };
  scene.world = { enemies: [], enemyShots: [], beacon: null };
  scene.dirty = { enemies: false, enemyShots: false };
  scene.enemySim = new Map();
  scene.simFor = () => sim;
  return { scene, sim };
}

test("actual accepted shot preserves origin, velocity, lifetime and records one visual time", () => {
  const { scene } = shooter();
  const enemy = constants.spawnEnemyState("sniper", 100, 200);
  scene.hostSpawnShot(enemy, Math.PI / 2, constants.SNIPER_SHOT_SPEED, 1234);
  const [shot] = scene.world.enemyShots;
  assert.deepEqual(shot, {
    id: "shot-0",
    x: 100,
    y: 200,
    vx: Math.cos(Math.PI / 2) * constants.SNIPER_SHOT_SPEED,
    vy: constants.SNIPER_SHOT_SPEED,
    diesAt: 1234 + constants.ENEMY_SHOT_TTL_MS,
  });
  assert.equal(enemy.attackAt, 1234);
  assert.deepEqual(scene.dirty, { enemies: true, enemyShots: true });
});

test("expired warning outside range does not invent an attack; accepted in-range fire does", () => {
  for (const distance of [100, constants.ENEMY_FIRE_RANGE + 100]) {
    const { scene } = shooter();
    const enemy = constants.spawnEnemyState("drone", 0, 0);
    enemy.telegraphUntil = 100;
    scene.world.enemies.push(enemy);
    scene.hostSimEnemies(100, 1 / 60, [{ x: distance, y: 0 }]);
    assert.equal(scene.world.enemyShots.length, distance === 100 ? 1 : 0);
    assert.equal(enemy.attackAt, distance === 100 ? 100 : undefined);
  }
});

test("wire round trip ages recovery; old, future and malformed timestamps stay neutral", () => {
  const enemy = constants.spawnEnemyState("sniper", 10, 20);
  const neutral = { recoil: 0, scaleX: 1, scaleY: 1 };
  for (const attackAt of [undefined, NaN, Infinity, 1500]) {
    const wire = enemyToWire({ ...enemy, attackAt });
    assert.deepEqual(fleetPose(wire, 1000, 0, false), neutral);
  }
  const wire = enemyToWire({ ...enemy, attackAt: 1000 });
  const fresh = fleetPose(wire, 1000, 0, false);
  const late = fleetPose(wire, 1120, 0, false);
  assert.ok(fresh.recoil > late.recoil && late.recoil > 0);
  assert.deepEqual(fleetPose(wire, 1220, 0, false), neutral);
  assert.deepEqual(fleetPose(wire, 1000, 0, true), neutral);
  assert.equal(wire.x, 10);
  assert.equal(wire.y, 20);
});

test("charge trail density agrees at30/60/144Hz and skips long-gap backlog", () => {
  for (const hz of [30, 60, 144]) {
    let nextAt = null;
    let emitted = 0;
    for (let frame = 0; frame <= hz; frame++) {
      const sample = chargeTrail(nextAt, (frame * 1000) / hz, true);
      nextAt = sample.nextAt;
      emitted += sample.count;
    }
    assert.equal(emitted, 61, `${hz}Hz inclusive1s`);
    assert.equal(chargeTrail(nextAt, 1000, true).count, 0, "same paused time");
    assert.equal(chargeTrail(nextAt, 10000, true).count, 3);
    assert.deepEqual(chargeTrail(nextAt, 10000, false), { nextAt: null, count: 0 });
  }
});

test("hostile motifs match existing serialized-speed damage bands", () => {
  for (const [speed, look, damage] of [
    [220, "plasma", constants.DMG.DRONE_SHOT],
    [260, "plasma", constants.DMG.DRONE_SHOT],
    [420, "burst", constants.DMG.WASP_SHOT],
    [720, "rail", constants.DMG.SNIPER_BOLT],
    [820, "lance", constants.DMG.BOSS_LANCE],
  ]) {
    assert.equal(hostileShotLook(speed), look);
    assert.equal(constants.enemyShotHit(speed).dmg, damage);
  }
});

test("live reduced motion clears actual camera recoil, roll, trauma and screen flash", () => {
  let reduced = false;
  const camera = {
    centerOn(x, y) {
      this.x = x;
      this.y = y;
    },
    setAngle(value) {
      this.angle = value;
    },
  };
  const scene = actual(["updateCamera", "screenFlash"], {});
  Object.assign(scene, {
    spawned: true,
    shipX: 50,
    shipY: 70,
    kickX: 8,
    kickY: 5,
    trauma: new TraumaCamera(),
    fx: { battle: { reducedMotion: () => reduced } },
    cameras: { main: camera },
    scale: { width: 1280, height: 720 },
    flashRect: {
      setSize() {},
      setAlpha(n) {
        this.alpha = n;
      },
    },
    tweens: { killTweensOf() {}, add() {} },
  });
  scene.trauma.add(1);
  scene.updateCamera(1 / 60, 1000);
  assert.notEqual(camera.angle, 0);
  reduced = true;
  scene.screenFlash();
  scene.updateCamera(1 / 60, 1016);
  assert.deepEqual(
    [
      camera.x,
      camera.y,
      camera.angle,
      scene.camRollDeg,
      scene.kickX,
      scene.kickY,
      scene.flashRect.alpha,
    ],
    [50, 70, 0, 0, 0, 0, 0],
  );
  reduced = false;
  scene.updateCamera(1 / 60, 1032);
  assert.deepEqual(
    [camera.x, camera.y, camera.angle],
    [50, 70, 0],
    "no deferred kick after restoring motion",
  );
  scene.trailer = { camPos: { x: 300, y: 200 } };
  reduced = true;
  scene.updateCamera(1 / 60, 1048);
  assert.deepEqual([camera.x, camera.y, camera.angle], [300, 200, 0], "trailer target retained");
});

test("existing connected enemy adopts fresh attack time and clears legacy/invalid replacements", () => {
  const f = networkFixture();
  const enemy = constants.spawnEnemyState("sniper", 400, 300);
  f.sync({ ...f.empty(), enemies: [enemy] }, "remote");
  const local = f.scene.world.enemies[0];
  assert.equal(local.attackAt, undefined);
  for (const attackAt of [999_900, 1_000_000, undefined, 1_000_100, NaN]) {
    f.sync({ ...f.empty(), enemies: [{ ...enemy, attackAt }] }, "remote");
    assert.equal(f.scene.world.enemies[0], local, "same living hull");
    assert.equal(local.attackAt, Number.isFinite(attackAt) ? attackAt : undefined);
  }
  f.client.destroy();
});
