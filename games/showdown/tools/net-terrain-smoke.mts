// The wire format and the guest's two drives, piece by piece: rows survive the
// trip at their stated precision, impossible poses never reach the sim,
// remote bodies keep their feet on the terrain, cues are copied and aged to
// render time, a promoted host resumes what was in flight, and the guest's own
// prediction settles leaps and spent ammo against the host's verdicts — and
// never against a row from before an intent it sent had landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteClock } from "@vibedgames/multiplayer";
import { Vector2 } from "three";
import { BRAWLERS } from "../src/config.ts";
import { EVADE } from "../src/entities/evasion.ts";
import type { JsonValue } from "../src/json.ts";
import { spawnFromNet } from "../src/net/host.ts";
import { applyPuppetRow, PuppetTrack } from "../src/net/interpolation.ts";
import { OwnPrediction } from "../src/net/prediction.ts";
import type { OwnBody, OwnRow } from "../src/net/prediction.ts";
import {
  decodeFrame,
  encodeFrame,
  encodeMatch,
  parseFrame,
  parseMatch,
} from "../src/net/snapshot.ts";
import type { BrawlerState, NetFrame } from "../src/net/snapshot.ts";
import { terrainHeight } from "../src/world/terrain.ts";
import { asGame, body, openWorld, overTheWire, stubGame } from "./headless.mts";

/** A host with one titan, one ace and one dusty, and the roster guests decode against. */
const lineup = () => {
  const host = stubGame("host");
  const titan = body(host, { name: "Rook", netId: "p:a", owner: "a", x: 0, z: 0 }, "titan");
  const ace = body(host, { name: "Wren", netId: "bot:1", x: 3, z: 1 }, "ace");
  const dusty = body(host, { name: "Briar", netId: "bot:2", x: -3, z: 1 }, "dusty");
  const roster = parseMatch(overTheWire(encodeMatch(host.brawlers, 1, 7, null, 1)));
  assert.ok(roster);
  return { ace, dusty, host, roster, titan };
};

const sendFrame = (host: ReturnType<typeof stubGame>, t = 1000): NetFrame => {
  const frame = parseFrame(overTheWire(encodeFrame(host, 1, 1, t, host.elapsed * 1000)));
  assert.ok(frame);
  return frame;
};

test("a row comes back at its wire precision, cues and all", () => {
  const { ace, dusty, host, roster, titan } = lineup();
  titan.root.position.set(1.2346, 0, -2.3457);
  titan.facing = 7;
  titan.hp = 4321;
  titan.ammo = 2;
  titan.reloadT = 0.456;
  titan.superCharge = 0.789;
  titan.cubes = 3;
  titan.kills = 2;
  titan.rank = 0;
  titan.evadeCooldown = 1.234;
  titan.applyKnock(-3.3, 4.4);
  titan.ack.take(17, 500);
  host.elapsed = 0.75;
  const { super: slam } = BRAWLERS.titan;
  assert.ok(slam.kind === "leap");
  titan.leap = { a: slam, sx: 1, sz: 2, t: 0.25, tx: 5, tz: -4 };
  ace.rangedCue = { elapsed: 0.1, isSuper: true };
  dusty.meleeCue = { angle: -1.5, elapsed: 0.3, recovery: 0.42, windup: 0.2 };
  const decoded = decodeFrame(sendFrame(host), roster);
  assert.ok(decoded);
  const [rook, wren, briar] = decoded.brawlers;
  assert.ok(rook && wren && briar);
  assert.ok(Math.abs(rook.x - 1.23) < 0.006 && Math.abs(rook.z + 2.35) < 0.006);
  assert.ok(Math.abs(rook.facing - Math.atan2(Math.sin(7), Math.cos(7))) < 0.006);
  assert.equal(rook.hp, 4321);
  assert.equal(rook.ammo, 2);
  assert.ok(Math.abs(rook.reload - 0.46) < 1e-9);
  assert.ok(Math.abs(rook.charge - 0.79) < 1e-9);
  assert.ok(Math.abs(rook.evadeCooldown - 1.23) < 1e-9);
  assert.equal(rook.ack, 17);
  assert.equal(rook.ackAge, 250);
  assert.equal(rook.knockSeq, 1);
  assert.ok(Math.abs(rook.knockX + 3.3) < 1e-9 && Math.abs(rook.knockZ - 4.4) < 1e-9);
  assert.deepEqual(rook.leap, { sx: 1, sz: 2, t: 0.25, tx: 5, tz: -4 });
  assert.deepEqual(wren.ranged, { elapsed: 0.1, isSuper: true });
  assert.deepEqual(briar.melee, { angle: -1.5, elapsed: 0.3, recovery: 0.42, windup: 0.2 });
  assert.equal(wren.ack, 0, "bots carry no acknowledgment");
});

/** Re-send `frame` with one row or cue list swapped, as a hostile or broken host might. */
const tampered = (frame: NetFrame, change: (copy: NetFrame) => void): NetFrame | null => {
  const copy = parseFrame(overTheWire(frame));
  assert.ok(copy);
  change(copy);
  return parseFrame(overTheWire(copy));
};

test("poses the host could never hold, and malformed rows, are refused whole", () => {
  const { host, roster } = lineup();
  const frame = sendFrame(host);
  assert.ok(decodeFrame(frame, roster));
  const cues: number[][] = [
    [1, 1, 300, 0, 0, 100, 100],
    [0, 1, -10, 0, 0, 100, 100],
    [1, 3, 0, 100, 200, 400],
    [2, 3, 0, 900, 200, 400],
    [2, 4, 100, 0],
    [1, 4, 5000, 0],
    [0, 9, 0, 0],
    [7, 2, 0, 100],
    [0, 2, 400, 100],
  ];
  for (const cue of cues) {
    const bad = tampered(frame, (copy) => {
      copy.q = [cue];
    });
    assert.equal(bad && decodeFrame(bad, roster), null, JSON.stringify(cue));
  }
  // A roll in mid-leap, a shot while rolling, a shot while dead.
  const clashes: number[][][] = [
    [
      [0, 1, 100, 0, 0, 100, 100],
      [0, 2, 0, 100],
    ],
    [
      [1, 4, 100, 0],
      [1, 2, 0, 100],
    ],
  ];
  for (const q of clashes) {
    const bad = tampered(frame, (copy) => {
      copy.q = q;
    });
    assert.equal(bad && decodeFrame(bad, roster), null, JSON.stringify(q));
  }
  const dead = tampered(frame, (copy) => {
    copy.b[1] = [300, 100, 0, 0, 0];
    copy.q = [[1, 4, 100, 0]];
  });
  assert.equal(dead && decodeFrame(dead, roster), null);
  const rows: JsonValue[][] = [[9000, 0], [0, 0, 0, -5], [0, 0, 0, 100, 1, 400], [1.5]];
  for (const row of rows) {
    const copy = parseFrame(overTheWire(frame));
    assert.ok(copy);
    const wire = overTheWire({ ...copy, b: [row, ...copy.b.slice(1)] });
    const parsed = parseFrame(wire);
    assert.equal(parsed && decodeFrame(parsed, roster), null, JSON.stringify(row));
  }
  assert.equal(decodeFrame({ ...frame, v: 2 }, roster), null, "a frame for another roster");
  assert.equal(decodeFrame({ ...frame, b: frame.b.slice(1) }, roster), null);
  assert.equal(
    parseMatch(
      overTheWire({ b: [["bot:1", null, "wizard", "Merlin", 0]], g: 1, seed: 7, v: 1, w: null }),
    ),
    null,
  );
});

/** A puppet for the ace in `lineup`, fed frames by hand. */
const puppetOf = () => {
  const guest = stubGame("guest");
  const puppet = body(
    guest,
    { drive: "puppet", name: "Wren", netId: "bot:1", x: 0, z: 4.8 },
    "ace",
  );
  const clock = new RemoteClock();
  const track = new PuppetTrack(clock);
  return { clock, puppet, track };
};

const state = (overrides: Partial<BrawlerState>): BrawlerState => ({
  ack: 0,
  ackAge: 0,
  alive: true,
  ammo: 3,
  charge: 0,
  concealed: false,
  cubes: 0,
  evade: 0,
  evadeCooldown: 0,
  evasion: null,
  facing: 0,
  hp: 3200,
  kills: 0,
  knockSeq: 0,
  knockX: 0,
  knockZ: 0,
  leap: null,
  melee: null,
  ranged: null,
  rank: 0,
  reload: 0,
  x: 0,
  z: 4.8,
  ...overrides,
});

test("puppets keep their feet on the ramp, interpolating and extrapolating uphill", () => {
  const { clock, puppet, track } = puppetOf();
  for (let i = 0; i <= 10; i += 1) {
    track.receive(i * 33, state({ z: 4.8 + i * 0.12 }), 1000 + i * 33);
  }
  let moved = false;
  for (let now = 1100; now < 1600; now += 16) {
    const before = puppet.z;
    track.pose(puppet, now, clock.now(now) - 100, openWorld);
    moved ||= puppet.z > before;
    assert.equal(puppet.root.position.y, terrainHeight(puppet.x, puppet.z));
  }
  assert.equal(moved, true);
  // Past the newest frame the body carries on for a beat, then holds — still on the ground.
  assert.ok(puppet.z > 6 && puppet.z < 6.4, `held at ${puppet.z}`);
  assert.equal(puppet.netAir, false);
});

test("a puppet's leap rises from its cue and comes down with the frame that ends it", () => {
  const { clock, puppet, track } = puppetOf();
  const leap = { sx: 0, sz: 0, t: 0.3, tx: 0, tz: 4 };
  track.receive(0, state({ leap, z: 1.6 }), 1000);
  track.receive(33, state({ leap: { ...leap, t: 0.333 }, z: 1.78 }), 1033);
  track.pose(puppet, 1140, clock.now(1140) - 100, openWorld);
  assert.equal(puppet.netAir, true);
  assert.ok(puppet.root.position.y > terrainHeight(0, puppet.z) + 1, "mid-arc");
  track.receive(66, state({ z: 4 }), 1066);
  track.pose(puppet, 1200, clock.now(1200) - 100, openWorld);
  assert.equal(puppet.netAir, false);
  assert.equal(puppet.root.position.y, terrainHeight(puppet.x, puppet.z));
});

test("puppet cues are copied, aged to render time, and cleared by death", () => {
  const { puppet } = puppetOf();
  const ranged = { elapsed: 0.1, isSuper: false };
  const evasion = { angle: 0.4, elapsed: 0.05 };
  const row = state({ evadeCooldown: 2.3, evasion, ranged: null });
  applyPuppetRow(puppet, row, 0.04);
  assert.notEqual(puppet.evasion, evasion, "local animation must not write into the frame");
  assert.ok(Math.abs((puppet.evasion?.elapsed ?? 0) - 0.09) < 1e-9);
  applyPuppetRow(puppet, state({ ranged }), 0.02);
  assert.ok(Math.abs((puppet.rangedCue?.elapsed ?? 0) - 0.12) < 1e-9);
  assert.equal(puppet.evasion, null);
  applyPuppetRow(puppet, state({ hp: 1000 }), 0);
  assert.equal(puppet.flash, 1, "a hit flashes the body");
  applyPuppetRow(puppet, state({ alive: false, hp: 0, ranged }), 0);
  assert.equal(puppet.alive, false);
  assert.equal(puppet.rangedCue, null);
});

test("a promoted host finishes an inherited leap and roll from where they stood", () => {
  const host = stubGame("host");
  const { roster: match } = lineup();
  const [rook, wren] = match.roster;
  assert.ok(rook && wren);
  const leap = { sx: 0, sz: 0, t: 0.375, tx: 0, tz: 6 };
  const leaper = spawnFromNet(asGame(host), rook, state({ leap, x: 0, z: 3 }), "sim", false);
  assert.equal(leaper.leap?.t, 0.375);
  assert.ok(leaper.root.position.y > 2, "resumes mid-arc");
  for (let i = 0; i < 40; i += 1) {
    leaper.update(1 / 60);
  }
  assert.equal(leaper.leap, null);
  assert.ok(Math.abs(leaper.z - 6) < 1e-9, "lands on the old host's landing spot");
  const evasion = { angle: 0, elapsed: EVADE.duration / 2 };
  const roller = spawnFromNet(
    asGame(host),
    wren,
    state({ evadeCooldown: 2.2, evasion, z: 0 }),
    "sim",
    false,
  );
  assert.notEqual(roller.evasion, evasion);
  for (let i = 0; i < 30; i += 1) {
    roller.update(1 / 60);
  }
  assert.equal(roller.evasion, null);
  assert.ok(Math.abs(roller.z - EVADE.distance / 2) < 1e-9, "only the remaining half is rolled");
});

const ownBody = (): OwnBody => ({
  alive: true,
  evadeCooldown: 0,
  evadePending: false,
  evasion: null,
  knock: new Vector2(),
  leap: null,
});

const ownRow = (overrides: Partial<OwnRow>): OwnRow => ({
  ack: 0,
  ackAge: 0,
  alive: true,
  evade: 0,
  evadeCooldown: 0,
  knockSeq: 0,
  knockX: 0,
  knockZ: 0,
  leap: null,
  x: 0,
  z: 0,
  ...overrides,
});

test("a predicted leap lands where the host says, and one the host never started is called off", () => {
  const prediction = new OwnPrediction();
  const own = ownBody();
  prediction.beginStep(16);
  prediction.receive(own, ownRow({}));
  prediction.beginStep(16);
  const seq = prediction.stamp("super");
  own.leap = { sx: 0, sz: 0, t: 0, tx: 0, tz: 5 };
  prediction.leapSent(seq, 0.75);
  prediction.beginStep(100);
  prediction.receive(
    own,
    ownRow({ ack: seq, ackAge: 50, leap: { sx: 0.1, sz: 0, t: 0.05, tx: 0.2, tz: 5.3 } }),
  );
  assert.deepEqual(own.leap, { sx: 0.1, sz: 0, t: 0, tx: 0.2, tz: 5.3 });
  prediction.beginStep(100);
  const refused = prediction.receive(own, ownRow({ ack: seq, ackAge: 100 }));
  assert.equal(refused.leapCancelled, true);
  assert.equal(own.leap, null);
});

test("ammo and charge from the host wait until it has seen every shot and super sent", () => {
  const prediction = new OwnPrediction();
  const own = ownBody();
  prediction.beginStep(16);
  assert.equal(prediction.receive(own, ownRow({})).ammoSettled, true);
  const attack = prediction.stamp("attack");
  const special = prediction.stamp("super");
  prediction.beginStep(16);
  const early = prediction.receive(own, ownRow({ ack: attack - 1, ackAge: 30 }));
  assert.equal(early.ammoSettled, false);
  assert.equal(early.chargeSettled, false);
  const half = prediction.receive(own, ownRow({ ack: attack, ackAge: 10 }));
  assert.equal(half.ammoSettled, true);
  assert.equal(half.chargeSettled, false);
  assert.equal(prediction.receive(own, ownRow({ ack: special, ackAge: 5 })).chargeSettled, true);
});

test("a row from before an intent landed is not held against the body that ran it; a lost intent is", () => {
  const prediction = new OwnPrediction();
  const own = ownBody();
  // Standing on an input the host has long had, then a roll leaves at 976 ms.
  prediction.beginStep(16);
  const input = prediction.stamp("input");
  prediction.settle(0, 0, 16);
  for (let i = 0; i < 60; i += 1) {
    prediction.beginStep(16);
    prediction.settle(0, 0, 16);
  }
  prediction.beginStep(16);
  const evadeLeft = prediction.clock - 16;
  prediction.stamp("evade");
  for (let x = 0.5; prediction.clock < evadeLeft + 600; x = Math.min(3, x + 0.5)) {
    prediction.settle(x, 0, 16);
    prediction.beginStep(16);
  }
  // The host's frame left 20 ms after the roll did, before it arrived: it still
  // acks the input and stands still. The roll is not an error it reports.
  prediction.receive(own, ownRow({ ack: input, ackAge: evadeLeft + 20 }));
  assert.deepEqual(prediction.reconciler.pending, { x: 0, y: 0 });
  // 300 ms on with the roll still unanswered, it was lost: the host is the truth.
  prediction.receive(own, ownRow({ ack: input, ackAge: evadeLeft + 300 }));
  assert.ok(
    Math.abs(prediction.reconciler.pending.x + 3) < 1e-9,
    "the roll that never was is undone",
  );
});
