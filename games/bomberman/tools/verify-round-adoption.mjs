import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import * as constants from "../src/shared/constants.ts";

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const found = new RegExp(`^  private (?:get )?${name}\\([^]*?^  }`, "m").exec(source)?.[0];
  assert.ok(found, name);
  return found;
};
const helper = (name) => {
  const found = new RegExp(`^function ${name}\\([^]*?^}`, "m").exec(source)?.[0];
  assert.ok(found, name);
  return found;
};
const compile = (code) =>
  stripTypeScriptTypes(code.replace(/^import[^;]+;$/gm, ""), { mode: "transform" }).replace(
    /^export (function|const) /gm,
    "$1 ",
  );
const arena = compile(readFileSync(new URL("../src/shared/arena.ts", import.meta.url), "utf8"));
const code = compile(`
const isJsonObject=value=>Object.prototype.toString.call(value)==='[object Object]';
const isJsonNumber=Number.isFinite;
${arena}
${["emptyShared", "isShared", "readPlayerState"].map(helper).join("\n")}
class Scene {
${["live", "amHost", "myId", "peers", "shared", "netSendEvent", "netUpdateMyState", "writeShared", "requestRestart", "handleEvent", "onUpdate", "ensureMySpawn", "respawnSelf"].map(method).join("\n")}
}
globalThis.Scene=Scene;
`);

/** Actual snapshot/request/adoption methods. UI and transport are explicit
 * collaborators; each case controls which accepted snapshots/events arrive. */
function fixture({ host = false, offline = false, previous = 1000, started = true } = {}) {
  const calls = { audioResets: 0, positions: [], shared: [], events: [], clock: 0 };
  const context = vm.createContext({
    ...constants,
    simNow: () => 1000,
    clockStamp: () => ({ kind: "running", offset: 0 }),
    resetRoundAudio: () => calls.audioResets++,
    document: { getElementById: () => null },
    colX: (col) => col * constants.TILE,
    rowY: (row) => row * constants.TILE,
  });
  vm.runInContext(code, context);
  const grid = Array.from({ length: 15 }, () =>
    Array.from({ length: 19 }, () => ({ kind: "empty" })),
  );
  grid[7][9] = { kind: "crate" };
  const world = {
    arena: "classic",
    nextArena: "crossroads",
    clock: { kind: "running", offset: 0 },
    grid,
    bombs: {},
    blasts: {},
    powerups: {},
    bots: {},
    stats: {},
    deaths: {},
    winner: null,
    startedAt: 1000,
  };
  const state = { col: 9, row: 7, colorIdx: 1, dir: "left", moving: false };
  const h = Object.assign(new context.Scene(), {
    offline,
    offlineShared: structuredClone(world),
    offlineMyState: { ...state },
    started,
    controlsPaused: false,
    presentationRound: previous,
    moving: false,
    myCol: 9,
    myRow: 7,
    myDir: "left",
    players: new Map(),
    blastSeen: new Set(),
    statsEl: null,
    battleFx: null,
    sparkEmitter: null,
    client: {
      connectionStatus: "connected",
      isHost: host,
      playerId: "guest",
      hostId: host ? "guest" : "host",
      sharedState: structuredClone(world),
      players: { host: { id: "host" }, guest: { id: "guest", state: { ...state } } },
      updateMyState(patch) {
        calls.positions.push(structuredClone(patch));
        Object.assign(this.players.guest.state, patch);
      },
      updateSharedState(patch) {
        calls.shared.push(structuredClone(patch));
        this.sharedState = { ...this.sharedState, ...patch };
      },
      sendEvent: (event, payload) =>
        calls.events.push({ event, payload: structuredClone(payload) }),
    },
    syncSharedClock() {
      calls.clock++;
    },
    ensureSeeded() {},
    trackRestartable() {},
    setStatus() {},
    statusText() {},
    syncArenaControls() {},
    syncRoster() {},
    setStats() {},
    statsText() {},
    setBanner() {},
    syncGrid() {},
    syncBombs() {},
    syncBlasts() {},
    syncPowerups() {},
    syncPlayers() {},
  });
  return { h, calls };
}

const pose = (h) => [h.myCol, h.myRow, h.myDir, h.moving];

test("missed restart event: accepted new round replaces cached old coordinates once", () => {
  const { h, calls } = fixture();
  h.client.connectionStatus = "disconnected";
  // SDK sync re-announces cached state on reconnect; no round event is replayed.
  h.client.sharedState.startedAt = 2000;
  h.client.connectionStatus = "connected";
  h.onUpdate();
  assert.deepEqual(pose(h), [17, 13, "down", false]);
  assert.equal(calls.positions.length, 1);
  assert.equal(calls.audioResets, 1);
  assert.equal(h.presentationRound, 2000);
  for (let i = 0; i < 10; i++) h.onUpdate();
  assert.equal(calls.positions.length, 1);
  assert.equal(calls.audioResets, 1);
});

test("initial ongoing join, same-round reconnect and host promotion preserve current pose", () => {
  for (const previous of [null, 1000]) {
    const { h, calls } = fixture({ previous });
    h.myDir = "right";
    h.moving = true;
    h.myCol = 8;
    h.onUpdate();
    h.client.isHost = true;
    h.client.hostId = "guest";
    h.onUpdate();
    assert.deepEqual(pose(h), [8, 7, "right", true]);
    assert.equal(calls.positions.length, 0);
  }
  const { h, calls } = fixture({ previous: null });
  h.client.players.guest.state = {};
  h.onUpdate();
  assert.deepEqual([h.myCol, h.myRow], [17, 13]);
  assert.equal(calls.positions.length, 1, "original empty-state late-join spawn still runs");
});

test("title observes round quietly; original spawn policy runs only after play", () => {
  const { h, calls } = fixture({ started: false });
  h.client.sharedState.startedAt = 2000;
  h.client.players.guest.state = {};
  h.onUpdate();
  assert.equal(calls.positions.length, 0);
  h.started = true;
  h.onUpdate();
  assert.deepEqual([h.myCol, h.myRow], [17, 13]);
  assert.equal(calls.positions.length, 1);
});

test("old unversioned restart events never teleport either a host or a guest", () => {
  for (const host of [false, true]) {
    const { h, calls } = fixture({ host });
    for (const from of ["host", "guest", "departed-host"]) h.handleEvent("round_restart", {}, from);
    assert.deepEqual(pose(h), [9, 7, "left", false]);
    assert.equal(calls.positions.length + calls.shared.length, 0);
  }
});

test("requests carry observed round; stale/duplicate requests cannot reset its replacement", () => {
  const { h, calls } = fixture({ host: true });
  h.requestRestart();
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].payload.round, 1000);
  h.handleEvent("request_restart", calls.events[0].payload, "host");
  assert.equal(h.shared().startedAt, 1001, "same-millisecond reset still changes identity");
  assert.equal(h.shared().arena, "crossroads");
  assert.equal(calls.shared.length, 1);
  assert.equal(calls.events.length, 1, "no redundant respawn broadcast");
  for (const payload of [{}, { round: 999 }, { round: 1000 }, { round: "1001" }])
    h.handleEvent("request_restart", payload, "host");
  assert.equal(calls.shared.length, 1);
  h.onUpdate();
  assert.equal(calls.positions.length, 1);
  h.requestRestart();
  h.handleEvent("request_restart", calls.events[1].payload, "host");
  assert.equal(h.shared().startedAt, 1002);
  h.onUpdate();
  assert.equal(calls.positions.length, 2);
});

test("offline loopback and paused/disconnected request guards retain their contracts", () => {
  const { h, calls } = fixture({ offline: true });
  h.requestRestart();
  assert.equal(h.shared().startedAt, 1001);
  h.onUpdate();
  assert.deepEqual(pose(h), [1, 1, "down", false]);
  assert.equal(calls.audioResets, 1);
  for (const blocked of ["paused", "disconnected", "unstarted"]) {
    const f = fixture({ host: true });
    if (blocked === "paused") f.h.controlsPaused = true;
    if (blocked === "disconnected") f.h.client.connectionStatus = "disconnected";
    if (blocked === "unstarted") f.h.started = false;
    f.h.requestRestart();
    assert.equal(f.calls.events.length, 0);
  }
});
