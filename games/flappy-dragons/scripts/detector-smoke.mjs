import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cameraFixture } from "./camera-harness.mjs";

// Math.sin is implementation-dependent at the last bit. Replay the original
// camera samples instead of regenerating subtly different inputs per CPU.
// No detector state, callback strength, action frame or timing is rounded.
const { samples } = JSON.parse(
  readFileSync(new URL("./fixtures/detector-inputs.json", import.meta.url), "utf8"),
);
assert.equal(samples.length, 1200);
for (const sample of samples) {
  assert.equal(sample.length, 2);
  assert.ok(sample.every(Number.isFinite));
}

export function detectorTrace(sourcePath) {
  const f = cameraFixture(sourcePath),
    camera = f.detector(),
    rows = [];
  camera.beginWarmup();
  for (let frame = 0; frame < 1200; frame++) {
    f.clock.now += 1000 / 30;
    if (frame % 300 === 0 && frame > 0) camera.recalibrate();
    camera.setLocked(frame % 300 >= 60 && frame % 300 < 260);
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    const phase = frame % 300;
    const [noseY, wrist] = samples[frame];
    landmarks[0].y = noseY / 480;
    landmarks[0].visibility = phase >= 265 && phase < 275 ? 0.2 : 1;
    landmarks[11].x = 0.3;
    landmarks[12].x = 0.7;
    landmarks[15].y = wrist;
    landmarks[16].y = wrist;
    if (phase >= 275 && phase < 290) landmarks[15].visibility = 0.2;
    if (phase >= 280 && phase < 295) landmarks[12].x = 0.32;
    if (landmarks[0].visibility > 0.3) {
      camera.yPositions.unshift(noseY);
      if (camera.yPositions.length > 5) camera.yPositions.pop();
      camera.processSample();
    }
    camera.processArmFlap(landmarks);
    rows.push({
      state: camera.state,
      baseline: camera.baselineY,
      min: camera.minY,
      locked: camera.locked,
      warmup: camera.warmupSamples,
      ys: [...camera.yPositions],
      wrists: [...camera.wristYs],
      armed: camera.flapArmed,
      top: camera.strokeTopY,
      bottom: camera.strokeBottomY,
      jumps: f.jumps.map((jump) => [...jump]),
    });
  }
  const result = {
    frames: rows.length,
    initial: f.jumps.filter(([, refire]) => !refire).length,
    refires: f.jumps.filter(([, refire]) => refire).length,
    states: [...new Set(rows.map((row) => row.state))],
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
  camera.dispose?.();
  return result;
}
test("baseline detector trace preserves warmup, smoothing, jump/refire/landing/stuck reset, arm rearm and visibility", () => {
  const result = detectorTrace();
  assert.equal(result.frames, 1200);
  assert.equal(result.initial, 28);
  assert.equal(result.refires, 137);
  assert.deepEqual(result.states, ["warming", "detecting", "jumping"]);
  assert.equal(result.sha256, "3728aa5f03ab2e548821fa0254e2db85645b31cd242e6ff8eead0df98e61d171");
});
