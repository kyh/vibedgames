import assert from "node:assert/strict";
import { test } from "node:test";
import * as constants from "../src/shared/constants.ts";
import { sceneFixture } from "./scene-harness.mjs";

function soloFixture() {
  const fixture = sceneFixture();
  fixture.game.playSolo();
  return fixture;
}

test("ordinary accepted contacts teach only the local paddle, preserving physics and beats", () => {
  const f = soloFixture(),
    g = f.game;
  try {
    let strength = 0;
    g.stroke = { read: () => strength, reset() {} };
    g.net.offline = false;
    g.net.other = { id: "guest" };
    g.admitRole();
    g.phase = "rally";
    g.ballPos.set(0, -constants.PADDLE_Y);
    g.onPaddleHit("player");
    assert.equal(g.curveLesson, "curve");
    assert.equal(g.ballVel.x, 0);
    assert.equal(g.ballVel.y, constants.RALLY_SPEED_BASE + constants.RALLY_SPEED_STEP);
    g.remoteStrokeIntent = -0.8;
    g.remoteStrokeUntil = 2;
    g.onPaddleHit("ai");
    assert.equal(g.curveLesson, "curve", "opponent's curve cannot complete the local lesson");
    strength = -0.8;
    g.onPaddleHit("player");
    assert.equal(g.curveLesson, "complete");
    assert.equal(g.lessonUntil, g.elapsed + 2);
    strength = 0.8;
    g.onPaddleHit("player");
    assert.equal(g.spinShots, 3);
    assert.equal(g.rallyHits, 4);
    assert.equal(g.longestRally, 4);
    assert.equal(f.sounds.filter(([name]) => name === "paddleHit").length, 4);
    assert.equal(g.net.events.length, 4);
    assert.equal(g.net.events[3][0], "phit");
    assert.equal(g.net.events[3][1].spin, 0.8);
    assert.equal(Object.hasOwn(g.diagnostics(), "practice"), false);
  } finally {
    g.dispose();
  }
});

test("guest teaching accepts only host-authenticated local contact beats", () => {
  const f = sceneFixture(),
    g = f.game;
  try {
    Object.assign(g.net, { live: true, offline: false, isHost: false, hostId: "host" });
    g.admitRole();
    g.handleEvent("phit", { a: false, spin: 1 }, "intruder");
    assert.equal(g.curveLesson, "return");
    g.handleEvent("phit", { a: true, spin: -1 }, "host");
    assert.equal(g.curveLesson, "return");
    g.handleEvent("phit", { a: false, spin: 0 }, "host");
    assert.equal(g.curveLesson, "curve");
    g.handleEvent("phit", { a: false, spin: -0.5 }, "host");
    assert.equal(g.curveLesson, "complete");
    assert.equal(g.spinShots, 0);
    assert.equal(f.sounds.filter(([name]) => name === "paddleHit").length, 3);
  } finally {
    g.dispose();
  }
});

test("normal rematch keeps learned teaching and the current transport", () => {
  const f = soloFixture(),
    g = f.game;
  try {
    g.curveLesson = "complete";
    g.lessonUntil = 0;
    g.scoreYou = 7;
    g.scoreAi = 2;
    g.longestRally = 11;
    g.phase = "won";
    const net = g.net,
      sessionCount = f.sessions.length;
    g.syncHud();
    assert.equal(g.actionEl.textContent, "REMATCH");
    assert.equal(g.bannerTitleEl.textContent, "YOU WIN");
    g.confirm();
    assert.equal(g.phase, "rally");
    assert.deepEqual([g.scoreYou, g.scoreAi, g.longestRally], [0, 0, 0]);
    assert.equal(g.curveLesson, "complete");
    assert.equal(g.teachingEl.hidden, true);
    assert.equal(g.net, net);
    assert.equal(f.sessions.length, sessionCount);
  } finally {
    g.dispose();
  }
});

test("passive teaching is available in AI and live matches, then retires after two seconds", () => {
  for (const human of [false, true]) {
    const f = soloFixture(),
      g = f.game;
    try {
      if (human) {
        g.net.offline = false;
        g.net.other = { id: "guest" };
        g.admitRole();
      }
      const net = g.net,
        sessionCount = f.sessions.length;
      g.phase = "rally";
      g.syncHud();
      assert.equal(g.teachingEl.hidden, false);
      assert.equal(g.teachingTitleEl.textContent, "Meet the ball with your paddle");
      g.observeLocalContact(true, 0);
      assert.equal(g.teachingTitleEl.textContent, "Flick sideways at contact to curve");
      g.observeLocalContact(true, -0.5);
      assert.equal(g.teachingTitleEl.textContent, "CURVE LANDED");
      g.freeze = 5; // Existing contact freeze keeps this timer probe away from a new collision.
      g.update(1.99);
      assert.equal(g.teachingEl.hidden, false);
      g.update(0.02);
      assert.equal(g.lessonUntil, 0);
      assert.equal(g.teachingEl.hidden, true);
      assert.equal(g.net, net);
      assert.equal(f.sessions.length, sessionCount);
    } finally {
      g.dispose();
    }
  }
});
