import assert from "node:assert/strict";
import { test } from "node:test";
import { Group, Vector2 } from "three";
import { advanceEvasion, EVADE } from "../src/entities/evasion.ts";
import {
  applyNetState,
  makeNetTarget,
  restoreNetEvasion,
  steerPuppet,
} from "../src/net/interpolation.ts";
import { isSnapshot } from "../src/net/snapshot.ts";
import type { NetBrawler, Snapshot } from "../src/net/snapshot.ts";
import { terrainHeight } from "../src/world/terrain.ts";

const row = (overrides: Partial<NetBrawler> = {}): NetBrawler => ({
  alive: true,
  ammo: 3,
  bush: false,
  charge: 0,
  cubes: 0,
  evadeAccepted: false,
  evadeAck: 0,
  evadeCooldown: 0,
  evasion: null,
  facing: 0,
  hp: 6000,
  hue: 0,
  id: "p:test",
  kills: 0,
  kit: "titan",
  leap: null,
  maxHp: 6000,
  melee: null,
  name: "Warden",
  owner: "test",
  rank: 0,
  vx: 0,
  vz: 0,
  x: 0,
  y: 2.4,
  z: 18,
  ...overrides,
});

const body = (drive: "predict" | "puppet"): Parameters<typeof applyNetState>[0] => ({
  alive: true,
  ammo: 3,
  burst: null,
  cubes: 0,
  deadT: 0,
  drive,
  evadeCooldown: 0,
  evasion: null,
  facing: 0,
  flash: 0,
  hp: 6000,
  inBush: false,
  kills: 0,
  leap: null,
  maxHp: 6000,
  meleeCue: null,
  netAir: false,
  netTarget: makeNetTarget(),
  rank: 0,
  recoil: 0,
  revealT: 0,
  root: new Group(),
  squash: 0,
  superCharge: 0,
  swing: null,
  vel: new Vector2(),
});

test("highland snapshots leave grounded guests mobile", () => {
  const drives: readonly ("predict" | "puppet")[] = ["predict", "puppet"];
  for (const drive of drives) {
    const b = body(drive);
    applyNetState(b, row());
    assert.equal(b.netAir, false);
    assert.equal(b.root.position.y, terrainHeight(0, 18));
  }
});

test("prediction correction samples the corrected ramp position, including rounded wire heights", () => {
  const b = body("predict");
  b.root.position.set(0, terrainHeight(0, 6), 6);
  applyNetState(b, row({ y: 0.93, z: 7 }));
  assert.ok(b.root.position.z > 6 && b.root.position.z < 7);
  assert.equal(b.root.position.y, terrainHeight(0, b.root.position.z));
  assert.equal(b.netAir, false);

  applyNetState(b, row({ y: 2.4, z: -20 }));
  assert.equal(b.root.position.z, -20);
  assert.equal(b.root.position.y, terrainHeight(0, -20));
});

test("puppets stay on the ramp while interpolating and extrapolating uphill", () => {
  const b = body("puppet");
  applyNetState(b, row({ y: 0, z: 4.8 }));
  applyNetState(b, row({ vz: 5, y: 0.93, z: 7 }));
  let moved = false;
  for (let frame = 0; frame < 30; frame += 1) {
    moved = steerPuppet(b, 1 / 60) || moved;
    assert.equal(b.root.position.y, terrainHeight(b.root.position.x, b.root.position.z));
  }
  assert.equal(moved, true);
  assert.ok(b.root.position.z > 7);
  assert.equal(b.netAir, false);
});

test("leap state, rather than height, governs airborne prediction and landing", () => {
  const b = body("predict");
  const leap = { sx: 0, sz: 0, t: 0, tx: 0, tz: 18 };
  applyNetState(b, row({ leap, y: 0, z: 0 }));
  assert.equal(b.netAir, true);
  applyNetState(b, row({ leap: { ...leap, t: 0.4 }, y: 4.2, z: 9 }));
  assert.equal(b.root.position.y, 4.2);
  applyNetState(b, row());
  assert.equal(b.netAir, false);
  assert.equal(b.root.position.y, terrainHeight(0, 18));
});

const snapshot = (brawler: NetBrawler): Snapshot => ({
  bombs: [],
  boxes: [],
  brawlers: [brawler],
  broken: [],
  bullets: [],
  countdownT: 0,
  cubes: [],
  gas: { active: false, half: 25, round: 0 },
  gen: 1,
  hour: 15,
  matchTime: 10,
  phase: "playing",
  seed: 7,
  seq: 1,
  winner: null,
});

test("snapshot validation preserves leap progress and rejects impossible or malformed airborne rows", () => {
  const leap = { sx: 2, sz: 6, t: 0.3, tx: 4, tz: 16 };
  assert.equal(isSnapshot(snapshot(row())), true);
  assert.equal(isSnapshot(snapshot(row({ leap }))), true);
  assert.equal(isSnapshot(snapshot(row({ kit: "ace", leap }))), false);
  assert.equal(isSnapshot(snapshot(row({ leap: { ...leap, t: -1 } }))), false);
  assert.equal(isSnapshot(snapshot(row({ leap: { ...leap, tx: Number.NaN } }))), false);
  const missingLeap = row();
  Reflect.deleteProperty(missingLeap, "leap");
  assert.equal(isSnapshot(snapshot(missingLeap)), false);
});

test("late melee snapshots sample the accepted pose age and death clears the pose", () => {
  const b = body("puppet");
  const melee = { angle: Math.PI / 2, elapsed: 0.25, recovery: 0.56, windup: 0.18 };
  const n = row({ melee });
  assert.equal(isSnapshot(snapshot(n)), true);
  applyNetState(b, n);
  assert.deepEqual(b.meleeCue, melee);
  assert.notEqual(b.meleeCue, melee, "local animation cannot mutate the wire snapshot");
  applyNetState(b, row({ alive: false, melee }));
  assert.equal(b.meleeCue, null);
  assert.equal(isSnapshot(snapshot(row({ kit: "ace", melee }))), false);
  assert.equal(isSnapshot(snapshot(row({ melee: { ...melee, elapsed: -1 } }))), false);
  assert.equal(isSnapshot(snapshot(row({ melee: { ...melee, windup: 0 } }))), false);
  assert.equal(isSnapshot(snapshot(row({ melee: { ...melee, elapsed: 1 } }))), false);
});

test("projectile and lob silhouettes survive the snapshot boundary; unknown styles fail", () => {
  const base = snapshot(row());
  const bullet = {
    c: 0xba_dd_84,
    dx: 0,
    dz: 1,
    l: 7,
    m: false,
    r: 0.15,
    s: false,
    v: 14,
    x: 2,
    z: 3,
  };
  for (const style of ["arrow", "spear", "thorn", "bolt"]) {
    assert.equal(isSnapshot({ ...base, bullets: [{ ...bullet, style }] }), true);
  }
  assert.equal(isSnapshot({ ...base, bullets: [{ ...bullet, style: "unknown" }] }), false);
  const bomb = {
    big: false,
    c: 0x82_d9_c8,
    r: 1.5,
    s: false,
    tx: 3,
    tz: 4,
    u: 0.2,
    x: 2,
    y: 1,
    z: 3,
  };
  for (const style of ["fire", "seed", "potion"]) {
    assert.equal(isSnapshot({ ...base, bombs: [{ ...bomb, style }] }), true);
  }
  assert.equal(isSnapshot({ ...base, bombs: [{ ...bomb, style: "unknown" }] }), false);
});

test("pre-ack snapshots preserve active and completed predicted rolls while applying damage", () => {
  for (const evasion of [{ angle: 0, elapsed: 0.2 }, null]) {
    const b = body("predict");
    applyNetState(b, row());
    b.root.position.z = 20;
    b.evasion = evasion;
    b.evadeCooldown = 2.2;
    b.netTarget.evadePending = 1;
    applyNetState(b, row({ hp: 5000 }));
    assert.equal(b.root.position.z, 20);
    assert.equal(b.evasion, evasion);
    assert.equal(b.evadeCooldown, 2.2);
    assert.equal(b.netTarget.evadePending, 1);
    assert.equal(b.netTarget.evadeAck, 0);
    assert.equal(b.hp, 5000);
  }
});

test("accepted evades retain the predicted clock and wait for both rolls to finish before correction", () => {
  const b = body("predict");
  applyNetState(b, row());
  b.root.position.z = 20;
  b.evasion = { angle: 0, elapsed: 0.25 };
  b.netTarget.evadePending = 1;
  const accepted = row({
    evadeAccepted: true,
    evadeAck: 1,
    evadeCooldown: 2.3,
    evasion: { angle: 0, elapsed: 0.1 },
    z: 18.8,
  });
  applyNetState(b, accepted);
  assert.equal(b.evasion?.elapsed, 0.25);
  assert.equal(b.root.position.z, 20);
  assert.equal(b.netTarget.evadePending, null);
  assert.equal(b.netTarget.evadeAck, 1);
  assert.equal(b.netTarget.evadeAccepted, true);
  assert.equal(b.evadeCooldown, 2.3);

  applyNetState(b, { ...accepted, evasion: null, z: 19 });
  assert.equal(b.root.position.z, 20, "an active local roll must not reconcile mid-step");
  b.evasion = null;
  applyNetState(b, { ...accepted, evasion: null, z: 19 });
  assert.equal(b.root.position.z, 19.8);
  assert.equal(b.root.position.y, terrainHeight(0, 19.8));
});

test("a late accepted acknowledgment never replays a roll that prediction already completed", () => {
  const b = body("predict");
  applyNetState(b, row());
  b.root.position.z = 21;
  b.netTarget.evadePending = 1;
  const accepted = row({
    evadeAccepted: true,
    evadeAck: 1,
    evadeCooldown: 2.1,
    evasion: { angle: 0, elapsed: 0.3 },
    z: 20.5,
  });
  applyNetState(b, accepted);
  assert.equal(b.evasion, null);
  assert.equal(b.netTarget.evadePending, null);
  assert.equal(b.root.position.z, 21);
  applyNetState(b, accepted);
  assert.equal(b.evasion, null);
  assert.equal(b.root.position.z, 21);
  applyNetState(b, { ...accepted, evasion: null, z: 20.8 });
  assert.ok(Math.abs(b.root.position.z - 20.96) < 1e-10);
});

test("a rejection cancels prediction and snaps even a small error to authoritative terrain", () => {
  const b = body("predict");
  applyNetState(b, row({ z: 6 }));
  b.root.position.z = 6.3;
  b.evasion = { angle: 0, elapsed: 0.1 };
  b.evadeCooldown = 2.3;
  b.netTarget.evadePending = 1;
  applyNetState(b, row({ evadeAck: 1, evadeCooldown: 0.6, z: 6 }));
  assert.equal(b.evasion, null);
  assert.equal(b.netTarget.evadePending, null);
  assert.equal(b.netTarget.evadeAck, 1);
  assert.equal(b.netTarget.evadeAccepted, false);
  assert.equal(b.evadeCooldown, 0.6);
  assert.equal(b.root.position.z, 6);
  assert.equal(b.root.position.y, terrainHeight(0, 6));
});

test("older acknowledgments cannot rewind accepted roll state or resurrect a pending roll after death", () => {
  const b = body("predict");
  applyNetState(b, row({ evadeAccepted: true, evadeAck: 2, evadeCooldown: 1 }));
  const position = b.root.position.clone();
  applyNetState(b, row({ evadeAck: 1, evadeCooldown: 2, z: 10 }));
  assert.equal(b.netTarget.evadeAck, 2);
  assert.equal(b.netTarget.evadeAccepted, true);
  assert.equal(b.evadeCooldown, 1);
  assert.deepEqual(b.root.position, position);

  b.evasion = { angle: 0, elapsed: 0.2 };
  b.netTarget.evadePending = 3;
  applyNetState(b, row({ alive: false, evadeAck: 2, hp: 0 }));
  assert.equal(b.alive, false);
  assert.equal(b.evasion, null);
  assert.equal(b.netTarget.evadePending, null);
});

test("puppets sample roll progress without sharing mutable snapshot state", () => {
  const b = body("puppet");
  const n = row({
    evadeAccepted: true,
    evadeAck: 1,
    evadeCooldown: 2.2,
    evasion: { angle: 0.4, elapsed: 0.2 },
  });
  applyNetState(b, n);
  assert.deepEqual(b.evasion, n.evasion);
  assert.notEqual(b.evasion, n.evasion);
  assert.equal(b.evadeCooldown, 2.2);
  assert.equal(b.netAir, false);
  applyNetState(b, { ...n, evasion: null });
  assert.equal(b.evasion, null);
});

test("host promotion restores acknowledged roll progress and only simulates its remaining distance", () => {
  const b = body("predict");
  b.netTarget.evadePending = 5;
  b.root.position.set(0, terrainHeight(0, 6), 6);
  const n = row({
    evadeAccepted: true,
    evadeAck: 4,
    evadeCooldown: 2.2,
    evasion: { angle: 0, elapsed: EVADE.duration / 2 },
  });
  restoreNetEvasion(b, n);
  assert.equal(b.netTarget.evadePending, null);
  assert.equal(b.netTarget.evadeAck, 4);
  assert.equal(b.netTarget.evadeAccepted, true);
  assert.equal(b.evadeCooldown, 2.2);
  assert.deepEqual(b.evasion, n.evasion);
  assert.notEqual(b.evasion, n.evasion);
  assert.ok(b.evasion);
  const complete = advanceEvasion(
    b.evasion,
    b.root.position,
    { heightAt: terrainHeight, resolveCircle: () => null },
    1,
  );
  assert.equal(complete, true);
  assert.ok(Math.abs(b.root.position.z - (6 + EVADE.distance / 2)) < 1e-10);
  assert.equal(b.root.position.y, terrainHeight(0, b.root.position.z));
  assert.equal(n.evasion?.elapsed, EVADE.duration / 2);
});

test("snapshot validation rejects malformed or impossible evasion state", () => {
  const rolling = row({
    evadeAccepted: true,
    evadeAck: 1,
    evadeCooldown: 2.2,
    evasion: { angle: Math.PI, elapsed: 0.2 },
  });
  assert.equal(isSnapshot(snapshot(rolling)), true);
  assert.equal(isSnapshot(snapshot({ ...rolling, evadeAccepted: false, evadeAck: 0 })), true);
  const invalid: Partial<NetBrawler>[] = [
    { evadeAck: 0 },
    { evadeAck: -1 },
    { evadeAck: 0.5 },
    { evadeAck: Number.MAX_SAFE_INTEGER + 1 },
    { evadeCooldown: Number.NaN },
    { evadeCooldown: -0.1 },
    { evadeCooldown: EVADE.cooldown + 0.1 },
    { evadeCooldown: 0 },
    { evasion: { angle: Number.NaN, elapsed: 0.1 } },
    { evasion: { angle: Math.PI + 0.1, elapsed: 0.1 } },
    { evasion: { angle: 0, elapsed: -0.1 } },
    { evasion: { angle: 0, elapsed: EVADE.duration + 0.1 } },
    { alive: false },
    { leap: { sx: 0, sz: 0, t: 0.2, tx: 0, tz: 3 } },
  ];
  for (const fields of invalid) {
    assert.equal(isSnapshot(snapshot({ ...rolling, ...fields })), false, JSON.stringify(fields));
  }
  for (const key of ["evasion", "evadeCooldown", "evadeAck", "evadeAccepted"]) {
    const missing = { ...rolling };
    Reflect.deleteProperty(missing, key);
    assert.equal(isSnapshot(snapshot(missing)), false, key);
  }
});
