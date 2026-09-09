// Actual shared shell + game state machine. EventTarget supplies native event
// dispatch; only DOM drawing and the frame scheduler are inert fixtures.
import assert from "node:assert/strict";

const inert = () => {
  /* inert fixture */
};
const noMatch = () => null;

class Node extends EventTarget {
  style = { setProperty: inert };
  children = [];
  setAttribute = inert;
  append(...children) {
    this.children.push(...children);
  }
  remove = inert;
  closest = noMatch;
}
const win = new EventTarget();
const removeWindowListener = win.removeEventListener.bind(win);
// Node ignores a boolean capture flag on removal; browsers accept both forms.
win.removeEventListener = (type, listener, options) =>
  removeWindowListener(
    type,
    listener,
    options === true || options === false ? { capture: options } : options,
  );
win.parent = win;
win.matchMedia = () => ({ matches: true });
globalThis.window = win;
globalThis.HTMLElement = Node;
globalThis.Element = Node;
globalThis.document = {
  body: Object.assign(new Node(), { classList: { add: inert } }),
  createElement: () => new Node(),
  getElementById: () => null,
  head: new Node(),
  querySelector: () => null,
};
const callbacks = new Map();
let serial = 0;
globalThis.requestAnimationFrame = (frame) => {
  serial += 1;
  callbacks.set(serial, frame);
  return serial;
};
globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
const { createPauseShell } = await import("../src/pause-shell.ts");
const { setPauseHandlers, notifyGameStarted, pauseGame, resumeGame, isPausable } =
  await import("../src/game.ts");
let modal = false;
let resumes = 0;
const shell = createPauseShell({ fadeMs: 0, modalOpen: () => modal, render: inert });
setPauseHandlers({
  onPause: shell.show,
  onResume: () => {
    resumes += 1;
    shell.hide();
  },
});
notifyGameStarted();
const key = (type, code, repeat = false) => {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: code === "Escape" ? "Escape" : code.slice(3).toLowerCase() },
    repeat: { value: repeat },
  });
  win.dispatchEvent(event);
  return event;
};
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
for (let cycle = 0; cycle < 3; cycle += 1) {
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
const keyBlocked = (type) => {
  const event = new Event(type);
  let blocked = false;
  event.stopPropagation = () => {
    blocked = true;
  };
  win.dispatchEvent(event);
  return blocked;
};
setPauseHandlers({
  canResume: () => available,
  onResume: () => {
    guardedResumes += 1;
  },
});
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
setPauseHandlers({
  onResume: () => {
    newResumes += 1;
  },
});
resumeGame();
assert.equal(newResumes, 1, "a replacement owner resumes by default");
assert.equal(isPausable(), true);

// The sound toggle lives on the pause screen: M flips it and never resumes.
let muted = true;
let soundResumes = 0;
const soundShell = createPauseShell({
  fadeMs: 0,
  mute: { get: () => muted, set: (next) => (muted = next) },
  render: inert,
});
setPauseHandlers({
  onPause: soundShell.show,
  onResume: () => {
    soundResumes += 1;
    soundShell.hide();
  },
});
pauseGame();
const toggle = document.body.children.at(-1)?.children.at(-1);
assert.equal(toggle?.textContent, "sound off", "toggle reflects the accessor on show");
key("keydown", "KeyM");
key("keyup", "KeyM");
assert.equal(muted, false, "M while paused toggles sound");
assert.equal(toggle?.textContent, "sound on", "toggle redraws after M");
assert.equal(isPausable(), false, "M does not resume");
assert.equal(soundResumes, 0);
const tap = new Event("pointerup", { bubbles: true });
Object.defineProperty(tap, "target", { value: toggle });
toggle?.dispatchEvent(tap);
assert.equal(muted, true, "tapping the toggle flips sound");
assert.equal(isPausable(), false, "tapping the toggle does not resume");
key("keydown", "KeyJ");
key("keyup", "KeyJ");
assert.equal(soundResumes, 1, "other keys still resume");
console.log(
  "PASS held-key/fresh-key/modal/Escape ownership; canResume gates resume and keys; sound toggle",
);
