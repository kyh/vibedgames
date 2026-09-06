import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { AUTO_SERVE_S } from "../src/shared/constants.ts";
import { compile, sceneFixture } from "./scene-harness.mjs";
import * as constants from "../src/shared/constants.ts";

function admitGuest(f) {
  Object.assign(f.game.net, { live: true, offline: false, isHost: false });
  f.game.admitRole();
}
test("admitted guest keeps canonical paddle, view, score and hand direction through a transport gap", () => {
  const f = sceneFixture(),
    g = f.game;
  admitGuest(f);
  g.playerX = 2;
  g.aiX = -3;
  g.scoreYou = 4;
  g.scoreAi = 6;
  g.updateVisuals(0);
  assert.equal(g.flip, -1);
  assert.equal(g.playerRing.position.x, 3);
  g.net.live = false;
  g.net.isHost = true; // cached role is not an election while disconnected.
  g.update(0.016);
  assert.equal(g.role, "guest");
  assert.equal(g.flip, -1);
  assert.equal(g.myPaddle, -3);
  assert.equal(g.playerRing.position.x, 3);
  assert.deepEqual([g.scoreYou, g.scoreAi], [4, 6]);
  g.handleHandPosition(0.2);
  g.applyPaddleInput(1 / 60);
  assert.equal(g.playerX, 2, "guest input cannot write the host's paddle during a gap");
  assert.ok(g.aiX > -3 && g.aiX < 0);
  g.net.live = true;
  g.net.isHost = false;
  g.admitRole();
  assert.equal(g.role, "guest");
  g.dispose();
});
test("only a connected election promotes B to A once; current point resets on the authored deadline", () => {
  const f = sceneFixture(),
    g = f.game;
  admitGuest(f);
  g.aiX = -2;
  g.playerX = 3;
  g.phase = "rally";
  g.elapsed = 70;
  g.ballPos.set(1, 4);
  g.ballVel.set(2, 8);
  g.scoreYou = 2;
  g.scoreAi = 5;
  g.longestRally = 12;
  g.rallyHits = 9;
  g.net.live = false;
  g.net.isHost = true;
  g.admitRole();
  assert.equal(g.phase, "rally");
  g.net.live = true;
  g.admitRole();
  assert.equal(g.role, "host");
  assert.equal(g.flip, 1);
  assert.deepEqual([g.playerX, g.aiX], [2, -3]);
  assert.deepEqual(g.ballPos.toArray(), [0, 0]);
  assert.equal(g.ballVel.length(), 0);
  assert.equal(g.phase, "serving");
  assert.equal(g.serveAt, 70 + AUTO_SERVE_S);
  assert.equal(AUTO_SERVE_S, 1.1);
  assert.deepEqual([g.scoreYou, g.scoreAi, g.longestRally], [2, 5, 12]);
  g.elapsed += 0.4;
  g.admitRole();
  assert.equal(g.serveAt, 70 + AUTO_SERVE_S);
  assert.equal(g.playerX, 2);
  g.dispose();
});
test("terminal promotion preserves personal result and cannot auto-rematch", () => {
  const f = sceneFixture(),
    g = f.game;
  admitGuest(f);
  g.phase = "won";
  g.scoreYou = 7;
  g.scoreAi = 6;
  g.serveAt = 999;
  g.net.isHost = true;
  g.admitRole();
  assert.equal(g.phase, "won");
  assert.equal(g.serveAt, null);
  assert.deepEqual([g.scoreYou, g.scoreAi], [7, 6]);
  g.update(3);
  assert.equal(g.phase, "won");
  g.confirm();
  assert.equal(g.phase, "rally");
  assert.deepEqual([g.scoreYou, g.scoreAi], [0, 0]);
  g.dispose();
});
test("first accepted role precedes local confirm and event handling; explicit replacement seals old callbacks", () => {
  const f = sceneFixture(),
    g = f.game,
    old = g.net;
  Object.assign(old, { live: true, isHost: false, other: { id: "a" } });
  g.confirm();
  assert.equal(g.role, "guest");
  assert.equal(g.phase, "serving");
  assert.deepEqual(old.events, [["confirm", {}]]);
  g.replaceSession(true);
  assert.equal(old.destroyed, 1);
  assert.equal(g.role, "solo");
  assert.equal(g.flip, 1);
  assert.equal(g.net.options.forceOffline, true);
  old.options.onEvent("phit", { a: false, spin: -1 }, "a");
  assert.equal(f.sounds.length, 0, "old connection cannot deliver FX into a replacement session");
  const solo = g.net;
  g.hostSeq = 88;
  g.lastSeq = 77;
  g.connectedBefore = true;
  g.replaceSession(false);
  assert.equal(solo.destroyed, 1);
  assert.equal(g.role, "pending");
  assert.equal(g.net.options.forceOffline, false);
  assert.deepEqual([g.hostSeq, g.lastSeq, g.connectedBefore], [0, -1, false]);
  g.dispose();
});
test("actual scene construction/disposal releases every unique Three owner and external listener once", () => {
  const resources = new Map(),
    originals = [];
  for (const Type of [THREE.BufferGeometry, THREE.Material, THREE.Texture, THREE.InstancedMesh]) {
    const original = Type.prototype.dispose;
    originals.push(() => {
      Type.prototype.dispose = original;
    });
    Type.prototype.dispose = function () {
      resources.set(this, (resources.get(this) ?? 0) + 1);
      original.call(this);
    };
  }
  try {
    const f = sceneFixture(),
      g = f.game,
      expected = new Set();
    assert.equal(resources.size, 1, "EdgesGeometry source plane must dispose at construction");
    for (const node of g.scene.children) {
      if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments)) continue;
      expected.add(node.geometry);
      if (node instanceof THREE.InstancedMesh) expected.add(node);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        expected.add(material);
        if (material.map) expected.add(material.map);
      }
    }
    assert.equal(f.window.listenerCount, 5);
    assert.equal(f.media.listenerCount, 1);
    assert.equal(f.watchers.size, 2);
    const oldEvent = g.net.options.onEvent,
      staleWatcher = [...f.watchers][0];
    const frame = g.frame;
    g.dispose();
    g.dispose();
    for (const resource of expected) assert.equal(resources.get(resource), 1);
    assert.equal(resources.size, expected.size + 1);
    assert.equal(g.scene.children.length, 0);
    assert.equal(g.net.destroyed, 1);
    assert.equal(f.window.listenerCount, 0);
    assert.equal(f.media.listenerCount, 0);
    assert.equal(f.watchers.size, 0);
    assert.ok([...f.elements.values()].every((element) => element.listenerCount === 0));
    staleWatcher();
    oldEvent("serve", {}, "a");
    g.update(1);
    g.handleHandPosition(0.4);
    g.handleGestureConfirm();
    g.setTestState("active-play");
    g.replaceSession(false);
    assert.equal(g.frame, frame);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.watchers.size, 0);
    assert.equal(f.sounds.length, 0);
  } finally {
    for (const restore of originals) restore();
  }
});
test("actual dither target, Bayer texture, material and quad geometry dispose once and reject late renders", () => {
  const deps = { THREE, ...constants };
  const DitherPass = new Function(
    ...Object.keys(deps),
    `${compile("../src/render/dither-pass.ts")};return DitherPass;`,
  )(...Object.values(deps));
  const pass = new DitherPass(1280, 800),
    counts = new Map();
  for (const resource of [pass.target, pass.bayer, pass.geometry, pass.material])
    resource.addEventListener("dispose", () =>
      counts.set(resource, (counts.get(resource) ?? 0) + 1),
    );
  let renders = 0;
  const renderer = {
    setRenderTarget() {},
    render() {
      renders++;
    },
  };
  pass.render(renderer, new THREE.Scene(), new THREE.Camera());
  assert.equal(renders, 2);
  pass.dispose();
  pass.dispose();
  for (const resource of [pass.target, pass.bayer, pass.geometry, pass.material])
    assert.equal(counts.get(resource), 1);
  pass.render(renderer, new THREE.Scene(), new THREE.Camera());
  pass.setSize(50, 80);
  pass.setInverted(true);
  assert.equal(renders, 2);
  assert.equal(pass.quadScene.children.length, 0);
});
