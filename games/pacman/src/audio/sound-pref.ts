const SOUND_KEY = "pacman:sound";

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

const initialSoundOn = () => storageGet(SOUND_KEY) === "1";

let soundOn = initialSoundOn();

export const rememberSound = (on: boolean) => {
  soundOn = on;
  storageSet(SOUND_KEY, on ? "1" : "0");
};

/** The persisted preference both engines follow — what a mute button reads. */
export const isSoundOn = () => soundOn;
