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
  body: new Node(),
  createElement: () => new Node(),
  getElementById: () => null,
  head: new Node(),
};
const callbacks = new Map();
let serial = 0;
globalThis.requestAnimationFrame = (callback) => {
  callbacks.set(++serial, callback);
  return serial;
};
globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
const { createPauseShell } = await import("../src/pause-shell.ts");
const { setPauseHandlers, notifyGameStarted, pauseGame, resumeGame, isPausable } =
  await import("../src/game.ts");
let modal = false;
let resumes = 0;
const shell = createPauseShell({ fadeMs: 0, modalOpen: () => modal, render() {} });
setPauseHandlers({
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
    code: { value: code },
    key: { value: code === "Escape" ? "Escape" : code.slice(3).toLowerCase() },
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

// canResume holds a pause the game cannot leave yet (tetris: lost graphics).
let available = false;
let guardedResumes = 0;
function keyBlocked(type) {
  const event = new Event(type);
  let blocked = false;
  event.stopPropagation = () => {
    blocked = true;
  };
  win.dispatchEvent(event);
  return blocked;
}
setPauseHandlers({ canResume: () => available, onResume: () => guardedResumes++ });
notifyGameStarted();
pauseGame();
resumeGame();
key("keydown", "Escape");
key("keyup", "Escape");
assert.equal(guardedResumes, 0, "unavailable game cannot resume through API or Escape");
assert.equal(isPausable(), false);
assert.equal(keyBlocked("keydown"), true, "keys stay gated through a denied resume");
available = true;
resumeGame();
assert.equal(guardedResumes, 1);
assert.equal(isPausable(), true);
assert.equal(keyBlocked("keyup"), false);

pauseGame();
let newResumes = 0;
setPauseHandlers({ onResume: () => newResumes++ });
resumeGame();
assert.equal(newResumes, 1, "a replacement owner resumes by default");
assert.equal(isPausable(), true);
console.log("PASS held-key/fresh-key/modal/Escape ownership; canResume gates resume and keys");
