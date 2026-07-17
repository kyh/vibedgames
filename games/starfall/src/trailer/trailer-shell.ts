// trailer-shell.ts — self-contained trailer-mode runner: 16:9 letterbox, title
// cards, lower-third captions, dip-to-black cuts, start gate, end card.
//
// This file is copied identically into each game (like session.ts); keep copies
// in sync. Game-specific staging lives in the game's own trailer-director file.
//
// Integration:
//   1. Copy this file to games/<game>/src/trailer/trailer-shell.ts unchanged.
//   2. In main.ts (or the boot path), if isTrailerMode(), boot the game into a
//      deterministic offline/solo state with menus skipped, then call
//      runTrailer(config) from a game-specific trailer-director.ts.
//   3. Each scene stages real gameplay via setup() (position entities, camera,
//      world state) and optionally choreographs per-frame via run(t, dt).
//
// URL params:
//   ?trailer=1     enter trailer mode
//   &autostart=1   skip the click gate + countdown (agent/headless preview)
//   &loop=1        auto-replay 3s after the end card
//   Esc            exits back to the normal game

export type TrailerCard = {
  title: string;
  sub?: string;
};

export type TrailerScene = {
  /** Stable id, exposed on window.__trailer for tooling. */
  id: string;
  /** Milliseconds the scene plays (excludes card/cut time). */
  duration: number;
  /** Full-screen black title card shown before the scene; masks staging. */
  card?: TrailerCard;
  /** Lower-third caption overlaid during the scene. */
  caption?: string;
  /** Stage the scene: entities, camera, world state. Runs while screen is black. */
  setup: () => void | Promise<void>;
  /** Per-frame choreography. t = ms since scene start, dt = ms since last frame. */
  run?: (t: number, dt: number) => void;
  /** Cleanup before the next scene stages. */
  teardown?: () => void;
};

export type TrailerConfig = {
  /** Wordmark text for start/end cards, e.g. "LUNERFALL". */
  title: string;
  /** Play URL for the end card, e.g. "lunerfall.vibedgames.com". */
  url: string;
  /** Accent CSS color used for card highlights. */
  accent: string;
  /** Sub-line on the end card, e.g. "Online co-op roguelite". */
  tagline?: string;
  /** Display font; defaults to system stack. Pass the game's loaded font. */
  fontFamily?: string;
  /** Dip-to-black duration between card-less scenes. Default 120ms. */
  cutMs?: number;
  /** Title card hold duration. Default 1400ms. */
  cardMs?: number;
  /** Subtle cinematic vignette inside the 16:9 stage. Default true. */
  vignette?: boolean;
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
  display: flex; align-items: center; justify-content: center;
  font-family: var(--vgt-font); }
.vgt-stage { position: relative; aspect-ratio: 16 / 9;
  width: min(100vw, calc(100vh * 16 / 9)); overflow: hidden;
  box-shadow: 0 0 0 200vmax #000; }
.vgt-vignette { position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.30) 100%); }
.vgt-cut { position: absolute; inset: 0; background: #000; opacity: 0; }
.vgt-caption { position: absolute; bottom: 6.5%; width: 100%; text-align: center;
  font-size: 1.9vmin; letter-spacing: 0.34em; text-indent: 0.34em;
  text-transform: uppercase; color: #fff; font-weight: 600;
  text-shadow: 0 2px 14px rgba(0,0,0,0.85), 0 0 3px rgba(0,0,0,0.9);
  opacity: 0; transform: translateY(0.8vmin);
  transition: opacity 260ms ease, transform 260ms ease; }
.vgt-caption.vgt-show { opacity: 1; transform: translateY(0); }
.vgt-card { position: absolute; inset: 0; background: #000; display: flex;
  flex-direction: column; gap: 2.4vmin; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 170ms ease; text-align: center; }
.vgt-card.vgt-show { opacity: 1; }
.vgt-card-title { font-size: 4.8vmin; font-weight: 700; color: #fff;
  text-transform: uppercase; letter-spacing: 0.34em; text-indent: 0.34em;
  transition: letter-spacing 1100ms cubic-bezier(0.16, 1, 0.3, 1),
    text-indent 1100ms cubic-bezier(0.16, 1, 0.3, 1); }
.vgt-card.vgt-show .vgt-card-title { letter-spacing: 0.26em; text-indent: 0.26em; }
.vgt-card-sub { font-size: 1.9vmin; letter-spacing: 0.42em; text-indent: 0.42em;
  text-transform: uppercase; color: var(--vgt-accent); font-weight: 600; }
.vgt-gate { position: absolute; inset: 0; background: #000; display: flex;
  flex-direction: column; gap: 3vmin; align-items: center; justify-content: center;
  pointer-events: auto; cursor: pointer; text-align: center; }
.vgt-eyebrow { font-size: 1.7vmin; letter-spacing: 0.5em; text-indent: 0.5em;
  text-transform: uppercase; color: var(--vgt-accent); font-weight: 600; }
.vgt-wordmark { font-size: 7vmin; font-weight: 800; color: #fff;
  text-transform: uppercase; letter-spacing: 0.18em; text-indent: 0.18em; }
.vgt-hint { font-size: 1.8vmin; letter-spacing: 0.3em; text-indent: 0.3em;
  text-transform: uppercase; color: #fff; opacity: 0.9;
  animation: vgt-pulse 1.6s ease-in-out infinite; }
.vgt-finehint { position: absolute; bottom: 5%; width: 100%; font-size: 1.3vmin;
  letter-spacing: 0.28em; text-indent: 0.28em; text-transform: uppercase;
  color: rgba(255,255,255,0.35); }
@keyframes vgt-pulse { 0%, 100% { opacity: 0.95; } 50% { opacity: 0.35; } }
.vgt-count { position: absolute; inset: 0; background: #000; display: flex;
  align-items: center; justify-content: center; }
.vgt-count-num { font-size: 13vmin; font-weight: 800; color: var(--vgt-accent); }
.vgt-count-num.vgt-tick { animation: vgt-pop 700ms ease-out; }
@keyframes vgt-pop { 0% { transform: scale(1.35); opacity: 0; }
  25% { transform: scale(1); opacity: 1; } 100% { transform: scale(0.94); opacity: 0.9; } }
.vgt-end { position: absolute; inset: 0; background: #000; display: flex;
  flex-direction: column; gap: 2.6vmin; align-items: center; justify-content: center;
  pointer-events: auto; opacity: 0; transition: opacity 600ms ease; text-align: center; }
.vgt-end.vgt-show { opacity: 1; }
.vgt-rule { width: 7vmin; height: 2px; background: var(--vgt-accent); }
.vgt-url { font-size: 2.3vmin; letter-spacing: 0.3em; text-indent: 0.3em;
  text-transform: uppercase; color: #fff; font-weight: 600; }
.vgt-tagline { font-size: 1.7vmin; letter-spacing: 0.34em; text-indent: 0.34em;
  text-transform: uppercase; color: rgba(255,255,255,0.5); }
.vgt-replay { margin-top: 2vmin; padding: 1.2vmin 3vmin; font-size: 1.6vmin;
  letter-spacing: 0.3em; text-indent: 0.3em; text-transform: uppercase;
  color: #fff; background: transparent; border: 1px solid rgba(255,255,255,0.4);
  cursor: pointer; font-family: inherit; transition: background 150ms, color 150ms; }
.vgt-replay:hover { background: #fff; color: #000; }
`;

type Refs = {
  root: HTMLElement;
  stage: HTMLElement;
  cut: HTMLElement;
  caption: HTMLElement;
  card: HTMLElement;
  cardTitle: HTMLElement;
  cardSub: HTMLElement;
  end: HTMLElement;
};

function buildDom(config: TrailerConfig): Refs {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el("div", "vgt-root", document.body);
  root.style.setProperty("--vgt-accent", config.accent);
  root.style.setProperty(
    "--vgt-font",
    config.fontFamily ?? "'SF Pro Display', 'Segoe UI', system-ui, sans-serif",
  );
  const stage = el("div", "vgt-stage", root);
  if (config.vignette !== false) el("div", "vgt-vignette", stage);
  const cut = el("div", "vgt-cut", stage);
  const caption = el("div", "vgt-caption", stage);
  const card = el("div", "vgt-card", stage);
  const cardTitle = el("div", "vgt-card-title", card);
  const cardSub = el("div", "vgt-card-sub", card);
  const end = el("div", "vgt-end", stage);
  end.style.display = "none";
  return { root, stage, cut, caption, card, cardTitle, cardSub, end };
}

export function runTrailer(config: TrailerConfig): void {
  const params = new URLSearchParams(window.location.search);
  const autostart = params.has("autostart");
  const autoloop = params.has("loop");
  const cutMs = config.cutMs ?? 120;
  const cardMs = config.cardMs ?? 1400;
  const refs = buildDom(config);

  const state: TrailerState = { sceneId: "", sceneIndex: -1, t: 0, done: false };
  window.__trailer = state;

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const url = new URL(window.location.href);
    for (const p of ["trailer", "autostart", "loop"]) url.searchParams.delete(p);
    window.location.href = url.toString();
  });

  let generation = 0;
  let activeScene: TrailerScene | null = null;

  const setCut = (opacity: number, ms: number): void => {
    refs.cut.style.transition = ms > 0 ? `opacity ${ms}ms linear` : "none";
    refs.cut.style.opacity = String(opacity);
  };

  const showCaption = (text: string | undefined): void => {
    if (text === undefined) {
      refs.caption.classList.remove("vgt-show");
      return;
    }
    refs.caption.textContent = text;
    refs.caption.classList.add("vgt-show");
  };

  const playScene = async (scene: TrailerScene, index: number, myGen: number): Promise<void> => {
    // Mask staging: title card for beat openers, quick dip-to-black otherwise.
    if (scene.card) {
      refs.cardTitle.textContent = scene.card.title;
      refs.cardSub.textContent = scene.card.sub ?? "";
      refs.cardSub.style.display = scene.card.sub === undefined ? "none" : "";
      refs.card.classList.add("vgt-show");
      setCut(1, 0);
    } else {
      setCut(1, cutMs * 0.4);
      await wait(cutMs * 0.4);
    }
    if (myGen !== generation) return;

    activeScene?.teardown?.();
    activeScene = scene;
    try {
      await scene.setup();
    } catch (err) {
      console.error(`[trailer] setup failed for scene "${scene.id}"`, err);
    }
    if (myGen !== generation) return;

    if (scene.card) {
      await wait(cardMs);
      if (myGen !== generation) return;
      refs.card.classList.remove("vgt-show");
      setCut(0, 170);
    } else {
      await wait(cutMs * 0.2);
      setCut(0, cutMs * 0.4);
    }
    if (myGen !== generation) return;

    state.sceneId = scene.id;
    state.sceneIndex = index;
    state.t = 0;
    showCaption(scene.caption);

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
    showCaption(undefined);
  };

  const showEnd = (): void => {
    refs.end.innerHTML = "";
    refs.end.style.display = "";
    const wordmark = el("div", "vgt-wordmark", refs.end);
    wordmark.textContent = config.title;
    el("div", "vgt-rule", refs.end);
    const url = el("div", "vgt-url", refs.end);
    url.textContent = config.url;
    if (config.tagline !== undefined) {
      const tagline = el("div", "vgt-tagline", refs.end);
      tagline.textContent = config.tagline;
    }
    const replay = el("button", "vgt-replay", refs.end);
    replay.textContent = "Replay";
    replay.addEventListener("click", () => {
      void playFrom(0);
    });
    requestAnimationFrame(() => refs.end.classList.add("vgt-show"));
    state.done = true;
    if (autoloop) {
      const myGen = generation;
      void wait(3000).then(() => {
        if (myGen === generation) void playFrom(0);
      });
    }
  };

  const hideEnd = (): void => {
    refs.end.classList.remove("vgt-show");
    refs.end.style.display = "none";
  };

  const playFrom = async (startIndex: number): Promise<void> => {
    const myGen = ++generation;
    hideEnd();
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
    if (myGen === generation) showEnd();
  };

  window.__trailerJump = (sceneIndex: number): void => {
    const clamped = Math.max(0, Math.min(config.scenes.length - 1, Math.floor(sceneIndex)));
    void playFrom(clamped);
  };

  const begin = async (): Promise<void> => {
    if (autostart) {
      await wait(600);
      void playFrom(0);
      return;
    }
    const gate = el("div", "vgt-gate", refs.stage);
    const eyebrow = el("div", "vgt-eyebrow", gate);
    eyebrow.textContent = "Gameplay Trailer";
    const wordmark = el("div", "vgt-wordmark", gate);
    wordmark.textContent = config.title;
    const hint = el("div", "vgt-hint", gate);
    hint.textContent = "Click to roll";
    const fine = el("div", "vgt-finehint", gate);
    fine.textContent = "Esc exits · scenes play automatically · best recorded fullscreen";
    gate.addEventListener(
      "click",
      () => {
        gate.remove();
        void (async () => {
          const count = el("div", "vgt-count", refs.stage);
          const num = el("div", "vgt-count-num", count);
          for (const n of ["3", "2", "1"]) {
            num.textContent = n;
            num.classList.remove("vgt-tick");
            // Force reflow so the pop animation restarts per tick.
            void num.offsetWidth;
            num.classList.add("vgt-tick");
            await wait(700);
          }
          count.remove();
          void playFrom(0);
        })();
      },
      { once: true },
    );
  };

  void begin();
}
