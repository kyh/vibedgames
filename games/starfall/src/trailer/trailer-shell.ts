export interface TrailerScene {
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
}

export interface TrailerConfig {
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
}

export interface TrailerState {
  sceneId: string;
  sceneIndex: number;
  t: number;
  done: boolean;
}

declare global {
  interface Window {
    __trailer?: TrailerState;
    __trailerJump?: (sceneIndex: number) => void;
  }
}

export const isTrailerMode = () => new URLSearchParams(window.location.search).has("trailer");

const wait: (ms: number) => Promise<void> = (ms) =>
  // oxlint-disable-next-line promise/avoid-new -- the one shared sleep helper
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const el = (tag: string, cls: string, parent: Element) => {
  const node = document.createElement(tag);
  node.className = cls;
  parent.append(node);

  return node;
};

const CSS = `
.vgt-root { position: fixed; inset: 0; z-index: 2147480000; pointer-events: none;
  display: flex; align-items: center; justify-content: center; }
.vgt-stage { position: relative; aspect-ratio: 16 / 9;
  width: min(100vw, calc(100vh * 16 / 9)); overflow: hidden;
  box-shadow: 0 0 0 200vmax #000; }
.vgt-vignette { position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.30) 100%); }
.vgt-cut { position: absolute; inset: 0; background: #000; opacity: 1; }
`;

const buildDom = (config: TrailerConfig) => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const root = el("div", "vgt-root", document.body);
  const stage = el("div", "vgt-stage", root);

  if (config.vignette !== false) {
    el("div", "vgt-vignette", stage);
  }

  return el("div", "vgt-cut", stage);
};

const LOOP_GAP_MS = 900;

export const runTrailer = (config: TrailerConfig) => {
  const params = new URLSearchParams(window.location.search);
  const autoloop = params.has("loop");
  const cutMs = config.cutMs ?? 120;
  const cutPlate = buildDom(config);

  const state: TrailerState = { done: false, sceneId: "", sceneIndex: -1, t: 0 };
  window.__trailer = state;

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") {
      return;
    }

    const url = new URL(window.location.href);

    for (const p of ["trailer", "loop"]) {
      url.searchParams.delete(p);
    }

    window.location.href = url.toString();
  });

  if (config.onGesture) {
    const { onGesture } = config;

    const fire = (e: Event) => {
      if (!e.isTrusted) {
        return;
      }

      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
      onGesture();
    };

    window.addEventListener("pointerdown", fire);
    window.addEventListener("keydown", fire);
  }

  let generation = 0;
  let activeScene: TrailerScene | null = null;

  const setCut = (opacity: number, ms: number) => {
    cutPlate.style.transition = ms > 0 ? `opacity ${ms}ms linear` : "none";
    cutPlate.style.opacity = String(opacity);
  };

  const playScene = async (scene: TrailerScene, index: number, myGen: number) => {
    setCut(1, cutMs * 0.4);
    await wait(cutMs * 0.4);

    if (myGen !== generation) {
      return;
    }

    activeScene?.teardown?.();
    activeScene = scene;

    try {
      await scene.setup();
    } catch (error) {
      console.error(`[trailer] setup failed for scene "${scene.id}"`, error);
    }

    if (myGen !== generation) {
      return;
    }

    if (scene.hold !== undefined && scene.hold > 0) {
      await wait(scene.hold);

      if (myGen !== generation) {
        return;
      }
    }

    await wait(cutMs * 0.2);
    setCut(0, cutMs * 0.4);

    state.sceneId = scene.id;
    state.sceneIndex = index;
    state.t = 0;

    // oxlint-disable-next-line promise/avoid-new -- wraps the rAF loop
    await new Promise<void>((resolve) => {
      const start = performance.now();
      let last = start;

      const frame = (now: number) => {
        if (myGen !== generation) {
          return resolve();
        }

        const t = now - start;
        state.t = t;

        try {
          scene.run?.(t, now - last);
        } catch (error) {
          console.error(`[trailer] run failed for scene "${scene.id}"`, error);
        }

        last = now;

        if (t >= scene.duration) {
          return resolve();
        }

        requestAnimationFrame(frame);
      };

      requestAnimationFrame(frame);
    });
  };

  const playFrom = async (startIndex: number) => {
    generation += 1;
    const myGen = generation;
    state.done = false;

    for (let i = startIndex; i < config.scenes.length; i += 1) {
      const scene = config.scenes[i];

      if (scene === undefined) {
        break;
      }

      await playScene(scene, i, myGen);

      if (myGen !== generation) {
        return;
      }
    }

    if (myGen !== generation) {
      return;
    }

    activeScene?.teardown?.();
    activeScene = null;
    setCut(1, 400);
    await wait(420);

    if (myGen !== generation) {
      return;
    }

    state.done = true;

    if (!autoloop) {
      return;
    }

    await wait(LOOP_GAP_MS);

    if (myGen === generation) {
      void playFrom(0);
    }
  };

  window.__trailerJump = (sceneIndex: number) => {
    const clamped = Math.max(0, Math.min(config.scenes.length - 1, Math.floor(sceneIndex)));
    void playFrom(clamped);
  };

  window.setTimeout(() => {
    if (generation === 0) {
      void playFrom(0);
    }
  }, config.leadInMs ?? 600);
};
