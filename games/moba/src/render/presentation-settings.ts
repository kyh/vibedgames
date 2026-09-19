export interface PresentationSettings {
  effects: "full" | "focused";
  motion: "system" | "reduced";
  view: "standard" | "close";
}

const KEY = "moba:presentation";
const listeners = new Set<() => void>();

export const parsePresentationSettings = (raw: string | null): PresentationSettings => {
  const defaults: PresentationSettings = { effects: "full", motion: "system", view: "standard" };
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    // JSON objects have ordinary prototypes; accept only the three enum fields.
    if (!(value instanceof Object) || Array.isArray(value)) {
      return defaults;
    }
    return {
      effects: "effects" in value && value.effects === "focused" ? "focused" : "full",
      motion: "motion" in value && value.motion === "reduced" ? "reduced" : "system",
      view: "view" in value && value.view === "close" ? "close" : "standard",
    };
  } catch {
    return defaults;
  }
};

const storedSettings = (): PresentationSettings => {
  try {
    return parsePresentationSettings(window.localStorage.getItem(KEY));
  } catch {
    return parsePresentationSettings(null);
  }
};

let settings = storedSettings();

export const presentationSettings = (): Readonly<PresentationSettings> => settings;

/** Blocked embed storage loses persistence, never the current preference. */
export const setPresentationSettings = (next: PresentationSettings): void => {
  settings = { ...next };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Keep the in-memory setting usable in restricted embeds.
  }
  for (const listener of listeners) {
    listener();
  }
};

export const watchPresentationSettings = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let reducedMotionQuery: MediaQueryList | null = null;

/** The OS preference or the in-game motion setting: skip entrance/pulse motion. */
export const reducedMotion = (): boolean => {
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery.matches || settings.motion === "reduced";
};
