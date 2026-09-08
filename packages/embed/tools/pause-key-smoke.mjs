// Actual shared shell + game state machine. EventTarget supplies native event
// dispatch; only DOM drawing and the frame scheduler are inert fixtures.
import assert from "node:assert/strict";
class Node extends EventTarget {
  style = { setProperty() {} };
  children = [];
  setAttribute() {}
  append(...children) {
    this.children.push(...children);
  }
  remove() {}
  closest() {
    return null;
  }
}
class WindowTarget extends EventTarget {
  removeEventListener(type, listener, options) {
    // Node ignores a boolean capture flag on removal; browsers accept both forms.
    super.removeEventListener(
      type,
      listener,
      options === true || options === false ? { capture: options } : options,
    );
  }
}
const win = new WindowTarget();
win.parent = win;
win.matchMedia = () => ({ matches: true });
globalThis.window = win;
globalThis.HTMLElement = Node;
globalThis.Element = Node;
globalThis.document = {
  createElement: () => new Node(),
  body: new Node(),
  head: new Node(),
  getElementById: () => null,
};
const callbacks = new Map();
let serial = 0;
globalThis.requestAnimationFrame = (callback) => {
  callbacks.set(++serial, callback);
  return serial;
};
globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
const { createPauseShell } = await import("../src/pause-shell.ts");
const { setPauseHandlers, notifyGameStarted, pauseGame, resumeGame, isPausable, watchPausable } =
  await import("../src/game.ts");
let modal = false,
  resumes = 0;
const shell = createPauseShell({ render() {}, fadeMs: 0, modalOpen: () => modal });
const releaseShell = setPauseHandlers({
  onPause: shell.show,
  onResume: () => {
    resumes++;
    shell.hide();
  },
});
notifyGameStarted();
function key(type, code, repeat = false) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    key: { value: code === "Escape" ? "Escape" : code.slice(3).toLowerCase() },
    code: { value: code },
    repeat: { value: repeat },
  });
  win.dispatchEvent(event);
  return event;
}
key("keydown", "KeyD");
key("keydown", "Escape");
key("keyup", "Escape");
assert.equal(isPausable(), false);
key("keydown", "KeyD", true);
key("keyup", "KeyD");
assert.equal(isPausable(), false, "releasing movement held before pause cannot dismiss it");
assert.equal(resumes, 0);
key("keydown", "KeyJ");
assert.equal(isPausable(), false, "fresh keydown stays gated");
key("keyup", "KeyJ");
assert.equal(isPausable(), true);
assert.equal(resumes, 1);
for (let cycle = 0; cycle < 3; cycle++) {
  pauseGame();
  shell.show();
  key("keyup", "KeyJ");
  assert.equal(isPausable(), false, "prior pause key cannot carry into the next pause");
  modal = true;
  key("keydown", "KeyI");
  modal = false;
  key("keyup", "KeyI");
  assert.equal(isPausable(), false, "modal-owned key cannot resume after modal closes");
  key("keydown", "KeyK");
  modal = true;
  key("keyup", "KeyK");
  modal = false;
  assert.equal(isPausable(), false);
  key("keyup", "KeyK");
  assert.equal(isPausable(), false, "release consumed inside modal stays consumed");
  key("keydown", "Escape");
  key("keyup", "Escape");
  assert.equal(isPausable(), true, "Escape remains one toggle");
  assert.equal(callbacks.size, 0, "hide releases pad polling");
}
shell.hide();
assert.equal(resumes, 4);
releaseShell();

const messages = [];
win.parent = { postMessage: (message) => messages.push(message) };
const changes = [];
const unwatch = watchPausable(() => changes.push(isPausable()));
let pauses = 0;
const release = setPauseHandlers({
  onPause: () => pauses++,
  onResume: () => assert.fail("owner disposal must not resume a destroyed game"),
});
notifyGameStarted();
pauseGame();
function keyBlocked(type) {
  const event = new Event(type);
  let blocked = false;
  event.stopPropagation = () => {
    blocked = true;
  };
  win.dispatchEvent(event);
  return blocked;
}
assert.equal(keyBlocked("keydown"), true, "actual paused key gate is installed");
const beforeRelease = messages.length;
release();
release();
assert.equal(isPausable(), false);
assert.equal(keyBlocked("keydown"), false);
assert.equal(keyBlocked("keyup"), false, "next UI release is not swallowed");
assert.equal(messages.length, beforeRelease, "final teardown emits no phantom started message");
assert.deepEqual(changes, [true, false, false], "only the first disposal notifies observers");
key("keydown", "Escape");
pauseGame();
assert.equal(pauses, 1, "module listeners stay inert after final owner release");

const releaseStale = setPauseHandlers({ onPause: () => assert.fail("stale owner") });
let replacementPauses = 0;
const releaseReplacement = setPauseHandlers({ onPause: () => replacementPauses++ });
notifyGameStarted();
releaseStale();
assert.equal(isPausable(), true, "stale disposal leaves replacement owner active");
pauseGame();
assert.equal(replacementPauses, 1);
releaseStale();
assert.equal(keyBlocked("keyup"), true, "stale disposal cannot release replacement's pause");
releaseReplacement();
assert.equal(keyBlocked("keyup"), false);

for (const alreadyPaused of [false, true]) {
  let sameObjectPauses = 0;
  const sharedHandlers = { onPause: () => assert.fail("callback replaced after installation") };
  const releaseOlder = setPauseHandlers(sharedHandlers);
  const releaseLatest = setPauseHandlers(sharedHandlers);
  // Registration retains the supplied object's live callbacks; it must not clone it.
  sharedHandlers.onPause = () => sameObjectPauses++;
  notifyGameStarted();
  if (alreadyPaused) pauseGame();
  const beforeStaleRelease = messages.length;
  releaseOlder();
  assert.equal(
    isPausable(),
    !alreadyPaused,
    "same-object stale disposer preserves latest installation",
  );
  assert.equal(keyBlocked("keyup"), alreadyPaused);
  assert.equal(messages.length, beforeStaleRelease);
  if (!alreadyPaused) pauseGame();
  assert.equal(sameObjectPauses, 1, "latest installation retains passed-object callback semantics");
  releaseLatest();
  assert.equal(isPausable(), false);
  assert.equal(keyBlocked("keyup"), false);
  releaseOlder();
  releaseLatest();
}
let available = false,
  guardedResumes = 0;
const releaseGuarded = setPauseHandlers({
  canResume: () => available,
  onResume: () => guardedResumes++,
});
notifyGameStarted();
pauseGame();
const beforeDenied = { messages: messages.length, changes: changes.length };
resumeGame();
key("keydown", "Escape");
key("keyup", "Escape");
assert.equal(guardedResumes, 0, "unavailable game cannot resume through API or Escape");
assert.equal(isPausable(), false);
assert.equal(keyBlocked("keydown"), true);
assert.equal(keyBlocked("keyup"), true);
assert.equal(messages.length, beforeDenied.messages, "denied resume never announces start");
assert.equal(changes.length, beforeDenied.changes, "denied resume does not change pause state");
available = true;
resumeGame();
assert.equal(guardedResumes, 1);
assert.equal(isPausable(), true);
assert.equal(keyBlocked("keyup"), false);
available = false;
pauseGame();
let newResumes = 0;
const releaseUnguarded = setPauseHandlers({ onResume: () => newResumes++ });
releaseGuarded();
resumeGame();
assert.equal(newResumes, 1, "replacement owner keeps default resume permission");
assert.equal(guardedResumes, 1);
assert.equal(isPausable(), true);
releaseUnguarded();
unwatch();
console.log(
  "PASS held-key/fresh-key/modal/Escape ownership; final paused disposal releases keys without resume/message; stale disposal preserves distinct-object and same-object replacements; denied resume preserves state/keys/messages and replacement permission",
);
