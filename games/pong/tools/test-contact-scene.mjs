import assert from "node:assert/strict";
import { test } from "node:test";
import { sceneFixture } from "./scene-harness.mjs";
import { PhysicalGamepad } from "../../../packages/gamepad/src/physical.ts";
import {
  BALL_R,
  GOAL_Y,
  HIT_HALF_X,
  PADDLE_Y,
  RALLY_SPEED_BASE,
  RALLY_SPEED_STEP,
} from "../src/shared/constants.ts";
import { chargeHits } from "../src/shared/contact-shot.ts";

function fixture(role = "solo") {
  const f = sceneFixture(),
    g = f.game;
  if (role === "solo") g.playSolo();
  else {
    Object.assign(g.net, {
      live: true,
      offline: false,
      isHost: role === "host",
      hostId: "host",
      other: { id: role === "host" ? "guest" : "host", state: { paddle: 0 } },
    });
    g.admitRole();
    g.chargeOpponentId = g.net.other.id;
  }
  g.phase = "rally";
  g.freeze = 0;
  return f;
}
function contact(g, side = "player", screenOffset = 0) {
  g.phase = "rally";
  g.playerX = 0;
  g.aiX = 0;
  const direction = side === "player" ? 1 : -1;
  g.ballPos.set(screenOffset * direction * HIT_HALF_X, -direction * (PADDLE_Y - 0.02));
  g.ballVel.set(0, -direction * 6);
  g.updateBall(1 / 120);
}
function snapshot(host, guest) {
  host.broadcastShared(1);
  guest.net.sharedState = host.net.patches.at(-1);
  guest.applyGuestShared(0);
}
function deliver(guest, host) {
  const [name, payload] = guest.net.events.at(-1);
  host.handleEvent(name, payload, "guest");
}

test("actual collision earns only that seat; serve, wall, miss and duplicate guest FX cannot charge", () => {
  const f = fixture(),
    g = f.game;
  try {
    g.serve();
    g.wallFx(4, 0);
    assert.equal(chargeHits(g.chargeA), 0);
    for (let i = 1; i <= 4; i++) {
      contact(g);
      assert.equal(chargeHits(g.chargeA), i);
      assert.equal(chargeHits(g.chargeB), 0);
      assert.ok(Math.abs(g.ballVel.y - (RALLY_SPEED_BASE + RALLY_SPEED_STEP * i)) < 1e-10);
    }
    g.confirm();
    assert.equal(g.chargeA.kind, "armed");
    g.ballPos.set(4, -GOAL_Y - 0.1);
    g.ballVel.set(0, -6);
    g.updateBall(1 / 60);
    assert.equal(g.chargeA.kind, "ready", "miss cancels queue without spending charge");
    g.serve();
    assert.equal(g.chargeA.kind, "ready");
    g.confirm();
    contact(g);
    assert.equal(chargeHits(g.chargeA), 0);
    assert.equal(g.powerShots, 1);
    assert.equal(g.ballVel.y, 1.4 * (RALLY_SPEED_BASE + RALLY_SPEED_STEP));
    contact(g, "ai");
    assert.equal(chargeHits(g.chargeB), 1);
    assert.equal(g.ballVel.length(), RALLY_SPEED_BASE + RALLY_SPEED_STEP * 2);
  } finally {
    g.dispose();
  }
  const guest = fixture("guest");
  try {
    for (let i = 0; i < 3; i++) guest.game.handleEvent("phit", { a: false, powered: true }, "host");
    assert.equal(chargeHits(guest.game.chargeB), 0);
  } finally {
    guest.game.dispose();
  }
});

test("actual contacts mirror zones, bound power, and render the lower topspin hop", () => {
  const f = fixture(),
    g = f.game;
  try {
    for (const side of ["player", "ai"]) {
      for (const offset of [-0.8, 0, 0.8]) {
        g.rallySpeed = 10;
        contact(g, side, offset);
        const ordinary = 10 + RALLY_SPEED_STEP;
        assert.ok(Math.abs(g.ballVel.length() - ordinary * (offset > 0 ? 1.1 : 1)) < 1e-10);
        assert.equal(
          Math.sign(g.spin?.strength ?? 0),
          offset < 0 ? (side === "player" ? -1 : 1) : 0,
        );
        g.ballPos.y = (g.arc.fromY + g.arc.toY) / 2;
        g.updateVisuals(0);
        const lift = g.ball.position.z - BALL_R;
        if (offset > 0) {
          g.shotLift = 1;
          g.updateVisuals(0);
          assert.ok(Math.abs(lift - (g.ball.position.z - BALL_R) * 0.55) < 1e-10);
        }
        if (side === "player") g.chargeA = { kind: "armed" };
        else g.chargeB = { kind: "armed" };
        g.rallySpeed = 13;
        contact(g, side, offset);
        assert.ok(Math.abs(g.ballVel.length() - 17) < 1e-10);
      }
    }
  } finally {
    g.dispose();
  }
});

test("guest command acknowledgement permits another power in the same rally; stale and spoofed input cannot arm", () => {
  const h = fixture("host"),
    f = fixture("guest"),
    host = h.game,
    guest = f.game;
  try {
    host.hostSeq = 100;
    host.shotRally = 4;
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 4; i++) contact(host, "ai");
      snapshot(host, guest);
      guest.confirm();
      assert.equal(guest.powerIntent, true);
      deliver(guest, host);
      assert.equal(host.chargeB.kind, "armed");
      snapshot(host, guest);
      assert.equal(guest.powerIntent, false);
      assert.equal(guest.chargeB.kind, "armed");
      contact(host, "ai");
      snapshot(host, guest);
      assert.equal(chargeHits(guest.chargeB), 0);
    }
    host.chargeB = { kind: "ready" };
    const valid = {
      seq: host.remoteActionSeq + 1,
      rally: host.shotRally,
      seen: host.hostSeq,
      armed: true,
    };
    for (const bad of [
      { ...valid, seq: 2 ** 40 },
      { ...valid, seen: 0 },
      { ...valid, rally: valid.rally - 1 },
      { ...valid, seq: host.remoteActionSeq },
    ]) {
      host.handleEvent("power", bad, "guest");
      assert.equal(host.chargeB.kind, "ready");
    }
    host.handleEvent("power", valid, "intruder");
    assert.equal(host.chargeB.kind, "ready");
    host.chargeB = { kind: "charging", hits: 3 };
    host.handleEvent("power", valid, "guest");
    contact(host, "ai");
    host.handleEvent("power", valid, "guest");
    assert.equal(
      host.chargeB.kind,
      "ready",
      "early command was consumed, not stored for later charge",
    );
  } finally {
    host.dispose();
    guest.dispose();
  }
});

test("live overlay blocks local steering and all confirms, while remote power and authoritative world continue", () => {
  for (const role of ["host", "guest"]) {
    const f = fixture(role),
      g = f.game;
    try {
      g.chargeA = { kind: "armed" };
      g.chargeB = { kind: "armed" };
      g.lastSeq = 10;
      g.requestPause();
      assert.equal(g.paused, false, "live match keeps sim policy");
      assert.equal(g.myCharge.kind, "ready");
      const events = g.net.events.length,
        paddle = g.myPaddle,
        frame = g.frame;
      g.handleHandPosition(0.1);
      g.applyPaddleInput(1 / 60);
      g.handleGestureConfirm();
      g.onPointerDown({ pointerType: "touch" });
      g.pad.justPressed = () => true;
      g.update(1 / 60);
      assert.equal(g.myPaddle, paddle);
      assert.equal(g.myCharge.kind, "ready");
      assert.equal(g.net.events.length, events);
      assert.ok(g.frame > frame);
      if (role === "host") {
        g.chargeB = { kind: "ready" };
        g.handleEvent(
          "power",
          { seq: 1, rally: g.shotRally, seen: g.hostSeq, armed: true },
          "guest",
        );
        assert.equal(g.chargeB.kind, "armed");
      }
      g.requestResume();
      g.handleGestureConfirm();
      assert.equal(role === "host" ? g.chargeA.kind === "armed" : g.powerIntent, true);
    } finally {
      g.dispose();
    }
  }
});

test("tracking loss, pause, points, rematch and seat migration preserve the right charge owner", () => {
  const f = fixture(),
    g = f.game;
  try {
    g.chargeA = { kind: "armed" };
    g.handleHandPosition(0.5);
    g.applyPaddleInput(1 / 60);
    f.clock.ms += 600;
    g.applyPaddleInput(1 / 60);
    assert.equal(g.chargeA.kind, "ready");
    g.confirm();
    g.requestPause();
    g.handleGestureConfirm();
    assert.equal(g.chargeA.kind, "ready");
    assert.equal(g.paused, true);
    g.requestResume();
    g.phase = "won";
    g.scoreYou = 7;
    g.scoreAi = 2;
    const session = g.net;
    g.confirm();
    assert.equal(g.net, session);
    assert.equal(chargeHits(g.chargeA), 0);
    assert.equal(chargeHits(g.chargeB), 0);
  } finally {
    g.dispose();
  }
  const guest = fixture("guest"),
    b = guest.game;
  try {
    b.chargeB = { kind: "armed" };
    b.chargeA = { kind: "ready" };
    b.powerActionSeq = 100;
    b.net.live = false;
    b.update(0.01);
    b.net.live = true;
    b.update(0.01);
    assert.equal(b.powerActionSeq, 100, "same peer reconnect keeps request sequence");
    assert.equal(b.chargeB.kind, "armed");
    b.net.isHost = true;
    b.admitRole();
    assert.equal(b.chargeA.kind, "ready");
    assert.equal(chargeHits(b.chargeB), 0);
    b.replaceSession(true);
    assert.equal(chargeHits(b.chargeA), 0);
  } finally {
    b.dispose();
  }
});

test("held controller resume does not arm; release and new press does", () => {
  const f = fixture(),
    g = f.game;
  let held = false;
  g.pad = new PhysicalGamepad({
    poll: () => [
      { connected: true, axes: [0, 0], buttons: [{ pressed: held, value: Number(held) }] },
    ],
  });
  try {
    g.chargeA = { kind: "ready" };
    g.pad.update();
    g.requestPause();
    held = true;
    g.requestResume();
    g.update(1 / 60);
    assert.equal(g.chargeA.kind, "ready");
    held = false;
    g.update(1 / 60);
    held = true;
    g.update(1 / 60);
    assert.equal(g.chargeA.kind, "armed");
  } finally {
    g.dispose();
  }
});

test("guest may serve and rematch while host controls overlay remains open", () => {
  const f = fixture("host"),
    g = f.game;
  try {
    g.phase = "serving";
    g.requestPause();
    g.handleEvent("confirm", {}, "intruder");
    assert.equal(g.phase, "serving");
    g.handleEvent("confirm", {}, "guest");
    assert.equal(g.phase, "rally");
    g.phase = "won";
    g.scoreYou = 7;
    g.scoreAi = 3;
    g.handleEvent("confirm", {}, "guest");
    assert.equal(g.phase, "rally");
    assert.deepEqual([g.scoreYou, g.scoreAi], [0, 0]);
    assert.equal(g.inputSuspended, true);
  } finally {
    g.dispose();
  }
});

test("stale authenticated request is acknowledged without arming; point/rally resets never strand pending intent", () => {
  const h = fixture("host"),
    f = fixture("guest"),
    host = h.game,
    guest = f.game;
  try {
    host.chargeB = { kind: "ready" };
    guest.chargeB = { kind: "ready" };
    host.hostSeq = 100;
    guest.lastSeq = 1;
    host.shotRally = 5;
    guest.shotRally = 5;
    guest.confirm();
    deliver(guest, host);
    assert.equal(host.remoteActionSeq, 1);
    assert.equal(host.chargeB.kind, "ready");
    snapshot(host, guest);
    assert.equal(guest.powerIntent, false);
    guest.confirm();
    deliver(guest, host);
    assert.equal(host.chargeB.kind, "armed", "fresh retry succeeds after stale rejection");
    snapshot(host, guest);
    host.onPoint("you");
    snapshot(host, guest);
    assert.equal(guest.powerIntent, false);
    host.serve();
    snapshot(host, guest);
    guest.confirm();
    assert.equal(guest.powerIntent, true);
    // No delivered request/ack: authoritative new rally still releases local pending state.
    host.serve();
    snapshot(host, guest);
    assert.equal(guest.powerIntent, false);
    guest.confirm();
    assert.equal(guest.powerIntent, true);
  } finally {
    host.dispose();
    guest.dispose();
  }
});

test("guest reports accepted active match to the embed; initial and stale waiting snapshots do not", () => {
  const f = fixture("guest"),
    g = f.game;
  try {
    g.net.sharedState = { seq: 1, phase: "serving", serveLeft: null };
    g.applyGuestShared(0);
    assert.equal(f.startup.calls, 0);
    g.net.sharedState = { seq: 2, phase: "rally" };
    g.applyGuestShared(0);
    assert.equal(f.startup.calls, 1);
    g.applyGuestShared(0);
    assert.equal(f.startup.calls, 1, "no notification from repeated snapshot");
    g.net.sharedState = { seq: 1, phase: "serving" };
    g.applyGuestShared(0);
    assert.equal(g.phase, "rally");
    assert.equal(f.startup.calls, 1);
  } finally {
    g.dispose();
  }
});

test("old-view same-rally cancel releases only authenticated owner; old-rally cancel stays inert", () => {
  const f = fixture("host"),
    g = f.game;
  try {
    g.hostSeq = 100;
    g.shotRally = 5;
    g.chargeA = { kind: "armed" };
    g.chargeB = { kind: "armed" };
    const cancel = { seq: 1, rally: 5, seen: 1, armed: false };
    g.handleEvent("power", cancel, "intruder");
    assert.equal(g.chargeB.kind, "armed");
    g.handleEvent("power", { ...cancel, rally: 4 }, "guest");
    assert.equal(g.chargeB.kind, "armed");
    g.handleEvent("power", { ...cancel, seq: 2 }, "guest");
    assert.equal(g.chargeB.kind, "ready");
    assert.equal(g.chargeA.kind, "armed");
    assert.equal(g.remoteActionSeq, 2);
  } finally {
    g.dispose();
  }
});
