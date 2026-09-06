import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as constants from "../src/shared/constants.ts";
import * as wire from "../src/shared/wire.ts";
import { rand } from "../src/shared/rng.ts";
import { BossEncounters } from "../src/render/boss-encounters.ts";
import * as protocol from "../../../packages/multiplayer/src/types.ts";

export const sceneSource = readFileSync(
  new URL("../src/scenes/game-scene.ts", import.meta.url),
  "utf8",
);
export const method = (name, source = sceneSource) => {
  const found = new RegExp(`^  (?:(?:private|override) )?(?:get )?${name}\\([^]*?^  }`, "m").exec(
    source,
  )?.[0];
  assert.ok(found, `GameScene.${name}`);
  return found;
};
const helper = (name) => {
  const found = new RegExp(`^function ${name}(?:<[^]*?>)?\\([^]*?^}`, "m").exec(sceneSource)?.[0];
  assert.ok(found, name);
  return found;
};
const methods = [
  "live",
  "amHost",
  "myId",
  "peers",
  "shared",
  "prepareHost",
  "ensureSeeded",
  "onUpdate",
  "reconcileFromShared",
  "handleEvent",
  "hostTick",
  "advanceWorld",
  "observeBossEncounters",
];
const helpers = [
  "emptyShared",
  "isShared",
  "sharedToPatch",
  "indexById",
  "cloneAsteroid",
  "blendPos",
  "inWorld",
  "isWireRecord",
  "asWireRecord",
  "wireNum",
  "wireStr",
];
const noOp = () => {};

/** Actual SDK admission/merge/notify/destruction and current scene methods.
 * Socket delivery and omitted simulation/display collaborators are explicit.
 * This is a deterministic protocol boundary test, not a native two-client run. */
export function networkFixture() {
  let now = 1_000_000;
  const timers = new Map();
  const packets = [];
  const cues = [];
  const sockets = [];
  class Socket extends EventTarget {
    id = "self";
    closed = 0;
    constructor() {
      super();
      sockets.push(this);
    }
    send(payload) {
      packets.push(JSON.parse(payload));
    }
    close() {
      this.closed++;
      this.dispatchEvent(new Event("close"));
    }
    receive(message) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }
  const sdkSource = readFileSync(
    new URL("../../../packages/multiplayer/src/client.ts", import.meta.url),
    "utf8",
  );
  const sdkCode = stripTypeScriptTypes(sdkSource.replace(/^import[^;]+;$/gm, ""), {
    mode: "strip",
  }).replace(/^export /gm, "");
  const sdkContext = {
    ...protocol,
    PartySocket: Socket,
    setInterval: (fn) => {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    console: {
      error: (...args) => assert.fail(args.join(" ")),
      warn: (...args) => assert.fail(args.join(" ")),
    },
  };
  const Client = new Function(...Object.keys(sdkContext), `${sdkCode};return MultiplayerClient;`)(
    ...Object.values(sdkContext),
  );
  const context = {
    ...constants,
    ...wire,
    rand,
    simNow: () => now,
    SNAP_DIST: 80,
    SOLO_PEERS: { solo: { id: "solo" } },
    Phaser: { Math: { Clamp: (n, low, high) => Math.max(low, Math.min(high, n)) } },
    sfx: { play: (name) => cues.push(name) },
  };
  const sceneCode = stripTypeScriptTypes(
    `${helpers.map(helper).join("\n")}\nclass SceneProbe {\n${methods.map((name) => method(name)).join("\n")}\n}`,
    { mode: "strip" },
  );
  const SceneProbe = new Function(
    ...Object.keys(context),
    `${sceneCode};return {SceneProbe, emptyShared, sharedToPatch};`,
  )(...Object.values(context));
  const scene = Object.assign(new SceneProbe.SceneProbe(), {
    offline: false,
    offlineSeeded: false,
    world: SceneProbe.emptyShared(),
    hostSnapshotReady: false,
    lastSharedRef: null,
    enemySim: new Map(),
    wasHost: false,
    lastAsteroidSpawnAt: 0,
    lastEnemySpawnAt: 0,
    lastBeaconStartedAt: 0,
    shareAcc: 0,
    playBoundsDirty: false,
    dirty: {
      asteroids: false,
      ufo: false,
      items: false,
      enemies: false,
      enemyShots: false,
      shards: false,
      pulls: false,
      beacon: false,
    },
    bossEncounters: new BossEncounters(),
    beatResets: 0,
    battleBeat: { observe: (...cue) => cues.push(cue), reset: () => scene.beatResets++ },
    started: true,
    spawned: true,
    alive: true,
    paused: false,
    trailer: null,
    shipX: 156.25,
    shipY: 444.125,
    shipVX: 12,
    shipVY: -5,
    xp: 123,
    runXp: 45,
    level: 4,
    weapon: constants.WEAPON_DEFAULT,
    recentPickups: new Map(),
    recentShardPickups: new Map(),
    recentConsumedShots: new Map(),
    hostMagnetItems: noOp,
    livingPlayers: () => [],
    hostTickBeacon: noOp,
    hostSpawnEnemies: noOp,
    hostMaybeSpawnBoss: noOp,
    hostSimEnemies: noOp,
    hostApplyPulls: noOp,
    hostDespawnBreather: noOp,
  });
  const client = new Client({
    host: "fixture",
    room: "fixture",
    onEvent: (...args) => scene.handleEvent(...args),
  });
  scene.client = client;
  client.subscribe(() => scene.onUpdate());
  const socket = sockets[0];
  assert.ok(socket);
  return {
    scene,
    client,
    socket,
    packets,
    cues,
    timers,
    SceneProbe: SceneProbe.SceneProbe,
    empty: SceneProbe.emptyShared,
    patch: SceneProbe.sharedToPatch,
    setNow: (value) => {
      now = value;
    },
    sync(state, hostId = "self") {
      socket.receive({ type: "sync", data: { state, hostId, players: { self: { id: "self" } } } });
    },
    event(event, payload) {
      socket.receive({ type: "event", data: { event, payload, from: "remote" } });
    },
  };
}
