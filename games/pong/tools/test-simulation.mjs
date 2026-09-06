import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sceneFixture } from "./scene-harness.mjs";
import { GOAL_Y, HAND_RANGE, PADDLE_X_MAX, PADDLE_Y } from "../src/shared/constants.ts";

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
    // Isolate real contact admission in both directions, including live remote
    // strokes. A prerequisite pose is staged; updateBall still decides collision.
    for (const side of ["player", "ai"]) {
      for (const direction of [0, -1, 1]) {
        g.phase = "rally";
        g.freeze = 0;
        g.playerX = 0;
        g.aiX = 0;
        g.resetStrokes();
        if (direction) {
          const now = f.clock.ms / 1000;
          for (let i = 0; i < 4; i++)
            g.stroke.sample(direction * i * 0.3, now - (3 - i) / 60, "hand");
          g.remoteStrokeIntent = direction;
          g.remoteStrokeUntil = now + 0.1;
        }
        g.ballPos.set(0.1, side === "player" ? -PADDLE_Y + 0.02 : PADDLE_Y - 0.02);
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
test("solo and host simulation retain the verified baseline across hand input, contacts, curves, walls, points and rematches", () => {
  const result = simulationTrace();
  assert.ok(result.coverage.soloContacts > 10);
  assert.ok(result.coverage.hostContacts > 10);
  assert.ok(result.coverage.curves >= 6);
  assert.ok(result.coverage.walls > 5);
  assert.ok(result.coverage.points > 10);
  assert.ok(result.coverage.wonFrames >= 4);
  assert.equal(result.frames, 4822);
  assert.equal(result.sha256, "b09c5c4b53c1bda54b84e1197102446172418b8541ca3dbbe701e5670130917b");
});
