import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  settings: { device: { prefersReducedMotion: "reduce" } },
});

after(async () => {
  await GlobalRegistrator.unregister();
});

const frames = mock.method(window, "requestAnimationFrame");
const cancels = mock.method(window, "cancelAnimationFrame");

const lastFrameCancelled = () =>
  cancels.mock.calls.at(-1)?.arguments[0] === frames.mock.calls.at(-1)?.result;

const { createPauseShell } = await import("./pause-shell");

const { isPausable, notifyGameStarted, pauseGame, resumeGame, setPauseHandlers } =
  await import("./game");

const render = (root: HTMLElement) => {
  root.append(document.createElement("p"));
};

const key = (type: "keydown" | "keyup", code: string, repeat = false) => {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      cancelable: true,
      code,
      key: code === "Escape" ? "Escape" : code.slice(3).toLowerCase(),
      repeat,
    }),
  );
};

const keyBlocked = (type: "keydown" | "keyup") => {
  let reached = false;

  const listener = () => {
    reached = true;
  };

  document.body.addEventListener(type, listener);
  document.body.dispatchEvent(new KeyboardEvent(type, { bubbles: true }));
  document.body.removeEventListener(type, listener);

  return !reached;
};

test("a pause is owned by the key that made it, a modal and Escape", () => {
  let modal = false;
  let resumes = 0;
  const shell = createPauseShell({ fadeMs: 0, modalOpen: () => modal, render });

  setPauseHandlers({
    onPause: shell.show,
    onResume: () => {
      resumes += 1;
      shell.hide();
    },
  });

  notifyGameStarted();

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

  for (const cycle of [1, 2, 3]) {
    pauseGame();
    shell.show();
    key("keyup", "KeyJ");
    assert.equal(isPausable(), false, `${cycle}: prior pause key cannot carry into the next pause`);
    modal = true;
    key("keydown", "KeyI");
    modal = false;
    key("keyup", "KeyI");
    assert.equal(isPausable(), false, `${cycle}: modal-owned key cannot resume after modal closes`);
    key("keydown", "KeyK");
    modal = true;
    key("keyup", "KeyK");
    modal = false;
    assert.equal(isPausable(), false);
    key("keyup", "KeyK");
    assert.equal(isPausable(), false, `${cycle}: release consumed inside modal stays consumed`);
    key("keydown", "Escape");
    key("keyup", "Escape");
    assert.equal(isPausable(), true, `${cycle}: Escape remains one toggle`);
    assert.ok(lastFrameCancelled(), `${cycle}: hide releases pad polling`);
  }

  shell.hide();
  assert.equal(resumes, 4);
});

test("canResume gates resuming and keeps the keys gated", () => {
  let available = false;
  let guardedResumes = 0;

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
});

test("the sound toggle answers M and a tap without resuming", () => {
  let muted = true;
  let soundResumes = 0;

  const soundShell = createPauseShell({
    fadeMs: 0,
    mute: {
      get: () => muted,
      set: (next) => {
        muted = next;
      },
    },
    render,
  });

  setPauseHandlers({
    onPause: soundShell.show,
    onResume: () => {
      soundResumes += 1;
      soundShell.hide();
    },
  });

  pauseGame();

  const toggle = document.querySelector<HTMLButtonElement>(".vg-pause-sound");

  assert.equal(toggle?.textContent, "sound off", "toggle reflects the accessor on show");

  key("keydown", "KeyM");
  key("keyup", "KeyM");
  assert.equal(muted, false, "M while paused toggles sound");
  assert.equal(toggle.textContent, "sound on", "toggle redraws after M");
  assert.equal(isPausable(), false, "M does not resume");
  assert.equal(soundResumes, 0);

  toggle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  assert.equal(muted, true, "tapping the toggle flips sound");
  assert.equal(isPausable(), false, "tapping the toggle does not resume");

  key("keydown", "KeyJ");
  key("keyup", "KeyJ");
  assert.equal(soundResumes, 1, "other keys still resume");
});
