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
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true };
  }
  return { blocked: BLOCK_PATTERN.test(reason), ok: false, reason };
};

/** What to tell the player. Plain text; the game owns the surface it lands on. */
export const webglFailureMessage = (probe: Extract<WebGLProbe, { ok: false }>): string => {
  if (probe.blocked) {
    return "Chrome paused graphics for this site after a game crashed. Wait two minutes, then reload.";
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
    "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;background:#0b0e14;color:#f4f7fb;font:15px/1.5 system-ui,sans-serif;text-align:center;cursor:pointer";
  const text = document.createElement("div");
  text.style.maxWidth = "28em";
  text.textContent = `${message} Tap to reload.`;
  veil.append(text);
  veil.addEventListener("click", () => window.location.reload());
  document.body.append(veil);
};
