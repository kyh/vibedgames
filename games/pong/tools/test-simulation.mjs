import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sceneFixture } from "./scene-harness.mjs";
import { GOAL_Y, HAND_RANGE, PADDLE_X_MAX, PADDLE_Y, HIT_HALF_X } from "../src/shared/constants.ts";

const hashFile = (path) =>
  createHash("sha256")
    .update(readFileSync(new URL(path, import.meta.url)))
    .digest("hex");

/** Actual fixed-step simulation, hand mapping and authoritative contacts. */
export function simulationTrace(sourcePath) {
  const trace = [],
    coverage = { soloContacts: 0, hostContacts: 0, points: 0, curves: 0, walls: 0, wonFrames: 0 };
  for (const mode of ["solo", "host"]) {
    const f = sceneFixture(sourcePath),
      g = f.game;
    g.seed(7123);
    if (mode === "host") {
      Object.assign(g.net, {
        live: true,
        offline: false,
        isHost: true,
        other: { id: "rival", state: { paddle: 0 } },
      });
    }
    const snapshot = () =>
      trace.push({
        mode,
        phase: g.phase,
        x: g.ballPos.x,
        y: g.ballPos.y,
        vx: g.ballVel.x,
        vy: g.ballVel.y,
        player: g.playerX,
        opponent: g.aiX,
        score: g.scoreYou,
        opponentScore: g.scoreAi,
        speed: g.rallySpeed,
        hits: g.rallyHits,
        longest: g.longestRally,
        spin: g.spin ? { ...g.spin } : null,
        arc: g.arc ? { ...g.arc } : null,
        serveAt: g.serveAt,
        freeze: g.freeze,
      });
    const onHit = g.onPaddleHit.bind(g),
      onPoint = g.onPoint.bind(g);
    g.onPaddleHit = (side) => {
      onHit(side);
      coverage[mode === "solo" ? "soloContacts" : "hostContacts"]++;
      if (g.spin) coverage.curves++;
    };
    g.onPoint = (side) => {
      onPoint(side);
      coverage.points++;
    };
    for (let frame = 0; frame < 2400; frame++) {
      f.clock.ms += 1000 / 60;
      const target = frame % 480 < 250 ? g.ballPos.x : Math.sin(frame * 0.025) * 3.2;
      g.handleHandPosition(
        1 - (Math.max(-PADDLE_X_MAX, Math.min(PADDLE_X_MAX, target)) + PADDLE_X_MAX) / HAND_RANGE,
      );
      if (mode === "host") g.net.other.state.paddle = Math.sin(frame * 0.04) * 3;
      if (g.phase === "won") {
        coverage.wonFrames++;
        if (frame % 30 === 0) g.confirm();
      }
      g.update(1 / 60);
      snapshot();
    }
    // Stage contact zones; updateBall still decides actual collision admission.
    for (const side of ["player", "ai"]) {
      for (const direction of [0, -1, 1]) {
        g.phase = "rally";
        g.freeze = 0;
        g.playerX = 0;
        g.aiX = 0;
        g.ballPos.set(
          direction * HIT_HALF_X * 0.8,
          side === "player" ? -PADDLE_Y + 0.02 : PADDLE_Y - 0.02,
        );
        g.ballVel.set(0, side === "player" ? -6 : 6);
        g.updateBall(1 / 120);
        snapshot();
      }
    }
    for (const direction of [-1, 1]) {
      g.phase = "rally";
      g.ballPos.set(4, direction * (GOAL_Y + 0.1));
      g.ballVel.set(0, direction * 6);
      g.updateBall(1 / 60);
      snapshot();
    }
    g.phase = "rally";
    g.scoreYou = 6;
    g.scoreAi = 5;
    g.ballPos.set(4, GOAL_Y + 0.1);
    g.ballVel.set(0, 6);
    g.updateBall(1 / 60);
    assert.equal(g.phase, "won");
    coverage.wonFrames++;
    snapshot();
    g.update(0.5);
    assert.equal(g.phase, "won");
    coverage.wonFrames++;
    snapshot();
    g.confirm();
    assert.equal(g.phase, "rally");
    snapshot();
    coverage.walls += f.sounds.filter(([name]) => name === "wall").length;
    // Baseline has no final owner; the harness never creates browser resources.
    g.dispose?.();
  }
  return {
    coverage,
    frames: trace.length,
    sha256: createHash("sha256").update(JSON.stringify(trace)).digest("hex"),
  };
}
test("seeded solo and host play covers contacts, slices, walls, points and rematches deterministically", () => {
  const result = simulationTrace();
  assert.deepEqual(result, simulationTrace());
  assert.equal(result.frames, 4822);
  for (const [key, value] of Object.entries(result.coverage)) assert.ok(value > 0, key);
});

// Only the removed motion sampler is inert in this original-code comparison.
// Centered neutral returns must retain the original ball/ramp/score/clock trace.
class StationaryStroke {
  sample() {}
  read() {
    return 0;
  }
  reset() {}
}
function neutralTrace(path) {
  const f = sceneFixture(path, { PaddleStroke: StationaryStroke }),
    g = f.game;
  const trace = [];
  const snapshot = () =>
    trace.push({
      ball: g.ballPos.toArray(),
      velocity: g.ballVel.toArray(),
      paddle: g.myPaddle,
      phase: g.phase,
      score: [g.scoreYou, g.scoreAi],
      speed: g.rallySpeed,
      hits: g.rallyHits,
      longest: g.longestRally,
      arc: g.arc ? { ...g.arc } : null,
      freeze: g.freeze,
      serveAt: g.serveAt,
    });
  g.seed(7123);
  g.playSolo();
  g.confirm();
  snapshot();
  for (const hand of [0.5, 0.2, 0.9, 1, 0, 0.51]) {
    g.handleHandPosition(hand);
    g.applyPaddleInput(1 / 60);
    snapshot();
  }
  for (let i = 0; i < 20; i++) {
    const side = i % 2 ? "ai" : "player";
    g.playerX = 0;
    g.aiX = 0;
    g.phase = "rally";
    g.ballPos.set(0, side === "player" ? -PADDLE_Y + 0.02 : PADDLE_Y - 0.02);
    g.ballVel.set(0, side === "player" ? -6 : 6);
    g.updateBall(1 / 120);
    snapshot();
  }
  for (let i = 0; i < 7; i++) {
    g.phase = "rally";
    g.ballPos.set(4, GOAL_Y + 0.1);
    g.ballVel.set(0, 6);
    g.updateBall(1 / 60);
    snapshot();
    if (i < 6) {
      g.update(0.4);
      snapshot();
      g.update(0.72);
      snapshot();
    }
  }
  assert.equal(g.phase, "won");
  g.update(1);
  snapshot();
  g.confirm();
  snapshot();
  g.dispose?.();
  return trace;
}
test("centered ordinary returns retain original hand mapping, ramp, RNG, score, point timing and rematch", () => {
  const baselinePath = "./fixtures/simulation-baseline.txt";
  const manifest = JSON.parse(
    readFileSync(new URL("./fixtures/simulation-baseline.json", import.meta.url), "utf8"),
  );
  assert.equal(hashFile(baselinePath), manifest.oracleSha256);
  assert.equal(
    hashFile("../src/shared/constants.ts"),
    manifest.dependencies["src/shared/constants.ts"],
  );
  assert.deepEqual(neutralTrace(), neutralTrace(baselinePath));
});
