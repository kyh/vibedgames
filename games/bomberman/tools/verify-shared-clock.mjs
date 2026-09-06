import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import * as constants from "../src/shared/constants.ts";

const sceneSource = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
function compile(source) {
  return stripTypeScriptTypes(source.replace(/^import[^;]+;$/gm, ""), { mode: "transform" })
    .replace(/^export (class|function|const) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");
}
function method(name) {
  const found = new RegExp(`^  (?:(?:private|override) )?(?:get )?${name}\\([^]*?^  }`, "m").exec(
    sceneSource,
  )?.[0];
  assert.ok(found, name);
  return found;
}
function helper(name) {
  const found = new RegExp(`^function ${name}\\([^]*?^}`, "m").exec(sceneSource)?.[0];
  assert.ok(found, name);
  return found;
}
const clockCode = compile(readFileSync(new URL("../src/util/clock.ts", import.meta.url), "utf8"));
const arenaCode = compile(readFileSync(new URL("../src/shared/arena.ts", import.meta.url), "utf8"));
const sceneCode = compile(`
const simNow=now;
const isJsonObject=v=>Object.prototype.toString.call(v)==='[object Object]';
const isJsonNumber=Number.isFinite;
${["isShared", "emptyShared", "structuredCloneBots", "makeBomb", "bombOn", "computeBlastTiles", "grantPowerup"].map(helper).join("\n")}
class Scene {
${["live", "amHost", "myId", "peers", "freezable", "shared", "isAlive", "pauseSimulation", "resumeSimulation", "syncSharedClock", "publishClock", "netPatchShared", "writeShared", "hostTick", "hostPlaceBomb"].map(method).join("\n")}
}
`);
const subscription = /this.client.subscribe\(\(\) => \{[^]*?^      }\);/m.exec(sceneSource)?.[0];
assert.ok(subscription, "actual network subscription");

/** Independent module clock per peer. Actual scene clock/writer/bomb/host-tick
 * methods; explicit transport, render-loop and unrelated bot-AI collaborators. */
function peer({ host = true, started = true, offline = false, stamp, real = 10000 } = {}) {
  const time = { real };
  const context = vm.createContext({
    ...constants,
    structuredClone,
    Date: { now: () => time.real },
  });
  vm.runInContext(
    `${clockCode}\n${arenaCode}\n${sceneCode}\n
    const calls=[];
    const shared={arena:'crossroads',nextArena:'classic',grid:Array.from({length:15},()=>Array.from({length:19},()=>({kind:'empty'}))),bombs:{},blasts:{},powerups:{},bots:{},stats:{},deaths:{},winner:null,startedAt:10000,foreign:{retained:1}};
    const h=Object.assign(new Scene(),{
      offline:false,started:true,clockAuthority:false,simulationFrozen:false,controlsPaused:false,
      netDirty:false,hostTickAcc:0,botTimes:[],offlineShared:null,offlineMyState:{},
      game:{loop:{sleep:()=>calls.push('sleep'),wake:()=>calls.push('wake')},sound:{pauseAll:()=>calls.push('sound-pause'),resumeAll:()=>calls.push('sound-resume')}},
      reconcileBots(){},tickBots(_world,at){this.botTimes.push(at);return false},fighterPositions(){return []},
      setPresentationPaused(paused){this.controlsPaused=paused},netSendEvent(){},
      client:{connectionStatus:'connected',isHost:true,playerId:'host',hostId:'host',players:{host:{id:'host'}},sharedState:shared,writes:[],listeners:[],
        subscribe(fn){this.listeners.push(fn)},notify(){for(const fn of this.listeners)fn()},
        updateSharedState(patch){this.sharedState={...this.sharedState,...patch};this.writes.push(structuredClone(patch));this.notify()}
      }
    });
    h.game.scene={getScene:()=>h};
    (function(){${subscription}}).call(h);
    globalThis.fixture={h,calls,api:{now,clockStamp,pauseClock,resumeClock,readClock,adoptClock}};
  `,
    context,
  );
  const { h, calls, api } = context.fixture;
  h.offline = offline;
  h.started = started;
  h.client.isHost = host;
  h.client.playerId = host ? "host" : "guest";
  if (stamp !== undefined) h.client.sharedState.clock = stamp;
  if (offline) h.offlineShared = structuredClone(h.client.sharedState);
  return {
    h,
    calls,
    api,
    context,
    advance(ms) {
      time.real += ms;
    },
    notify() {
      h.client.notify();
    },
    accept(shared) {
      h.client.sharedState = structuredClone(shared);
      h.client.notify();
    },
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("wire clock ADT: malformed/legacy defaults, copies, pause at epoch0 and repeated resume", () => {
  const p = peer({ real: 0 });
  for (const value of [
    undefined,
    null,
    {},
    [],
    1,
    "paused",
    { kind: "paused", now: "1" },
    { kind: "running", offset: Infinity },
  ])
    assert.deepEqual(plain(p.api.readClock(value)), { kind: "running", offset: 0 });
  p.api.pauseClock();
  p.advance(3000);
  p.api.pauseClock();
  assert.equal(p.api.now(), 0);
  const stamp = p.api.clockStamp();
  stamp.now = 999;
  assert.equal(p.api.now(), 0);
  p.api.resumeClock();
  p.api.resumeClock();
  p.advance(100);
  assert.equal(p.api.now(), 100);
});

test("solo host stamps pause before sleep; late guest adopts frozen fuse and subscriber resumes shared play", () => {
  const host = peer();
  host.notify();
  host.h.hostPlaceBomb("host", 1, 1);
  host.advance(500);
  host.h.controlsPaused = true;
  host.h.pauseSimulation();
  const paused = structuredClone(host.h.client.sharedState);
  assert.deepEqual(plain(paused.clock), { kind: "paused", now: 10500 });
  assert.equal(host.calls.at(-1), "sleep");
  host.advance(5000);
  assert.equal(host.api.now(), 10500);
  const guest = peer({ host: false, real: 15500 });
  guest.accept(paused);
  assert.equal(guest.api.now(), 10500);
  const bomb = Object.values(paused.bombs)[0];
  assert.equal(constants.FUSE_MS - (guest.api.now() - bomb.placedAt), 1700);
  host.h.client.players.guest = { id: "guest" };
  host.notify(); // no scene update while the host's loop was sleeping
  assert.equal(host.h.simulationFrozen, false);
  assert.equal(host.h.controlsPaused, true);
  assert.equal(host.calls.at(-1), "wake");
  assert.equal(host.api.now(), 10500);
  guest.accept(host.h.client.sharedState);
  assert.deepEqual(plain(guest.api.clockStamp()), { kind: "running", offset: 5000 });
  host.advance(1699);
  guest.advance(1699);
  host.h.hostTick(70);
  assert.equal(Object.keys(host.h.client.sharedState.bombs).length, 1);
  assert.equal(host.api.now(), guest.api.now());
  host.advance(1);
  host.h.hostTick(70);
  assert.equal(Object.keys(host.h.client.sharedState.bombs).length, 0);
  assert.equal(Object.keys(host.h.client.sharedState.blasts).length, 1);
  assert.equal(host.h.client.sharedState.arena, "crossroads");
  assert.deepEqual(plain(host.h.client.sharedState.foreign), { retained: 1 });
  assert.ok(host.h.client.writes.every((patch) => patch.clock));
});

test("dead paused host migration preserves remaining fuse; first new-host bomb uses adopted timeline", () => {
  const old = peer();
  old.notify();
  old.h.hostPlaceBomb("host", 1, 1);
  old.advance(600);
  old.h.pauseSimulation();
  const next = peer({ host: false, real: 25000 });
  next.accept(old.h.client.sharedState);
  next.h.client.players = { guest: { id: "guest" } };
  next.h.client.isHost = true;
  next.h.client.hostId = "guest";
  next.h.hostPlaceBomb("guest", 5, 5); // event can precede the next render tick
  assert.equal(next.api.now(), 10600);
  const added = Object.values(next.h.client.sharedState.bombs).find(
    (bomb) => bomb.ownerId === "guest",
  );
  assert.equal(added.placedAt, 10600);
  assert.equal(next.h.client.sharedState.clock.offset, 14400);
  next.advance(1599);
  next.h.hostTick(70);
  assert.equal(Object.keys(next.h.client.sharedState.bombs).length, 2);
  next.advance(1);
  next.h.hostTick(70);
  assert.equal(Object.keys(next.h.client.sharedState.bombs).length, 1);
  assert.equal(next.h.client.sharedState.bombs[added.id].placedAt, 10600);
});

test("promotion while reading title or locally paused retains freeze until active play", () => {
  for (const localPause of [false, true]) {
    const p = peer({
      host: false,
      started: false,
      stamp: { kind: "paused", now: 9000 },
      real: 20000,
    });
    p.notify();
    if (localPause) p.h.pauseSimulation();
    p.h.client.isHost = true;
    p.notify();
    assert.equal(p.api.now(), 9000);
    assert.equal(p.api.clockStamp().kind, "paused");
    p.advance(1000);
    if (localPause) p.h.resumeSimulation();
    else {
      p.h.started = true;
      p.notify();
    }
    assert.equal(p.api.now(), 9000);
    assert.equal(p.api.clockStamp().kind, "running");
    p.advance(100);
    assert.equal(p.api.now(), 9100);
  }
});

test("reconnect adopts accepted clock before reads/writes; guests/disconnected hosts never stamp", () => {
  const p = peer({ stamp: { kind: "running", offset: 2000 } });
  p.notify();
  p.h.client.connectionStatus = "disconnected";
  p.notify();
  p.advance(4000);
  p.h.netPatchShared({ winner: "bad" });
  p.h.hostPlaceBomb("host", 1, 1);
  assert.equal(p.h.client.writes.length, 0);
  p.h.client.sharedState.clock = { kind: "running", offset: 5000 };
  p.h.client.connectionStatus = "connected";
  p.h.hostPlaceBomb("host", 1, 1);
  assert.equal(Object.values(p.h.client.sharedState.bombs)[0].placedAt, 9000);
  p.h.client.isHost = false;
  p.h.netPatchShared({ winner: "bad" });
  assert.equal(p.h.client.sharedState.winner, null);
  assert.equal(p.h.client.writes.length, 1);
});

test("full/partial/reset clock stamps preserve foreign fields and offline fuse pause", () => {
  const p = peer({ offline: true });
  p.h.hostPlaceBomb("solo", 1, 1);
  p.advance(300);
  p.h.pauseSimulation();
  p.advance(5000);
  p.h.hostTick(70);
  assert.equal(Object.keys(p.h.offlineShared.bombs).length, 1);
  p.h.resumeSimulation();
  p.h.netPatchShared({ nextArena: "crossroads" });
  assert.equal(p.h.offlineShared.clock.offset, 5000);
  assert.deepEqual(plain(p.h.offlineShared.foreign), { retained: 1 });
  p.advance(1900);
  p.h.hostTick(70);
  assert.equal(Object.keys(p.h.offlineShared.bombs).length, 0);
  p.h.writeShared({ ...p.h.offlineShared, bombs: {}, blasts: {}, startedAt: p.api.now() });
  assert.equal(p.h.offlineShared.clock.offset, 5000);
  assert.equal(p.h.offlineShared.arena, "crossroads");
  assert.deepEqual(plain(p.h.offlineShared.foreign), { retained: 1 });
});

test("actual wrapper: late-peer wake retains input/audio pause; later overlay resume restores sound", () => {
  const p = peer();
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  Object.assign(p.context, {
    game: p.h.game,
    setPauseHandlers: (handlers) => {
      p.context.handlers = handlers;
    },
    createBombermanPauseOverlay: () => ({ show() {}, hide() {} }),
    pauseAudio: (paused) => p.calls.push(`audio-${paused}`),
  });
  vm.runInContext(compile(main.slice(main.indexOf("let froze = false;"))), p.context);
  p.context.handlers.onPause();
  assert.equal(p.h.controlsPaused, true);
  assert.equal(p.h.simulationFrozen, true);
  p.advance(2000);
  p.h.client.players.guest = { id: "guest" };
  p.notify();
  assert.equal(p.h.simulationFrozen, false);
  assert.equal(p.h.controlsPaused, true);
  assert.deepEqual(plain(p.calls.filter((call) => call.startsWith("audio-"))), ["audio-true"]);
  assert.equal(p.calls.includes("sound-resume"), false);
  p.context.handlers.onResume();
  assert.equal(p.h.controlsPaused, false);
  assert.equal(p.calls.filter((call) => call === "wake").length, 1);
  assert.equal(p.calls.filter((call) => call === "sound-resume").length, 1);
  assert.deepEqual(plain(p.calls.filter((call) => call.startsWith("audio-"))), [
    "audio-true",
    "audio-false",
  ]);
});
