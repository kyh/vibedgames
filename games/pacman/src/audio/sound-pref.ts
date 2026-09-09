// Sound on/off preference, shared by the synth SFX and the music player.

/** "1" = sound ON; anything else/absent = muted (sound is opt-in). */
const SOUND_KEY = "pacman:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). Audio prefs fall back to muted — never crash the game.
const storageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const storageSet = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the game.
  }
};

/** Muted by default; enabled only when the user previously opted in via M. */
const initialSoundOn = (): boolean => storageGet(SOUND_KEY) === "1";

let soundOn = initialSoundOn();

export const rememberSound = (on: boolean): void => {
  soundOn = on;
  storageSet(SOUND_KEY, on ? "1" : "0");
};

/** The persisted preference both engines follow — what a mute button reads. */
export const isSoundOn = (): boolean => soundOn;
