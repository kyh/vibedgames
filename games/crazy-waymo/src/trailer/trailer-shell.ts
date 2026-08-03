// trailer-shell.ts — self-contained trailer-mode runner: 16:9 letterbox,
// dip-to-black cuts between staged scenes, and interstitial text cards.
//
// This copy DIVERGES from the shared shell (like session.ts, normally kept in
// sync): it adds `card` scenes — black frames carrying a line of display type.
// A trailer with no written beats has no premise; this game's premise ("a
// robotaxi with no driver") is the joke, and the joke needs three words on
// black to land. Game-specific staging lives in trailer-director.ts.
//
// Integration:
//   1. Copy this file to games/<game>/src/trailer/trailer-shell.ts unchanged.
//   2. In main.ts (or the boot path), if isTrailerMode(), boot the game into a
//      deterministic offline/solo state with menus skipped, then call
//      runTrailer(config) from a game-specific trailer-director.ts.
//   3. Each scene stages real gameplay via setup() (position entities, camera,
//      world state) and optionally choreographs per-frame via run(t, dt).
//
// Audio: the trailer rolls on its own, so no user gesture has happened when the
// first scene reveals and browsers keep the AudioContext suspended. Games that
// want sound should unlock it from config.onGesture, which fires on the first
// real click/keypress whenever that lands.
//
// URL params:
//   ?trailer=1     enter trailer mode
//   &loop=1        auto-replay shortly after the final cut
//   Esc            exits back to the normal game

export type TrailerScene = {
  /** Stable id, exposed on window.__trailer for tooling. */
  id: string;
  /** Milliseconds the scene plays (excludes cut time). */
  duration: number;
  /**
   * Extra ms of black held after setup() before the reveal. Default 0 — only
   * reach for it when staging genuinely needs the world to settle (physics
   * drop-in, an approach the scene should open mid-flight), never as a beat.
   */
  hold?: number;
  /** Stage the scene: entities, camera, world state. Runs while screen is black. */
  setup: () => void | Promise<void>;
  /** Per-frame choreography. t = ms since scene start, dt = ms since last frame. */
  run?: (t: number, dt: number) => void;
  /** Cleanup before the next scene stages. */
  teardown?: () => void;
  /**
   * Text card: the scene plays as display type over the black plate — the
   * plate never lifts, `run` is ignored. `duration` is the hold.
   */
  card?: { title: string; sub?: string };
};

export type TrailerConfig = {
  /** Dip-to-black duration between scenes. Default 120ms. */
  cutMs?: number;
  /** Black held before the first scene reveals, covering boot. Default 600ms. */
  leadInMs?: number;
  /** Subtle cinematic vignette inside the 16:9 stage. Default true. */
  vignette?: boolean;
  /**
   * Fires once on the first trusted user gesture (click or keypress), at
   * whatever point in the trailer it lands. Unlock/unmute audio here — the
   * trailer starts with no gesture, so an AudioContext created before this
   * stays suspended.
   */
  onGesture?: () => void;
  scenes: TrailerScene[];
};

export type TrailerState = {
  sceneId: string;
  sceneIndex: number;
  t: number;
  done: boolean;
};

declare global {
  interface Window {
    __trailer?: TrailerState;
    __trailerJump?: (sceneIndex: number) => void;
  }
}

export function isTrailerMode(): boolean {
  return new URLSearchParams(window.location.search).has("trailer");
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag: string, cls: string, parent: Element): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  parent.appendChild(node);
  return node;
}

const CSS = `
.vgt-root { position: fixed; inset: 0; z-index: 2147480000; pointer-events: none;
  display: flex; align-items: center; justify-content: center; }
.vgt-stage { position: relative; aspect-ratio: 16 / 9;
  width: min(100vw, calc(100vh * 16 / 9)); overflow: hidden;
  box-shadow: 0 0 0 200vmax #000; }
.vgt-vignette { position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.30) 100%); }
.vgt-cut { position: absolute; inset: 0; background: #000; opacity: 1; }
.vgt-card { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 1.2vh; opacity: 0;
  transition: opacity 180ms ease-out; text-align: center;
  font-family: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", sans-serif; }
.vgt-card .t { color: #fff4e2; font-weight: 900; font-size: 7.2vh;
  letter-spacing: 0.14em; text-transform: uppercase; }
.vgt-card .s { color: #ffcf6b; font-weight: 700; font-size: 2.6vh;
  letter-spacing: 0.3em; text-transform: uppercase; }
`;

type TrailerDom = { cutPlate: HTMLElement; card: HTMLElement };

function buildDom(config: TrailerConfig): TrailerDom {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el("div", "vgt-root", document.body);
  const stage = el("div", "vgt-stage", root);
  if (config.vignette !== false) el("div", "vgt-vignette", stage);
  const cutPlate = el("div", "vgt-cut", stage);
  const card = el("div", "vgt-card", stage);
  el("div", "t", card);
  el("div", "s", card);
  return { cutPlate, card };
}

/** Black held after the final cut before ?loop=1 restarts the trailer. */
const LOOP_GAP_MS = 900;

export function runTrailer(config: TrailerConfig): void {
  const params = new URLSearchParams(window.location.search);
  const autoloop = params.has("loop");
  const cutMs = config.cutMs ?? 120;
  const { cutPlate, card } = buildDom(config);

  const state: TrailerState = { sceneId: "", sceneIndex: -1, t: 0, done: false };
  window.__trailer = state;

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const url = new URL(window.location.href);
    for (const p of ["trailer", "loop"]) url.searchParams.delete(p);
    window.location.href = url.toString();
  });

  if (config.onGesture) {
    const onGesture = config.onGesture;
    const fire = (e: Event): void => {
      if (!e.isTrusted) return;
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
      onGesture();
    };
    window.addEventListener("pointerdown", fire);
    window.addEventListener("keydown", fire);
  }

  let generation = 0;
  let activeScene: TrailerScene | null = null;

  const setCut = (opacity: number, ms: number): void => {
    cutPlate.style.transition = ms > 0 ? `opacity ${ms}ms linear` : "none";
    cutPlate.style.opacity = String(opacity);
  };

  let lastWasCard = true;
  const playScene = async (scene: TrailerScene, index: number, myGen: number): Promise<void> => {
    // Gameplay-to-gameplay cuts are HARD — a montage that dips to black
    // between every beat has no momentum. The dip survives only around cards
    // (text needs the black) and the first reveal.
    const softCut = lastWasCard || scene.card !== undefined;
    setCut(1, softCut ? cutMs * 0.4 : 0);
    await wait(softCut ? cutMs * 0.4 : 20);
    if (myGen !== generation) return;

    activeScene?.teardown?.();
    activeScene = scene;
    try {
      await scene.setup();
    } catch (err) {
      console.error(`[trailer] setup failed for scene "${scene.id}"`, err);
    }
    if (myGen !== generation) return;

    if (scene.hold !== undefined && scene.hold > 0) {
      await wait(scene.hold);
      if (myGen !== generation) return;
    }

    if (scene.card) {
      const title = card.querySelector<HTMLElement>(".t");
      const sub = card.querySelector<HTMLElement>(".s");
      if (title) title.textContent = scene.card.title;
      if (sub) {
        sub.textContent = scene.card.sub ?? "";
        sub.style.display = scene.card.sub ? "" : "none";
      }
      state.sceneId = scene.id;
      state.sceneIndex = index;
      state.t = 0;
      card.style.opacity = "1";
      await wait(scene.duration);
      // The final card IS the end frame — it holds through the closing plate
      // instead of fading to dead black.
      if (index !== config.scenes.length - 1) {
        card.style.opacity = "0";
        await wait(160);
      }
      state.t = scene.duration;
      lastWasCard = true;
      return;
    }

    await wait(softCut ? cutMs * 0.2 : 0);
    setCut(0, softCut ? cutMs * 0.4 : 0);
    lastWasCard = false;

    state.sceneId = scene.id;
    state.sceneIndex = index;
    state.t = 0;

    await new Promise<void>((resolve) => {
      const start = performance.now();
      let last = start;
      const frame = (now: number): void => {
        if (myGen !== generation) return resolve();
        const t = now - start;
        state.t = t;
        try {
          scene.run?.(t, now - last);
        } catch (err) {
          console.error(`[trailer] run failed for scene "${scene.id}"`, err);
        }
        last = now;
        if (t >= scene.duration) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  };

  const playFrom = async (startIndex: number): Promise<void> => {
    const myGen = ++generation;
    state.done = false;
    for (let i = startIndex; i < config.scenes.length; i++) {
      const scene = config.scenes[i];
      if (scene === undefined) break;
      await playScene(scene, i, myGen);
      if (myGen !== generation) return;
    }
    if (myGen !== generation) return;
    activeScene?.teardown?.();
    activeScene = null;
    setCut(1, 400);
    await wait(420);
    if (myGen !== generation) return;
    state.done = true;
    if (!autoloop) return;
    await wait(LOOP_GAP_MS);
    if (myGen === generation) void playFrom(0);
  };

  window.__trailerJump = (sceneIndex: number): void => {
    const clamped = Math.max(0, Math.min(config.scenes.length - 1, Math.floor(sceneIndex)));
    void playFrom(clamped);
  };

  // Roll once boot is covered. Skipped if tooling already called
  // __trailerJump during the lead-in — that claimed generation 1, and starting
  // scene 0 here would silently clobber the jump.
  window.setTimeout(() => {
    if (generation === 0) void playFrom(0);
  }, config.leadInMs ?? 600);
}
