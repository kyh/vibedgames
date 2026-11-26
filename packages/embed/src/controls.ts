/** How the player physically produces the input. */
export type ControlMethod = "keys" | "mouse" | "touch" | "camera" | "controller";

/** One binding: what the player does (`input`) and what happens (`action`). */
export interface ControlEntry {
  readonly method: ControlMethod;
  /** The gesture/key as shown to the player: "SPACE", "✊ fist", "RT". */
  readonly input: string;
  /** What it does, lower-case verb phrase: "flap", "drop a bomb". */
  readonly action: string;
}

/** Everything a game can be controlled with, in display order. */
export type ControlsManifest = readonly ControlEntry[];

/** One rendered group: a method plus its visible entries, in manifest order. */
export interface ControlGroup {
  readonly method: ControlMethod;
  readonly entries: readonly ControlEntry[];
}

export interface ControlContext {
  /** Touch-first device. Default: `(pointer: coarse)` / `ontouchstart`. */
  coarse?: boolean;
  /** A physical pad is connected. Default: live `navigator.getGamepads()`. */
  padConnected?: boolean;
}

export const isCoarsePointer = () =>
  (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) ||
  (typeof window !== "undefined" && "ontouchstart" in window);

const padConnectedNow = () => {
  if (typeof navigator === "undefined" || !("getGamepads" in navigator)) {
    return false;
  }

  return navigator.getGamepads().some((pad) => pad?.connected ?? false);
};

/**
 * The methods worth showing right now. Camera entries always show (the webcam
 * works on both platforms); controller entries only while a pad is connected.
 */
export const activeMethods = (context: ControlContext = {}) => {
  const coarse = context.coarse ?? isCoarsePointer();
  const pad = context.padConnected ?? padConnectedNow();

  const methods = new Set<ControlMethod>(
    coarse ? ["touch", "camera"] : ["keys", "mouse", "camera"],
  );

  if (pad) {
    methods.add("controller");
  }

  return methods;
};

const METHOD_ORDER: readonly ControlMethod[] = ["keys", "mouse", "touch", "camera", "controller"];

/**
 * Manifest → visible groups, in a stable method order (entries keep manifest
 * order within a group). The shape start screens and HUDs render from.
 */
export const controlGroups = (manifest: ControlsManifest, context: ControlContext = {}) => {
  const visible = activeMethods(context);
  const groups: ControlGroup[] = [];

  for (const method of METHOD_ORDER) {
    if (!visible.has(method)) {
      continue;
    }

    const entries = manifest.filter((entry) => entry.method === method);

    if (entries.length > 0) {
      groups.push({ entries, method });
    }
  }

  return groups;
};

/**
 * Manifest → flat `[input, action]` rows for the pause overlay, deduping
 * repeated actions across methods (e.g. keys "SPACE — flap" and mouse
 * "CLICK — flap" merge to "SPACE / CLICK — flap") so the overlay stays short.
 */
export const controlHints: (
  manifest: ControlsManifest,
  context?: ControlContext,
) => readonly (readonly [input: string, action: string])[] = (manifest, context = {}) => {
  const byAction = new Map<string, string[]>();

  for (const group of controlGroups(manifest, context)) {
    for (const entry of group.entries) {
      const inputs = byAction.get(entry.action);

      if (inputs) {
        if (!inputs.includes(entry.input)) {
          inputs.push(entry.input);
        }
      } else {
        byAction.set(entry.action, [entry.input]);
      }
    }
  }

  return Array.from(byAction, ([action, inputs]) => [inputs.join(" / "), action]);
};

/**
 * Re-render trigger for instruction surfaces that outlive a render (a title
 * screen waiting while the player plugs in a pad): fires on pad
 * connect/disconnect. Returns an unsubscribe.
 */
export const watchControlContext = (onChange: () => void) => {
  if (typeof window === "undefined") {
    return () => null;
  }

  window.addEventListener("gamepadconnected", onChange);
  window.addEventListener("gamepaddisconnected", onChange);

  return () => {
    window.removeEventListener("gamepadconnected", onChange);
    window.removeEventListener("gamepaddisconnected", onChange);
  };
};
