import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { source } from "./checkpoint-harness.mjs";
const require = createRequire(import.meta.url),
  root = dirname(require.resolve("phaser/package.json"));
const EventEmitter = require(join(root, "src/events/EventEmitter.js"));
const Systems = require(join(root, "src/scene/Systems.js"));
const Events = require(join(root, "src/scene/events/index.js"));
const start = source.indexOf("    let cleaned = false;"),
  end = source.indexOf("\n  }", start);
assert.ok(start >= 0 && end > start);
const register = new Function(
  "Phaser",
  "params",
  "mountTouchHud",
  `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })};return cleanup;`,
);
for (const edge of ["shutdown", "destroy"])
  for (const trailer of [false, true]) {
    const counts = { physical: 0, virtual: 0, network: 0, mount: 0 };
    const events = new EventEmitter();
    const scene = {
      events,
      controls: { destroy: () => counts.physical++ },
      gamepad: { destroy: () => counts.virtual++ },
      session: { destroy: () => counts.network++ },
      runRecap: {},
      activeBanner: {},
      pendingObjective: {},
      adoptedTerminal: {},
      checkpointCache: { kind: "ready" },
      checkpointRef: {},
      checkpointRoomRef: {},
    };
    const sys = new Systems(scene, { key: "game" });
    sys.events = events;
    // Installed Systems owns lifecycle event semantics. External cleanup must work
    // for both ordinary scene shutdown and final scene destruction, exactly once.
    const cleanup = register.call(
      scene,
      { Scenes: { Events } },
      new URLSearchParams(trailer ? "trailer=1" : ""),
      () => counts.mount++,
    );
    if (edge === "shutdown") sys.shutdown();
    else sys.destroy();
    cleanup(true);
    cleanup(false);
    assert.deepEqual(counts, {
      physical: 1,
      virtual: 1,
      network: 1,
      mount: edge === "shutdown" && !trailer ? 1 : 0,
    });
    assert.equal(scene.runRecap, null);
    assert.equal(scene.adoptedTerminal, null);
    assert.deepEqual(scene.checkpointCache, { kind: "absent" });
    assert.equal(events.listenerCount(Events.SHUTDOWN), 0);
    assert.equal(events.listenerCount(Events.DESTROY), 0);
  }
console.log(
  "PASS 4 installed Phaser shutdown/destroy cleanup groups; final destroy never remounts touch ownership",
);
