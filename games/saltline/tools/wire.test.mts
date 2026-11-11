// Wire narrowing, room ids and callsigns: the pure edges of the co-op layer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ROOM_PREFIX, q3, roomId } from "../src/net/protocol.ts";
import { callsignOf } from "../src/net/squad.ts";
import { isRecord, nums, strs, vecAt, vecWire } from "../src/net/wire.ts";

test("nums accepts only arrays of finite numbers, at least min long", () => {
  assert.deepEqual(nums([1, 2.5, -3], 3), [1, 2.5, -3]);
  assert.equal(nums([1, 2], 3), null);
  assert.equal(nums([1, "2", 3]), null);
  assert.equal(nums({ 0: 1 }), null);
  assert.equal(nums(null), null);
});

test("strs keeps only strings; isRecord rejects arrays and null", () => {
  assert.deepEqual(strs(["a", 1, "b", null]), ["a", "b"]);
  assert.deepEqual(strs("a"), []);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([1]), false);
  assert.equal(isRecord(null), false);
});

test("vectors round-trip through the wire at millimetre precision", () => {
  const v = vecAt([0, 1.23456, -7.0004, 3.9999], 1);
  assert.deepEqual(vecWire(v), [1.235, -7, 4]);
  assert.deepEqual(vecWire(null), [0, 0, 0]);
  assert.equal(q3(1.23449), 1.234);
});

test("room codes normalise into one prefixed room id", () => {
  assert.equal(roomId("Dock-7!"), `${ROOM_PREFIX}dock7`);
  assert.equal(roomId("dock7"), roomId("DOCK 7"));
  assert.equal(roomId("x".repeat(40)).length, ROOM_PREFIX.length + 16);
});

test("callsigns are stable two-digit B4 tags", () => {
  assert.equal(callsignOf("abc123"), callsignOf("abc123"));
  assert.match(callsignOf("abc123"), /^B4-\d{2}$/u);
  const tags = new Set(["p1", "p2", "p3", "p4", "p5", "p6"].map(callsignOf));
  assert.ok(tags.size >= 5, "six ids rarely share a callsign");
});
