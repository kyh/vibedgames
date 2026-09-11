// WebGL availability, asked before a game constructs its renderer.
//
// A refused context has three causes a player can act on, and the browser
// tells the page which through `webglcontextcreationerror.statusMessage`.
// The one that matters on this platform: Chrome blocks WebGL for the
// TOP-LEVEL page's host for two minutes after a page under it loses its
// context twice (GPU process killed for memory or a hung frame). Every game
// is framed under vibedgames.com, so one crashing game refuses graphics to
// the next nine a player opens — and a game that boots blind into
// `new WebGLRenderer()` or Phaser `type: WEBGL` then shows a black canvas
// with no explanation. Probe first, and say what happened.

export type WebGLProbe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The browser's own reason, when it gave one. */
      readonly reason: string;
      /** Chrome's per-site block after repeated context loss — waiting clears it. */
      readonly blocked: boolean;
    };

const BLOCK_PATTERN = /blocked|blocklist|too many|context limit/iu;

// Captured by the boot probe so a later failure veil can say what the device
// is — a lost context cannot be asked, and a phone's player cannot open
// chrome://gpu for us.
let captured = "";

/** What the boot probe learned about the GPU; empty before `probeWebGL`. */
export const gpuDescription = (): string => captured;

/** Vendor and model of the live context's GPU, unmasked where the browser allows it. */
export const describeGpu = (gl: WebGLRenderingContext | WebGL2RenderingContext): string => {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
};

/**
 * Try to create a context on a throwaway canvas. Cheap: a probe context is
 * released immediately, and the browser's creation-error event carries the
 * reason a plain `getContext` swallows.
 */
export const probeWebGL = (): WebGLProbe => {
  if (typeof document === "undefined") {
    return { ok: true };
  }
  const canvas = document.createElement("canvas");
  let reason = "";
  canvas.addEventListener("webglcontextcreationerror", (event: Event) => {
    if (event instanceof WebGLContextEvent && event.statusMessage) {
      reason = event.statusMessage;
    }
  });
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  } catch {
    gl = null;
  }
  if (gl) {
    const renderer = describeGpu(gl);
    captured = `${renderer} · ${gl instanceof WebGL2RenderingContext ? "WebGL2" : "WebGL1"}`;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true };
  }
  return { blocked: BLOCK_PATTERN.test(reason), ok: false, reason };
};

/** What to tell the player. Plain text; the game owns the surface it lands on. */
export const webglFailureMessage = (probe: Extract<WebGLProbe, { ok: false }>): string => {
  if (probe.blocked) {
    return "Chrome paused graphics for this site after a game crashed. It lifts two minutes after the last crash.";
  }
  const detail = probe.reason ? ` (${probe.reason})` : "";
  return `Graphics are unavailable in this browser${detail}. Try reloading, another browser, or enabling hardware acceleration.`;
};

const VEIL_ID = "vg-webgl-veil";

/**
 * A full-screen notice for a refused context, styled to sit over any game:
 * dark ground, one line, tap to reload. Idempotent. `message` overrides the
 * probe wording for a context lost mid-play, where "unavailable" misleads.
 */
export const showWebGLVeil = (
  probe: Extract<WebGLProbe, { ok: false }>,
  message: string = webglFailureMessage(probe),
): void => {
  if (typeof document === "undefined" || document.querySelector(`#${VEIL_ID}`)) {
    return;
  }
  const veil = document.createElement("div");
  veil.id = VEIL_ID;
  veil.setAttribute("role", "alert");
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "padding:24px;background:#0b0e14;color:#f4f7fb;font:15px/1.5 system-ui,sans-serif;text-align:center;cursor:pointer";
  // Chrome keys the block on the top-level host, so a game framed under the
  // hub can still run on its own origin: the tap takes the player there.
  const escape = probe.blocked && window.top !== window.self;
  const text = document.createElement("div");
  text.style.maxWidth = "28em";
  text.textContent = `${message} ${escape ? "Tap to open the game on its own page." : "Tap to reload."}`;
  // The diagnostic line is what a screenshot from a phone has to carry.
  const detail = document.createElement("div");
  detail.style.cssText = "margin-top:14px;font-size:11px;color:#8b95a1;word-break:break-word";
  detail.textContent = [
    captured || "GPU unknown",
    `${Math.round(performance.now() / 1000)} s after load`,
    probe.reason,
    `${screen.width}×${screen.height} @${window.devicePixelRatio}`,
  ]
    .filter(Boolean)
    .join(" · ");
  veil.append(text, detail);
  veil.addEventListener("click", () => {
    if (escape) {
      window.open(window.location.href, "_top");
    } else {
      window.location.reload();
    }
  });
  document.body.append(veil);
};
