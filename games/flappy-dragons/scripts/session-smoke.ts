import assert from "node:assert/strict";
import { poseStatus } from "../src/input/pose-status";

// A visible skeleton alone cannot claim readiness before the actual warmup.
assert.equal(poseStatus(true, 14, 15, true, true).label, "CENTER 14/15");
assert.equal(poseStatus(true, 0, 15, false, true).label, "FIND FACE");
console.log("✓ Warmup never advertises an armed input");

// Either input can remain usable when the other channel leaves the frame.
assert.equal(poseStatus(false, 15, 15, true, true).label, "POSE READY");
assert.equal(poseStatus(false, 15, 15, true, false).label, "JUMP READY");
assert.equal(poseStatus(false, 15, 15, false, true).label, "ARMS READY");
assert.equal(poseStatus(false, 15, 15, false, false).label, "FIND YOU");
console.log("✓ Readiness reflects both independent input channels, including tracking loss");
