import assert from "node:assert/strict";
import {
  fixture,
  accepted,
  wire,
  neutral,
  checkpoint,
  rng,
  enemies,
} from "./checkpoint-harness.mjs";
let groups = 0;
const check = (name, run) => {
  run();
  groups++;
  console.log(`PASS ${name}`);
};
const comparable = (c) => {
  const v = wire(c);
  delete v.writer;
  delete v.term;
  delete v.tick;
  v.players.sort((a, b) => a.id.localeCompare(b.id));
  return v;
};
check(
  "new peer waits for its chosen hero; accepted kit and live body never follow presence edits",
  () => {
    for (const mode of ["coop", "versus"]) {
      const f = fixture("left", false),
        s = f.scene;
      s.mode = mode;
      if (mode === "versus") s.vs = new f.context.VersusMatch();
      f.session.players.right = { id: "right", connected: true, state: {} };
      for (const hero of [undefined, "unknown", null]) {
        f.session.players.right.state.hero = hero;
        s.syncRemotePresence();
        assert.equal(s.remote, undefined, "presence without a valid choice cannot invent Axion");
        assert.deepEqual(s.seats, { host: "left", guest: null });
        assert.equal(accepted(s).read.kind, "ready");
      }
      f.session.players.right.state.hero = "reaper";
      s.syncRemotePresence();
      const admitted = s.remote;
      assert.equal(admitted.encode("right").hero, "reaper");
      assert.deepEqual(s.seats, { host: "left", guest: "right" });
      if (mode === "versus") assert.equal(s.vs.phase, "countdown");
      admitted.body.x = 211;
      admitted.buffer({ ...neutral, attackPressed: true, right: true });
      const body = admitted.body.checkpoint(),
        cues = [...f.cues];
      f.session.players.right.state.hero = "axion";
      s.syncRemotePresence();
      assert.equal(s.remote, admitted, "next-run selection cannot replace the current actor");
      assert.deepEqual(admitted.body.checkpoint(), body);
      assert.deepEqual(f.cues, cues, "presence updates cannot replay round-start cues");
      assert.equal(s.encodeCheckpoint().players.find((p) => p.id === "right").hero, "reaper");
    }
  },
);
check(
  "fresh expedition never publishes a seat without an admitted hero, including retained right side",
  () => {
    for (const id of ["left", "right"]) {
      const f = fixture(id, false),
        s = f.scene,
        peer = id === "left" ? "right" : "left";
      s.seats = id === "left" ? { host: id, guest: null } : { host: null, guest: id };
      f.session.players[peer] = { id: peer, connected: true, state: {} };
      s.beginOnlineExpedition();
      assert.equal(s.remote, undefined);
      assert.equal(s.remoteId, null);
      assert.deepEqual(
        s.seats,
        id === "left" ? { host: id, guest: null } : { host: null, guest: id },
      );
      assert.equal(checkpoint.readCheckpoint(f.writes.at(-1)).kind, "ready");
      f.session.players[peer].state.hero = "reaper";
      s.syncRemotePresence();
      assert.equal(s.remote.encode(peer).hero, "reaper");
      assert.deepEqual(s.seats, { host: "left", guest: "right" });
      assert.equal(accepted(s).read.kind, "ready");
    }
  },
);
check(
  "guest round respawn clears death once and returns movement on the actual fighting edge",
  () => {
    const host = fixture(),
      h = host.scene;
    h.mode = "versus";
    host.session.players.right.state.hero = "reaper";
    h.beginOnlineExpedition();
    while (h.vs.phase === "countdown") h.simStepVersus(1 / 60);
    h.hostNet(0, true);
    const guest = fixture("right"),
      g = guest.scene;
    guest.session.isHost = false;
    guest.session.hostId = "left";
    g.role = "guest";
    g.authority = { kind: "waiting" };
    const deliver = () => {
      guest.session.sharedState = wire(host.session.sharedState);
      g.prepareSession();
      g.stepGuest(0);
    };
    deliver();
    assert.equal(g.heroName, "reaper");
    h.vs.hp.guest = 1;
    h.remote.body.iframes = 0;
    assert.equal(h.hurtVersus(h.remote, 1, 1), true);
    h.hostNet(0, true);
    deliver();
    assert.equal(g.player.body.dead, true);
    assert.equal(g.netVs.phase, "roundEnd");
    while (h.vs.phase === "roundEnd") h.simStepVersus(1 / 60);
    assert.equal(h.vs.round, 2);
    assert.equal(h.remote.body.dead, false);
    h.hostNet(0, true);
    deliver();
    assert.equal(
      g.player.body.dead,
      false,
      "authoritative respawn must release the prior death flag",
    );
    assert.equal(g.netVs.phase, "countdown");
    assert.equal(g.netVs.guestHp, 5);
    let resets = 0;
    const enter = g.player.enterRoom.bind(g.player);
    g.player.enterRoom = (...args) => {
      resets++;
      return enter(...args);
    };
    for (let i = 0; i < 3; i++) {
      h.hostNet(0, true);
      deliver();
    }
    assert.equal(resets, 0, "fresh live snapshots cannot repeatedly reset the revived body");
    g.guestIn = { ...neutral, right: true };
    const frozenX = g.player.x;
    for (let i = 0; i < 6; i++) g.stepGuest(1 / 60);
    assert.equal(g.player.x, frozenX, "countdown still drops local movement");
    while (h.vs.phase === "countdown") h.simStepVersus(1 / 60);
    h.hostNet(0, true);
    deliver();
    assert.equal(g.netVs.phase, "fighting");
    const start = g.player.x;
    for (let i = 0; i < 6; i++) g.stepGuest(1 / 60);
    assert.ok(g.player.x > start, "actual body moves again after round countdown");
    assert.equal(guest.cues.filter((c) => c === "sound:die").length, 1);
  },
);
function rich() {
  const f = fixture();
  const s = f.scene;
  rng.reseed(59213);
  for (let i = 0; i < 6; i++) {
    const e = new f.context.Enemy(
      s,
      s.grid,
      enemies.ENEMIES[i % 2 ? "archer" : "warrior"],
      130 + i * 25,
      s.roomSpawn.y,
    );
    e.body.hp = 10;
    e.baseTint = 0xaabbcc;
    e.body.speedMult = 1.2;
    s.enemies.push(e);
  }
  s.boss = new f.context.Boss(s, s.grid, 270, s.roomSpawn.y, 2);
  s.boss.body.forceState("wave");
  s.player.body.iframes = 100;
  s.remote.body.iframes = 100;
  s.player.buffer({ ...neutral, attackPressed: true });
  s.remote.buffer({ ...neutral, specialPressed: true });
  for (let i = 0; i < 8; i++) s.simStep(1 / 60);
  s.spawnArrow(400, 80, -50, 15, 1);
  s.arrows[0].life = 0.67;
  s.spawnShot(390, 60, -70, 3, 2, s.remote);
  s.shots.at(-1).life = 0.41;
  s.shots.at(-1).hit.add(s.enemies[0]);
  s.shots.at(-1).hitP.add(s.player);
  s.shots.at(-1).hitBoss = true;
  s.spawnHazard(360, 100, -40, 2);
  s.hazards.at(-1).life = 0.78;
  s.hazards.at(-1).hitPlayer = true;
  const cs = s.cs(s.player);
  cs.hitSwing.add(s.enemies[0]);
  cs.hitSpecial.add(s.enemies[1]);
  cs.lastSwing = s.player.body.swingId;
  cs.lastSpecial = s.player.body.specialId;
  cs.bossSwing = 3;
  cs.bossSpecial = 4;
  s.vsSeq(s.player).swing = 17;
  s.vsSeq(s.remote).special = 18;
  s.enemies.at(-1).body.dead = true;
  s.enemies.at(-1).body.state = "dead";
  s.deadTimers.set(s.enemies.at(-1), 0.27);
  s.combo = 3;
  s.comboT = 0.63;
  s.freeze = 0.021;
  s.acc = 0.004;
  s.gold = 23;
  s.score = 71;
  return f;
}
check(
  "strict schema rejects partial/malformed graphs; accepted payload and live owner are detached",
  () => {
    const f = rich();
    const { state, read } = accepted(f.scene);
    const saved = wire(state);
    read.value.players[0].body.x += 99;
    read.room.cells[0] = 1;
    assert.deepEqual(state, saved);
    f.scene.player.body.x += 50;
    f.scene.shots.at(-1).hit.clear();
    assert.deepEqual(state, saved);
    assert.equal(checkpoint.readCheckpoint(null).kind, "absent");
    assert.equal(checkpoint.readCheckpoint({ room: state.room }).kind, "invalid");
    for (const mutate of [
      (c) => (c.players[0].body.attackCd = NaN),
      (c) => c.players[0].combat.hitSwing.push(999),
      (c) => (c.shots[0].owner = "absent"),
      (c) => (c.seats.guest = c.seats.host),
      (c) => c.enemies.push(c.enemies[0]),
      (c) => (c.phase = { kind: "transition", elapsed: 0.2, built: false }),
      (c) => (c.mode = "other"),
    ]) {
      const changed = wire(state);
      mutate(changed.checkpoint);
      assert.equal(checkpoint.readCheckpoint(changed).kind, "invalid");
    }
    const roomMismatch = wire(state);
    roomMismatch.room.seq++;
    assert.equal(checkpoint.readCheckpoint(roomMismatch).kind, "invalid");
  },
);
check(
  "actual capture/restore rebinds hit/projectile ownership, private clocks and future combat exactly",
  () => {
    const live = rich();
    const { read } = accepted(live.scene);
    const incoming = wire(read.value);
    const restored = fixture();
    restored.scene.authority = { kind: "ready", runId: incoming.runId, term: 1, revision: 2 };
    restored.scene.adoptCheckpoint(incoming, read.room);
    assert.deepEqual(comparable(restored.scene.encodeCheckpoint()), comparable(incoming));
    assert.equal(restored.scene.enemies[0].sprite.tint, 0xaabbcc);
    assert.equal(restored.scene.shots.at(-1).owner, restored.scene.remote);
    assert.ok(restored.scene.shots.at(-1).hit.has(restored.scene.enemies[0]));
    assert.ok(restored.scene.shots.at(-1).hitP.has(restored.scene.player));
    assert.equal(restored.bank.length, 0);
    assert.equal(restored.cues.filter((c) => c.startsWith("sound:")).length, 0);
    let liveRng = incoming.rng,
      restoredRng = incoming.rng;
    for (let i = 0; i < 120; i++) {
      rng.restoreRng(liveRng);
      live.scene.simStep(1 / 60);
      liveRng = rng.checkpointRng();
      rng.restoreRng(restoredRng);
      restored.scene.simStep(1 / 60);
      restoredRng = rng.checkpointRng();
      rng.restoreRng(liveRng);
      const a = live.scene.encodeCheckpoint();
      rng.restoreRng(restoredRng);
      const b = restored.scene.encodeCheckpoint();
      assert.deepEqual(comparable(b), comparable(a), `subsequent combat step ${i}`);
    }
    assert.deepEqual(
      incoming,
      read.value,
      "restore and subsequent simulation never mutate the accepted checkpoint",
    );
  },
);
check(
  "promotion preserves original versus seat, exact phase/HP/score and pending hit dedup",
  () => {
    const left = fixture();
    const s = left.scene;
    s.mode = "versus";
    s.vs = new left.context.VersusMatch();
    s.vs.beginMatch();
    s.vs.t = 0.381;
    s.vs.hp.host = 2;
    s.vs.hp.guest = 3;
    s.vs.score.host = 2;
    s.vs.score.guest = 1;
    s.vsSeq(s.remote).swing = 31;
    const { read } = accepted(s);
    const right = fixture("right");
    right.scene.authority = { kind: "ready", runId: read.value.runId, term: 1, revision: 2 };
    right.scene.adoptCheckpoint(read.value, read.room);
    assert.equal(right.scene.heroName, "salamander");
    assert.equal(right.scene.vsSide(right.scene.player), "guest");
    assert.equal(right.scene.vsSide(right.scene.remote), "host");
    assert.equal(right.scene.vsPlayer("guest"), right.scene.player);
    assert.deepEqual(right.scene.vs.checkpoint(), s.vs.checkpoint());
    assert.equal(right.scene.vsSeq(right.scene.player).swing, 31);
    right.scene.vsRespawn();
    assert.equal(right.scene.player.x, right.scene.grid.cols * 16 - right.scene.roomSpawn.x);
    assert.equal(right.scene.remote.x, right.scene.roomSpawn.x);
  },
);
check(
  "cleared door, accepted shrine/shop state and last-stand clocks survive without replaying rewards",
  () => {
    const f = fixture();
    const s = f.scene;
    s.run.type = "merchant";
    s.cleared = true;
    s.mustClear = false;
    const door = new f.context.Door(s, 460, 100, "rest", 0);
    door.setActive(true);
    s.doors = [door];
    s.offers = [{ type: "rest" }];
    const relic = f.context.RELICS[0];
    s.buildMerchantItem(relic, 100, 80, true);
    s.ownedRelics.add(relic.id);
    s.buildFeature(160, 90);
    s.feature.used = true;
    s.player.body.down();
    s.hearts = 0;
    s.lastStand = { pl: s.player, bleedT: 3.317, reviveT: 0.813 };
    const { read } = accepted(s);
    const r = fixture();
    r.scene.adoptCheckpoint(read.value, read.room);
    assert.equal(r.scene.doors[0].active, true);
    assert.equal(r.scene.merchantItems[0].g.visible, false);
    assert.equal(r.scene.feature.g.visible, false);
    assert.deepEqual(
      { bleed: r.scene.lastStand.bleedT, revive: r.scene.lastStand.reviveT },
      { bleed: 3.317, revive: 0.813 },
    );
    assert.equal(r.scene.lastStand.pl, r.scene.player);
    assert.equal(r.bank.length, 0);
    assert.equal(r.cues.filter((c) => c.startsWith("sound:")).length, 0);
    const guest = fixture();
    guest.scene.syncRoomFeatures(
      {
        ...read.value,
        merchant: [{ ...read.value.merchant[0], bought: false }],
        feature: { ...read.value.feature, used: false },
      },
      true,
    );
    guest.cues.length = 0;
    guest.scene.syncRoomFeatures(read.value, false);
    guest.scene.syncRoomFeatures(read.value, false);
    assert.equal(
      guest.cues.filter((c) => c === "sound:pickup").length,
      2,
      "one shop edge and one feature edge",
    );
    assert.equal(guest.scene.gold, 0);
    assert.equal(guest.scene.ownedRelics.size, 0);
  },
);
check(
  "terminal adoption stays terminal on election and never banks, respawns or seeds implicitly",
  () => {
    const f = fixture();
    f.scene.state = "dead";
    f.scene.deadT = 2.31;
    f.scene.hearts = 0;
    f.scene.player.body.dead = true;
    f.scene.remote.body.dead = true;
    const { state } = accepted(f.scene);
    const r = fixture("right");
    r.session.sharedState = state;
    r.session.authorityRevision = 2;
    r.scene.authority = { kind: "waiting" };
    delete r.session.players.left;
    assert.equal(r.scene.prepareSession(), true);
    assert.equal(r.scene.state, "dead");
    assert.equal(r.scene.deadT, 2.31);
    assert.equal(r.scene.hearts, 0);
    assert.equal(r.scene.player.body.dead, true);
    assert.equal(r.bank.length, 0);
    assert.equal(r.scene.runRecap.kind, "coop-guest");
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].checkpoint.runId, state.checkpoint.runId);
    assert.equal(r.writes[0].checkpoint.phase.kind, "dead");
    r.scene.handleExpeditionRestart();
    assert.equal(r.writes.length, 1);
    r.scene.restartRequested = true;
    r.scene.handleExpeditionRestart();
    assert.equal(r.scene.state, "active");
    assert.notEqual(r.scene.authority.runId, state.checkpoint.runId);
    assert.equal(r.bank.length, 0);
  },
);
check(
  "new active successor preserves remaining peer body and existing departed-seat relief",
  () => {
    const old = fixture();
    old.scene.player.body.down();
    old.scene.hearts = 0;
    old.scene.lastStand = { pl: old.scene.player, bleedT: 4, reviveT: 0.3 };
    old.scene.remote.body.x = 347;
    old.scene.remote.body.vx = 12;
    const { state } = accepted(old.scene);
    const fresh = fixture();
    fresh.session.playerId = "new";
    fresh.session.hostId = "new";
    fresh.session.players = {
      new: { id: "new", connected: true, state: { hero: "axion" } },
      right: { id: "right", connected: false, state: { hero: "salamander" } },
    };
    fresh.session.sharedState = state;
    fresh.session.authorityRevision = 2;
    fresh.scene.authority = { kind: "waiting" };
    fresh.scene.prepareSession();
    assert.equal(fresh.scene.remoteId, "right");
    assert.equal(fresh.scene.remote.x, 347);
    assert.equal(fresh.scene.remote.body.vx, 12);
    assert.equal(fresh.scene.hearts, 1);
    assert.equal(fresh.scene.lastStand, null);
    assert.deepEqual(fresh.scene.seats, { host: "new", guest: "right" });
    assert.equal(checkpoint.readCheckpoint(fresh.writes.at(-1)).kind, "ready");
  },
);
check(
  "unassigned terminal successor preserves the old roster until explicit restart and uses newly requested hero",
  () => {
    const old = fixture();
    old.scene.state = "dead";
    old.scene.deadT = 1.7;
    old.scene.hearts = 0;
    const { state } = accepted(old.scene);
    const fresh = fixture();
    fresh.session.playerId = "new";
    fresh.session.hostId = "new";
    fresh.session.players = { new: { id: "new", connected: true, state: { hero: "mooni" } } };
    fresh.session.sharedState = state;
    fresh.session.authorityRevision = 2;
    fresh.scene.authority = { kind: "waiting" };
    fresh.scene.prepareSession();
    const saved = fresh.writes.at(-1);
    assert.equal(checkpoint.readCheckpoint(saved).kind, "ready");
    assert.deepEqual(saved.checkpoint.seats, state.checkpoint.seats);
    assert.deepEqual(saved.checkpoint.players, state.checkpoint.players);
    fresh.scene.requestedHero = "mooni";
    fresh.scene.sendInput(neutral);
    fresh.scene.restartRequested = true;
    fresh.scene.handleExpeditionRestart();
    assert.equal(fresh.scene.heroName, "mooni");
    assert.equal(fresh.scene.state, "active");
    assert.equal(fresh.bank.length, 0);
    assert.equal(checkpoint.readCheckpoint(fresh.writes.at(-1)).kind, "ready");
    assert.deepEqual(fresh.scene.seats, { host: "new", guest: null });
  },
);
check("adopted versus result silently restores durable winner/rematch copy and exact hold", () => {
  const old = fixture();
  old.scene.mode = "versus";
  old.scene.vs = new old.context.VersusMatch();
  old.scene.vs.phase = "matchEnd";
  old.scene.vs.winner = "guest";
  old.scene.vs.t = 0.47;
  old.scene.vs.score.guest = 3;
  const { read } = accepted(old.scene);
  const next = fixture("right");
  next.scene.adoptCheckpoint(read.value, read.room);
  assert.equal(next.scene.vs.t, 0.47);
  assert.equal(next.scene.vs.phase, "matchEnd");
  assert.match(next.scene.activeBanner.text, /P2.*YOU.*WINS THE MATCH.*REMATCH/);
  assert.equal(next.cues.filter((c) => c.startsWith("sound:")).length, 0);
});
check(
  "transition checkpoints publish atomically after choose; takeover never chooses a built room twice",
  () => {
    for (const [elapsed, built] of [
      [0.18, false],
      [0.27, true],
    ]) {
      const f = fixture();
      const s = f.scene;
      s.state = "transition";
      s.pendingOffer = { type: "rest" };
      s.transT = elapsed;
      s.transBuilt = built;
      s.roomDirty = false;
      const { read } = accepted(s);
      const r = fixture();
      r.scene.adoptCheckpoint(read.value, read.room);
      let choices = 0;
      const choose = r.scene.run.choose.bind(r.scene.run);
      r.scene.run.choose = (offer) => {
        choices++;
        return choose(offer);
      };
      r.scene.update(0, 50);
      assert.equal(choices, built ? 0 : 1);
      const packet = r.writes.at(-1);
      assert.ok(packet);
      assert.equal(packet.snap.t, packet.checkpoint.tick);
      assert.equal(packet.checkpoint.phase.built, true);
      if (!built) {
        assert.ok(packet.room);
        assert.equal(packet.room.seq, packet.snap.room);
        assert.equal(packet.room.seq, packet.checkpoint.room);
      }
    }
  },
);
check(
  "connected admission precedes inputs; missing legacy data never seeds; current counters baseline after pause/drop",
  () => {
    const f = fixture();
    f.scene.player.buffer({ ...neutral, right: true, attackPressed: true });
    f.scene.wasConnected = true;
    f.session.live = false;
    f.session.isHost = false;
    assert.equal(f.scene.prepareSession(), false);
    assert.equal(f.scene.player.body.checkpoint().attackBuf, 0);
    assert.equal(f.scene.player.body.checkpoint().hRight, false);
    const peer = f.session.players.right;
    peer.state.input = { ...neutral, right: true, j: 5, d: 3, a: 7, s: 2 };
    assert.equal(f.scene.readRemoteInput().attackPressed, false);
    peer.state.input.a++;
    assert.equal(f.scene.readRemoteInput().attackPressed, true);
    peer.state.paused = true;
    assert.deepEqual(f.scene.readRemoteInput(), neutral);
    peer.state.input.a += 9;
    peer.state.paused = false;
    assert.equal(f.scene.readRemoteInput().attackPressed, false);
    peer.connected = false;
    assert.deepEqual(f.scene.readRemoteInput(), neutral);
    peer.connected = true;
    peer.state.input.a++;
    assert.equal(f.scene.readRemoteInput().attackPressed, false);
    peer.state.input.a++;
    assert.equal(f.scene.readRemoteInput().attackPressed, true);
    f.session.live = true;
    f.session.isHost = true;
    f.session.authorityRevision++;
    f.session.sharedState = { room: {} };
    assert.equal(f.scene.prepareSession(), false);
    assert.equal(f.writes.length, 0);
  },
);
check(
  "30 Hz views retain bounded 10 Hz complete checkpoints, forced edges and detached payloads",
  () => {
    const f = rich();
    f.scene.roomDirty = true;
    f.scene.hostNet(0, true);
    const first = f.writes[0];
    const saved = wire(first);
    f.scene.player.body.x += 1;
    f.scene.boss.body.pendingWaves.push({ x: 1, y: 2, vx: 3, dmg: 1 });
    assert.deepEqual(first, saved);
    const sample = () => {
      const start = f.writes.length;
      for (let i = 0; i < 30; i++) f.scene.hostNet(1 / 30);
      const packets = f.writes.slice(start);
      assert.equal(packets.length, 30);
      assert.equal(packets.filter((p) => p.checkpoint).length, 10);
      assert.equal(packets.filter((p) => !p.checkpoint).length, 20);
      return {
        bytes: packets.reduce((sum, p) => sum + Buffer.byteLength(JSON.stringify(p)), 0),
        full: Buffer.byteLength(JSON.stringify(packets.find((p) => p.checkpoint))),
        view: Buffer.byteLength(JSON.stringify(packets.find((p) => !p.checkpoint))),
      };
    };
    const typical = sample();
    for (let i = 0; i < 24; i++) {
      f.scene.spawnArrow(200, 40, i, 15, 1);
      f.scene.spawnShot(220, 50, -i, 0, 1, f.scene.player);
      f.scene.spawnHazard(260, 70, i, 1);
    }
    const dense = sample();
    f.scene.state = "transition";
    f.scene.pendingOffer = { type: "rest" };
    f.scene.transBuilt = false;
    f.scene.transT = 0.1;
    f.scene.hostNet(1 / 30);
    assert.equal(f.writes.at(-1).checkpoint.phase.kind, "transition");
    f.scene.state = "dead";
    f.scene.deadT = 0;
    f.scene.hostNet(0, true);
    assert.equal(f.writes.at(-1).checkpoint.phase.kind, "dead");
    console.log(
      JSON.stringify({
        cadence: { viewHz: 30, checkpointHz: 10 },
        typical,
        dense,
        roomTransitionBytes: Buffer.byteLength(JSON.stringify(first)),
        denseEntities: {
          enemies: f.scene.enemies.length,
          projectiles: f.scene.arrows.length + f.scene.shots.length + f.scene.hazards.length,
        },
      }),
    );
    assert.ok(typical.bytes < 120000);
    assert.ok(dense.bytes < 250000);
  },
);
console.log(`PASS ${groups} checkpoint scene groups`);
