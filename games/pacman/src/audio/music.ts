import { isSoundOn } from "./sound-pref";

const MUSIC_TITLE_VOLUME = 0.16;
const MUSIC_PLAY_VOLUME = 0.24;
const MUSIC_POWER_VOLUME = 0.3;
const MUSIC_CHASE_VOLUME = 0.32;
const MUSIC_RESULT_VOLUME = 0.12;
const MUSIC_DUCK_VOLUME = 0.1;
const MUSIC_DUCK_MS = 1400;
const MUSIC_POWER_RATE = 1.06;
const CHASE_ENTER_CELLS = 3;
const CHASE_EXIT_CELLS = 4.2;
const CHASE_ENTER_MS = 450;
const CHASE_EXIT_MS = 900;

export type MusicPhase = "title" | "ready" | "playing" | "win" | "gameover";

/**
 * Looping ambient track (vg-generated music-box lullaby). Degrades silently
 * if the file is missing or autoplay is blocked; `start()` is only called
 * after the same gesture that unlocks the Sfx context.
 */
export class Music {
  private audio: HTMLAudioElement | null = null;
  private paused = false;
  private power = false;
  private duckRemaining = 0;
  private chasing = false;
  private candidateMs = 0;
  private volume = MUSIC_TITLE_VOLUME;
  private phase: MusicPhase = "title";
  private failed = false;

  start(url: string) {
    if (this.failed || !isSoundOn()) {
      return;
    }

    if (!this.audio) {
      const audio = new Audio(url);
      audio.loop = true;
      audio.addEventListener("error", () => {
        this.audio = null;
        this.failed = true;
      });
      this.audio = audio;
    }

    this.sync();
    this.play();
  }

  setPowerMode(on: boolean) {
    this.power = on;
    this.sync();
  }

  /** Wrapper-requested pause: stop the loop, resumable in place. */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.sync();

    if (!paused) {
      this.play();
    }
  }

  /** Dip under the `caught` sting, restored by update(). */
  duck() {
    if (this.paused || !isSoundOn()) {
      return;
    }

    this.duckRemaining = MUSIC_DUCK_MS / 1000;
    this.sync();
  }

  /** @param nearestDanger maze-cell distance to a threatening ghost; null while none can. */
  update(dt: number, phase: MusicPhase, nearestDanger: number | null) {
    if (this.paused) {
      return;
    }

    this.phase = phase;

    if (phase !== "playing" || this.power) {
      this.chasing = false;
      this.candidateMs = 0;
    } else {
      const candidate =
        nearestDanger !== null &&
        nearestDanger < (this.chasing ? CHASE_EXIT_CELLS : CHASE_ENTER_CELLS);

      if (candidate === this.chasing) {
        this.candidateMs = 0;
      } else {
        this.candidateMs += dt * 1000;

        if (this.candidateMs >= (candidate ? CHASE_ENTER_MS : CHASE_EXIT_MS)) {
          this.chasing = candidate;
          this.candidateMs = 0;
        }
      }
    }

    this.duckRemaining = Math.max(0, this.duckRemaining - dt);
    this.volume += (this.targetVolume() - this.volume) * (1 - Math.exp(-dt * 3));
    this.sync();
  }

  /** Push mute/pause/duck/power onto the element; muted or paused also halts it. */
  sync() {
    const { audio } = this;

    if (!audio) {
      return;
    }

    const silent = !isSoundOn() || this.paused;
    audio.volume = silent ? 0 : this.currentVolume();
    audio.playbackRate = this.power ? MUSIC_POWER_RATE : 1;

    if (silent) {
      audio.pause();
      this.duckRemaining = 0;
    }
  }

  private currentVolume() {
    return this.duckRemaining > 0 ? MUSIC_DUCK_VOLUME : this.volume;
  }

  private play() {
    const { audio } = this;

    if (!audio || !isSoundOn() || this.paused || !audio.paused) {
      return;
    }

    void this.playThenSync(audio);
  }

  private async playThenSync(audio: HTMLAudioElement) {
    try {
      await audio.play();
    } catch {
      return;
    }

    this.sync();
  }

  private targetVolume() {
    if (this.phase === "title") {
      return MUSIC_TITLE_VOLUME;
    }

    if (this.phase === "win" || this.phase === "gameover") {
      return MUSIC_RESULT_VOLUME;
    }

    if (this.chasing) {
      return MUSIC_CHASE_VOLUME;
    }

    return this.power ? MUSIC_POWER_VOLUME : MUSIC_PLAY_VOLUME;
  }
}

export const music = new Music();
