/** The part of YouTube's `ytgame` global this package uses. */
interface YtGame {
  IN_PLAYABLES_ENV: boolean;
  game: {
    firstFrameReady: () => void;
    gameReady: () => void;
  };
  system: {
    isAudioEnabled: () => boolean;
    onAudioEnabledChange: (callback: (enabled: boolean) => void) => () => void;
    onPause: (callback: () => void) => () => void;
    onResume: (callback: () => void) => () => void;
  };
}

declare global {
  interface Window {
    /** Defined by YouTube's SDK script; never assigned by a game. */
    ytgame?: YtGame;
  }
}

const sdk = () => {
  if (!("window" in globalThis)) {
    return null;
  }

  const { ytgame } = window;

  return ytgame?.IN_PLAYABLES_ENV === true ? ytgame : null;
};

/** True when the game is running inside YouTube Playables. */
export const isPlayables = () => sdk() !== null;

let firstFrame = false;
let ready = false;

/** The first frame is on screen. Call it after the first render; repeats are ignored. */
export const markFirstFrame = () => {
  const ytgame = sdk();

  if (ytgame === null || firstFrame) {
    return;
  }

  firstFrame = true;
  ytgame.game.firstFrameReady();
};

/**
 * The player can act now: no loading screen is showing. Implies the first
 * frame, since YouTube requires that call first; repeats are ignored.
 */
export const markGameReady = () => {
  const ytgame = sdk();

  if (ytgame === null || ready) {
    return;
  }

  markFirstFrame();
  ready = true;
  ytgame.game.gameReady();
};

let systemPaused = false;
const pauseListeners = new Set<(paused: boolean) => void>();
let pauseWired = false;

const setSystemPaused = (paused: boolean) => {
  systemPaused = paused;

  for (const listener of pauseListeners) {
    listener(paused);
  }
};

const wirePause = (ytgame: YtGame) => {
  if (pauseWired) {
    return;
  }

  pauseWired = true;
  ytgame.system.onPause(() => {
    setSystemPaused(true);
  });
  ytgame.system.onResume(() => {
    setSystemPaused(false);
  });
};

/** Whether YouTube has paused the game. While true, step and draw nothing. */
export const isSystemPaused = () => systemPaused;

/** Hear YouTube pause and resume the game. Returns an unsubscribe. */
export const watchSystemPause = (listener: (paused: boolean) => void) => {
  const ytgame = sdk();

  if (ytgame !== null) {
    wirePause(ytgame);
  }

  pauseListeners.add(listener);

  return () => pauseListeners.delete(listener);
};

/**
 * YouTube's audio switch, or null outside Playables. Inside, it is the only
 * say over sound: the game plays sound exactly while `enabled()` is true, and
 * shows no mute control of its own.
 */
export interface PlayablesAudio {
  enabled: () => boolean;
  /** Returns an unsubscribe. */
  watch: (listener: (enabled: boolean) => void) => () => void;
}

export const playablesAudio: () => PlayablesAudio | null = () => {
  const ytgame = sdk();

  if (ytgame === null) {
    return null;
  }

  return {
    enabled: () => ytgame.system.isAudioEnabled(),
    watch: (listener) => ytgame.system.onAudioEnabledChange(listener),
  };
};
