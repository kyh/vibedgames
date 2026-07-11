// Controls manifest — a game's single source of truth for instruction copy.
// Each game declares every way it can be played (one entry per binding), and
// every instruction surface (start screen, pause overlay, future HUD) renders
// from the same list, filtered to the input methods that matter right now:
// touch copy on coarse pointers, keys/mouse copy on fine ones, camera copy
// always (gimmick inputs are core, not fallbacks), controller copy only while
// a pad is actually connected.

/** How the player physically produces the input. */
export type ControlMethod = "keys" | "mouse" | "touch" | "camera" | "controller";

/** One binding: what the player does (`input`) and what happens (`action`). */
export type ControlEntry = {
  readonly method: ControlMethod;
  /** The gesture/key as shown to the player: "SPACE", "✊ fist", "RT". */
  readonly input: string;
  /** What it does, lower-case verb phrase: "flap", "drop a bomb". */
  readonly action: string;
};

/** Everything a game can be controlled with, in display order. */
export type ControlsManifest = readonly ControlEntry[];

/** One rendered group: a method plus its visible entries, in manifest order. */
export type ControlGroup = {
  readonly method: ControlMethod;
  readonly entries: readonly ControlEntry[];
};

export type ControlContext = {
  /** Touch-first device. Default: `(pointer: coarse)` / `ontouchstart`. */
  coarse?: boolean;
  /** A physical pad is connected. Default: live `navigator.getGamepads()`. */
  padConnected?: boolean;
};

// Same boot-time check every game uses (e.g. crazy-waymo touch.ts) — but
// evaluated lazily so overlays pick up the truth at render time.
function isCoarse(): boolean {
  return (
    (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) ||
    (typeof window !== "undefined" && "ontouchstart" in window)
  );
}

function padConnectedNow(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return false;
  return navigator.getGamepads().some((pad) => pad?.connected ?? false);
}

/**
 * The methods worth showing right now. Camera entries always show (the webcam
 * works on both platforms); controller entries only while a pad is connected.
 */
export function activeMethods(context: ControlContext = {}): ReadonlySet<ControlMethod> {
  const coarse = context.coarse ?? isCoarse();
  const pad = context.padConnected ?? padConnectedNow();
  const methods = new Set<ControlMethod>(
    coarse ? ["touch", "camera"] : ["keys", "mouse", "camera"],
  );
  if (pad) methods.add("controller");
  return methods;
}

const METHOD_ORDER: readonly ControlMethod[] = ["keys", "mouse", "touch", "camera", "controller"];

/**
 * Manifest → visible groups, in a stable method order (entries keep manifest
 * order within a group). The shape start screens and HUDs render from.
 */
export function controlGroups(
  manifest: ControlsManifest,
  context: ControlContext = {},
): readonly ControlGroup[] {
  const visible = activeMethods(context);
  const groups: ControlGroup[] = [];
  for (const method of METHOD_ORDER) {
    if (!visible.has(method)) continue;
    const entries = manifest.filter((entry) => entry.method === method);
    if (entries.length > 0) groups.push({ method, entries });
  }
  return groups;
}

/**
 * Manifest → flat `[input, action]` rows for the pause overlay, deduping
 * repeated actions across methods (e.g. keys "SPACE — flap" and mouse
 * "CLICK — flap" merge to "SPACE / CLICK — flap") so the overlay stays short.
 */
export function controlHints(
  manifest: ControlsManifest,
  context: ControlContext = {},
): readonly (readonly [input: string, action: string])[] {
  const byAction = new Map<string, string[]>();
  for (const group of controlGroups(manifest, context)) {
    for (const entry of group.entries) {
      const inputs = byAction.get(entry.action);
      if (inputs) {
        if (!inputs.includes(entry.input)) inputs.push(entry.input);
      } else {
        byAction.set(entry.action, [entry.input]);
      }
    }
  }
  return Array.from(byAction, ([action, inputs]) => [inputs.join(" / "), action]);
}

/**
 * Re-render trigger for instruction surfaces that outlive a render (a title
 * screen waiting while the player plugs in a pad): fires on pad
 * connect/disconnect. Returns an unsubscribe.
 */
export function watchControlContext(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("gamepadconnected", onChange);
  window.addEventListener("gamepaddisconnected", onChange);
  return () => {
    window.removeEventListener("gamepadconnected", onChange);
    window.removeEventListener("gamepaddisconnected", onChange);
  };
}
