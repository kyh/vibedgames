import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as protocol from "../../../packages/multiplayer/src/types.ts";
import { fixture, accepted, wire, neutral } from "./checkpoint-harness.mjs";
const compile = (path, name, context) => {
  const src = readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/^import\b[^;]+;\s*/gm, "")
    .replaceAll("import.meta.env.DEV", "true");
  const code = stripTypeScriptTypes(src, { mode: "transform" }).replace(/^export /gm, "");
  return new Function(...Object.keys(context), `${code};return ${name};`)(
    ...Object.values(context),
  );
};
export function sessionFixture() {
  const packets = [],
    timers = new Map(),
    sockets = [];
  let now = 1;
  class Socket extends EventTarget {
    id = "right";
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
  const Client = compile("../../../packages/multiplayer/src/client.ts", "MultiplayerClient", {
    ...protocol,
    PartySocket: Socket,
    setInterval: (fn) => {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    console,
  });
  const Session = compile("../src/net/session.ts", "NetSession", {
    MultiplayerClient: Client,
    isOfflineRequested: () => false,
    performance: { now: () => now },
  });
  const session = new Session({ room: "checkpoint-test", fallbackMs: 50, maxPlayers: 2 });
  const socket = sockets[0];
  const players = {
    left: {
      id: "left",
      connected: true,
      state: { hero: "axion", input: { ...neutral, j: 0, d: 0, a: 0, s: 0 } },
    },
    right: {
      id: "right",
      connected: true,
      state: { hero: "salamander", input: { ...neutral, j: 0, d: 0, a: 0, s: 0 } },
    },
  };
  const sync = (state, hostId = "left") =>
    socket.receive({ type: "sync", data: { state, hostId, players } });
  return { session, socket, packets, timers, players, sync, setNow: (v) => (now = v) };
}
let groups = 0;
const check = (name, run) => {
  run();
  groups++;
  console.log(`PASS ${name}`);
};
check(
  "actual SDK disconnected host cannot write, send events, or queue player input; election alone admits authority",
  () => {
    const n = sessionFixture();
    n.sync({});
    assert.equal(n.session.live, true);
    assert.equal(n.session.isHost, false);
    const revision = n.session.authorityRevision;
    n.sync({}, "right");
    assert.equal(n.session.isHost, true);
    assert.ok(n.session.authorityRevision > revision);
    n.session.patchShared({ proof: 1 });
    const count = n.packets.length;
    n.socket.close();
    assert.equal(n.session.isHost, false);
    assert.equal(n.session.live, false);
    n.session.patchShared({ proof: 2 });
    n.session.updateMyState({ attack: true });
    n.session.sendEvent("attack", {});
    assert.equal(n.packets.length, count);
    n.setNow(100000);
    n.session.tick();
    assert.equal(n.session.offline, false, "ever-connected never silently forks into solo");
    n.session.destroy();
    assert.equal(n.timers.size, 0);
  },
);
check(
  "transport loss between scene frames still changes admission and prevents fallback; cleanup is idempotent",
  () => {
    const n = sessionFixture();
    n.sync({});
    const before = n.session.authorityRevision;
    n.socket.close();
    n.sync({});
    assert.ok(n.session.authorityRevision > before);
    assert.equal(n.session.disconnectRevision, 1);
    n.setNow(500);
    n.session.tick();
    assert.equal(n.session.offline, false);
    n.session.destroy();
    const closed = n.socket.closed;
    n.session.destroy();
    assert.equal(n.socket.closed, closed);
    assert.equal(n.session.live, false);
    assert.equal(n.timers.size, 0);
  },
);
check(
  "actual SDK cache remains detached after promoted scene restores then advances accepted world",
  () => {
    const host = fixture();
    host.scene.player.body.vx = 19;
    host.scene.remote.body.x = 333;
    host.scene.remote.buffer({ ...neutral, right: true, attackPressed: true });
    const { state } = accepted(host.scene);
    const n = sessionFixture();
    n.sync(state);
    const guest = fixture("right");
    guest.scene.session = n.session;
    guest.scene.role = "guest";
    guest.scene.authority = { kind: "waiting" };
    assert.equal(guest.scene.prepareSession(), true);
    assert.equal(guest.scene.heroName, "salamander");
    assert.equal(guest.scene.player.x, 333);
    const acceptedBefore = wire(n.session.sharedState);
    assert.equal(guest.scene.authority.term, 0);
    n.sync(state, "right");
    assert.equal(guest.scene.prepareSession(), true);
    assert.equal(guest.scene.role, "host");
    assert.equal(guest.scene.authority.term, 1);
    assert.equal(guest.scene.heroName, "salamander");
    assert.equal(guest.scene.player.x, 333);
    assert.deepEqual(state, acceptedBefore);
    const published = wire(n.session.sharedState);
    guest.scene.player.body.x += 100;
    guest.scene.simStep(1 / 60);
    assert.deepEqual(n.session.sharedState, published);
    const count = n.packets.length;
    guest.scene.prepareSession();
    assert.equal(n.packets.length, count, "same admission does not restore/publish again");
    n.session.destroy();
  },
);
check(
  "same-ID reconnect replaces stale private scene before current held movement; old queued casts clear",
  () => {
    const host = fixture();
    host.scene.remote.buffer({ ...neutral, attackPressed: true, right: true });
    const { state } = accepted(host.scene);
    const n = sessionFixture();
    n.sync(state, "right");
    const f = fixture("right");
    f.scene.session = n.session;
    f.scene.authority = { kind: "waiting" };
    f.scene.prepareSession();
    f.scene.player.body.x = -999;
    f.scene.player.buffer({ ...neutral, specialPressed: true });
    n.socket.close();
    n.sync(state, "right");
    assert.equal(f.scene.prepareSession(), true);
    assert.equal(f.scene.player.x, state.checkpoint.players.find((p) => p.id === "right").body.x);
    const body = f.scene.player.body.checkpoint();
    assert.equal(body.attackBuf, 0);
    assert.equal(body.specialBuf, 0);
    assert.equal(body.hRight, false);
    f.scene.controls.sample = () => ({ ...neutral, right: true });
    f.scene.update(0, 16);
    assert.equal(
      f.scene.player.body.checkpoint().hRight,
      true,
      "new held movement survives admission",
    );
    n.session.destroy();
  },
);
check(
  "guest rejects cross-room and stale packet before hearts/reconciliation, and late terminal baseline stays silent",
  () => {
    const host = fixture();
    const { state } = accepted(host.scene);
    const n = sessionFixture();
    n.sync(state);
    const f = fixture("right");
    f.scene.session = n.session;
    f.scene.role = "guest";
    f.scene.authority = { kind: "waiting" };
    f.scene.prepareSession();
    f.scene.stepGuest(0);
    const viewOnly = wire(state);
    viewOnly.snap.t++;
    viewOnly.snap.hearts = 3;
    n.sync(viewOnly);
    f.scene.prepareSession();
    f.scene.stepGuest(0);
    assert.equal(f.scene.guestSnapT, viewOnly.snap.t);
    assert.equal(
      f.scene.hearts,
      3,
      "newer view within accepted run/term/room does not wait for full checkpoint",
    );
    const health = f.scene.hearts;
    const wrong = wire(state.snap);
    wrong.room++;
    wrong.hearts = 0;
    f.scene.applySnapshot(wrong);
    assert.equal(f.scene.hearts, health);
    assert.notEqual(f.scene.state, "dead");
    const terminal = wire(state);
    terminal.checkpoint.phase = { kind: "dead", elapsed: 1.78 };
    terminal.checkpoint.hearts = 0;
    terminal.snap.hearts = 0;
    n.sync(terminal);
    f.scene.authority = { kind: "waiting" };
    f.cues.length = 0;
    f.scene.prepareSession();
    assert.equal(f.scene.state, "dead");
    assert.equal(f.scene.deadT, 1.78);
    assert.equal(f.bank.length, 0);
    assert.equal(f.cues.filter((c) => c.startsWith("sound:")).length, 0);
    n.session.destroy();
  },
);
console.log(`PASS ${groups} actual SDK/session groups`);
