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
const win = new EventTarget();
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
const { setPauseHandlers, notifyGameStarted, pauseGame, isPausable } =
  await import("../src/game.ts");
let modal = false,
  resumes = 0;
const shell = createPauseShell({ render() {}, fadeMs: 0, modalOpen: () => modal });
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
    key: { value: code === "Escape" ? "Escape" : code.slice(3).toLowerCase() },
    code: { value: code },
    repeat: { value: repeat },
  });
  win.dispatchEvent(event);
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
console.log(
  "PASS held-key release and repeats stay paused; fresh key release resumes once; modal, Escape and repeated lifecycle preserve ownership",
);
