import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraFixture, connect, deferred, model, settle, stream } from "./camera-harness.mjs";

test("touch remains gesture-started; denial/retry owns one live stream/model/drawer/RAF", async () => {
  const f = cameraFixture(),
    camera = f.init();
  assert.equal(f.media.length, 0);
  camera.ui.screen.click();
  assert.equal(f.media.length, 1);
  f.media[0].reject(new Error("permission denied"));
  await settle();
  assert.equal(camera.state, "idle");
  assert.match(camera.ui.status.textContent, /permission denied/);
  camera.ui.screen.click();
  const { feed, tracker } = await connect(f);
  assert.equal(camera.state, "warming");
  assert.equal(f.frames.size, 1);
  assert.deepEqual(f.media[1].options, { video: { facingMode: "user" }, audio: false });
  assert.equal(f.models[0].options.baseOptions.delegate, "GPU");
  const staleFrame = [...f.frames.values()][0],
    observer = f.observers[0];
  f.api.disposePoseCamera();
  f.api.disposePoseCamera();
  staleFrame();
  observer.callback();
  assert.equal(feed.track.stopped, 1);
  assert.equal(tracker.closed, 1);
  assert.equal(f.drawers[0].closed, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(observer.disconnected, 1);
  assert.equal(camera.ui.video.srcObject, null);
  assert.equal(camera.ui.root.parent, null);
  assert.equal(camera.ui.screen.listenerCount, 0);
  assert.equal(camera.ui.button.listenerCount, 0);
  assert.equal(f.document.documentElement.styleValues.has("--fd-cam-h"), false);
});
test("late media success/rejection after disposal cannot change the removed panel or create a model", async () => {
  for (const succeeds of [false, true]) {
    const f = cameraFixture(),
      camera = f.init();
    camera.ui.screen.click();
    const status = camera.ui.status.textContent;
    f.api.disposePoseCamera();
    const feed = stream();
    if (succeeds) f.media[0].resolve(feed);
    else f.media[0].reject(new Error("late denial"));
    await settle();
    assert.equal(feed.track.stopped, succeeds ? 1 : 0);
    assert.equal(f.vision.length, 0);
    assert.equal(camera.ui.status.textContent, status);
    assert.equal(f.frames.size, 0);
    camera.ui.screen.click();
    assert.equal(f.media.length, 1);
  }
});
test("desktop still auto-starts; a missing overlay context releases the stream before model startup", async () => {
  const f = cameraFixture(undefined, false),
    camera = f.init(),
    feed = stream();
  assert.equal(f.media.length, 1);
  camera.ui.overlay.context = null;
  f.media[0].resolve(feed);
  await settle();
  camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
  await settle();
  assert.equal(camera.state, "idle");
  assert.equal(feed.track.stopped, 1);
  assert.equal(f.vision.length, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(camera.ui.video.listenerCount, 0);
  f.api.disposePoseCamera();
});
test("late model or fileset resolves only into its attempt and cannot revive a disposed camera", async () => {
  for (const waitingForModel of [false, true]) {
    const f = cameraFixture(),
      camera = f.init(),
      feed = stream();
    camera.start();
    f.media[0].resolve(feed);
    await settle();
    camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
    if (waitingForModel) {
      f.vision[0].resolve({});
      await settle();
    }
    f.api.disposePoseCamera();
    const tracker = model();
    if (waitingForModel) f.models[0].resolve(tracker);
    else f.vision[0].resolve({});
    await settle();
    assert.equal(tracker.closed, waitingForModel ? 1 : 0);
    assert.equal(f.models.length, waitingForModel ? 1 : 0);
    assert.equal(feed.track.stopped, 1);
    assert.equal(f.drawers[0].closed, 1);
    assert.equal(f.frames.size, 0);
  }
});
test("play rejection and model failure release partial capture immediately and permit fresh retries", async () => {
  for (const playFails of [true, false]) {
    const f = cameraFixture(),
      camera = f.init(),
      feed = stream();
    const play = deferred();
    camera.ui.video.playResult = play.promise;
    camera.start();
    f.media[0].resolve(feed);
    await settle();
    camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
    if (playFails) play.reject(new Error("play failed"));
    else {
      play.resolve();
      f.vision[0].reject(new Error("model failed"));
    }
    await settle();
    assert.equal(camera.state, "idle");
    assert.equal(feed.track.stopped, 1);
    assert.equal(f.drawers[0].closed, 1);
    assert.equal(camera.ui.video.srcObject, null);
    const oldStatus = camera.ui.status.textContent;
    if (playFails) {
      f.vision[0].resolve({});
      await settle();
    }
    assert.equal(camera.ui.status.textContent, oldStatus);
    camera.ui.video.playResult = null;
    camera.start();
    const fresh = await connect(f);
    assert.equal(camera.state, "warming");
    assert.equal(f.frames.size, 1);
    f.api.disposePoseCamera();
    assert.equal(fresh.feed.track.stopped, 1);
  }
});
test("RAF cadence processes only new video frames with increasing timestamps; stale callbacks cannot erase a new owner", async () => {
  const f = cameraFixture(),
    camera = f.init();
  camera.start();
  const { tracker } = await connect(f);
  assert.equal(tracker.calls.length, 1);
  f.frame();
  assert.equal(tracker.calls.length, 1);
  camera.ui.video.currentTime += 0.033;
  f.frame();
  assert.equal(tracker.calls.length, 2);
  assert.ok(tracker.calls[1][1] > tracker.calls[0][1]);
  const stale = [...f.frames.values()][0];
  camera.failStart(camera.attempt, "fixture retry");
  camera.start();
  await connect(f);
  const newRaf = camera.raf;
  stale();
  assert.equal(camera.raf, newRaf);
  assert.equal(f.frames.size, 1);
  f.api.disposePoseCamera();
  assert.equal(f.frames.size, 0);
  const freshCamera = f.init();
  assert.notEqual(freshCamera, camera);
  assert.equal(f.media.length, 2, "fresh touch init still waits for a gesture");
  f.api.disposePoseCamera();
});

function warm(f, camera, tracker) {
  tracker.result = {
    landmarks: [Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))],
  };
  for (let i = 0; i < 20; i++) {
    camera.ui.video.currentTime += 0.033;
    f.clock.now += 33;
    f.frame();
  }
  assert.equal(camera.state, "detecting");
}

for (const terminal of ["ended", "error", "inference"]) {
  test(`${terminal} releases a warmed attempt; native retry owns fresh media and ignores stale callbacks`, async () => {
    const f = cameraFixture(),
      camera = f.init();
    camera.ui.screen.click();
    const { feed, tracker } = await connect(f);
    warm(f, camera, tracker);
    const ended = [...(feed.track.listenerRecords.get("ended") ?? [])];
    const errors = [...(camera.ui.video.listenerRecords.get("error") ?? [])];
    const staleFrame = [...f.frames.values()][0];
    if (terminal === "ended") feed.track.dispatchEvent(new Event("ended"));
    else if (terminal === "error") {
      camera.ui.video.error = { code: 3, message: "decoder failure" };
      camera.ui.video.dispatchEvent(new Event("error"));
    } else {
      tracker.detectForVideo = () => {
        throw new Error("inference backend unavailable");
      };
      camera.ui.video.currentTime += 0.033;
      f.frame();
    }
    assert.equal(camera.state, "idle");
    assert.equal(ended.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(camera.ui.cap.textContent, "📷 RETRY");
    assert.equal(camera.ui.button.classList.contains("fd-cam__btn--off"), false);
    assert.equal(feed.track.stopped, 1);
    assert.equal(feed.track.listenersAtStop, 0);
    assert.equal(camera.ui.video.listenerCount, 0);
    assert.equal(camera.ui.video.srcObject, null);
    assert.equal(tracker.closed, 1);
    assert.equal(f.drawers[0].closed, 1);
    assert.equal(f.frames.size, 0);

    camera.ui.video.error = null;
    camera.ui.button.click();
    camera.ui.button.click();
    camera.start();
    assert.equal(f.media.length, 2);
    const fresh = await connect(f);
    warm(f, camera, fresh.tracker);
    const raf = camera.raf;
    for (const callback of [...ended, ...errors]) callback(new Event("error"));
    feed.track.dispatchEvent(new Event("ended"));
    camera.ui.video.dispatchEvent(new Event("error"));
    staleFrame();
    assert.equal(camera.state, "detecting");
    assert.equal(camera.raf, raf);
    assert.equal(f.frames.size, 1);
    assert.equal(fresh.feed.track.stopped, 0);
    assert.equal(fresh.tracker.closed, 0);
    assert.deepEqual(f.jumps, []);
    f.api.disposePoseCamera();
    f.api.disposePoseCamera();
    assert.equal(fresh.feed.track.stopped, 1);
    assert.equal(fresh.feed.track.listenersAtStop, 0);
    assert.equal(fresh.tracker.closed, 1);
    assert.equal(f.drawers[1].closed, 1);
    assert.equal(camera.ui.video.listenerCount, 0);
    assert.equal(f.frames.size, 0);
  });
}

test("ended media before metadata releases listeners; late old metadata/model cannot replace retry", async () => {
  const f = cameraFixture(),
    camera = f.init(),
    feed = stream();
  camera.start();
  f.media[0].resolve(feed);
  await settle();
  const metadata = [...camera.ui.video.listenerRecords.get("loadedmetadata")][0];
  feed.track.dispatchEvent(new Event("ended"));
  assert.equal(camera.state, "idle");
  assert.equal(camera.ui.video.listenerCount, 0);
  assert.equal(feed.track.listenersAtStop, 0);
  camera.ui.button.click();
  const fresh = await connect(f);
  metadata();
  assert.equal(f.models.length, 1);
  assert.equal(camera.landmarker, fresh.tracker);
  f.api.disposePoseCamera();
});

test("ended pending play/model cannot revive after a fresh attempt", async () => {
  const f = cameraFixture(),
    camera = f.init(),
    feed = stream(),
    play = deferred();
  camera.ui.video.playResult = play.promise;
  camera.start();
  f.media[0].resolve(feed);
  await settle();
  camera.ui.video.readyState = 4;
  camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
  f.vision[0].resolve({});
  await settle();
  const pending = f.models[0];
  feed.track.dispatchEvent(new Event("ended"));
  assert.equal(camera.state, "idle");
  camera.ui.video.playResult = null;
  camera.ui.button.click();
  const fresh = await connect(f);
  const old = model();
  pending.resolve(old);
  play.reject(new Error("late old play rejection"));
  await settle();
  assert.equal(old.closed, 1);
  assert.equal(camera.landmarker, fresh.tracker);
  assert.equal(camera.state, "warming");
  assert.equal(f.frames.size, 1);
  f.api.disposePoseCamera();
});

test("ordinary absent poses and stalled frames keep warm-up/live capture, with no retry or rebaseline", async () => {
  const f = cameraFixture(),
    camera = f.init();
  camera.start();
  const { feed, tracker } = await connect(f);
  const sampleCount = tracker.calls.length;
  f.clock.now += 5000;
  f.frame();
  assert.equal(tracker.calls.length, sampleCount);
  assert.equal(camera.state, "warming");
  warm(f, camera, tracker);
  const baseline = camera.baselineY;
  tracker.result = { landmarks: [] };
  for (let i = 0; i < 20; i++) {
    camera.ui.video.currentTime += 0.033;
    f.frame();
  }
  assert.equal(camera.state, "detecting");
  assert.equal(camera.baselineY, baseline);
  assert.equal(camera.ui.button.classList.contains("fd-cam__btn--off"), true);
  assert.equal(feed.track.stopped, 0);
  assert.equal(tracker.closed, 0);
  assert.equal(f.media.length, 1);
  f.api.disposePoseCamera();
});

test("already-ended admission fails before playback/model; first-frame recognizer failure is retryable", async () => {
  for (const ended of [true, false]) {
    const f = cameraFixture(),
      camera = f.init(),
      feed = stream();
    if (ended) feed.track.readyState = "ended";
    camera.start();
    f.media[0].resolve(feed);
    await settle();
    let tracker;
    if (!ended) {
      camera.ui.video.readyState = 4;
      camera.ui.video.dispatchEvent(new Event("loadedmetadata"));
      f.vision[0].resolve({});
      await settle();
      tracker = model();
      tracker.detectForVideo = () => {
        throw new Error("first inference unavailable");
      };
      f.models[0].resolve(tracker);
      await settle();
    } else {
      assert.equal(camera.ui.video.plays, 0);
      assert.equal(f.models.length, 0);
    }
    assert.equal(camera.state, "idle");
    assert.equal(camera.ui.button.classList.contains("fd-cam__btn--off"), false);
    assert.equal(camera.ui.video.listenerCount, 0);
    assert.equal(feed.track.stopped, 1);
    assert.equal(feed.track.listenersAtStop, 0);
    assert.equal(f.frames.size, 0);
    if (tracker) assert.equal(tracker.closed, 1);
    camera.ui.button.click();
    const fresh = await connect(f);
    assert.equal(f.media.length, 2);
    assert.equal(camera.state, "warming");
    assert.equal(camera.landmarker, fresh.tracker);
    f.api.disposePoseCamera();
  }
});
