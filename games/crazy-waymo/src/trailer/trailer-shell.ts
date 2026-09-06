// Trailer playback and capture contract. Normal gameplay never mounts this shell.
// ?manual=1 stages before recording; ?clean=1 omits editorial graphics;
// ?scene=<id> plays one reference shot; ?loop=1 repeats. Escape returns to play.

export type TrailerScene = {
  id: string;
  duration: number;
  hold?: number;
  caption?: { label: string; title: string };
  setup: () => void | Promise<void>;
  /** Stage moving actors after a manual hold, immediately before reveal. */
  reveal?: () => void;
  run?: (t: number, dt: number) => void;
  teardown?: () => void;
};

export type TrailerConfig = {
  scenes: TrailerScene[];
  onGesture?: () => void;
  /** Milliseconds of simulation, so a slow render cannot skip the action. */
  clock: () => number;
  /** Re-render synchronously before copying the default WebGL framebuffer. */
  captureFrame: () => HTMLCanvasElement;
  branding?: { title: string; tagline: string; url: string; durationMs: number };
};

type TimelineEntry = { id: string; startMs: number; endMs: number };
type PlaybackStatus =
  | { phase: "staging" | "ready" | "playing" | "end-card"; done: false }
  | { phase: "done"; done: true }
  | { phase: "error"; done: true; error: string };
export type TrailerState = PlaybackStatus & {
  sceneId: string;
  sceneIndex: number;
  t: number;
  /** Only visible footage. Exporters remove the preparation between shots. */
  timeline: TimelineEntry[];
};

declare global {
  interface Window {
    __trailer?: TrailerState;
    __trailerStart?: () => void;
    __trailerJump?: (sceneIndex: number) => void;
  }
}

export function isTrailerMode(): boolean {
  return new URLSearchParams(window.location.search).has("trailer");
}

const write = (parent: Element, selector: string, text: string): void => {
  const node = parent.querySelector(selector);
  if (node) node.textContent = text;
};

const CSS = `
.vgt-root { position:fixed; inset:0; z-index:2147480000; pointer-events:none; display:grid; place-items:center; color:#fff4e2; font-family:var(--f, sans-serif); }
.vgt-stage { position:relative; aspect-ratio:16/9; width:min(100vw, calc(100vh * 16 / 9)); overflow:hidden; box-shadow:0 0 0 200vmax #080706; }
.vgt-hold { position:absolute; inset:0; width:100%; height:100%; background:#080706; }
.vgt-caption { position:absolute; left:6%; bottom:8%; max-width:80%; text-shadow:0 2px 18px #000b; opacity:0; transform:translateY(8px); transition:opacity 240ms ease-out, transform 240ms ease-out; }
.vgt-caption[data-visible=true] { opacity:1; transform:none; }
.vgt-label { display:block; font-size:clamp(9px,1.1vw,20px); font-weight:700; letter-spacing:.17em; line-height:1.5; color:#ffcf6b; }
.vgt-title { display:block; font-family:var(--fd, sans-serif); font-weight:900; font-size:clamp(26px,4.1vw,80px); line-height:1; letter-spacing:-.035em; margin-top:.16em; }
.vgt-end { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; align-items:center; background:linear-gradient(0deg,#080706ee,#080706a8); text-align:center; }
.vgt-end[hidden], .vgt-ready[hidden], .vgt-hold[hidden] { display:none; }
.vgt-end .vgt-title { font-size:clamp(50px,9vw,172px); line-height:.86; max-width:8ch; color:#fff4e2; }
.vgt-tagline { font-size:clamp(14px,1.6vw,30px); margin:1.1em 0 2em; }
.vgt-link { font-size:clamp(11px,1.35vw,25px); color:#ffcf6b; text-decoration:none; pointer-events:auto; }
.vgt-ready { position:absolute; inset:0; display:grid; align-content:center; justify-items:center; gap:18px; background:#100d0ae8; pointer-events:auto; text-align:center; padding:5%; }
.vgt-play { border:1px solid #ffcf6b; background:#ffcf6b; color:#170e0a; padding:14px 26px; border-radius:5px; font:700 16px var(--f, sans-serif); cursor:pointer; }
.vgt-play:focus-visible, .vgt-link:focus-visible { outline:3px solid #fff4e2; outline-offset:5px; }
@media (prefers-reduced-motion:reduce) { .vgt-caption { transition:none; transform:none; } }
`;

export function runTrailer(config: TrailerConfig): void {
  const params = new URLSearchParams(window.location.search);
  const clean = params.has("clean");
  const selected = params.get("scene");
  const scenes = selected ? config.scenes.filter((scene) => scene.id === selected) : config.scenes;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.className = "vgt-root";
  root.innerHTML = `<div class="vgt-stage"><canvas class="vgt-hold"></canvas><div class="vgt-caption"><span class="vgt-label"></span><strong class="vgt-title"></strong></div><div class="vgt-end" hidden><strong class="vgt-title"></strong><p class="vgt-tagline"></p><span class="vgt-label">PLAY FREE IN YOUR BROWSER</span><a class="vgt-link"></a></div><div class="vgt-ready" hidden><strong class="vgt-title">CRAZY WAYMO</strong><span class="vgt-message">Trailer ready. Sound starts when you press play.</span><button type="button" class="vgt-play">Play trailer</button></div></div>`;
  document.body.appendChild(root);
  const hold = root.querySelector("canvas");
  const caption = root.querySelector(".vgt-caption");
  const end = root.querySelector(".vgt-end");
  const ready = root.querySelector(".vgt-ready");
  const play = root.querySelector(".vgt-play");
  if (
    !(hold instanceof HTMLCanvasElement) ||
    !(caption instanceof HTMLElement) ||
    !(end instanceof HTMLElement) ||
    !(ready instanceof HTMLElement) ||
    !(play instanceof HTMLButtonElement)
  ) {
    throw new Error("Trailer shell failed to mount");
  }
  const context = hold.getContext("2d");
  if (!context) throw new Error("Trailer hold frame unavailable");
  const branding = config.branding;
  write(end, ".vgt-title", branding?.title ?? "");
  write(end, ".vgt-tagline", branding?.tagline ?? "");
  const link = end.querySelector("a");
  if (link && branding) {
    link.href = branding.url;
    link.textContent = new URL(branding.url).host;
  }

  let timeline: TimelineEntry[] = [];
  let sceneId = "";
  let sceneIndex = -1;
  const publish = (status: PlaybackStatus, t = 0): void => {
    window["__trailer"] = { ...status, sceneId, sceneIndex, t, timeline };
  };
  const freeze = (): void => {
    const source = config.captureFrame();
    // Crop the same center 16:9 viewport shown by the letterbox.
    const width = Math.min(source.width, (source.height * 16) / 9);
    const height = (width * 9) / 16;
    hold.width = Math.round(width);
    hold.height = Math.round(height);
    context.drawImage(
      source,
      (source.width - width) / 2,
      (source.height - height) / 2,
      width,
      height,
      0,
      0,
      hold.width,
      hold.height,
    );
    hold.hidden = false;
  };
  const fail = (err: Error): void => {
    const message = err.message;
    console.error("[trailer]", message);
    ready.hidden = false;
    play.hidden = true;
    write(ready, ".vgt-message", `Trailer stopped: ${message}`);
    publish({ phase: "error", done: true, error: message });
  };
  publish({ phase: "staging", done: false });
  let generation = 0;
  let gate: (() => void) | null = null;
  let started = !params.has("manual");
  let active: TrailerScene | null = null;
  let running = Promise.resolve();
  let audioUnlocked = false;
  const unlock = (event: Event): void => {
    if (!event.isTrusted || audioUnlocked) return;
    audioUnlocked = true;
    config.onGesture?.();
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  window["__trailerStart"] = () => {
    started = true;
    gate?.();
    gate = null;
  };
  play.addEventListener("click", () => window["__trailerStart"]?.());
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const url = new URL(window.location.href);
    for (const key of ["trailer", "loop", "manual", "clean", "scene"]) url.searchParams.delete(key);
    window.location.href = url.toString();
  });

  const runFrames = (
    duration: number,
    token: number,
    body: (t: number, dt: number) => void,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const start = config.clock();
      let last = start;
      const frame = (): void => {
        if (generation !== token) return resolve();
        const now = config.clock();
        const t = Math.min(duration, now - start);
        try {
          body(t, now - last);
        } catch (error) {
          reject(error);
          return;
        }
        last = now;
        if (t >= duration) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

  const playFrom = async (index: number, token: number): Promise<void> => {
    timeline = [];
    end.hidden = true;
    for (let i = index; i < scenes.length; i++) {
      if (token !== generation) return;
      const scene = scenes[i];
      if (!scene) return;
      caption.dataset["visible"] = "false";
      if (active) freeze();
      active?.teardown?.();
      active = scene;
      sceneId = scene.id;
      sceneIndex = i;
      publish({ phase: "staging", done: false });
      await scene.setup();
      if (token !== generation) return;
      if (!started) {
        ready.hidden = false;
        publish({ phase: "ready", done: false });
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
        if (token !== generation) return;
        ready.hidden = true;
      }
      write(caption, ".vgt-label", scene.caption?.label ?? "");
      write(caption, ".vgt-title", scene.caption?.title ?? "");
      scene.reveal?.();
      hold.hidden = true;
      const entry = { id: scene.id, startMs: performance.now(), endMs: 0 };
      timeline.push(entry);
      await runFrames(scene.duration, token, (t, dt) => {
        scene.run?.(t, dt);
        caption.dataset["visible"] = String(
          !clean && Boolean(scene.caption) && t > 250 && t < scene.duration - 300,
        );
        publish({ phase: "playing", done: false }, t);
      });
      entry.endMs = performance.now();
    }
    if (token !== generation) return;
    freeze();
    active?.teardown?.();
    active = null;
    caption.dataset["visible"] = "false";
    if (!clean && !selected && branding) {
      end.hidden = false;
      sceneId = "end-card";
      const entry = { id: sceneId, startMs: performance.now(), endMs: 0 };
      timeline.push(entry);
      await runFrames(branding.durationMs, token, (t) =>
        publish({ phase: "end-card", done: false }, t),
      );
      entry.endMs = performance.now();
    }
    if (token !== generation) return;
    publish({ phase: "done", done: true });
    if (params.has("loop")) window.setTimeout(() => window["__trailerJump"]?.(0), 900);
  };
  const enqueue = (index: number): void => {
    const token = ++generation;
    gate?.();
    gate = null;
    running = running
      .then(() => playFrom(index, token))
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  };
  window["__trailerJump"] = (index) => {
    if (!Number.isFinite(index)) return;
    started = true;
    ready.hidden = true;
    enqueue(Math.max(0, Math.min(scenes.length - 1, Math.floor(index))));
  };
  if (scenes.length === 0) fail(new Error(`Unknown trailer scene: ${selected}`));
  else enqueue(0);
}
