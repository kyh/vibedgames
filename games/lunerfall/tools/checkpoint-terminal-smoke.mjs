import assert from "node:assert/strict";
import { fixture, wire, display } from "./checkpoint-harness.mjs";
const host = fixture(),
  h = host.scene;
h.hearts = 1;
h.gold = 40;
h.score = 500;
h.player.body.iframes = 0;
h.remote.body.iframes = 0;
h.hurtPlayer(1, 1, h.player);
assert.ok(h.lastStand);
assert.equal(h.player.body.downed, true);
h.roomDirty = true;
h.hostNet(0, true);
const guest = fixture("right"),
  g = guest.scene;
guest.session.isHost = false;
guest.session.hostId = "left";
g.role = "guest";
g.authority = { kind: "waiting" };
guest.session.sharedState = wire(host.session.sharedState);
g.prepareSession();
g.stepGuest(0);
assert.equal(g.state, "active");
assert.ok(g.netLastStand);
g.lsG = display();
g.lsLabel = display();
h.lsG = display();
h.lsLabel = display();
const hostUi = h.lsG,
  guestUi = g.lsG;
const downedView = wire(host.session.sharedState.snap.lastStand);
h.hurtPlayer(1, 1, h.remote);
guest.session.sharedState = wire(host.session.sharedState);
// Visual downed metadata is advisory; coherent checkpoint death owns terminality.
guest.session.sharedState.snap.lastStand = downedView;
g.prepareSession();
g.stepGuest(0);
console.log(
  JSON.stringify({
    secondFatal: {
      hostPhase: h.state,
      hostLastStand: h.lastStand !== null,
      checkpointPhase: host.session.sharedState.checkpoint.phase,
      snapshotLastStand: host.session.sharedState.snap.lastStand,
      guestPhase: g.state,
      guestLastStand: g.netLastStand !== null,
      bankCalls: host.bank.filter(([kind]) => kind === "bank").length,
    },
  }),
);
assert.equal(h.state, "dead");
assert.equal(
  h.lastStand === null,
  true,
  "terminal host must clear the incompatible last-stand state before publication",
);
assert.equal(h.netLastStand, null);
assert.equal(hostUi.active, false);
assert.equal(host.session.sharedState.checkpoint.lastStand, null);
assert.equal(host.session.sharedState.snap.lastStand, null);
assert.equal(g.state, "dead", "same-authority guest must consume the coherent terminal checkpoint");
assert.equal(g.netLastStand, null);
assert.equal(guestUi.active, false);
assert.equal(host.bank.filter(([kind]) => kind === "bank").length, 1);
assert.equal(host.bank.filter(([kind]) => kind === "best").length, 1);
assert.equal(guest.bank.length, 0);
const hostCues = host.cues.filter((c) => c === "sound:die").length,
  guestCues = guest.cues.filter((c) => c === "sound:die").length;
assert.equal(hostCues, 1);
assert.equal(guestCues, 1);
h.playerDie();
h.remote.body.iframes = 0;
h.hurtPlayer(1, 1, h.remote);
h.deadT = 0.4;
h.hostNet(0, true);
guest.session.sharedState = wire(host.session.sharedState);
g.stepGuest(0);
g.stepGuest(0);
assert.equal(
  host.bank.filter(([kind]) => kind === "bank").length,
  1,
  "repeated terminal calls cannot bank again",
);
assert.equal(h.hearts, 0);
assert.equal(h.lastStand, null);
assert.equal(host.cues.filter((c) => c === "sound:die").length, hostCues);
assert.equal(guest.cues.filter((c) => c === "sound:die").length, guestCues);
const late = fixture("right");
late.session.isHost = false;
late.session.hostId = "left";
late.scene.role = "guest";
late.scene.authority = { kind: "waiting" };
late.session.sharedState = wire(host.session.sharedState);
late.scene.prepareSession();
assert.equal(late.scene.state, "dead");
assert.equal(late.scene.deadT, 0.4);
assert.equal(late.bank.length, 0);
assert.equal(
  late.cues.filter((c) => c === "sound:die").length,
  0,
  "late terminal baseline stays silent",
);
console.log(
  "PASS second fatal contact clears last stand, ends both peers, banks once; repeated and late terminal admission stays quiet",
);
